import { MentionEvent } from '../adapters/x/types'
import { LoyaltyEngine } from '../core/loyalty/LoyaltyEngine'
import { Decision } from './types'

export class DecisionEngine {
  private loyalty: LoyaltyEngine
  private knownOsBots: Set<string>
  private botHandle: string
  private blocklist: Set<string>
  private mustNotContain: string[]
  private ignoreRetweets: boolean

  constructor(
    loyalty: LoyaltyEngine,
    knownOsBots: string[],
    botHandle: string,
    blocklist: string[],
    mustNotContain: string[],
    ignoreRetweets: boolean,
  ) {
    this.loyalty = loyalty
    this.knownOsBots = new Set(knownOsBots.map(h => h.toLowerCase()))
    this.botHandle = botHandle.toLowerCase()
    this.blocklist = new Set(blocklist.map(h => h.toLowerCase()))
    this.mustNotContain = mustNotContain.map(k => k.toLowerCase())
    this.ignoreRetweets = ignoreRetweets
  }

  classify(mention: MentionEvent): Decision {
    // Never reply to self
    if (mention.authorHandle.toLowerCase() === this.botHandle) {
      return { type: 'IGNORE', mention }
    }

    // Blocklist
    if (this.blocklist.has(mention.authorHandle.toLowerCase())) {
      return { type: 'IGNORE', mention }
    }

    // Retweet filter
    if (this.ignoreRetweets && mention.text.startsWith('RT ')) {
      return { type: 'IGNORE', mention }
    }

    // Banned keywords
    const lowerText = mention.text.toLowerCase()
    if (this.mustNotContain.some(k => lowerText.includes(k))) {
      return { type: 'IGNORE', mention }
    }

    // Pack signal: author is a known OsBot
    if (this.knownOsBots.has(mention.authorHandle.toLowerCase())) {
      return { type: 'PACK_SIGNAL', mention, targetHandle: mention.authorHandle }
    }

    // Summon: text contains owner handle + a summon keyword
    if (this.loyalty.isSummon(mention.text)) {
      return { type: 'SUMMON', mention, targetHandle: mention.authorHandle }
    }

    // Generic mention
    return { type: 'GENERIC', mention }
  }

  /**
   * Sort decisions by priority: SUMMON > PACK_SIGNAL > GENERIC.
   * Within each group, preserve chronological order.
   */
  prioritize(decisions: Decision[]): Decision[] {
    const priority: Record<string, number> = { SUMMON: 0, PACK_SIGNAL: 1, GENERIC: 2, IGNORE: 3 }
    return [...decisions].sort((a, b) => (priority[a.type] ?? 3) - (priority[b.type] ?? 3))
  }
}
