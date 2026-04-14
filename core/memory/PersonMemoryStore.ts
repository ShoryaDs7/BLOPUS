/**
 * PersonMemoryStore — deep per-person memory.
 *
 * Every person the owner has ever interacted with gets their own file:
 *   creators/memory-store/persons/{handle}.json
 *
 * Contains the FULL interaction history — every message, both sides,
 * dates, topics, conversation arcs, tone patterns. Nothing omitted.
 *
 * Used by BlopusAgent before generating any reply:
 *   1. Load person file (instant — one small JSON)
 *   2. Inject recent conversation history into Claude's prompt
 *   3. Claude replies knowing exactly who this is and what was said before
 *   4. Save the new exchange back to the file
 *
 * Works for X replies today, DMs when built, any platform — same structure.
 */

import fs from 'fs'
import path from 'path'

export interface Message {
  by: 'owner' | 'them'
  text: string
  timestamp: string
  tweetId?: string
  platform: 'x' | 'dm' | 'discord' | 'reddit'
}

export interface Conversation {
  id: string                // tweetId of the root tweet, or generated UUID for DMs
  startedAt: string
  lastMessageAt: string
  topic: string             // inferred topic (single phrase)
  messages: Message[]
}

export type RelationshipType =
  | 'romantic'       // girlfriend, wife, partner — always review queue, never auto
  | 'family'         // parents, siblings — always review queue
  | 'close_friend'   // people you talk to daily/weekly, personal topics
  | 'professional'   // colleague, client, boss — formal register
  | 'fan'            // follows you, engages but you don't know them personally
  | 'acquaintance'   // met a few times, no deep history
  | 'unknown'        // not enough data yet

export type DmReplyPermission =
  | null        // never asked — show Telegram approval prompt on first DM
  | 'auto'      // reply without asking
  | 'review'    // draft + Telegram approval before sending
  | 'blocked'   // never touch their DMs

export interface ToneBaseline {
  avgMessageLengthChars: number       // their typical message length
  emojiFrequency: number              // emojis per message (0–5+)
  questionFrequency: number           // questions per message (0–3+)
  avgResponseTimeMs: number | null    // how fast they usually reply (null if unknown)
  warmthScore: number                 // 0–1 (inferred from words like "love", "miss", "haha")
  sampledAt: string                   // when baseline was last computed
}

export interface PendingClassification {
  type: RelationshipType
  evidence: string        // Claude's human-readable reasoning, e.g. "you call her 'babe', she says 'miss you ❤️'"
  setAt: string           // ISO timestamp
  confirmed: boolean      // true once owner confirms via Telegram
}

/**
 * If this person is a fellow Blopus bot, this is populated on first pack connection.
 * Lets OsBot know who the other bot's owner is and when they first met.
 */
export interface BlopusMeta {
  ownerHandle: string    // e.g. "shoryaDs7" — the human behind this OsBot
  packId: string         // e.g. "blopus:bbbbbb"
  connectedAt: string    // ISO — when PackDiscovery first linked them
}

export interface PersonMemory {
  handle: string
  userId?: string               // Twitter numeric ID — never changes even if handle changes
  platform: 'x' | 'dm' | 'discord' | 'reddit'

  // Set if this person is a fellow Blopus bot — undefined for regular humans
  blopusMeta?: BlopusMeta

  // Relationship stats
  score: number
  firstSeenAt: string
  lastSeenAt: string
  totalInteractions: number
  conversationCount: number

  // Relationship context
  // NOTE: stays 'unknown' until owner confirms via Telegram.
  // pendingClassification holds Claude's reasoning until then.
  relationshipType: RelationshipType
  pendingClassification: PendingClassification | null   // set by Claude reasoning, awaiting user confirm
  dmReplyPermission: DmReplyPermission
  toneBaseline: ToneBaseline | null   // built from first N DM messages, used for anomaly detection

  // Deep profile — built from all conversations
  theirPersonality: string
  ownerToneWithThem: string      // general tone from public replies
  dominantTopics: string[]
  notableEvents: string[]

  // DM-specific voice — derived ONLY from DM history with this person
  // This is how the owner actually talks to THIS person in private, not how they tweet
  dmVoiceProfile: DmVoiceProfile | null

  // Owner note — set manually via Telegram when no DM history exists
  // e.g. "this is my investor, always formal, no jokes"
  ownerNote: string | null

  // Full conversation log — EVERY exchange, nothing omitted
  conversations: Conversation[]
}

export interface DmVoiceProfile {
  formalityLevel: 'very_casual' | 'casual' | 'neutral' | 'formal' | 'very_formal'
  typicalReplyLength: 'brief' | 'medium' | 'long'       // owner's avg reply chars in DMs
  emojiUsage: 'none' | 'rare' | 'moderate' | 'frequent'
  endearments: string[]                                  // "bro", "babe", "man", etc. owner uses with them
  recurringTopics: string[]                              // what you actually talk about in DMs (not public)
  toneDescriptor: string                                 // "warm and playful", "brief and professional" etc.
  derivedFrom: 'dm_history' | 'owner_told_telegram' | 'comment_history'
  builtAt: string
}

// Simple topic extraction — no LLM needed
const TOPIC_KEYWORDS: Record<string, string[]> = {
  'AI / agents':      ['agent', 'ai', 'llm', 'gpt', 'claude', 'model', 'autonomous', 'chatbot', 'openai'],
  'startups':         ['startup', 'founder', 'ship', 'product', 'launch', 'build', 'mvp', 'saas', 'b2b'],
  'crypto / web3':    ['crypto', 'blockchain', 'eth', 'btc', 'defi', 'nft', 'web3', 'token'],
  'tech / engineering':['code', 'api', 'sdk', 'deploy', 'infra', 'devops', 'typescript', 'python', 'github'],
  'space / science':  ['rocket', 'starship', 'nasa', 'spacex', 'physics', 'quantum', 'nuclear', 'scaling'],
  'geopolitics':      ['war', 'israel', 'russia', 'china', 'ukraine', 'nato', 'policy', 'election'],
  'opinion / debate': ['agree', 'wrong', 'disagree', 'actually', 'think', 'believe', 'argue', 'debate'],
}

