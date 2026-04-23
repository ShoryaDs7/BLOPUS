/**
 * OwnerViralReplyHunter — Phase 2 only (MODE_B, owner account).
 *
 * Instead of waiting to be mentioned, this actively finds viral tweets
 * in the owner's interest topics and replies to them in the owner's voice.
 *
 * Logic:
 * 1. Every 30 min, pick a random topic from the owner's personality profile
 * 2. Search for tweets on that topic with 500+ likes posted in the last 2 hours
 * 3. Pick 1 tweet not yet replied to
 * 4. Generate a reply in the owner's voice
 * 5. Post via Playwright (zero API cost)
 *
 * Daily cap: 10 proactive replies (conservative for a real human account)
 */

import { LLMReplyEngine } from '../core/personality/LLMReplyEngine'
import { PersonalityProfile } from '../core/personality/LLMReplyEngine'
import { XAdapter } from '../adapters/x/XAdapter'
import { PlaywrightHomeTimelineProvider } from '../adapters/x/PlaywrightHomeTimelineProvider'
import { PlaywrightDomainSearchProvider } from '../adapters/x/PlaywrightDomainSearchProvider'
import { Mood } from '../core/memory/types'
import { readFocusOverride } from '../adapters/control/FocusOverride'
import { readRuntimeConfig, readRuntimeConfigOverrides } from '../adapters/control/RuntimeConfig'
import fs from 'fs'
import path from 'path'

export class OwnerViralReplyHunter {
  private replyCountToday = 0
  private currentDate = new Date().toDateString()
  private lastRunAt: number = 0
  private repliedTweetIds = new Set<string>()
  private lastTopicWords: string[] = []
  private consecutiveSameTopic = 0
  private domainSearch = new PlaywrightDomainSearchProvider()
  private repliedIdsPath: string = ''
  lastCandidates: Array<{ id: string; text: string; authorHandle: string; likeCount?: number }> = []
  lastRepliedTweetId: string | null = null

  constructor(
    private llmEngine: LLMReplyEngine,
    private xAdapter: XAdapter,
    private homeTimeline: PlaywrightHomeTimelineProvider,
    private personalityProfile: PersonalityProfile | undefined,
    private ownerHandle: string,
    private useGrokTag: boolean = false,
  ) {
    // Persist replied tweet IDs so restarts don't re-reply to same tweets
    const configPath = process.env.BLOPUS_CONFIG_PATH ?? ''
    this.repliedIdsPath = path.join(path.dirname(path.resolve(configPath)), 'replied_tweet_ids.json')
    this.loadRepliedIds()
  }

  private loadRepliedIds(): void {
    try {
      if (fs.existsSync(this.repliedIdsPath)) {
        const ids: string[] = JSON.parse(fs.readFileSync(this.repliedIdsPath, 'utf-8'))
        this.repliedTweetIds = new Set(ids)
        console.log(`[OwnerViralHunter] Loaded ${ids.length} previously replied tweet IDs`)
      }
    } catch {}
  }

  private saveRepliedIds(): void {
    try {
      // Keep last 5000 IDs max — enough history without growing forever
      const ids = [...this.repliedTweetIds].slice(-5000)
      fs.writeFileSync(this.repliedIdsPath, JSON.stringify(ids))
    } catch {}
  }

