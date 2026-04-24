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

      // Archive-derived values win unless user explicitly overrode via Telegram
      const effectiveDailyCap = overrides.maxAutonomousPostsPerDay != null
        ? rc.maxAutonomousPostsPerDay
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
      const postSourceType: string = opp?.postSourceType ?? 'mixed'
      // Only fetch news if user actually posts news-driven content
      const needsNews = ['news-driven', 'mixed', 'opinions-hot-takes'].includes(postSourceType)
      const currentEvents = needsNews ? await this.tavily.fetchCurrentEvents(postTopics) : []

      // Inject personal context from Telegram memory — but only if user actually posts personal content
      // Check their archive's dominant topics for personal/lifestyle signals
      const personalFacts = this.userContext?.getPersonalFacts() ?? []
      const dominantTopics = this.personalityProfile?.dominantTopics ?? []
      const PERSONAL_SIGNALS = ['life', 'personal', 'daily', 'study', 'exam', 'college', 'university', 'health', 'travel', 'family', 'experience']
      const userPostsPersonalContent = dominantTopics.some(t =>
        PERSONAL_SIGNALS.some(s => t.toLowerCase().includes(s))
      )
      const personalContext = (userPostsPersonalContent && personalFacts.length > 0)
        ? personalFacts.map(f => f.text)
        : []

      // Post on X
      const xCtx = this.gatherContext(mood, currentEvents, this.xAccountKey)
      // Weighted topic selection — pick topic based on engagementShare from setup
      if (!override?.topics?.length) {
        const tp = this.personalityProfile?.topicProfiles
        if (tp && Object.keys(tp).length) {
          const entries = Object.entries(tp) as [string, { engagementShare: number }][]
          const total = entries.reduce((s, [, v]) => s + (v.engagementShare ?? 0), 0)
          let rand = Math.random() * (total || 1)
          const picked = entries.find(([, v]) => { rand -= v.engagementShare ?? 0; return rand <= 0 })?.[0] ?? entries[0][0]
          xCtx.recentTopics = [picked]
        }
      }
      if (override?.topics?.length) xCtx.recentTopics = override.topics
      if (override?.instruction) xCtx.currentEvents = [override.instruction, ...currentEvents]
      if (personalContext.length > 0) {
        xCtx.currentEvents = [...personalContext, ...(xCtx.currentEvents ?? [])]
      }

      // Decide: quote tweet or original post — based on archive-derived QT ratio
      const qtRatio = bp?.quoteTweetRatio ?? 0
      const isOwner = this.xAccountKey.endsWith('owner-own')
      const doQuoteTweet = isOwner && qtRatio > 0 && Math.random() < qtRatio && this.xAdapter.playwright

      if (doQuoteTweet && this.xAdapter.playwright) {
        await this.maybeQuoteTweet(xCtx, mood, currentEvents)
      } else {
        const xText = await this.llmEngine.generateAutonomousPost(xCtx)
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
      const topics = pp?.dominantTopics ?? ctx.recentTopics
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
      // Generate QT comment in owner's voice
      const comment = await this.llmEngine.generateViralReply(
        { text: pick.text, authorHandle: pick.authorHandle },
        mood,
        false,
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