function extractTopic(text: string): string {
  const lower = text.toLowerCase()
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return topic
  }
  return 'general'
}

function inferPersonality(theirMessages: Message[]): string {
  if (theirMessages.length === 0) return 'unknown — no messages from them recorded yet'
  const texts = theirMessages.map(m => m.text).join(' ').toLowerCase()
  const traits: string[] = []
  if (theirMessages.length > 10) traits.push('high engagement')
  if (texts.includes('?')) traits.push('asks questions')
  if (/lol|haha|😂|lmao/.test(texts)) traits.push('casual/humorous')
  if (/agree|exactly|fair|valid/.test(texts)) traits.push('agreeable')
  if (/wrong|actually|no,|nah/.test(texts)) traits.push('challenges back')
  if (theirMessages.some(m => m.text.length > 150)) traits.push('writes long replies')
  if (theirMessages.every(m => m.text.length < 40)) traits.push('brief replies only')
  return traits.length ? traits.join(', ') : 'neutral'
}

function inferOwnerTone(ownerMessages: Message[]): string {
  if (ownerMessages.length === 0) return 'no data yet'
  const texts = ownerMessages.map(m => m.text).join(' ').toLowerCase()
  const traits: string[] = []
  if (texts.includes('actually')) traits.push('corrects them')
  if (/agree|fair|valid|right/.test(texts)) traits.push('agrees often')
  if (ownerMessages.some(m => m.text.length > 120)) traits.push('goes deep with them')
  if (ownerMessages.every(m => m.text.length < 50)) traits.push('stays brief')
  if (/lol|haha|hehe/.test(texts)) traits.push('jokes with them')
  if (/bro|man|dude/.test(texts)) traits.push('casual/friendly')
  return traits.length ? traits.join(', ') : 'neutral'
}

export interface PersonIndexEntry {
  handle: string
  userId?: string
  score: number
  topics: string[]
  totalInteractions: number
  firstSeenAt: string
  lastSeenAt: string
  theirPersonality: string
  ownerToneWithThem: string
}

export class PersonMemoryStore {
  private dir: string
  private indexPath: string

  constructor(memoryStoreDir: string) {
    this.dir = path.join(memoryStoreDir, 'persons')
    this.indexPath = path.join(this.dir, '_index.json')
    fs.mkdirSync(this.dir, { recursive: true })
    this.buildIndex()
  }

  private filePath(handle: string): string {
    return path.join(this.dir, `${handle.toLowerCase()}.json`)
  }

  // ── Index management ──────────────────────────────────────────────────────

  private loadIndex(): Record<string, PersonIndexEntry> {
    try {
      if (fs.existsSync(this.indexPath)) {
        return JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      }
    } catch {}
    return {}
  }