  async maybeReply(mood: Mood): Promise<void> {
    try {
      this.resetIfNewDay()

      const override = readFocusOverride()
      if (override?.paused) {
        console.log('[OwnerViralHunter] Paused by user command — skipping.')
        return
      }

      const rc = readRuntimeConfig()
      const overrides = readRuntimeConfigOverrides()
      const bp = this.personalityProfile?.behaviorProfile

      // Archive-derived values win unless user explicitly overrode via Telegram
      const effectiveDailyCap = overrides.maxRepliesPerDay != null
        ? rc.maxRepliesPerDay
        : (bp?.avgRepliesPerDay ? Math.max(5, Math.round(bp.avgRepliesPerDay)) : rc.maxRepliesPerDay)

      // Spread replies evenly across active hours: 24h / replies per day → minutes between
      const effectiveCooldown = overrides.cooldownMinutes != null
        ? rc.cooldownMinutes
        : (bp?.avgRepliesPerDay ? Math.max(10, Math.round((24 * 60) / bp.avgRepliesPerDay)) : rc.cooldownMinutes)

      if (this.replyCountToday >= effectiveDailyCap) {
        console.log(`[OwnerViralHunter] Daily cap reached (${this.replyCountToday}/${effectiveDailyCap}).`)
        return
      }

      const minsSinceLast = (Date.now() - this.lastRunAt) / 60_000
      if (this.lastRunAt > 0 && minsSinceLast < effectiveCooldown) {
        console.log(`[OwnerViralHunter] Cooldown (${Math.round(minsSinceLast)}/${effectiveCooldown} min).`)
        return
      }

      // Time-of-day gate — only hunt during typical posting hours (±2h window, UTC)
      if (bp?.typicalPostingHours && bp.typicalPostingHours.length > 0) {
        const nowUTC = new Date().getUTCHours()
        const isTypicalHour = bp.typicalPostingHours.some(h => {
          const diff = Math.abs(nowUTC - h)
          return diff <= 2 || diff >= 22
        })
        if (!isTypicalHour) {
          console.log(`[OwnerViralHunter] Hour ${nowUTC} UTC not a typical posting hour — skipping.`)
          return
        }
      }

      // Read replyMode + avoidTopics from config
      const configPath = process.env.BLOPUS_CONFIG_PATH ?? ''
      let replyMode: 'domain' | 'viral' = 'domain'
      let avoidTopics: string[] = []
      let domainMinLikes: Record<string, number> | undefined
      let domainSearchKeywords: Record<string, string[]> | undefined
      try {
        const cfg = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8'))
        replyMode = cfg.replyMode ?? 'domain'
        avoidTopics = cfg.avoidTopics ?? []
        domainMinLikes = cfg.domainMinLikes
        domainSearchKeywords = cfg.domainSearchKeywords
        if (cfg.maxAgeTweetMinutes) rc.maxAgeTweetMinutes = cfg.maxAgeTweetMinutes
      } catch {}

      this.lastRunAt = Date.now()
      let candidates: Awaited<ReturnType<PlaywrightHomeTimelineProvider['getViralFromHome']>> = []

      if (!this.homeTimeline.enabled) {
        console.log('[OwnerViralHunter] X_AUTH_TOKEN/X_CT0 not set — skipping.')
        return
      }

      const topics = override?.topics?.length
        ? override.topics
        : (this.personalityProfile?.dominantTopics ?? [])

      // Step 1: scan home timeline
      console.log(`[OwnerViralHunter] Scanning home timeline (mode: ${replyMode})...`)
      candidates = await this.homeTimeline.getViralFromHome(rc.minLikes, rc.maxAgeTweetMinutes)

      if (replyMode === 'viral') {
        // Pure home timeline — no domain filter, no web search fallback
        // Just filter avoidTopics and use everything X shows
        if (avoidTopics.length > 0) {
          candidates = candidates.filter(c => {
            const lower = c.text.toLowerCase()
            return !avoidTopics.some(t => lower.includes(t.toLowerCase()))
          })
        }
        console.log(`[OwnerViralHunter] Home timeline: ${candidates.length} viral candidates`)
      } else {
        // Domain mode — filter by owner's topics, fall back to topic search if empty
        const homeFiltered = this.applyFilters(candidates, avoidTopics, topics, domainSearchKeywords)
        console.log(`[OwnerViralHunter] Home timeline: ${candidates.length} viral → ${homeFiltered.length} on-domain`)

        if (homeFiltered.length > 0) {
          candidates = homeFiltered
        } else {
          // Fallback: direct topic search
          console.log(`[OwnerViralHunter] No domain tweets on home — searching by topic...`)
          if (this.domainSearch.enabled && topics.length > 0) {
            const searched = await this.domainSearch.searchViralByTopics(topics, rc.minLikes, rc.maxAgeTweetMinutes, domainMinLikes, domainSearchKeywords)
            const searchFiltered = this.applyFilters(searched, avoidTopics, topics, domainSearchKeywords)
            console.log(`[OwnerViralHunter] Topic search: ${searched.length} found → ${searchFiltered.length} on-domain`)
            candidates = searchFiltered.length > 0 ? searchFiltered : []
          } else {
            candidates = []
          }
        }
      }


      // Expose candidates for engagement engine (like/rt/qt)
      this.lastCandidates = candidates.map(c => ({
        id: c.tweetId, text: c.text, authorHandle: c.authorHandle, likeCount: c.likeCount,
      }))

      let fresh = candidates.filter(c =>
        !this.repliedTweetIds.has(c.tweetId) &&
        c.authorHandle.toLowerCase() !== this.ownerHandle.toLowerCase()
      )

      // If home timeline had on-domain tweets but all already replied to,
      // fall back to topic search for fresh candidates
      if (fresh.length === 0 && replyMode === 'domain' && this.domainSearch.enabled && topics.length > 0) {
        console.log('[OwnerViralHunter] All home candidates already replied to — falling back to topic search...')
        const searched = await this.domainSearch.searchViralByTopics(topics, rc.minLikes, rc.maxAgeTweetMinutes, domainMinLikes)
        const searchFiltered = this.applyFilters(searched, avoidTopics, topics, domainSearchKeywords)
        console.log(`[OwnerViralHunter] Topic search fallback: ${searched.length} found → ${searchFiltered.length} on-domain`)
        fresh = searchFiltered.filter(c =>
          !this.repliedTweetIds.has(c.tweetId) &&
          c.authorHandle.toLowerCase() !== this.ownerHandle.toLowerCase()
        )
      }

      if (fresh.length === 0) {
        console.log('[OwnerViralHunter] No fresh viral tweets found.')
        return
      }

      // Skip non-English tweets (Farsi, Arabic, etc.)
      const englishOnly = fresh.filter(c => this.isEnglish(c.text))
      if (englishOnly.length === 0) {
        console.log(`[OwnerViralHunter] All fresh tweets are non-English — skipping.`)
        return
      }

      // Skip tweets too short to reply to meaningfully (e.g. "Follow", "Lol", "Same")
      const meaningful = englishOnly.filter(c => c.text.trim().split(/\s+/).length >= 5)
      if (meaningful.length === 0) {
        console.log(`[OwnerViralHunter] All candidates too short to reply to — skipping.`)
        return
      }

      // If last 2 replies were same topic — filter out that topic for this pick
      let pool = meaningful
      if (this.consecutiveSameTopic >= rc.consecutiveTopicLimit && this.lastTopicWords.length > 0) {
        const filtered = meaningful.filter(c => !this.isSameTopic(c.text, this.lastTopicWords))
        if (filtered.length > 0) {
          pool = filtered
          console.log(`[OwnerViralHunter] Same topic x${this.consecutiveSameTopic} — forcing topic change.`)
        }
      }

      // Sort: strongest topic match first (most keyword hits), ties broken by likes.
      // All pool tweets already passed isTopicRelevant (binary), so sorting by binary would
      // always produce 0 — we count actual keyword hits to rank by relevance strength.
      const profileKeywords = this.personalityProfile?.topicKeywords ?? {}
      const countMatches = (text: string): number => {
        const stripped = text.replace(/@\w+/g, '').toLowerCase()
        return topics.reduce((total, topic) => {
          const kws = profileKeywords[topic] ?? []
          return total + kws.filter(kw => this.matchesKeyword(stripped, kw)).length
        }, 0)
      }
      pool.sort((a, b) => {
        const diff = countMatches(b.text) - countMatches(a.text)
        return diff !== 0 ? diff : b.likeCount - a.likeCount
      })

      const pick = pool[0]
      console.log(`[OwnerViralHunter] Picked tweet ${pick.tweetId} by @${pick.authorHandle} (${pick.likeCount} likes, ${pick.ageMinutes}m old)`)

      // Generate reply in owner's voice
      const replyText = await this.llmEngine.generateViralReply(
        { text: pick.text, authorHandle: pick.authorHandle, mediaUrls: pick.mediaUrls },
        mood,
        this.useGrokTag,
      )

      if (!replyText) {
        console.log('[OwnerViralHunter] LLM returned empty reply — skipping.')
        return
      }

      await this.xAdapter.postAutonomousReply(pick.tweetId, replyText)
      this.repliedTweetIds.add(pick.tweetId)
      this.lastRepliedTweetId = pick.tweetId
      this.saveRepliedIds()
      this.replyCountToday++

      // Track topic — if same as last reply, increment streak; else reset
      const pickWords = this.extractTopicWords(pick.text)
      if (this.lastTopicWords.length > 0 && this.isSameTopic(pick.text, this.lastTopicWords)) {
        this.consecutiveSameTopic++
      } else {
        this.consecutiveSameTopic = 1
      }
      this.lastTopicWords = pickWords

      console.log(`[OwnerViralHunter] Replied to @${pick.authorHandle}: "${replyText.slice(0, 80)}..." (topic streak: ${this.consecutiveSameTopic})`)
    } catch (err) {
      console.log(`[OwnerViralHunter] Suppressed error: ${err}`)
    }
  }

