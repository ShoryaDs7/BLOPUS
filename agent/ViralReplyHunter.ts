import { MemoryEngine } from '../core/memory/MemoryEngine'
import { LLMReplyEngine } from '../core/personality/LLMReplyEngine'
import { XAdapter } from '../adapters/x/XAdapter'
import { Mood, TraitVector } from '../core/memory/types'

const MAX_REPLIES_PER_DAY = 20
const MIN_INTERVAL_MINUTES = 5

/**
 * ViralReplyHunter — proactively engages in threads OsBot was already mentioned in.
 *
 * Logic:
 * 1. Every cycle, look at memory records (posts OsBot was mentioned in)
 * 2. Pick 1 root conversation that hasn't been proactively engaged with yet
 * 3. Generate a follow-up reply and post it via Playwright (bypasses X API unsolicited reply ban)
 *
 * These threads are real, already verified, and OsBot already has full context on them.
 */
export class ViralReplyHunter {
  private replyCountToday = 0
  private currentDate = new Date().toDateString()

  constructor(
    private memory: MemoryEngine,
    private llmEngine: LLMReplyEngine,
    private xAdapter: XAdapter,
    private traits: TraitVector,
  ) {}

  async maybeReply(mood: Mood): Promise<void> {
    try {
      this.resetIfNewDay()

      if (this.replyCountToday >= MAX_REPLIES_PER_DAY) {
        console.log('[ViralReplyHunter] Daily cap reached.')
        return
      }

      const lastSearchAt = this.memory.getLastViralSearchAt()
      if (lastSearchAt) {
        const minsSince = (Date.now() - new Date(lastSearchAt).getTime()) / 60_000
        if (minsSince < MIN_INTERVAL_MINUTES) {
          console.log(`[ViralReplyHunter] Cooldown active (${Math.round(minsSince)}/${MIN_INTERVAL_MINUTES} min).`)
          return
        }
      }

      // Get recent memory records — these are threads OsBot was mentioned in
      const records = this.memory.getRecentRecords(50)

      // Pick candidates: unique conversation roots not yet proactively engaged
      // Only consider threads at least 5 minutes old — avoids racing with the mention handler
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
      const seen = new Set<string>()
      const candidates = records.filter(r => {
        if (!r.conversationId || !r.mentionText) return false
        if (seen.has(r.conversationId)) return false
        if (this.memory.hasProactivelyEngaged(r.conversationId)) return false
        if (new Date(r.timestamp).getTime() > fiveMinutesAgo) return false
        seen.add(r.conversationId)
        return true
      })

      this.memory.setLastViralSearchAt()

      if (candidates.length === 0) {
        console.log('[ViralReplyHunter] No new threads to engage with.')
        return
      }

      // Pick 1 at random from the most recent 10
      const pool = candidates.slice(0, 10)
      const pick = pool[Math.floor(Math.random() * pool.length)]

      console.log(`[ViralReplyHunter] Engaging thread ${pick.conversationId} (@${pick.authorHandle})`)

      // Generate a proactive follow-up using the thread context
      const replyText = await this.llmEngine.generateProactiveEngagement(pick, mood)
      if (!replyText) {
        console.log('[ViralReplyHunter] LLM returned empty reply — skipping.')
        return
      }

      // Post via Playwright (not API — X bans unsolicited API replies)
      await this.xAdapter.postAutonomousReply(pick.conversationId, replyText)

      // Mark this conversation as proactively engaged so we don't spam it
      this.memory.markProactivelyEngaged(pick.conversationId)

      this.replyCountToday++
      console.log(`[ViralReplyHunter] Posted to thread ${pick.conversationId}: "${replyText.slice(0, 80)}..."`)
    } catch (err) {
      console.log(`[ViralReplyHunter] Suppressed error: ${err}`)
    }
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.replyCountToday = 0
    }
  }
}
