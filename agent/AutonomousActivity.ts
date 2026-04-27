import { MemoryEngine } from '../core/memory/MemoryEngine'
import { LLMReplyEngine, AutonomousPostContext, RecentInteraction } from '../core/personality/LLMReplyEngine'
import { XAdapter } from '../adapters/x/XAdapter'
// import { ThreadsAdapter } from '../adapters/threads' // Threads disabled — X-only launch. See docs/threads-wiring.md to re-enable.
import { TavilyClient } from '../adapters/search/TavilyClient'
import { Mood } from '../core/memory/types'
import { extractTopics } from '../core/memory/topicExtractor'
import { readFocusOverride } from '../adapters/control/FocusOverride'
import { readRuntimeConfig, readRuntimeConfigOverrides } from '../adapters/control/RuntimeConfig'
import { PersonalityProfile } from '../core/personality/LLMReplyEngine'
import { UserContext } from '../adapters/control/UserContext'
import { OwnerPostIndex } from '../core/memory/OwnerPostIndex'

export class AutonomousActivity {
  private tavily = new TavilyClient()
  private recentTopicsQueue: string[] = []

  constructor(
    private memory: MemoryEngine,
    private llmEngine: LLMReplyEngine,
    private xAdapter: XAdapter,
    private xAccountKey: string = 'x:bot-own',
    private threadsAdapter: null = null, // Threads disabled — see docs/threads-wiring.md
    private threadsAccountKey: string = 'threads:owner-own',
    private ownerHandle: string = '',
    private personalityProfile?: PersonalityProfile,
    private userContext?: UserContext,
    private postIndex?: OwnerPostIndex,
  ) {}

