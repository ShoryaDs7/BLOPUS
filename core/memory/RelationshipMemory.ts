/**
 * RelationshipMemory — OsBot's social graph.
 *
 * Every person OsBot ever replies to gets stored here with a score.
 * Score reflects conversation quality — goes up for good exchanges,
 * down for hostile/low-quality ones.
 *
 * When that person shows up again, OsBot pulls their history and
 * treats them accordingly — not as a stranger.
 *
 * Score guide:
 *  > 15  : recurring engaged contact, treat like a familiar face
 *  5–15  : positive history, good engager
 *  1–4   : seen before, neutral
 *  0     : single interaction, no signal
 * < 0    : hostile or low quality, keep brief
 */

import fs from 'fs'
import path from 'path'

export interface UserRelationship {
  handle: string
  score: number
  totalInteractions: number
  conversationCount: number   // separate conversation threads
  firstSeenAt: string
  lastSeenAt: string
  highlights: string[]        // notable moments: "sharp AI debate", "opened with slurs"
}

const HOSTILE_PATTERNS = [
  /\bf+u+c+k+\b/i, /\bs+h+i+t+\b/i, /\ba+s+s+h+o+l+e\b/i,
  /\bstfu\b/i, /\bkys\b/i, /\bidiot\b/i, /\bmoron\b/i, /\bstupid\b/i,
]

const AGREEMENT_SIGNALS = ['exactly', 'agree', 'right', 'true', 'facts', 'valid', 'well said', 'good point', 'fair', 'makes sense']

export class RelationshipMemory {
  private filePath: string
  private data: Record<string, UserRelationship> = {}

  constructor(configPath: string) {
    this.filePath = path.join(
      path.dirname(path.resolve(configPath)),
      '../memory-store/relationships.json',
    )
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      }
    } catch {
      this.data = {}
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2))
    } catch (err) {
      console.warn('[RelationshipMemory] Failed to save:', err)
    }
  }

  /**
   * Score an incoming message using heuristics — no LLM cost, no latency.
   * Called before recording so we know what quality this interaction was.
   */
  scoreInteraction(mentionText: string, convReplyCount: number): number {
    let score = 1 // baseline: they engaged

    // Back and forth — real conversation
    if (convReplyCount > 1) score += convReplyCount - 1

    // Substantive reply
    if (mentionText.length > 150) score += 2
    else if (mentionText.length > 80) score += 1

    // Agreement / positive signal
    const lower = mentionText.toLowerCase()
    if (AGREEMENT_SIGNALS.some(s => lower.includes(s))) score += 1

    // Hostile patterns — heavy penalty
    if (HOSTILE_PATTERNS.some(p => p.test(mentionText))) score -= 7

    // Very short / low effort
    if (mentionText.length < 15) score -= 1

    // ALL CAPS (shouting/aggressive)
    const words = mentionText.split(/\s+/)
    const capsWords = words.filter(w => w.length > 3 && w === w.toUpperCase())
    if (capsWords.length > words.length * 0.5) score -= 2

    return score
  }

  recordInteraction(handle: string, score: number, isNewConversation: boolean = false, highlight?: string): void {
    this.load()
    const h = handle.toLowerCase().replace(/^@/, '')
    const now = new Date().toISOString()

    if (!this.data[h]) {
      this.data[h] = {
        handle: h,
        score: 0,
        totalInteractions: 0,
        conversationCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        highlights: [],
      }
    }

    const rel = this.data[h]
    rel.score += score
    rel.totalInteractions++
    rel.lastSeenAt = now
    if (isNewConversation) rel.conversationCount++
    if (highlight) rel.highlights.push(`[${new Date().toLocaleDateString()}] ${highlight}`)
    // Keep only last 10 highlights
    if (rel.highlights.length > 10) rel.highlights = rel.highlights.slice(-10)

    this.save()
  }

  getRelationship(handle: string): UserRelationship | null {
    this.load()
    const h = handle.toLowerCase().replace(/^@/, '')
    return this.data[h] ?? null
  }

  /**
   * Returns a short context string for injection into the reply prompt.
   * Empty string if this person is new (no prior history).
   */
  getRelationshipContext(handle: string): string {
    const rel = this.getRelationship(handle)
    if (!rel || rel.totalInteractions === 0) return ''

    const h = `@${rel.handle}`

    // Pull actual conversation snippets ("you said:") separately from count summaries
    const snippets = (rel.highlights ?? []).filter(h => h.includes('you said:'))
    const snippetBlock = snippets.length
      ? `\nWhat you actually said to them before:\n${snippets.slice(-3).join('\n')}`
      : ''

    if (rel.score >= 15) {
      return `You know ${h} well — ${rel.conversationCount} conversations, good history. Treat them like a familiar contact.${snippetBlock}`
    }
    if (rel.score >= 5) {
      return `You've had positive exchanges with ${h} before (${rel.totalInteractions} interactions). They engage well — continue that.${snippetBlock}`
    }
    if (rel.score >= 1) {
      return `You've seen ${h} before (${rel.totalInteractions} interactions). No strong signal either way.${snippetBlock}`
    }
    if (rel.score < 0) {
      return `${h} has been hostile or low-quality in past interactions (score: ${rel.score}). Keep your response brief and don't invest.${snippetBlock}`
    }

    return ''
  }

  /**
   * Returns true if this account behaves like a bot:
   * - replies to many conversations but with very high interaction-per-conversation ratio
   *   (e.g. 30 replies across 2 conversations = 15x ratio = spam bot pattern)
   * - OR score went negative fast (hostile/low quality)
   * Used to apply a lower reply cap, same as Grok.
   */
  isBotLike(handle: string): boolean {
    const rel = this.getRelationship(handle)
    if (!rel) return false
    // High replies-per-conversation ratio = replying to everything automatically
    const ratio = rel.conversationCount > 0
      ? rel.totalInteractions / rel.conversationCount
      : rel.totalInteractions
    // ratio >= 4: averages 4+ replies per unique conversation = bot-like spam pattern
    // score < -3: consistently hostile or low quality
    return ratio >= 4 || rel.score < -3
  }

  /** Top relationships by score — for briefings/summaries */
  getTopRelationships(limit: number = 10): UserRelationship[] {
    this.load()
    return Object.values(this.data)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  getStats(): { total: number; positive: number; negative: number; topHandle: string } {
    this.load()
    const all = Object.values(this.data)
    return {
      total: all.length,
      positive: all.filter(r => r.score > 0).length,
      negative: all.filter(r => r.score < 0).length,
      topHandle: all.sort((a, b) => b.score - a.score)[0]?.handle ?? 'none',
    }
  }
}
