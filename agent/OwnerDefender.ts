/**
 * OwnerDefender — OsBot automatically jumps in when the owner is attacked.
 *
 * No summon needed. Every cycle OsBot scans recent replies on the owner's
 * tweets. If a reply is hostile, OsBot replies defending the owner unprompted.
 *
 * Daily cap: 5 defenses (avoid looking like a bot army)
 * Cooldown: 20 min between checks
 */

import Anthropic from '@anthropic-ai/sdk'
import { XAdapter } from '../adapters/x/XAdapter'
import { LLMReplyEngine } from '../core/personality/LLMReplyEngine'
import { Mood } from '../core/memory/types'

const MAX_DEFENSES_PER_DAY = 5
const CHECK_INTERVAL_MINUTES = 20
const OWNER_TWEETS_TO_SCAN = 5  // check replies on last N owner tweets

export class OwnerDefender {
  private defensesToday = 0
  private currentDate = new Date().toDateString()
  private lastCheckAt = 0
  private defendedTweetIds = new Set<string>()
  private client: Anthropic

  constructor(
    private xAdapter: XAdapter,
    private llmEngine: LLMReplyEngine,
    private ownerHandle: string,
    private botHandle: string,
    private apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey })
  }

  async maybeDefend(mood: Mood): Promise<void> {
    try {
      this.resetIfNewDay()

      if (this.defensesToday >= MAX_DEFENSES_PER_DAY) return

      const minsSince = (Date.now() - this.lastCheckAt) / 60_000
      if (minsSince < CHECK_INTERVAL_MINUTES) return

      this.lastCheckAt = Date.now()

      if (!this.xAdapter.playwright) return

      // Get owner's recent tweets
      const ownerTweets = await this.xAdapter.playwright.searchTweets(`from:${this.ownerHandle}`, OWNER_TWEETS_TO_SCAN)
      if (!ownerTweets.length) return

      for (const tweet of ownerTweets) {
        if (this.defensesToday >= MAX_DEFENSES_PER_DAY) break

        // Get replies to this tweet
        const replies = await this.xAdapter.playwright.searchTweets(`to:${this.ownerHandle}`, 10)
        const freshReplies = replies.filter(r => !this.defendedTweetIds.has(r.tweetId))

        for (const reply of freshReplies) {
          if (reply.authorHandle.toLowerCase() === this.ownerHandle.toLowerCase()) continue
          if (reply.authorHandle.toLowerCase() === this.botHandle.toLowerCase()) continue

          const isHostile = await this.isHostile(reply.text, this.ownerHandle)
          if (!isHostile) continue

          // Generate defense reply
          const defense = await this.llmEngine.generateViralReply(
            { text: reply.text, authorHandle: reply.authorHandle },
            mood,
            false,
          )
          if (!defense) continue

          const defenseText = `@${reply.authorHandle} ${defense}`
          await this.xAdapter.postReply({ text: defenseText, inReplyToTweetId: reply.tweetId })

          this.defendedTweetIds.add(reply.tweetId)
          this.defensesToday++
          console.log(`[OwnerDefender] Defended @${this.ownerHandle} against @${reply.authorHandle}`)

          // One defense per cycle max — don't pile on
          break
        }
      }
    } catch (err) {
      console.log(`[OwnerDefender] Error: ${err}`)
    }
  }

  private async isHostile(text: string, ownerHandle: string): Promise<boolean> {
    try {
      const resp = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',  // cheap, fast
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Is this tweet a direct personal attack, harassment, or hostile insult targeting @${ownerHandle}? Reply only YES or NO.\n\nTweet: "${text}"`,
        }],
      })
      const answer = (resp.content[0] as any).text?.trim().toUpperCase()
      return answer === 'YES'
    } catch {
      return false
    }
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.defensesToday = 0
      this.defendedTweetIds.clear()
    }
  }
}