  async maybePost(mood: Mood): Promise<void> {
    try {
      const override = readFocusOverride()
      if (override?.paused) {
        console.log('[AutonomousActivity] Paused by user command — skipping post.')
        return
      }

      const rc = readRuntimeConfig()
      const overrides = readRuntimeConfigOverrides()
      const bp = this.personalityProfile?.behaviorProfile

      // Priority: Telegram override → interview confirmed value → archive-derived → runtime default
      const confirmedPostsPerDay = this.personalityProfile?.voiceProfile?.originalPostProfile?.confirmedPostsPerDay
      const effectiveDailyCap = overrides.maxAutonomousPostsPerDay != null
        ? rc.maxAutonomousPostsPerDay
        : confirmedPostsPerDay
        ? confirmedPostsPerDay
        : (bp?.avgPostsPerDay ? Math.max(1, Math.round(bp.avgPostsPerDay)) : rc.maxAutonomousPostsPerDay)

      const effectiveIntervalHours = overrides.minPostIntervalHours != null
        ? rc.minPostIntervalHours
        : (bp?.avgIntervalHours ? Math.max(0.5, Math.round(bp.avgIntervalHours * 10) / 10) : rc.minPostIntervalHours)

      if (this.memory.getAutonomousPostCount() >= effectiveDailyCap) {
        console.log(`[AutonomousActivity] Daily cap reached (${effectiveDailyCap}) — skipping.`)
        return
      }

      const lastAt = this.memory.getLastAutonomousPostAt()
      if (lastAt) {
        const hoursSince = (Date.now() - new Date(lastAt).getTime()) / 3_600_000
        if (hoursSince < effectiveIntervalHours) return
      }

      // Time-of-day gate — only post during hours matching archive behavior (±2h window)
      // typicalPostingHours are UTC hours when the owner actually posts most
      if (bp?.typicalPostingHours && bp.typicalPostingHours.length > 0) {
        const nowUTC = new Date().getUTCHours()
        const isTypicalHour = bp.typicalPostingHours.some(h => {
          const diff = Math.abs(nowUTC - h)
          return diff <= 2 || diff >= 22  // wrap around midnight
        })
        if (!isTypicalHour) {
          console.log(`[AutonomousActivity] Hour ${nowUTC} UTC not a typical posting hour [${bp.typicalPostingHours.join(',')}] — skipping.`)
          return
        }
      }

      const opp = this.personalityProfile?.voiceProfile?.originalPostProfile
      const postTopics = opp?.topics ?? this.personalityProfile?.postTopics ?? this.personalityProfile?.dominantTopics

      // Pick post mode: newsDriven (Tavily) vs tweet-inspired (everything else)
      // Supports both new 2-field split {tweetInspired, newsDriven} and old 3-field {personalThought, tweetReaction, newsDriven}
      const split = opp?.postSourceSplit
      const newsDrivenChance = split
        ? (split.newsDriven ?? 0)
        : (['news-driven', 'opinions-hot-takes'].includes(opp?.postSourceType ?? '') ? 70 : 20)
      const isNewsDriven = Math.random() * 100 < newsDrivenChance

      console.log(`[AutonomousActivity] Post mode: ${isNewsDriven ? 'newsDriven' : 'tweetInspired'}`)

      // Fetch news when needed
      const currentEvents = isNewsDriven ? await this.tavily.fetchCurrentEvents(postTopics) : []

      // Post on X
      const xCtx = this.gatherContext(mood, currentEvents, this.xAccountKey)

      // Weighted topic selection — pick topic based on engagementShare from setup
      // Cooldown: never repeat a topic until all others have been used (N = topic count)
      if (!override?.topics?.length) {
        const tp = this.personalityProfile?.topicProfiles
        if (tp && Object.keys(tp).length) {
          const entries = Object.entries(tp) as [string, { engagementShare: number }][]
          const cooldown = entries.length - 1
          const available = entries.filter(([t]) => !this.recentTopicsQueue.includes(t))
          const pool = available.length ? available : entries
          const total = pool.reduce((s, [, v]) => s + (v.engagementShare ?? 0), 0)
          let rand = Math.random() * (total || 1)
          const picked = pool.find(([, v]) => { rand -= v.engagementShare ?? 0; return rand <= 0 })?.[0] ?? pool[0][0]
          xCtx.recentTopics = [picked]
          this.recentTopicsQueue.push(picked)
          if (this.recentTopicsQueue.length > cooldown) this.recentTopicsQueue.shift()
        } else if (postTopics?.length) {
          const cooldown = postTopics.length - 1
          const available = postTopics.filter(t => !this.recentTopicsQueue.includes(t))
          const pool = available.length ? available : postTopics
          const picked = pool[Math.floor(Math.random() * pool.length)]
          xCtx.recentTopics = [picked]
          this.recentTopicsQueue.push(picked)
          if (this.recentTopicsQueue.length > cooldown) this.recentTopicsQueue.shift()
        }
      }

      // Tweet-inspired mode: find a real tweet on the topic as concrete trigger.
      // Tweet text is passed raw — no "you saw this" framing. LLM writes in the user's own voice.
      // Falls back to a topicExample scenario if search fails or Playwright unavailable.
      if (!isNewsDriven && !xCtx.currentEvents?.length) {
        const topic = xCtx.recentTopics[0] ?? postTopics?.[0] ?? ''
        const oppRef = this.personalityProfile?.voiceProfile?.originalPostProfile
        const topicExamples = oppRef?.topicExamples as { scenario: string; post: string }[] | undefined

        let trigger = ''

        // Try live tweet search first
        if (topic && this.xAdapter.playwright) {
          const candidates = await this.xAdapter.playwright.searchTweets(topic, 5).catch(() => [])
          if (candidates.length) {
            const pick = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))]
            trigger = pick.text
          }
        }

        // Fall back to topicExample scenario (try matching, else pick any)
        if (!trigger && topicExamples?.length) {
          const firstWord = topic.toLowerCase().split(' ')[0]
          const matched = topicExamples.find(e => e.scenario.toLowerCase().includes(firstWord))
          const fallback = topicExamples[Math.floor(Math.random() * topicExamples.length)]
          trigger = (matched ?? fallback).scenario
        }

        // Last resort: bare topic
        if (!trigger) trigger = topic

