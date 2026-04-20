/**
 * EngagementEngine — like / retweet / quote-tweet every cycle.
 *
 * Each action has:
 *   - topics: which dominant topics trigger it
 *   - never: content/topics to never act on
 *   - probability: 0.0–1.0 chance of acting when a match is found
 *   - cooldownMs: minimum time between actions
 *
 * Topic matching uses the same keyword logic as the domain filter.
 * No LLM needed for matching — fast and predictable.
 */

import Anthropic from '@anthropic-ai/sdk'
import { XAdapter } from '../adapters/x/XAdapter'
import { PlaywrightDomainSearchProvider } from '../adapters/x/PlaywrightDomainSearchProvider'

interface Candidate {
  id: string
  text: string
  authorHandle: string
  likeCount?: number
}

interface EngagementBehavior {
  topics: string[]      // dominant topics that trigger the action
  never: string[]       // content/topics to never act on
  probability: number   // 0.0–1.0 chance of acting on a match
  cooldownMs: number    // min ms between actions
  enabled: boolean
}

export class EngagementEngine {
  private likedIds     = new Set<string>()
  private retweetedIds = new Set<string>()
  private quotedIds    = new Set<string>()
  private engagedIds   = new Set<string>()  // cross-cycle: any tweet already liked/retweeted/quoted
  private lastLikeRun    = 0
  private lastRetweetRun = 0
  private lastQuoteRun   = 0
  private client: Anthropic | null = null
  private isRunning = false

  private domainSearch = new PlaywrightDomainSearchProvider()

  constructor(
    private xAdapter: XAdapter,
    private ownerHandle: string,
    private likeBehavior?: EngagementBehavior,
    private retweetBehavior?: EngagementBehavior,
    private quoteBehavior?: EngagementBehavior,
    private voiceSynthesized?: string,
    private topicKeywords?: Record<string, string[]>,
  ) {
    if (process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    }
  }

  // ── Fallback search when home timeline has no matching candidates ─
  private async searchFallback(action: string, behavior: EngagementBehavior): Promise<Candidate[]> {
    if (!this.domainSearch.enabled || !behavior.topics.length) return []
    console.log(`[Engagement:${action}] No home candidates — searching by topics: ${behavior.topics.slice(0, 3).join(', ')}...`)
    const results = await this.domainSearch.searchViralByTopics(behavior.topics, 50, 1440)
    console.log(`[Engagement:${action}] Search returned ${results.length} candidates`)
    return results.map(r => ({ id: r.tweetId, text: r.text, authorHandle: r.authorHandle, likeCount: r.likeCount }))
  }

  async run(candidates: Candidate[]): Promise<void> {
    if (this.isRunning) return  // prevent concurrent cycles from doubling up
    this.isRunning = true
    try {
      const fresh = candidates.filter(c => c.authorHandle.toLowerCase() !== this.ownerHandle.toLowerCase())
      const usedThisCycle = new Set<string>()  // each action picks a different tweet
      await this.maybeLike(fresh, usedThisCycle)
      await this.maybeRetweet(fresh, usedThisCycle)
      await this.maybeQuoteTweet(fresh, usedThisCycle)
    } finally {
      this.isRunning = false
    }
  }

  // ── Topic match — uses profile keywords if available, falls back to topic name words ──
  private topicMatch(tweet: string, topics: string[]): boolean {
    const lower = tweet.toLowerCase()
    return topics.some(topic => {
      // Use rich profile keywords if available (same as reply hunter)
      const keywords = this.topicKeywords?.[topic]
      if (keywords?.length) {
        return keywords.some(kw => {
          if (kw.includes(' ')) return lower.includes(kw)
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          return new RegExp(`\\b${escaped}\\b`).test(lower)
        })
      }
      // Fallback: split topic name into 4+ char words
      return topic.toLowerCase().split(/[\s,()\/]+/)
        .filter(w => w.length >= 4)
        .some(w => lower.includes(w))
    })
  }

  private neverMatch(tweet: string, never: string[]): boolean {
    const lower = tweet.toLowerCase()
    return never.some(n => lower.includes(n.toLowerCase()))
  }

  private isEligible(c: Candidate, behavior: EngagementBehavior, seen: Set<string>): boolean {
    if (!behavior.enabled) return false
    if (seen.has(c.id)) return false
    if (this.engagedIds.has(c.id)) return false  // already liked/retweeted/quoted this tweet
    if (this.neverMatch(c.text, behavior.never)) return false
    if (this.neverMatch(c.authorHandle, behavior.never)) return false
    if (!this.topicMatch(c.text, behavior.topics)) return false
    if (Math.random() > behavior.probability) return false
    return true
  }