  private applyFilters(
    candidates: Awaited<ReturnType<PlaywrightHomeTimelineProvider['getViralFromHome']>>,
    avoidTopics: string[],
    domainTopics: string[],
    domainSearchKeywords?: Record<string, string[]>,
  ) {
    let filtered = candidates
    if (avoidTopics.length > 0) {
      filtered = filtered.filter(c => {
        const lower = c.text.toLowerCase()
        return !avoidTopics.some(t => lower.includes(t.toLowerCase()))
      })
    }
    if (domainTopics.length > 0) {
      filtered = filtered.filter(c => this.isTopicRelevant(c.text, domainTopics, domainSearchKeywords))
    }
    return filtered
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.replyCountToday = 0
    }
  }

  /**
   * Returns true if the tweet text overlaps with at least one owner topic.
   * Splits multi-word topics into component words and checks word boundaries.
   * Generic — works for any user's dominantTopics from their personality profile.
   */
  /** Returns true if the text is predominantly English (ASCII chars > 80%) */
  private isEnglish(text: string): boolean {
    if (!text || text.length === 0) return false
    const asciiChars = text.split('').filter(c => c.charCodeAt(0) < 128).length
    return asciiChars / text.length > 0.8
  }

  // Extract meaningful keywords from tweet text — no hardcoded topics
  private extractTopicWords(text: string): string[] {
    const STOP = new Set(['the','and','for','with','from','that','this','are','was','has','have','not','but','can','its','will','just','about','they','their','what','when','your','you','all','been','have','one','more','also','after','than','then','some','into','over','would','there','which','these','those','being','every','each'])
    return text.toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 5 && !STOP.has(w))
      .slice(0, 8)
  }

  // Returns true if tweet shares 2+ keywords with the reference topic words
  private isSameTopic(text: string, referenceWords: string[]): boolean {
    const words = this.extractTopicWords(text)
    const overlap = words.filter(w => referenceWords.includes(w)).length
    return overlap >= 2
  }

  /**
   * Single-word keywords use word boundaries (\b) to prevent substring false-positives.
   * e.g. "eth" won't match "method/together", "war" won't match "software/reward",
   * "sol" won't match "solve/solo", "win" won't match "window/twin".
   * Multi-word phrases (with spaces) still use plain includes — they're specific enough.
   */
  private matchesKeyword(text: string, kw: string): boolean {
    if (kw.includes(' ')) return text.includes(kw)
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`\\b${escaped}\\b`).test(text)
  }

  private isTopicRelevant(tweetText: string, topics: string[], domainSearchKeywords?: Record<string, string[]>): boolean {
    const stripped = tweetText.replace(/@\w+/g, '').toLowerCase()

    // Use profile-computed keywords if available (generated at setup from user's archive)
    const profileKeywords = this.personalityProfile?.topicKeywords ?? {}

    // Fallback hardcoded keyword list for common X topics
    const TOPIC_KEYWORDS: Record<string, string[]> = {
      // AI tools & models
      'ai': ['chatgpt','openai','anthropic','claude','gemini','grok','llm','gpt','mistral','copilot','perplexity','ollama','llama','deepseek','sora','dall-e','midjourney','stable diffusion','hugging face','cursor','ai model','language model','neural','inference','fine-tun','rag','embedding','token','prompt','artificial intelligence','machine learning','deep learning','transformer','benchmark','context window'],
      // Crypto & markets
      'crypto': ['bitcoin','btc','eth','ethereum','solana','sol','xrp','ripple','dogecoin','doge','usdt','usdc','stablecoin','defi','nft','web3','blockchain','altcoin','memecoin','binance','coinbase','kraken','bybit','crypto','wallet','on-chain','layer 2','l2','ordinals','inscription','halving','mining','staking','yield','airdrop','token','dao','protocol','liquidity','dex','cex','market cap','bull','bear','ath','correction','crash','pump','dump','whale','portfolio','trading','futures','options','nasdaq','s&p','dow','fed','inflation','interest rate','tariff','stock','equity','ipo','earnings','gdp','recession','economy','market'],
      // Sports & entertainment
      'sport': ['nba','nfl','nhl','mlb','fifa','ipl','bcci','cricket','football','basketball','soccer','tennis','f1','formula 1','ufc','mma','boxing','wrestling','olympics','world cup','champions league','premier league','la liga','bundesliga','serie a','lakers','warriors','celtics','bulls','knicks','heat','nets','spurs','clippers','nuggets','suns','bucks','sixers','raptors','pacers','cavaliers','thunder','mavericks','rockets','grizzlies','pelicans','timberwolves','blazers','kings','jazz','magic','wizards','pistons','hornets','hawks','lebron','curry','durant','giannis','luka','doncic','jokic','embiid','tatum','lillard','butler','reaves','davis','james','kobe','shaq','jordan','playoff','championship','draft','trade','roster','contract','mvp','all-star','slam dunk','three pointer','touchdown','goal','wicket','century','innings','over','bowler','batsman','match','series','tournament','fixture','transfer','manager','coach','lineup','bench','injury','suspension','stadium','fans','crowd','rivalry'],
      // Geopolitics & world news
      'geopolit': ['iran','israel','ukraine','russia','nato','china','taiwan','north korea','south korea','pakistan','india','modi','putin','zelensky','netanyahu','trump','biden','war','conflict','sanction','missile','drone','attack','airstrike','ceasefire','peace','treaty','embassy','diplomat','ambassador','congress','senate','parliament','election','vote','coup','protest','revolution','military','army','navy','troops','soldier','civilian','refugee','border','territory','occupation','annexation','nuclear','weapon','defense','intelligence','cia','fbi','un','g7','g20','imf','world bank','tariff','trade war','export','import','supply chain'],
      // Math & science
      'math': ['equation','theorem','proof','calculus','algebra','geometry','prime','fibonacci','pi','infinity','matrix','vector','probability','statistics','derivative','integral','function','graph','polynomial','logarithm','exponential','quantum','physics','chemistry','biology','neuroscience','astronomy','telescope','nasa','spacex','rocket','satellite','black hole','dark matter','relativity','particle','atom','molecule','dna','gene','crispr','vaccine','cancer','climate','carbon','emission','temperature','fossil fuel','renewable','solar','wind','nuclear energy','experiment','research','paper','peer review','study','data','model','simulation'],
      // Social commentary & humor
      'social': ['viral','wild','insane','crazy','imagine','this is','nobody','everyone','literally','actually','honestly','real talk','hot take','unpopular opinion','controversial','debate','ratio','ratio\'d','ratio\'ed','dunno','lmao','lol','bruh','bro','sis','fr fr','no cap','based','cringe','mid','sus','ngl','imo','tbh','yikes','rip','mood','same','relatable','thread','rant','story time','plot twist','not gonna lie','did you know','fun fact','reminder that','gentle reminder','the fact that','why is nobody','how is it that','can we talk about','we need to discuss','society','culture','generation','boomer','millennial','gen z','privilege','entitlement','trauma','toxic','red flag','green flag','boundaries','therapy','burnout','hustle','grind','side hustle','passive income','wealth','class','poor','rich','inequality','justice','racism','sexism','discrimination','stereotype','representation'],
      // X / Twitter platform
      'twitter': ['twitter','tweet','retweet','quote tweet','x.com','elon','musk','linda','yaccarino','blue check','verification','premium','subscription','algorithm','timeline','fyp','for you','trending','hashtag','thread','spaces','community','dm','direct message','follower','following','impressions','engagement','reach','analytics','monetization','creator','ads','ban','suspend','deplatform','free speech','moderation','content policy','misinformation'],
      // Tech & startups
      'tech': ['startup','founder','vc','venture capital','seed','series a','series b','valuation','unicorn','yc','y combinator','techcrunch','product hunt','saas','b2b','b2c','mrr','arr','churn','cac','ltv','runway','burn rate','pivot','mvp','launch','ship','build','indie hacker','solopreneur','bootstrapped','funding','raise','investor','angel','pitch','deck','term sheet','acquisition','ipo','exit','layoff','hiring','remote','hybrid','engineering','software','developer','codebase','api','backend','frontend','fullstack','devops','cloud','aws','azure','gcp','kubernetes','docker','microservice','database','postgres','mongodb','redis','graphql','rest','typescript','python','rust','golang','react','nextjs','open source','github','pull request','deploy','production','bug','feature','roadmap','sprint','agile','scrum'],
      // Grok / xAI / Elon
      'grok': ['grok','xai','elon','musk','spacex','tesla','neuralink','boring company','starlink','x.ai','supercomputer','colossus','memphis','dojo','optimus','robot','autonomous','self-driving','fsd','cybertruck','model s','model 3','model y','roadster','gigafactory','mars','starship','falcon','raptor'],
    }

    return topics.some(topic => {
      const topicLower = topic.toLowerCase()

      // 1. User's own expanded keywords from setup (most accurate — explicitly chosen by user)
      if (domainSearchKeywords?.[topic]?.length) {
        return domainSearchKeywords[topic].some(kw => this.matchesKeyword(stripped, kw.toLowerCase()))
      }

      // 2. Profile-computed keywords from archive
      if (profileKeywords[topic]?.length) {
        return profileKeywords[topic].some(kw => this.matchesKeyword(stripped, kw))
      }

      // 3. Hardcoded fallback keyword groups
      const matchedGroup = Object.entries(TOPIC_KEYWORDS).find(([key]) => topicLower.includes(key))
      if (matchedGroup) {
        return matchedGroup[1].some(kw => this.matchesKeyword(stripped, kw))
      }

      // 4. Last resort: split topic into words and match
      const SKIP = new Set(['and','the','for','with','from','that','this','are','was','has','have','not','but','can','its','will'])
      const words = topicLower.split(/[\s/,()\[\]]+/).filter(w => w.length >= 4 && !SKIP.has(w))
      return words.some(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(stripped))
    })
  }
}