  private saveIndex(index: Record<string, PersonIndexEntry>): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2))
  }

  updateIndex(mem: PersonMemory): void {
    const index = this.loadIndex()
    index[mem.handle] = {
      handle: mem.handle,
      userId: mem.userId,
      score: mem.score,
      topics: mem.dominantTopics,
      totalInteractions: mem.totalInteractions,
      firstSeenAt: mem.firstSeenAt,
      lastSeenAt: mem.lastSeenAt,
      theirPersonality: mem.theirPersonality,
      ownerToneWithThem: mem.ownerToneWithThem,
    }
    this.saveIndex(index)
  }

  /** Find a person by their Twitter numeric ID — works even if they changed handle */
  findByUserId(userId: string): PersonMemory | null {
    const index = this.loadIndex()
    const entry = Object.values(index).find(e => e.userId === userId)
    if (!entry) return null
    return this.load(entry.handle)
  }

  /** When a known userId shows up with a new handle — rename their file */
  handleRename(oldHandle: string, newHandle: string): void {
    const oldFile = this.filePath(oldHandle)
    const newFile = this.filePath(newHandle)
    if (!fs.existsSync(oldFile)) return
    const mem = this.load(oldHandle)!
    const oldHandleStr = mem.handle
    mem.handle = newHandle
    mem.notableEvents.push(`renamed from @${oldHandleStr} to @${newHandle} on ${new Date().toDateString()}`)
    fs.writeFileSync(newFile, JSON.stringify(mem, null, 2))
    fs.unlinkSync(oldFile)
    // Update index
    const index = this.loadIndex()
    delete index[oldHandle]
    index[newHandle] = { ...index[oldHandle] ?? {}, handle: newHandle, topics: mem.dominantTopics, score: mem.score, totalInteractions: mem.totalInteractions, firstSeenAt: mem.firstSeenAt, lastSeenAt: mem.lastSeenAt, theirPersonality: mem.theirPersonality, ownerToneWithThem: mem.ownerToneWithThem }
    this.saveIndex(index)
    console.log(`[PersonMemory] Renamed @${oldHandleStr} → @${newHandle}`)
  }

  /** Search across all persons by topic — returns matching handles sorted by interaction count */
  searchByTopic(topic: string): PersonIndexEntry[] {
    const index = this.loadIndex()
    const lower = topic.toLowerCase()
    return Object.values(index).filter(e =>
      e.topics.some(t => t.toLowerCase().includes(lower)) ||
      (e.theirPersonality ?? '').toLowerCase().includes(lower)
    ).sort((a, b) => b.totalInteractions - a.totalInteractions || b.score - a.score)
  }

  /** Search by any keyword across index — handle, personality, topics */
  search(query: string): PersonIndexEntry[] {
    const index = this.loadIndex()
    const lower = query.toLowerCase()
    return Object.values(index).filter(e =>
      e.handle.toLowerCase().includes(lower) ||
      e.topics.some(t => t.toLowerCase().includes(lower)) ||
      (e.theirPersonality ?? '').toLowerCase().includes(lower) ||
      (e.ownerToneWithThem ?? '').toLowerCase().includes(lower)
    ).sort((a, b) => b.score - a.score)
  }

  /** Build index from all existing person files — run once on startup */
  buildIndex(): void {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && f !== '_index.json')
    const index: Record<string, PersonIndexEntry> = {}
    for (const file of files) {
      try {
        const mem = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf-8')) as PersonMemory
        index[mem.handle] = {
          handle: mem.handle,
          userId: mem.userId,
          score: mem.score,
          topics: mem.dominantTopics,
          totalInteractions: mem.totalInteractions,
          firstSeenAt: mem.firstSeenAt,
          lastSeenAt: mem.lastSeenAt,
          theirPersonality: mem.theirPersonality,
          ownerToneWithThem: mem.ownerToneWithThem,
        }
      } catch {}
    }
    this.saveIndex(index)
    console.log(`[PersonMemory] Index built — ${Object.keys(index).length} persons`)
  }

  load(handle: string): PersonMemory | null {
    const fp = this.filePath(handle)
    if (!fs.existsSync(fp)) return null
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as PersonMemory
    } catch {
      return null
    }
  }

  save(mem: PersonMemory): void {
    fs.writeFileSync(this.filePath(mem.handle), JSON.stringify(mem, null, 2))
  }

  /** Called after every live exchange — saves both sides */
  recordExchange(
    handle: string,
    theirText: string,
    ownerReply: string,
    tweetId: string,
    platform: 'x' | 'dm' | 'discord' | 'reddit' = 'x',
  ): void {
    const mem = this.load(handle) ?? this.createEmpty(handle, platform)
    const now = new Date().toISOString()

    // Find or create a conversation for this exchange (within 90 min = same convo)
    const recent = mem.conversations[mem.conversations.length - 1]
    const isNewConv = !recent || (Date.now() - new Date(recent.lastMessageAt).getTime()) > 90 * 60 * 1000

    if (isNewConv) {
      const topic = extractTopic(theirText + ' ' + ownerReply)
      mem.conversations.push({
        id: tweetId,
        startedAt: now,
        lastMessageAt: now,
        topic,
        messages: [
          { by: 'them', text: theirText, timestamp: now, tweetId, platform },
          { by: 'owner', text: ownerReply, timestamp: now, tweetId, platform },
        ],
      })
      mem.conversationCount++
      if (!mem.notableEvents.includes(`first reply ${new Date(mem.firstSeenAt).toDateString()}`)) {
        mem.notableEvents.push(`first reply ${new Date(mem.firstSeenAt).toDateString()}`)
      }
    } else {
      recent.messages.push(
        { by: 'them', text: theirText, timestamp: now, tweetId, platform },
        { by: 'owner', text: ownerReply, timestamp: now, tweetId, platform },
      )
      recent.lastMessageAt = now
      recent.topic = extractTopic(recent.messages.map(m => m.text).join(' '))
    }

    mem.totalInteractions++
    mem.lastSeenAt = now

    // Rebuild derived fields from full history
    const allTheirMessages = mem.conversations.flatMap(c => c.messages.filter(m => m.by === 'them'))
    const allOwnerMessages = mem.conversations.flatMap(c => c.messages.filter(m => m.by === 'owner'))
    mem.theirPersonality = inferPersonality(allTheirMessages)
    mem.ownerToneWithThem = inferOwnerTone(allOwnerMessages)
    mem.dominantTopics = [...new Set(mem.conversations.map(c => c.topic))].slice(0, 5)

    this.save(mem)
    this.updateIndex(mem)
  }

  /**
   * Register a newly discovered OsBot as a known entity.
   * Creates their memory file if it doesn't exist, seeds blopusMeta.
   * Called by PackDiscovery the moment a new pack member is found.
   */
  registerBlopus(handle: string, packId: string, ownerHandle: string): void {
    const existing = this.load(handle)
    const mem: PersonMemory = existing ?? this.createEmpty(handle, 'x')
    mem.blopusMeta = {
      ownerHandle,
      packId,
      connectedAt: existing?.blopusMeta?.connectedAt ?? new Date().toISOString(),
    }
    mem.relationshipType = 'acquaintance'
    if (!mem.notableEvents.includes('pack_connected')) {
      mem.notableEvents.push('pack_connected')
    }
    this.save(mem)
    this.updateIndex(mem)
  }

  /**
   * Get a short context string for an OsBot — injected into chat prompt.
   * Returns null if no memory file exists yet.
   */
  getBlopusContext(handle: string): string | null {
    const mem = this.load(handle)
    if (!mem) return null

    const lines: string[] = []
    if (mem.blopusMeta) {
      lines.push(`@${handle} is a Blopus bot. Their owner is @${mem.blopusMeta.ownerHandle}.`)
      lines.push(`You first connected ${new Date(mem.blopusMeta.connectedAt).toDateString()}.`)
    }
    if (mem.dominantTopics.length > 0) {
      lines.push(`Topics you've discussed: ${mem.dominantTopics.slice(0, 3).join(', ')}.`)
    }

    // Last 3 exchanges for continuity
    const allMessages: { by: string; text: string }[] = []
    for (const conv of mem.conversations.slice(-3)) {
      for (const msg of conv.messages.slice(-4)) {
        allMessages.push({ by: msg.by === 'owner' ? 'you' : `@${handle}`, text: msg.text })
      }
    }
    if (allMessages.length > 0) {
      lines.push('Recent exchanges:')
      allMessages.forEach(m => lines.push(`  ${m.by}: "${m.text.slice(0, 100)}"`)      )
    }

    return lines.join('\n')
  }

  private createEmpty(handle: string, platform: 'x' | 'dm' | 'discord' | 'reddit'): PersonMemory {
    return {
      handle,
      platform,
      score: 0,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      totalInteractions: 0,
      conversationCount: 0,
      relationshipType: 'unknown',
      pendingClassification: null,
      dmReplyPermission: null,
      toneBaseline: null,
      theirPersonality: 'unknown',
      ownerToneWithThem: 'unknown',
      dominantTopics: [],
      notableEvents: [],
      dmVoiceProfile: null,
      ownerNote: null,
      conversations: [],
    }
  }

  // ── Relationship inference ─────────────────────────────────────────────────

  /**
   * Infer relationship type from DM conversation content and frequency.
   * Called during DM archive seed and updated as conversations grow.
   * Never overwrites a manually set relationship type (romantic/family).
   */
  static inferRelationshipType(
    mem: PersonMemory,
    dmMessages: Message[],
  ): RelationshipType {
    // Never downgrade a manually set close relationship
    if (mem.relationshipType === 'romantic' || mem.relationshipType === 'family') {
      return mem.relationshipType
    }

    const allText = dmMessages.map(m => m.text).join(' ').toLowerCase()
    const theirMsgs = dmMessages.filter(m => m.by === 'them')
    const dmConvCount = mem.conversations.filter(c =>
      c.messages.some(m => m.platform === 'dm')
    ).length

    // Need minimum messages before classifying — avoid false positives on tiny samples
    if (dmMessages.length < 5) {
      return mem.totalInteractions <= 3 ? 'fan' : 'unknown'
    }

    // Romantic signals — whole-word / phrase match only, not substring
    // "would love to" / "i'd love to" are NOT romantic — check for standalone "love" as greeting/term
    const romanticPhrases = ['miss you', 'babe', 'baby', 'honey', 'darling',
      'kiss', '❤️', '😘', '🥰', 'girlfriend', 'boyfriend', 'wife', 'husband']
    const hasRomantic = romanticPhrases.some(w => allText.includes(w))
      || /\blove\s+you\b/.test(allText)                          // "love you" but not "would love to"
      || /\bi\s+love\b/.test(allText)                            // "i love"
    if (hasRomantic) return 'romantic'

    // Family signals
    const familyWords = ['mom', 'mum', 'dad', 'papa', 'bhai', 'didi', 'brother',
      'sister', 'beta', 'son', 'daughter', 'uncle', 'auntie', 'family']
    if (familyWords.some(w => allText.includes(w))) return 'family'

    // Close friend — check BEFORE professional (casual language wins if both present)
    const casualWords = ['bro', 'dude', 'lmao', 'haha', 'lol', 'wtf',
      'ngl', 'tbh', 'fr fr', 'irl', 'bruh', 'man ']
    const isCasual = casualWords.some(w => allText.includes(w))
    if (isCasual && theirMsgs.length >= 4) return 'close_friend'

    // Professional: formal register — only if no casual signals
    const formalWords = ['regards', 'kindly', 'please find', 'sir', 'ma\'am',
      'partnership', 'opportunity', 'proposal', 'contract', 'invoice', 'term sheet',
      'attached', 'at your convenience', 'revert', 'eod', 'availability']
    if (formalWords.some(w => allText.includes(w))) return 'professional'

    // Fan: one-directional, few interactions
    if (mem.totalInteractions <= 5 && theirMsgs.length > 0) return 'fan'

    // Some DM history but no strong signal
    if (dmConvCount >= 1) return 'acquaintance'

    return 'unknown'
  }

  // ── Tone baseline ──────────────────────────────────────────────────────────

  /**
   * Compute tone baseline from their DM messages.
   * Call after archive seed, update periodically as more messages come in.
   */
  static computeToneBaseline(theirDmMessages: Message[]): ToneBaseline | null {
    if (theirDmMessages.length < 3) return null   // need min 3 messages

    const texts = theirDmMessages.map(m => m.text)
    const totalChars = texts.reduce((sum, t) => sum + t.length, 0)
    const totalEmojis = texts.reduce((sum, t) =>
      sum + (t.match(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu) ?? []).length, 0
    )
    const totalQuestions = texts.reduce((sum, t) => sum + (t.split('?').length - 1), 0)

    const warmthWords = ['love', 'miss', 'haha', 'lol', 'lmao', '❤', '😊', '😂',
      'amazing', 'great', 'awesome', 'thanks', 'thank you', 'appreciate']
    const warmthHits = texts.filter(t =>
      warmthWords.some(w => t.toLowerCase().includes(w))
    ).length

    return {
      avgMessageLengthChars: Math.round(totalChars / texts.length),
      emojiFrequency: parseFloat((totalEmojis / texts.length).toFixed(2)),
      questionFrequency: parseFloat((totalQuestions / texts.length).toFixed(2)),
      avgResponseTimeMs: null,    // populated by live DM adapter once we have timestamps
      warmthScore: parseFloat((warmthHits / texts.length).toFixed(2)),
      sampledAt: new Date().toISOString(),
    }
  }

  /**
   * Build DM voice profile from owner's DM messages to this person ONLY.
   * This captures how the owner actually talks in private — not their public tweet voice.
   * An investor gets formal short replies. A girlfriend gets warm casual long ones.
   * Used to tune OsBot's reply style per-person in DMs.
   */
  static buildDmVoiceProfile(ownerDmMessages: Message[]): DmVoiceProfile | null {
    if (ownerDmMessages.length < 2) return null

    const texts = ownerDmMessages.map(m => m.text)
    const allText = texts.join(' ').toLowerCase()
    const avgLen = texts.reduce((s, t) => s + t.length, 0) / texts.length

    // Formality
    const veryFormalWords = ['regards', 'sincerely', 'dear', 'please find', 'kindly', 'sir', 'ma\'am']
    const formalWords = ['please', 'would you', 'could you', 'appreciate', 'thank you', 'opportunity']
    const casualWords = ['bro', 'dude', 'man ', 'yo ', 'nah', 'yeah', 'tbh', 'ngl', 'lol', 'lmao', 'wtf', 'haha']
    const veryCasualWords = ['bruh', 'fr fr', 'no cap', 'lowkey', 'highkey', 'fam', 'bro 💀']

    let formalityLevel: DmVoiceProfile['formalityLevel'] = 'neutral'
    if (veryFormalWords.some(w => allText.includes(w))) formalityLevel = 'very_formal'
    else if (formalWords.some(w => allText.includes(w)) && !casualWords.some(w => allText.includes(w))) formalityLevel = 'formal'
    else if (veryCasualWords.some(w => allText.includes(w))) formalityLevel = 'very_casual'
    else if (casualWords.some(w => allText.includes(w))) formalityLevel = 'casual'

    // Reply length
    const typicalReplyLength: DmVoiceProfile['typicalReplyLength'] =
      avgLen < 40 ? 'brief' : avgLen < 120 ? 'medium' : 'long'

    // Emoji usage
    const totalEmojis = texts.reduce((s, t) =>
      s + (t.match(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu) ?? []).length, 0
    )
    const emojiPerMsg = totalEmojis / texts.length
    const emojiUsage: DmVoiceProfile['emojiUsage'] =
      emojiPerMsg === 0 ? 'none' : emojiPerMsg < 0.5 ? 'rare' : emojiPerMsg < 2 ? 'moderate' : 'frequent'

    // Endearments — words owner uses to address this person
    const endearmentPatterns = ['bro', 'babe', 'baby', 'man ', 'dude', 'yaar', 'boss', 'buddy',
      'love', 'honey', 'darling', 'sir', 'hey ', 'mate']
    const endearments = endearmentPatterns.filter(w => allText.includes(w))
      .map(w => w.trim())
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 5)

    // Topics from DM conversations specifically
    const recurringTopics = [...new Set(
      ownerDmMessages.map(m => extractTopic(m.text))
    )].filter(t => t !== 'general').slice(0, 4)

    // Tone descriptor — human readable
    const warmWords = ['love', 'miss', 'care', 'haha', 'lol', '❤', '😊']
    const isWarm = warmWords.some(w => allText.includes(w))
    const isPlayful = /lol|lmao|haha|😂|😅|💀/.test(allText)
    const isSerious = avgLen > 100 && !isPlayful

    let toneDescriptor = formalityLevel === 'formal' || formalityLevel === 'very_formal'
      ? 'professional and concise'
      : isWarm && isPlayful ? 'warm and playful'
      : isWarm ? 'warm and caring'
      : isPlayful ? 'casual and funny'
      : isSerious ? 'thoughtful and direct'
      : 'casual and friendly'

    return {
      formalityLevel,
      typicalReplyLength,
      emojiUsage,
      endearments,
      recurringTopics,
      toneDescriptor,
      derivedFrom: 'dm_history',
      builtAt: new Date().toISOString(),
    }
  }

  /**
   * Build a fallback DM voice profile from comment history when no DMs exist.
   * Less accurate than DM history but better than nothing.
   */
  static buildVoiceFromComments(ownerCommentMessages: Message[]): DmVoiceProfile | null {
    const profile = PersonMemoryStore.buildDmVoiceProfile(ownerCommentMessages)
    if (!profile) return null
    return { ...profile, derivedFrom: 'comment_history' }
  }

  /**
   * Check current session messages against baseline — statistical signals only.
   * Returns raw signal data. The actual escalation judgment is done by Claude
   * in checkEscalation() below — not by keyword rules.
   */
  static detectToneAnomaly(
    mem: PersonMemory,
    recentMessages: Message[],
  ): string | null {
    const baseline = mem.toneBaseline
    if (!baseline || recentMessages.length < 2) return null

    const texts = recentMessages.map(m => m.text)
    const avgLen = texts.reduce((s, t) => s + t.length, 0) / texts.length
    const avgQ = texts.reduce((s, t) => s + (t.split('?').length - 1), 0) / texts.length

    const signals: string[] = []

    if (baseline.avgMessageLengthChars > 20 && avgLen < baseline.avgMessageLengthChars * 0.4) {
      signals.push(`replies 60%+ shorter than usual (${Math.round(avgLen)} chars vs baseline ${baseline.avgMessageLengthChars})`)
    }
    if (baseline.questionFrequency > 0.3 && avgQ === 0 && recentMessages.length >= 3) {
      signals.push(`no questions this session (baseline: ${baseline.questionFrequency.toFixed(1)}/msg)`)
    }
    const warmthWords = ['love', 'miss', 'haha', 'lol', 'lmao', '❤', '😊', '😂', 'amazing', 'great']
    const currentWarmth = texts.filter(t =>
      warmthWords.some(w => t.toLowerCase().includes(w))
    ).length / texts.length
    if (baseline.warmthScore > 0.3 && currentWarmth === 0 && recentMessages.length >= 3) {
      signals.push(`warmth dropped to 0 (baseline: ${baseline.warmthScore})`)
    }

    if (signals.length === 0) return null
    const rType = mem.relationshipType !== 'unknown' ? ` (${mem.relationshipType})` : ''
    return `⚠️ @${mem.handle}${rType}: ${signals.join(', ')}`
  }

  /**
   * Reasoning-based escalation check — uses Claude to read the actual conversation
   * and judge whether something is emotionally wrong. Not keyword matching.
   *
   * Returns null if all fine, or a human explanation of what feels off.
   * Caller is responsible for pausing auto-replies and alerting Telegram.
   *
   * Call AFTER each DM exchange when relationship is romantic, family, or close_friend.
   */
  static async checkEscalation(
    mem: PersonMemory,
    recentSession: Message[],
    anthropicApiKey: string,
  ): Promise<string | null> {
    if (recentSession.length < 3) return null
    if (!['romantic', 'family', 'close_friend'].includes(mem.relationshipType)) return null

    // Build the conversation text for Claude to reason about
    const convoText = recentSession.map(m => {
      const who = m.by === 'owner' ? 'Owner' : `@${mem.handle}`
      return `${who}: ${m.text}`
    }).join('\n')

    // Pull last 2 previous sessions for baseline comparison
    const prevSessions = mem.conversations.slice(-3, -1)
    const prevText = prevSessions.flatMap(c => c.messages).map(m => {
      const who = m.by === 'owner' ? 'Owner' : `@${mem.handle}`
      return `${who}: ${m.text}`
    }).join('\n')

    const Anthropic = require('@anthropic-ai/sdk').default
    const client = new Anthropic({ apiKey: anthropicApiKey })

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are reading a private DM conversation to check if anything feels emotionally off.

Relationship: ${mem.relationshipType}
Person: @${mem.handle}

Previous conversations (baseline):
${prevText || '(no previous history)'}

Current session:
${convoText}

Question: Does anything in the current session feel emotionally concerning compared to baseline?
Think like a person who knows both sides well. Consider: Is someone pulling away? Is there tension? Does a message feel passive-aggressive or hurt? Is someone avoiding something?

Reply with ONLY:
- "fine" if nothing concerning
- One sentence explaining what feels off (no preamble, just the observation)`,
      }],
    })

    const result = (response.content[0] as any).text?.trim()
    if (!result || result.toLowerCase().startsWith('fine')) return null

    return `⚠️ @${mem.handle} (${mem.relationshipType}): ${result}\n\nI've finished this reply but I'm holding the next one — you should look at this.`
  }

  /**
   * Seed from Twitter archive — builds full person files for everyone in history.
   * Stores owner's full reply text + the tweet ID they replied to (both sides
   * captured live going forward; archive only has owner's side).
   */
  seedFromArchive(tweetsJsPath: string): { seeded: number; skipped: number } {
    if (!fs.existsSync(tweetsJsPath)) {
      console.log('[PersonMemory] Archive not found:', tweetsJsPath)
      return { seeded: 0, skipped: 0 }
    }

    // Skip if already seeded this archive version
    const flagPath = path.join(this.dir, '.seed_hash')
    const stat = fs.statSync(tweetsJsPath)
    const hash = `${stat.size}-${stat.mtimeMs}`
    if (fs.existsSync(flagPath) && fs.readFileSync(flagPath, 'utf-8') === hash) {
      return { seeded: 0, skipped: 0 }
    }

    console.log('[PersonMemory] Seeding per-person memory from archive...')

    const raw = fs.readFileSync(tweetsJsPath, 'utf-8')
      .replace(/^window\.YTD\.tweets\.part0\s*=\s*/, '')
    const tweets: any[] = JSON.parse(raw).map((t: any) => t.tweet)

    // Only process replies — these have the person's handle
    const replies = tweets.filter(t =>
      t.in_reply_to_screen_name && t.in_reply_to_screen_name.trim() !== ''
    )

    // Group by handle, also track userId per handle
    const byHandle: Record<string, any[]> = {}
    const handleToUserId: Record<string, string> = {}
    for (const t of replies) {
      const h = t.in_reply_to_screen_name.toLowerCase().replace(/^@/, '')
      if (!byHandle[h]) byHandle[h] = []
      byHandle[h].push(t)
      if (t.in_reply_to_user_id_str) handleToUserId[h] = t.in_reply_to_user_id_str
    }

    let seeded = 0
    let skipped = 0

    for (const [handle, handleReplies] of Object.entries(byHandle)) {
      // Skip if already has full conversation data (has conversations array with messages)
      const existing = this.load(handle)
      if (existing?.conversations?.some(c => c.messages.length > 0)) {
        skipped++
        continue
      }

      const sorted = [...handleReplies].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )

      const mem: PersonMemory = existing ?? this.createEmpty(handle, 'x')
      mem.firstSeenAt = sorted[0].created_at
      mem.lastSeenAt = sorted[sorted.length - 1].created_at
      mem.totalInteractions = sorted.length
      if (handleToUserId[handle]) mem.userId = handleToUserId[handle]

      // Group into conversations (90 min window)
      const conversations: Conversation[] = []
      let currentConv: Conversation | null = null

      for (const t of sorted) {
        const date = new Date(t.created_at)
        const text = (t.full_text ?? '')
          .replace(/^(@\w+\s*)+/, '')       // strip leading @handles
          .replace(/https:\/\/t\.co\/\S+/g, '') // strip t.co links
          .trim()

        const isNewConv = !currentConv ||
          (date.getTime() - new Date(currentConv.lastMessageAt).getTime()) > 90 * 60 * 1000

        if (isNewConv) {
          currentConv = {
            id: t.in_reply_to_status_id_str ?? t.id_str,
            startedAt: date.toISOString(),
            lastMessageAt: date.toISOString(),
            topic: extractTopic(text),
            messages: [],
          }
          conversations.push(currentConv)
        }

        // Owner's message — full text from archive
        currentConv!.messages.push({
          by: 'owner',
          text,
          timestamp: date.toISOString(),
          tweetId: t.id_str,
          platform: 'x',
        })
        // Note: other person's messages not available in archive —
        // captured live going forward in recordExchange()
        currentConv!.lastMessageAt = date.toISOString()
        currentConv!.topic = extractTopic(
          currentConv!.messages.map(m => m.text).join(' ')
        )
      }

      mem.conversations = conversations
      mem.conversationCount = conversations.length

      // Derive profile from full history
      const allOwnerMessages = conversations.flatMap(c => c.messages.filter(m => m.by === 'owner'))
      mem.ownerToneWithThem = inferOwnerTone(allOwnerMessages)
      mem.dominantTopics = [...new Set(conversations.map(c => c.topic))].slice(0, 5)

      const firstDate = new Date(sorted[0].created_at)
      const lastDate = new Date(sorted[sorted.length - 1].created_at)
      mem.notableEvents = [
        `first interaction: ${firstDate.toDateString()}`,
        sorted.length > 5 ? `${sorted.length} exchanges across ${conversations.length} conversations` : '',
        conversations.length > 3 ? `recurring contact since ${firstDate.toLocaleString('default', { month: 'short', year: 'numeric' })}` : '',
      ].filter(Boolean)

      this.save(mem)
      seeded++
    }

    fs.writeFileSync(flagPath, hash)
    console.log(`[PersonMemory] Done — seeded ${seeded} person files, skipped ${skipped} already done`)
    this.buildIndex()
    return { seeded, skipped }
  }

  /**
   * Seed from X DM archive (direct-messages.js).
   *
   * The DM archive contains BOTH sides of every conversation — sender_id tells
   * you who sent each message. ownerUserId is needed to split "owner" vs "them".
   *
   * Merges into existing person files (same handle = same file, cross-channel linking
   * is automatic). DM messages are stored with platform: 'dm' so they're distinguishable
   * from public tweet exchanges.
   */
  seedFromDMArchive(
    dmJsPath: string,
    ownerUserId: string,
    ownerHandle: string,
  ): { seeded: number; skipped: number; persons: string[] } {
    if (!fs.existsSync(dmJsPath)) {
      console.log('[PersonMemory] DM archive not found:', dmJsPath)
      return { seeded: 0, skipped: 0, persons: [] }
    }

    const flagPath = path.join(this.dir, '.dm_seed_hash')
    const stat = fs.statSync(dmJsPath)
    const hash = `${stat.size}-${stat.mtimeMs}`
    if (fs.existsSync(flagPath) && fs.readFileSync(flagPath, 'utf-8') === hash) {
      console.log('[PersonMemory] DM archive already seeded — skipping')
      return { seeded: 0, skipped: 0, persons: [] }
    }

    console.log('[PersonMemory] Seeding DM history from archive...')

    const raw = fs.readFileSync(dmJsPath, 'utf-8')
      .replace(/^window\.YTD\.direct_messages\.part0\s*=\s*/, '')
      .replace(/^window\.YTD\.direct_messages_group\.part0\s*=\s*/, '')
    const conversations: any[] = JSON.parse(raw)

    let seeded = 0
    let skipped = 0
    const persons: string[] = []

    for (const entry of conversations) {
      const conv = entry.dmConversation
      if (!conv?.messages?.length) continue

      // conversationId format: "ownerUserId-otherUserId" for 1:1
      // Skip group DMs (more than 2 participants in the ID)
      const convId: string = conv.conversationId ?? ''
      const parts = convId.split('-')
      if (parts.length !== 2) continue  // group DM — skip for now

      const otherUserId = parts.find((p: string) => p !== ownerUserId)
      if (!otherUserId) continue

      // Parse messages — both sides
      const rawMessages: any[] = conv.messages
        .map((m: any) => m.messageCreate)
        .filter(Boolean)
        .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

      if (rawMessages.length === 0) continue

      // We know userId but not handle — use userId as temp handle, resolve later
      // If we already have this userId in index, use their handle
      const existingByUserId = this.findByUserId(otherUserId)
      const handle = existingByUserId?.handle ?? `user_${otherUserId}`

      const mem = this.load(handle) ?? this.createEmpty(handle, 'dm')
      if (!mem.userId) mem.userId = otherUserId

      // Build DM conversation — group into sessions (2hr gap = new session)
      const dmMessages: Message[] = rawMessages.map((m: any) => ({
        by: m.senderId === ownerUserId ? 'owner' : 'them' as 'owner' | 'them',
        text: (m.text ?? '').trim(),
        timestamp: new Date(m.createdAt).toISOString(),
        tweetId: m.id,
        platform: 'dm' as const,
      })).filter((m: Message) => m.text.length > 0)

      if (dmMessages.length === 0) { skipped++; continue }

      // Group into conversation sessions
      const sessions: Conversation[] = []
      let currentSession: Conversation | null = null
      const SESSION_GAP_MS = 2 * 60 * 60 * 1000

      for (const msg of dmMessages) {
        const msgTime = new Date(msg.timestamp).getTime()
        const isNew = !currentSession ||
          (msgTime - new Date(currentSession.lastMessageAt).getTime()) > SESSION_GAP_MS

        if (isNew) {
          currentSession = {
            id: `dm-${otherUserId}-${msg.tweetId}`,
            startedAt: msg.timestamp,
            lastMessageAt: msg.timestamp,
            topic: extractTopic(msg.text),
            messages: [],
          }
          sessions.push(currentSession)
        }
        currentSession!.messages.push(msg)
        currentSession!.lastMessageAt = msg.timestamp
        currentSession!.topic = extractTopic(
          currentSession!.messages.map(m => m.text).join(' ')
        )
      }

      // Merge sessions into existing conversations (avoid duplicates by id prefix)
      const existingDmIds = new Set(mem.conversations.map(c => c.id))
      const newSessions = sessions.filter(s => !existingDmIds.has(s.id))
      mem.conversations = [...mem.conversations, ...newSessions].sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
      )
      mem.conversationCount = mem.conversations.length

      // Update stats
      const firstMsg = dmMessages[0]
      const lastMsg = dmMessages[dmMessages.length - 1]
      if (!mem.firstSeenAt || new Date(firstMsg.timestamp) < new Date(mem.firstSeenAt)) {
        mem.firstSeenAt = firstMsg.timestamp
      }
      if (!mem.lastSeenAt || new Date(lastMsg.timestamp) > new Date(mem.lastSeenAt)) {
        mem.lastSeenAt = lastMsg.timestamp
      }
      mem.totalInteractions += dmMessages.length

      // Rebuild derived fields
      const allTheirMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.by === 'them'))
      const allOwnerMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.by === 'owner'))
      mem.theirPersonality = inferPersonality(allTheirMsgs)
      mem.ownerToneWithThem = inferOwnerTone(allOwnerMsgs)
      mem.dominantTopics = [...new Set(mem.conversations.map(c => c.topic))].slice(0, 5)

      // Relationship type is left as 'unknown' — Claude reasoning + Telegram confirmation
      // happens in FullArchiveIngestor after all contacts are seeded.
      const allDmMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.platform === 'dm'))

      // Compute tone baseline from their DM messages
      const theirDmMsgs = allDmMsgs.filter(m => m.by === 'them')
      const baseline = PersonMemoryStore.computeToneBaseline(theirDmMsgs)
      if (baseline) mem.toneBaseline = baseline

      // Build DM voice profile — how owner talks to THIS person in DMs specifically
      const ownerDmMsgs = allDmMsgs.filter(m => m.by === 'owner')
      const dmVoice = PersonMemoryStore.buildDmVoiceProfile(ownerDmMsgs)
      if (dmVoice) mem.dmVoiceProfile = dmVoice

      // Notable events
      if (!mem.notableEvents.some(e => e.includes('DM'))) {
        mem.notableEvents.push(
          `first DM: ${new Date(firstMsg.timestamp).toDateString()}`,
          `${dmMessages.length} DM messages across ${sessions.length} sessions`,
        )
      }

      this.save(mem)
      this.updateIndex(mem)
      persons.push(handle)
      seeded++
    }

    fs.writeFileSync(flagPath, hash)
    console.log(`[PersonMemory] DM seed done — ${seeded} persons, ${skipped} skipped`)
    this.buildIndex()
    return { seeded, skipped, persons }
  }

  /**
   * Voice instructions for DM replies — tells OsBot exactly how to talk to this person.
   * Derived from DM history only. Falls back to comment history, then ownerNote.
   * Called before generating any DM reply.
   */
  getDmVoiceInstructions(handle: string): string {
    const mem = this.load(handle)
    if (!mem) return ''

    const lines: string[] = []

    if (mem.ownerNote) {
      lines.push(`Owner note about @${handle}: ${mem.ownerNote}`)
    }

    const profile = mem.dmVoiceProfile
    if (profile) {
      const source = profile.derivedFrom === 'dm_history'
        ? 'from your DM history with them'
        : profile.derivedFrom === 'comment_history'
          ? 'estimated from public comment history (no DMs yet)'
          : 'as told to Telegram'

      lines.push(`How you talk to @${handle} in DMs (${source}):`)
      lines.push(`  Tone: ${profile.toneDescriptor}`)
      lines.push(`  Formality: ${profile.formalityLevel}`)
      lines.push(`  Your reply length: ${profile.typicalReplyLength}`)
      lines.push(`  Emojis: ${profile.emojiUsage}`)
      if (profile.endearments.length) lines.push(`  You call them: ${profile.endearments.join(', ')}`)
      if (profile.recurringTopics.length) lines.push(`  DM topics: ${profile.recurringTopics.join(', ')}`)
    }

    if (mem.relationshipType !== 'unknown') {
      lines.push(`  Relationship: ${mem.relationshipType} — match that register, not your public tweet voice`)
    }

    return lines.join('\n')
  }

  /**
   * Full context block for Claude — aware of DM vs comment history separately.
   * Pass channel='dm' when replying to a DM, channel='x' for public replies.
   */
  getContextForClaude(handle: string, maxConversations = 5, channel: 'x' | 'dm' = 'x'): string {
    const mem = this.load(handle)
    if (!mem || mem.conversations.length === 0) return ''

    const theyEverReplied = mem.conversations.some(c => c.messages.some(m => m.by === 'them'))
    const dmConvs = mem.conversations.filter(c => c.messages.some(m => m.platform === 'dm'))
    const publicConvs = mem.conversations.filter(c => c.messages.some(m => m.platform === 'x'))
    const hasDMs = dmConvs.length > 0

    const lines: string[] = []
    lines.push(`=== Your history with @${handle} ===`)
    lines.push(`First seen: ${new Date(mem.firstSeenAt).toDateString()}`)
    if (mem.relationshipType !== 'unknown') lines.push(`Relationship: ${mem.relationshipType}`)
    if (mem.ownerNote) lines.push(`Your note: ${mem.ownerNote}`)
    if (hasDMs) {
      const dmMsgCount = dmConvs.flatMap(c => c.messages).length
      lines.push(`DM history: ${dmMsgCount} messages across ${dmConvs.length} sessions`)
    }
    if (publicConvs.length > 0) {
      lines.push(`Public X history: ${publicConvs.length} conversations`)
    }

    if (!theyEverReplied) {
      lines.push(`Relationship: ONE-SIDED — you have replied to their tweets ${mem.totalInteractions} time(s) but they have NEVER replied back to you.`)
      lines.push(`Topics you tweeted at them about: ${mem.dominantTopics.join(', ')}`)
      lines.push('\nYour replies to their tweets (they never responded):')
      const recent = mem.conversations.slice(-maxConversations)
      for (const conv of recent) {
        const date = new Date(conv.startedAt).toDateString()
        lines.push(`\n[${date} — topic: ${conv.topic}]`)
        for (const msg of conv.messages.slice(-4)) {
          lines.push(`  You replied: "${msg.text.slice(0, 120)}"`)
        }
      }
    } else {
      lines.push(`Total exchanges: ${mem.totalInteractions} across ${mem.conversationCount} conversations`)
      if (mem.dominantTopics.length) lines.push(`Topics you discuss: ${mem.dominantTopics.join(', ')}`)
      if (mem.theirPersonality !== 'unknown') lines.push(`Their personality: ${mem.theirPersonality}`)
      if (mem.ownerToneWithThem !== 'unknown') lines.push(`How you talk to them publicly: ${mem.ownerToneWithThem}`)
      if (mem.notableEvents.length) lines.push(`Notable: ${mem.notableEvents.join('; ')}`)

      // Show channel-relevant conversations first, then cross-reference the other channel
      const primaryConvs = channel === 'dm' ? dmConvs : publicConvs
      const secondaryConvs = channel === 'dm' ? publicConvs : dmConvs
      const primaryLabel = channel === 'dm' ? 'DM conversations' : 'Public conversations'
      const secondaryLabel = channel === 'dm' ? 'Public X history (context)' : 'DM history (context)'

      if (primaryConvs.length > 0) {
        lines.push(`\nRecent ${primaryLabel}:`)
        for (const conv of primaryConvs.slice(-maxConversations)) {
          const date = new Date(conv.startedAt).toDateString()
          lines.push(`\n[${date} — topic: ${conv.topic}]`)
          for (const msg of conv.messages.slice(-6)) {
            const who = msg.by === 'owner' ? 'You' : `@${handle}`
            lines.push(`  ${who}: "${msg.text.slice(0, 120)}"`)
          }
        }
      }

      // Cross-reference: show a summary of what happened in the other channel
      if (secondaryConvs.length > 0) {
        lines.push(`\n${secondaryLabel}: ${secondaryConvs.length} conversations on topics: ${
          [...new Set(secondaryConvs.map(c => c.topic))].slice(0, 3).join(', ')
        }`)
      }
    }

    return lines.join('\n')
  }
}