        if (trigger) xCtx.currentEvents = [trigger]
      }

      if (override?.topics?.length) xCtx.recentTopics = override.topics
      if (override?.instruction) xCtx.currentEvents = [override.instruction, ...currentEvents]

      // Decide: quote tweet or original post — based on archive-derived QT ratio
      const qtRatio = bp?.quoteTweetRatio ?? 0
      const isOwner = this.xAccountKey.endsWith('owner-own')
      const doQuoteTweet = isOwner && qtRatio > 0 && Math.random() < qtRatio && this.xAdapter.playwright

      console.log(`[AutonomousActivity] ctx — recentTopics:[${xCtx.recentTopics.join(',')}] currentEvents:${xCtx.currentEvents?.length ?? 0} mode:${isNewsDriven ? 'newsDriven' : 'tweetInspired'}`)

      if (doQuoteTweet && this.xAdapter.playwright) {
        await this.maybeQuoteTweet(xCtx, mood, currentEvents)
      } else {
        const xText = await this.llmEngine.generateAutonomousPost(xCtx)
        if (!xText) {
          console.log('[AutonomousActivity] generateAutonomousPost returned empty — skipping post')
        }
        if (xText) {
          const tweetId = await this.xAdapter.postTweet(xText)
          const topic = xCtx.recentTopics[0] ?? (xCtx.currentEvents?.[0]?.slice(0, 60) ?? 'unknown')
          const acctType = this.xAccountKey.endsWith('owner-own') ? 'owner-own' : 'bot-own'
          this.memory.recordAutonomousPost(tweetId, xText, topic, 'x', acctType)
          this.postIndex?.append({ id: tweetId, text: xText, date: new Date().toISOString(), type: 'autonomous' })
          this.memory.recordPlatformEvent({
            platform: 'x',
            type: 'post_published',
            summary: `posted on x: "${xText.slice(0, 80)}"`,
          })
          this.memory.updateTopicPerformance(this.xAccountKey, extractTopics([xText]))
          console.log(`[AutonomousActivity] Posted on X ${tweetId}: "${xText.slice(0, 60)}..."`)
        }
      }

      // Threads posting disabled — X-only launch. See docs/threads-wiring.md to re-enable.
    } catch {
      // fail silently — never interrupt mention processing
    }
  }

  private async maybeQuoteTweet(ctx: AutonomousPostContext, mood: Mood, currentEvents: string[]): Promise<void> {
    try {
      const pp = this.personalityProfile
      const topics = (pp?.quoteTweetBehavior as any)?.topics?.length
        ? (pp.quoteTweetBehavior as any).topics
        : pp?.postTopics ?? ctx.recentTopics
      // Search for a viral tweet on a random dominant topic
      const topic = topics[Math.floor(Math.random() * topics.length)]
      if (!topic || !this.xAdapter.playwright) return

      const candidates = await this.xAdapter.playwright.searchTweets(topic, 5)
      if (!candidates.length) {
        console.log(`[AutonomousActivity] QT search found nothing for "${topic}" — falling back to original post`)
        const text = await this.llmEngine.generateAutonomousPost(ctx)
        if (text) await this.xAdapter.postTweet(text)
        return
      }

      const pick = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))]
      const comment = await this.llmEngine.generateViralReply(
        { text: pick.text, authorHandle: pick.authorHandle },
        mood,
        false,
        'quoteTweet',
      )
      if (!comment) return

      await this.xAdapter.postQuoteTweet(comment, pick.tweetId)
      this.memory.recordAutonomousPost(pick.tweetId, comment, topic, 'x', 'owner-own')
      this.memory.recordPlatformEvent({
        platform: 'x',
        type: 'post_published',
        summary: `quote tweeted @${pick.authorHandle} on "${topic}": "${comment.slice(0, 60)}"`,
      })
      console.log(`[AutonomousActivity] Quote tweeted @${pick.authorHandle} (topic: ${topic}): "${comment.slice(0, 60)}..."`)
    } catch (err) {
      console.log(`[AutonomousActivity] QT failed: ${err}`)
    }
  }

  private gatherContext(
    mood: Mood,
    currentEvents: string[] = [],
    accountKey: string,
  ): AutonomousPostContext {
    const [platform, accountType] = accountKey.split(':') as [string, 'bot-own' | 'owner-own']
    const repliesToday = this.memory.getDailyUsage()
    const recent = this.memory.getRecentRecords(10)

    let hoursSinceLastMention = 99
    if (recent.length > 0) {
      const lastTs = recent[recent.length - 1].timestamp
      hoursSinceLastMention = Math.round((Date.now() - new Date(lastTs).getTime()) / 3_600_000)
    }

    const recentTopics = extractTopics(recent.map(r => r.mentionText))
    const smartContext = this.memory.getSmartContext(accountKey)

    const recentInteractions: RecentInteraction[] = recent
      .filter(r => r.replyText)
      .map(r => ({
        authorHandle: r.authorHandle,
        mentionText: r.mentionText,
        replyText: r.replyText,
      }))

    return {
      mentionsToday: repliesToday,
      repliesToday,
      hoursSinceLastMention,
      recentTopics,
      mood,
      currentEvents,
      targetPlatform: platform,
      accountType,
      ownerHandle: this.ownerHandle,
      smartContext,
      recentInteractions,
    }
  }
}