  // ── LLM topic check — confirms tweet is actually about the topic, not just keyword coincidence ──
  private async isTopicConfirmed(tweet: string, topics: string[]): Promise<boolean> {
    if (!this.client) return true  // no client = skip check, trust keyword match
    try {
      const res = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Is this tweet genuinely about any of these topics: ${topics.slice(0, 3).join(', ')}?
Tweet: "${tweet.slice(0, 280)}"
Answer only YES or NO.`
        }]
      })
      const answer = res.content[0].type === 'text' ? res.content[0].text.trim().toUpperCase() : 'NO'
      return answer.startsWith('YES')
    } catch {
      return true  // on error, don't block
    }
  }

  // ── Like ──────────────────────────────────────────────────────
  private async maybeLike(candidates: Candidate[], used: Set<string>): Promise<void> {
    if (!this.likeBehavior?.enabled) return
    if (Date.now() - this.lastLikeRun < this.likeBehavior.cooldownMs) return

    let pool = candidates.filter(c => !used.has(c.id) && this.isEligible(c, this.likeBehavior!, this.likedIds))
    if (pool.length === 0) {
      const searched = await this.searchFallback('like', this.likeBehavior)
      pool = searched.filter(c => !used.has(c.id) && this.isEligible(c, this.likeBehavior!, this.likedIds))
    }

    for (const c of pool) {
      if (!await this.isTopicConfirmed(c.text, this.likeBehavior.topics)) {
        console.log(`[Engagement:like] Skipped ${c.id} — LLM says not actually on topic`)
        continue
      }
      try {
        await this.xAdapter.likeTweet(c.id)
        this.likedIds.add(c.id)
        this.engagedIds.add(c.id)
        used.add(c.id)
        this.lastLikeRun = Date.now()
        console.log(`[Engagement:like] Liked ${c.id} by @${c.authorHandle}`)
      } catch (e) {
        console.log(`[Engagement:like] Failed: ${e}`)
      }
      break  // 1 per cycle
    }
  }

  // ── Retweet ───────────────────────────────────────────────────
  private async maybeRetweet(candidates: Candidate[], used: Set<string>): Promise<void> {
    if (!this.retweetBehavior?.enabled) return
    if (Date.now() - this.lastRetweetRun < this.retweetBehavior.cooldownMs) return

    let pool = candidates.filter(c => !used.has(c.id) && this.isEligible(c, this.retweetBehavior!, this.retweetedIds))
    if (pool.length === 0) {
      const searched = await this.searchFallback('retweet', this.retweetBehavior)
      pool = searched.filter(c => !used.has(c.id) && this.isEligible(c, this.retweetBehavior!, this.retweetedIds))
    }

    for (const c of pool) {
      if (!await this.isTopicConfirmed(c.text, this.retweetBehavior.topics)) {
        console.log(`[Engagement:retweet] Skipped ${c.id} — LLM says not actually on topic`)
        continue
      }
      try {
        await this.xAdapter.retweetTweet(c.id)
        this.retweetedIds.add(c.id)
        this.engagedIds.add(c.id)
        used.add(c.id)
        this.lastRetweetRun = Date.now()
        console.log(`[Engagement:retweet] Retweeted ${c.id} by @${c.authorHandle}`)
      } catch (e) {
        console.log(`[Engagement:retweet] Failed: ${e}`)
      }
      break  // 1 per cycle
    }
  }

  // ── Quote tweet ───────────────────────────────────────────────
  private async maybeQuoteTweet(candidates: Candidate[], used: Set<string>): Promise<void> {
    if (!this.quoteBehavior?.enabled || !this.client) return
    if (Date.now() - this.lastQuoteRun < this.quoteBehavior.cooldownMs) return

    let pool = candidates.filter(c => !used.has(c.id) && this.isEligible(c, this.quoteBehavior!, this.quotedIds))
    if (pool.length === 0) {
      const searched = await this.searchFallback('quote', this.quoteBehavior)
      pool = searched.filter(c => !used.has(c.id) && this.isEligible(c, this.quoteBehavior!, this.quotedIds))
    }

    for (const c of pool) {
      // Mark immediately before async LLM call — prevents duplicate if cycles overlap
      if (!await this.isTopicConfirmed(c.text, this.quoteBehavior.topics)) {
        this.quotedIds.delete(c.id)
        console.log(`[Engagement:quote] Skipped ${c.id} — LLM says not actually on topic`)
        continue
      }
      used.add(c.id)
      try {
        const res = await this.client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: `You are @${this.ownerHandle} — a real human on X. NOT a bot.
${this.voiceSynthesized ? `Your voice: ${this.voiceSynthesized}` : ''}
Write a short quote tweet comment adding your take. Lowercase, no apostrophes, no emojis, one line max.`,
          messages: [{ role: 'user', content: `Tweet by @${c.authorHandle}: "${c.text}"\n\nYour quote tweet:` }],
        })
        const block = res.content[0]
        if (block.type !== 'text' || !block.text.trim()) continue
        const text = block.text.trim().slice(0, 280)
        await this.xAdapter.postQuoteTweet(text, c.id)
        this.engagedIds.add(c.id)
        this.lastQuoteRun = Date.now()
        console.log(`[Engagement:quote] Quote tweeted ${c.id} by @${c.authorHandle}: "${text.slice(0, 60)}"`)
      } catch (e) {
        this.quotedIds.delete(c.id)  // roll back if post failed
        console.log(`[Engagement:quote] Failed: ${e}`)
      }
      break  // 1 per cycle
    }
  }
}
