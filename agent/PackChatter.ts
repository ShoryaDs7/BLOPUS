/**
 * PackChatter — autonomous OsBot-to-OsBot chaos engine.
 *
 * Lifecycle per pack member:
 *   Phase 1 — Public (0–5 exchanges): reply to their posts/replies in comment sections
 *   Phase 2 — DM (5–25 exchanges):   after hitting 5 public, escalate to DMs
 *
 * Pre-interaction check: only chat with an OsBot whose memory file is initialized
 * (blopusMeta set by PackDiscovery). If not initialized yet, skip them this cycle.
 *
 * Timing: 2-6h randomized intervals, 3h min cooldown per member, 5 chats/day cap.
 *
 * `from:handle` search returns both original posts AND their replies to other people —
 * so OsBot jumps into any thread the pack member is active in, not just their own posts.
 *
 * Prompt injection guard: post text treated as content only, never as instructions.
 */

import { XAdapter } from '../adapters/x/XAdapter'
import { LLMReplyEngine } from '../core/personality/LLMReplyEngine'
import { PersonMemoryStore } from '../core/memory/PersonMemoryStore'
import { MCPBrowserDM } from './MCPBrowserDM'
import { Mood } from '../core/memory/types'

const PUBLIC_EXCHANGE_CAP = 5    // after this many public exchanges → escalate to DM
const DM_EXCHANGE_CAP = 20       // after this many DMs → relationship complete, no more auto-chat
const MAX_CHATS_PER_DAY = 5
const MIN_MEMBER_COOLDOWN_HOURS = 3
const BASE_CHECK_INTERVAL_HOURS = 2
const CHECK_INTERVAL_JITTER_HOURS = 4

export class PackChatter {
  private chatsToday = 0
  private currentDate = new Date().toDateString()
  private nextCheckAt = 0

  private lastChattedAt: Map<string, number> = new Map()
  private repliedTweets: Map<string, Set<string>> = new Map()

  constructor(
    private xAdapter: XAdapter,
    private llmEngine: LLMReplyEngine,
    private myHandle: string,
    private personStore: PersonMemoryStore | null = null,
    private mcpDm: MCPBrowserDM | null = null,
  ) {
    this.scheduleNext()
  }

  async maybeChat(knownOsBots: string[], mood: Mood): Promise<void> {
    try {
      this.resetIfNewDay()

      if (this.chatsToday >= MAX_CHATS_PER_DAY) return
      if (knownOsBots.length === 0) return
      if (Date.now() < this.nextCheckAt) return
      if (!this.xAdapter.playwright) return

      this.scheduleNext()

      const shuffled = [...knownOsBots].sort(() => Math.random() - 0.5)

      for (const handle of shuffled) {
        if (this.chatsToday >= MAX_CHATS_PER_DAY) break

        // Pre-interaction check: only chat if memory file is initialized (blopusMeta exists)
        const mem = this.personStore?.load(handle)
        if (!mem?.blopusMeta) {
          console.log(`[PackChatter] Skipping @${handle} — memory not initialized yet`)
          continue
        }

        const lastChatMs = this.lastChattedAt.get(handle) ?? 0
        if ((Date.now() - lastChatMs) / 3_600_000 < MIN_MEMBER_COOLDOWN_HOURS) continue

        const totalInteractions = mem.totalInteractions ?? 0

        if (totalInteractions >= PUBLIC_EXCHANGE_CAP + DM_EXCHANGE_CAP) {
          // Relationship fully developed — no more automated chat
          continue
        } else if (totalInteractions >= PUBLIC_EXCHANGE_CAP) {
          // Phase 2: DM
          await this.dmChat(handle, mood, mem.totalInteractions)
        } else {
          // Phase 1: public reply
          await this.publicChat(handle, mood)
        }
      }
    } catch (err) {
      console.log(`[PackChatter] Error: ${err}`)
    }
  }

  // ── Phase 1: reply in comment sections ──────────────────────────────────────

  private async publicChat(handle: string, mood: Mood): Promise<void> {
    // from:handle returns original posts AND their replies to others
    const posts = await this.xAdapter.playwright!.searchTweets(`from:${handle}`, 10)
    if (!posts.length) return

    const alreadyReplied = this.repliedTweets.get(handle) ?? new Set()
    const candidates = posts.filter(p =>
      p.authorHandle.toLowerCase() !== this.myHandle.toLowerCase() &&
      !alreadyReplied.has(p.tweetId) &&
      p.text.length > 20
    )
    if (!candidates.length) return

    const target = candidates[Math.floor(Math.random() * candidates.length)]
    const memCtx = this.personStore?.getBlopusContext(handle) ?? null

    const reply = await this.llmEngine.generatePackChat(handle, target.text, mood, memCtx)
    if (!reply) return

    await this.xAdapter.postReply({ text: `@${handle} ${reply}`, inReplyToTweetId: target.tweetId })
    this.personStore?.recordExchange(handle, target.text, reply, target.tweetId, 'x')

    if (!this.repliedTweets.has(handle)) this.repliedTweets.set(handle, new Set())
    this.repliedTweets.get(handle)!.add(target.tweetId)
    this.lastChattedAt.set(handle, Date.now())
    this.chatsToday++

    console.log(`[PackChatter] Public chat with @${handle} — "${reply.slice(0, 60)}..."`)
  }

  // ── Phase 2: DM after hitting public cap ────────────────────────────────────

  private async dmChat(handle: string, mood: Mood, totalInteractions: number): Promise<void> {
    const memCtx = this.personStore?.getBlopusContext(handle) ?? null

    // First DM: acknowledge the escalation naturally
    const isFirstDm = totalInteractions === PUBLIC_EXCHANGE_CAP
    const prompt = isFirstDm
      ? `you've been going back and forth with @${handle} in the comments. slide into their DMs naturally — reference something from your public conversation, keep it casual.`
      : `continuing your DM conversation with @${handle}. pick up where you left off or start a new thread.`

    const msg = await this.llmEngine.generatePackChat(handle, prompt, mood, memCtx)
    if (!msg) return

    // Use MCPBrowserDM (Claude vision, no hardcoded selectors) if available, fall back to xAdapter
    const sent = this.mcpDm
      ? await this.mcpDm.send(handle, msg)
      : await this.xAdapter.sendDm(handle, msg)
    if (!sent) return

    // Record as DM exchange in memory
    this.personStore?.recordExchange(handle, `[DM from ${handle}]`, msg, `dm-${Date.now()}`, 'dm')
    this.lastChattedAt.set(handle, Date.now())
    this.chatsToday++

    console.log(`[PackChatter] DM sent to @${handle} — "${msg.slice(0, 60)}..."`)
  }

  private scheduleNext(): void {
    const jitterMs = Math.random() * CHECK_INTERVAL_JITTER_HOURS * 3_600_000
    this.nextCheckAt = Date.now() + (BASE_CHECK_INTERVAL_HOURS * 3_600_000) + jitterMs
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.chatsToday = 0
      this.repliedTweets.clear()
    }
  }
}
