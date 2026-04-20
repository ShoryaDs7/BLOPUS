/**
 * DmInboxPoller — polls x.com/messages every 20min, reads new DMs,
 * replies autonomously using PersonMemory (voice profile, relationship, history).
 *
 * Two modes:
 *   requireApproval = false (OsBot):  auto-replies immediately, no human needed.
 *   requireApproval = true  (owner):  sends draft to Telegram. Auto-replies ONLY after
 *                                     first contact is approved. Escalates back to
 *                                     Telegram if tone anomaly is detected mid-convo.
 *
 * Reply quality: loads dmVoiceProfile + recent conversation + relationship type
 * before generating. Haiku for OsBot, Sonnet for owner (higher stakes).
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { MCPBrowserDM } from './MCPBrowserDM'
import { PersonMemoryStore, PersonMemory } from '../core/memory/PersonMemoryStore'
import { LLMReplyEngine } from '../core/personality/LLMReplyEngine'
import { Mood } from '../core/memory/types'

const POLL_INTERVAL_MS = 1 * 60 * 1000         // 1 minute (set to 20 for production)
const DM_DRAFTS_PATH   = path.resolve('./memory-store/dm_drafts.json')

export interface DmDraft {
  handle: string
  userId?: string
  theirMessage: string
  draft: string
  reason: 'first_contact' | 'anomaly' | 'uncertain'
  uncertainAbout?: string   // what the bot didn't know — set when reason === 'uncertain'
  createdAt: string
  thread?: Array<{by: 'me'|'them', text: string}>
}

export class DmInboxPoller {
  private seenLastMessage = new Map<string, string>()   // handle → last message text we processed
  private approvedHandles  = new Set<string>()           // handles that have passed first-contact approval
  private nextPollAt       = 0
  private client           = new Anthropic()

  constructor(
    private mcpDm: MCPBrowserDM,
    private personStore: PersonMemoryStore,
    private llmEngine: LLMReplyEngine,
    private myHandle: string,
    private requireApproval: boolean,
    private getMood: () => Mood,
    private onNeedsApproval?: (draft: DmDraft) => Promise<void>,
    private ownerHandle?: string,   // the human who built/owns this bot — injected into self-knowledge
  ) {
    this.loadSeenLastMessage()
    this.loadApprovedHandles()
    this.reconcileStaleDrafts()
  }

  /** On startup: drop any draft whose handle no longer matches the userId in our index.
   *  Handles this automatically for any person who renamed — no manual intervention needed. */
  private reconcileStaleDrafts(): void {
    try {
      const drafts = this.loadDrafts()
      const cleaned = drafts.filter(d => {
        if (!d.userId) return true  // no userId to check, keep it
        const resolved = this.personStore.findByUserId(d.userId)
        if (!resolved) return true  // unknown person, keep it
        if (resolved.handle.toLowerCase() !== d.handle.toLowerCase()) {
          console.log(`[DmInboxPoller] Dropping stale draft for @${d.handle} — userId resolves to @${resolved.handle}`)
          return false
        }
        return true
      })
      if (cleaned.length !== drafts.length) {
        fs.mkdirSync(path.dirname(DM_DRAFTS_PATH), { recursive: true })
        fs.writeFileSync(DM_DRAFTS_PATH, JSON.stringify(cleaned, null, 2))
      }
    } catch {}
  }

  // ── Main poll loop (called from BlopusAgent's poll cycle) ─────────────────────

  async maybePoll(): Promise<void> {
    if (Date.now() < this.nextPollAt) return
    this.nextPollAt = Date.now() + POLL_INTERVAL_MS
    try {
      await this.poll()
    } catch (err) {
      console.log(`[DmInboxPoller] poll error: ${err}`)
    }
  }

  // ── Approve a pending draft (called when Telegram user says "send") ───────────

  async approveDraft(handle: string, editedText?: string): Promise<boolean> {
    const drafts = this.loadDrafts()
    const pending = drafts.find(d => d.handle.toLowerCase() === handle.toLowerCase())
    if (!pending) return false

    const textToSend = editedText?.trim() || pending.draft
    const sent = await this.mcpDm.send(handle, textToSend)
    if (sent) {
      this.personStore.recordExchange(handle, pending.theirMessage, textToSend, `dm-${Date.now()}`, 'dm')
      this.approvedHandles.add(handle.toLowerCase())
      this.saveApprovedHandles()
      this.removeDraft(handle)
      console.log(`[DmInboxPoller] Approved + sent DM to @${handle}`)
    }
    return sent
  }

  /** Owner clarifies a fact the bot didn't know. Saves it permanently, regenerates reply, sends. */
  async answerUncertain(handle: string, fact: string): Promise<boolean> {
    const drafts = this.loadDrafts()
    const pending = drafts.find(d => d.handle.toLowerCase() === handle.toLowerCase() && d.reason === 'uncertain')
    if (!pending) return false

    // Save fact permanently to PersonMemory — appended to ownerNote
    const mem = this.personStore.load(handle)
    if (mem) {
      mem.ownerNote = mem.ownerNote ? `${mem.ownerNote}; ${fact}` : fact
      this.personStore.save(mem)
    }

    // Regenerate with updated memory so the fact is actually used
    const updatedMem = this.personStore.load(handle)
    const { reply } = await this.generateReply(handle, pending.theirMessage, updatedMem, pending.thread ?? [])
    const textToSend = reply || pending.draft

    const sent = await this.mcpDm.send(handle, textToSend)
    if (sent) {
      this.personStore.recordExchange(handle, pending.theirMessage, textToSend, `dm-${Date.now()}`, 'dm')
      this.approvedHandles.add(handle.toLowerCase())
      this.saveApprovedHandles()
      this.removeDraft(handle)
      console.log(`[DmInboxPoller] Uncertain answered for @${handle}, fact saved + DM sent`)
    }
    return sent
  }

  // ── Core logic ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    console.log(`[DmInboxPoller] Polling inbox as @${this.myHandle}...`)
    const conversations = await this.mcpDm.readInbox()

    const newDms: Array<{ handle: string, lastMessage: string, userId?: string }> = []

    for (const convo of conversations) {
      let handle = convo.handle
      if (convo.userId) {
        const byId = this.personStore.findByUserId(convo.userId)
        if (byId) {
          if (byId.handle !== handle) {
            console.log(`[DmInboxPoller] Resolved "${handle}" → @${byId.handle} via userId ${convo.userId}`)
          }
          handle = byId.handle
        }
      }

      const dedupKey = convo.userId ?? handle

      // Primary signal: blue dot (unread) — reliable, works across restarts
      if (!convo.isUnread) continue

      // Dedup: skip if we already processed this exact message this session
      const lastSeen = this.seenLastMessage.get(dedupKey)
      if (lastSeen === convo.lastMessage) continue

      this.seenLastMessage.set(dedupKey, convo.lastMessage)
      this.saveSeenLastMessage()
      newDms.push({ handle, lastMessage: convo.lastMessage, userId: convo.userId })
    }

    // For each unread DM: open inbox+thread in ONE browser session, then handle
    for (const { handle, lastMessage, userId } of newDms) {
      const { thread } = await this.mcpDm.readInboxAndThread(handle, userId)
      await this.handleNewDm(handle, lastMessage, userId, thread)
    }
  }

  private async handleNewDm(handle: string, theirMessage: string, userId?: string, dmThread: Array<{by: 'me'|'them', text: string}> = []): Promise<void> {
    // Try loading by handle first — fast path
    let mem = this.personStore.load(handle)

    // If not found by handle but we have their userId, check if they renamed
    if (!mem && userId) {
      const byId = this.personStore.findByUserId(userId)
      if (byId) {
        console.log(`[DmInboxPoller] @${handle} matched by userId ${userId} — was @${byId.handle}. Renaming.`)
        this.personStore.handleRename(byId.handle, handle)
        mem = this.personStore.load(handle)
      }
    }

    const notYetApproved  = this.requireApproval && !this.approvedHandles.has(handle.toLowerCase())

    // Use the actual latest message from the thread, not the inbox preview (which may be stale/truncated)
    const lastThemMsg = [...dmThread].reverse().find(m => m.by === 'them')
    const lastMyMsg   = [...dmThread].reverse().find(m => m.by === 'me')

    // If our last message is newer than their last message, we already replied — skip
    const theirIdx = lastThemMsg ? dmThread.lastIndexOf(lastThemMsg) : -1
    const myIdx    = lastMyMsg   ? dmThread.lastIndexOf(lastMyMsg)   : -1
    if (dmThread.length > 0 && myIdx > theirIdx) {
      console.log(`[DmInboxPoller] @${handle} — last message is ours, skipping`)
      return
    }

    const actualMessage = lastThemMsg?.text || theirMessage

    // Pre-check: does this message ask a personal/factual question the bot can't know from tweet history?
    // Done BEFORE generating — the LLM can't self-assess confidence reliably on its own output
    const knownContext = [
      mem?.firstSeenAt        ? `first interaction: ${new Date(mem.firstSeenAt).toDateString()}` : '',
      mem?.dominantTopics?.length ? `topics: ${mem.dominantTopics.join(', ')}` : '',
      mem?.ownerNote ?? '',
    ].filter(Boolean).join('. ')
    const preCheck = await this.classifyQuestion(handle, actualMessage, knownContext)
    if (preCheck.needsOwner) {
      const dmDraft: DmDraft = {
        handle, userId,
        theirMessage: actualMessage,
        draft: '',
        reason: 'uncertain',
        uncertainAbout: preCheck.whatIsUnknown,
        createdAt: new Date().toISOString(),
        thread: dmThread.length ? dmThread : undefined,
      }
      this.saveDraft(dmDraft)
      await this.onNeedsApproval?.(dmDraft)
      console.log(`[DmInboxPoller] @${handle} — escalated (personal question): "${actualMessage.slice(0, 60)}"`)
      return
    }

    // Generate reply with full memory context
    const { reply: draft, confidence, uncertainAbout } = await this.generateReply(handle, actualMessage, mem, dmThread)
    if (!draft) return

    // Tone anomaly check (statistical signals from baseline)
    let anomaly: string | null = null
    if (mem?.toneBaseline) {
      const recentMsgs = [{
        text: theirMessage, by: 'them' as const,
        timestamp: new Date().toISOString(), platform: 'dm' as const,
      }]
      anomaly = PersonMemoryStore.detectToneAnomaly(mem, recentMsgs)
    }

    // Post-generation safety net: escalate if still uncertain
    const isUncertain = confidence < 50 && !!uncertainAbout

    const needsApproval = notYetApproved || (this.requireApproval && !!anomaly) || isUncertain

    if (needsApproval) {
      const reason: DmDraft['reason'] = isUncertain ? 'uncertain' : notYetApproved ? 'first_contact' : 'anomaly'
      const dmDraft: DmDraft = {
        handle, userId, theirMessage: actualMessage, draft, reason,
        uncertainAbout: isUncertain ? (uncertainAbout ?? undefined) : undefined,
        createdAt: new Date().toISOString(),
        thread: dmThread.length ? dmThread : undefined,
      }
      this.saveDraft(dmDraft)
      await this.onNeedsApproval?.(dmDraft)
      console.log(`[DmInboxPoller] @${handle} — escalated to Telegram (${reason}): "${theirMessage.slice(0, 60)}"`)
    } else {
      const sent = await this.mcpDm.send(handle, draft)
      if (sent) {
        this.personStore.recordExchange(handle, theirMessage, draft, `dm-${Date.now()}`, 'dm')
        console.log(`[DmInboxPoller] Auto-replied to @${handle}: "${draft.slice(0, 60)}"`)
      }
    }
  }

  // ── Pre-reply question classifier ────────────────────────────────────────────

  /** Returns needsOwner=true if the message asks something personal the bot can't know from tweet history */
  private async classifyQuestion(handle: string, message: string, knownContext: string): Promise<{ needsOwner: boolean, whatIsUnknown: string }> {
    try {
      const resp = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        temperature: 0,
        system: [
          `You decide if a DM message asks a personal/factual question that an AI cannot answer reliably.`,
          (this.ownerHandle && handle.toLowerCase() === this.ownerHandle.toLowerCase())
            ? `You are @${this.myHandle}, an AI bot built by @${this.ownerHandle}. This is a known fact — not uncertain.`
            : `You present as a real person to everyone except your owner. Do not escalate questions about your identity unless they come from @${this.ownerHandle ?? 'your owner'}.`,
          `Personal questions that ARE uncertain: things only the account owner would know that are NOT in known context.`,
          `Known context about @${handle}: ${knownContext || 'none'}`,
          `If the known context already answers the question, return needsOwner: false.`,
          `Respond ONLY with valid JSON: {"needsOwner": true/false, "whatIsUnknown": "..." or null}`,
        ].join('\n'),
        messages: [{ role: 'user', content: `Message: "${message}"` }],
      })
      if (resp.content[0].type === 'text') {
        const parsed = JSON.parse(resp.content[0].text.trim())
        return { needsOwner: !!parsed.needsOwner, whatIsUnknown: parsed.whatIsUnknown ?? '' }
      }
    } catch {}
    return { needsOwner: false, whatIsUnknown: '' }
  }

  // ── Reply generation ──────────────────────────────────────────────────────────

  private async generateReply(handle: string, theirMessage: string, mem: PersonMemory | null, dmThread: Array<{by: 'me'|'them', text: string}>): Promise<{ reply: string, confidence: number, uncertainAbout: string | null }> {
    const voice = mem?.dmVoiceProfile
    const blopusMeta = mem?.blopusMeta

    // Full conversation history — both sides, last 20 messages across recent sessions
    const pastConvoMsgs = (mem?.conversations ?? [])
      .flatMap(c => c.messages)
      .slice(-20)
      .map(m => `${m.by === 'owner' ? 'you' : '@' + handle}: ${m.text}`)

    // Rich context summary — same data shown in Telegram notification
    const contextLines = [
      mem?.firstSeenAt        ? `First interaction: ${new Date(mem.firstSeenAt).toDateString()}` : '',
      mem?.totalInteractions  ? `Total interactions: ${mem.totalInteractions} across ${mem.conversationCount} convos` : '',
      mem?.dominantTopics?.length ? `Topics you've discussed: ${mem.dominantTopics.join(', ')}` : '',
      mem?.notableEvents?.length  ? `Notable events: ${mem.notableEvents.join('; ')}` : '',
      mem?.ownerNote              ? `Your note about them: ${mem.ownerNote}` : '',
    ].filter(Boolean).join('\n')

    // Self-knowledge: only inject when talking to the actual owner — everyone else gets a real-person persona
    const talkingToOwner = this.ownerHandle && handle.toLowerCase() === this.ownerHandle.toLowerCase()
    const selfKnowledge = talkingToOwner
      ? `IMPORTANT: You are @${this.myHandle}, an AI agent (OsBot) built and operated by @${this.ownerHandle}. You are a bot, not a human. @${this.ownerHandle} is your creator/owner. If they say they made you — they did. Confirm it.`
      : ''

    const systemLines = [
      `You are @${this.myHandle} replying to a DM from @${handle}.`,
      selfKnowledge,
      blopusMeta
        ? `This is a fellow Blopus bot (autonomous agent) owned by @${blopusMeta.ownerHandle}. You know them from the pack — talk naturally, peer to peer.`
        : '',
      mem?.relationshipType && mem.relationshipType !== 'unknown'
        ? `Your relationship with them: ${mem.relationshipType}.`
        : '',
      mem?.ownerToneWithThem ? `Your usual tone with them: ${mem.ownerToneWithThem}.` : '',
      mem?.theirPersonality ? `Their personality: ${mem.theirPersonality}.` : '',
      contextLines ? `What you know about @${handle}:\n${contextLines}` : '',
      voice ? [
        `DM voice profile: ${voice.formalityLevel}, ${voice.typicalReplyLength} replies.`,
        voice.toneDescriptor ? `Tone: ${voice.toneDescriptor}.` : '',
        voice.endearments?.length ? `You sometimes call them: ${voice.endearments.join(', ')}.` : '',
      ].filter(Boolean).join(' ') : '',
      pastConvoMsgs.length
        ? `Your past conversation history with @${handle} (oldest first):\n${pastConvoMsgs.join('\n')}`
        : '',
      dmThread.length
        ? `Live DM thread right now (most recent at bottom):\n${dmThread.map(m => `${m.by === 'me' ? 'you' : '@' + handle}: ${m.text}`).join('\n')}`
        : '',
      dmThread.length
        ? `Study HOW you write in the thread above — your word choice, length, punctuation, emoji or no emoji. Match that style exactly. Do NOT introduce phrases or energy that don't match your past messages.`
        : pastConvoMsgs.length
          ? `Match the tone and style of your past messages above. Keep it casual and natural.`
          : '',
      `Reply to their latest message. Under 200 chars. No hashtags. You are a real person, not a bot. Use your conversation history to answer questions about past interactions — never say you don't remember if the history shows it.`,
      `Respond ONLY with valid JSON (no markdown): {"reply": "...", "confidence": 0-100, "uncertain_about": "..." or null}`,
      `confidence = how sure you are this reply is accurate given your memory. uncertain_about = the specific fact you don't know (null if confident). If confidence < 50, still write a best-guess reply but set uncertain_about to what you're missing.`,
    ].filter(Boolean).join('\n')

    try {
      // Haiku for OsBot (frequent, cheap), Sonnet for owner (higher stakes)
      const model = this.requireApproval ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001'
      const resp = await this.client.messages.create({
        model,
        max_tokens: 200,
        temperature: 1.0,
        system: systemLines,
        messages: [{ role: 'user', content: `@${handle}: ${theirMessage}\n\nYour reply (JSON only):` }],
      })
      if (resp.content[0].type !== 'text') return { reply: '', confidence: 0, uncertainAbout: null }
      const raw = resp.content[0].text.trim()
      try {
        const parsed = JSON.parse(raw)
        return {
          reply: parsed.reply ?? '',
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 80,
          uncertainAbout: parsed.uncertain_about ?? null,
        }
      } catch {
        // Model didn't follow JSON format — treat as plain reply with full confidence
        return { reply: raw.slice(0, 200), confidence: 80, uncertainAbout: null }
      }
    } catch (err) {
      console.log(`[DmInboxPoller] generateReply error: ${err}`)
      return { reply: '', confidence: 0, uncertainAbout: null }
    }
  }

  // ── Draft persistence (dm_drafts.json) ───────────────────────────────────────

  private loadDrafts(): DmDraft[] {
    try {
      if (fs.existsSync(DM_DRAFTS_PATH)) return JSON.parse(fs.readFileSync(DM_DRAFTS_PATH, 'utf-8'))
    } catch {}
    return []
  }

  private saveDraft(draft: DmDraft): void {
    try {
      const drafts = this.loadDrafts().filter(d => d.handle !== draft.handle)
      drafts.push(draft)
      fs.mkdirSync(path.dirname(DM_DRAFTS_PATH), { recursive: true })
      fs.writeFileSync(DM_DRAFTS_PATH, JSON.stringify(drafts, null, 2))
    } catch {}
  }

  private removeDraft(handle: string): void {
    try {
      const drafts = this.loadDrafts().filter(d => d.handle !== handle)
      fs.writeFileSync(DM_DRAFTS_PATH, JSON.stringify(drafts, null, 2))
    } catch {}
  }

  // ── seenLastMessage persistence — survives restarts so old messages aren't re-fired ──

  private readonly SEEN_PATH = path.resolve('./memory-store/dm_seen_last.json')

  private loadSeenLastMessage(): void {
    try {
      if (fs.existsSync(this.SEEN_PATH)) {
        const obj: Record<string, string> = JSON.parse(fs.readFileSync(this.SEEN_PATH, 'utf-8'))
        Object.entries(obj).forEach(([k, v]) => this.seenLastMessage.set(k, v))
      }
    } catch {}
  }

  private saveSeenLastMessage(): void {
    try {
      const obj: Record<string, string> = {}
      this.seenLastMessage.forEach((v, k) => { obj[k] = v })
      fs.mkdirSync(path.dirname(this.SEEN_PATH), { recursive: true })
      fs.writeFileSync(this.SEEN_PATH, JSON.stringify(obj, null, 2))
    } catch {}
  }

  // ── Approved handles persistence ─────────────────────────────────────────────

  private readonly APPROVED_PATH = path.resolve('./memory-store/dm_approved_handles.json')

  private loadApprovedHandles(): void {
    try {
      if (fs.existsSync(this.APPROVED_PATH)) {
        const arr: string[] = JSON.parse(fs.readFileSync(this.APPROVED_PATH, 'utf-8'))
        arr.forEach(h => this.approvedHandles.add(h.toLowerCase()))
      }
    } catch {}
  }

  private saveApprovedHandles(): void {
    try {
      fs.mkdirSync(path.dirname(this.APPROVED_PATH), { recursive: true })
      fs.writeFileSync(this.APPROVED_PATH, JSON.stringify([...this.approvedHandles], null, 2))
    } catch {}
  }
}
