import fs from 'fs'
import path from 'path'
import {
  MemoryRecord, MemoryStore, Mood, PendingReply, PlatformEvent,
  AccountMemory, MemorySummary, SmartContext, AutoPost,
} from './types'

const DEFAULT_STORE: MemoryStore = {
  sinceId: undefined,
  mood: 'chill',
  moodUpdatedAt: new Date().toISOString(),
  threadCooldowns: {},
  pendingReplies: [],
  records: [],
  monthlyCounts: {},
  autonomousPostCountToday: 0,
  lastAutonomousPostAt: undefined,
  lastViralSearchAt: undefined,
  mutedUntil: null,
  platformEvents: [],
  accounts: {},
  memorySummaries: [],
  autonomousPosts: [],
}

export class MemoryEngine {
  private storePath: string
  private replyLogPath: string   // append-only log — never pruned, permanent audit history
  private store: MemoryStore
  private maxRecords: number
  private pruneAfterDays: number

  constructor(storePath: string, maxRecords = 10000, pruneAfterDays = 90) {
    this.storePath = path.resolve(storePath)
    this.replyLogPath = path.resolve(path.dirname(this.storePath), 'reply_log.jsonl')
    this.maxRecords = maxRecords
    this.pruneAfterDays = pruneAfterDays
    this.store = this.load()
    this.pruneOldRecords()
    this.pruneExpiredCooldowns()
  }

  // --- Persistence ---

  private load(): MemoryStore {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true })
      return { ...DEFAULT_STORE }
    }
    try {
      const raw = fs.readFileSync(this.storePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<MemoryStore>
      return { ...DEFAULT_STORE, ...parsed }
    } catch {
      console.warn('[MemoryEngine] Failed to parse memory.json, starting fresh.')
      return { ...DEFAULT_STORE }
    }
  }

  private flush(): void {
    fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8')
  }

  // --- sinceId ---

  getLastSinceId(): string | undefined {
    return this.store.sinceId
  }

  updateSinceId(sinceId: string): void {
    this.store.sinceId = sinceId
    this.flush()
  }

  // --- Deduplication ---

  hasReplied(tweetId: string): boolean {
    return this.store.records.some(r => r.tweetId === tweetId)
  }

  hasProactivelyEngaged(conversationId: string): boolean {
    return !!(this.store as any).proactiveEngaged?.[conversationId]
  }

  markProactivelyEngaged(conversationId: string): void {
    if (!(this.store as any).proactiveEngaged) (this.store as any).proactiveEngaged = {}
    ;(this.store as any).proactiveEngaged[conversationId] = new Date().toISOString()
    this.flush()
  }

  getConversationReplyCount(conversationId: string): number {
    return this.store.records.filter(r => r.conversationId === conversationId).length
  }

  getEngagedAuthorIds(): { authorId: string; authorHandle: string }[] {
    const seen = new Set<string>()
    const result: { authorId: string; authorHandle: string }[] = []
    for (const r of this.store.records) {
      if (!seen.has(r.authorId)) {
        seen.add(r.authorId)
        result.push({ authorId: r.authorId, authorHandle: r.authorHandle })
      }
    }
    return result
  }

  // --- Reply Records ---

  recordReply(record: MemoryRecord): void {
    this.store.records.push(record)

    const monthKey = record.timestamp.slice(0, 7)
    this.store.monthlyCounts[monthKey] = (this.store.monthlyCounts[monthKey] ?? 0) + 1

    // Append to permanent reply log — never pruned, survives the 90-day rolling window
    fs.appendFileSync(this.replyLogPath, JSON.stringify({
      tweetId: record.tweetId,
      authorHandle: record.authorHandle,
      mentionText: record.mentionText,
      replyText: record.replyText,
      timestamp: record.timestamp,
    }) + '\n')

    this.flush()
  }

  getInteractionCount(authorId: string): number {
    return this.store.records.filter(r => r.authorId === authorId).length
  }

  getRecentRecords(n: number): MemoryRecord[] {
    return this.store.records.slice(-n)
  }

  // --- Monthly & Daily Usage ---

  getMonthlyUsage(): number {
    const key = new Date().toISOString().slice(0, 7)
    return this.store.monthlyCounts[key] ?? 0
  }

  getDailyUsage(): number {
    const today = new Date().toISOString().slice(0, 10)
    return this.store.records.filter(r => r.timestamp.startsWith(today)).length
  }

  // --- Mood ---

  getMood(): Mood {
    return this.store.mood
  }

  setMood(mood: Mood): void {
    this.store.mood = mood
    this.store.moodUpdatedAt = new Date().toISOString()
    this.flush()
  }

  getMoodUpdatedAt(): Date {
    return new Date(this.store.moodUpdatedAt)
  }

  // --- Thread Cooldowns ---

  isInThreadCooldown(conversationId: string): boolean {
    const expiry = this.store.threadCooldowns[conversationId]
    if (!expiry) return false
    return new Date(expiry) > new Date()
  }

  setThreadCooldown(conversationId: string, cooldownMinutes: number): void {
    const expiry = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString()
    this.store.threadCooldowns[conversationId] = expiry
    this.flush()
  }

  // --- Pending Replies ---

  addPendingReply(pending: PendingReply): void {
    this.store.pendingReplies.push(pending)
    this.flush()
  }

  getPendingReplies(): PendingReply[] {
    return this.store.pendingReplies.filter(p => !p.sent)
  }

  getOverduePendingReplies(): PendingReply[] {
    const now = new Date()
    return this.store.pendingReplies.filter(p => !p.sent && new Date(p.fireAt) <= now)
  }

  isPendingSent(id: string): boolean {
    const entry = this.store.pendingReplies.find(p => p.id === id)
    return entry ? entry.sent : true // if not found, treat as sent (safe default)
  }

  markPendingSent(id: string): void {
    const entry = this.store.pendingReplies.find(p => p.id === id)
    if (entry) {
      entry.sent = true
      this.flush()
    }
  }

  // --- Mute ---

  isMuted(): boolean {
    if (!this.store.mutedUntil) return false
    return new Date(this.store.mutedUntil) > new Date()
  }

  setMutedUntil(until: string | null): void {
    this.store.mutedUntil = until
    this.flush()
  }

  // --- Daily Stats ---

  getDailyStats(): { repliesToday: number; monthlyUsage: number; lastReplyAt: string | undefined } {
    const today = new Date().toISOString().slice(0, 10)
    const todayRecords = this.store.records.filter(r => r.timestamp.startsWith(today))
    const lastRecord = this.store.records[this.store.records.length - 1]
    return {
      repliesToday: todayRecords.length,
      monthlyUsage: this.getMonthlyUsage(),
      lastReplyAt: lastRecord?.timestamp,
    }
  }

  // --- Viral Search Cooldown ---

  getLastViralSearchAt(): string | undefined {
    return this.store.lastViralSearchAt
  }

  setLastViralSearchAt(): void {
    this.store.lastViralSearchAt = new Date().toISOString()
    this.flush()
  }

  // --- Autonomous Posts ---

  getAutonomousPostCount(): number {
    const last = this.store.lastAutonomousPostAt
    if (last && new Date(last).toDateString() !== new Date().toDateString()) {
      this.store.autonomousPostCountToday = 0
    }
    return this.store.autonomousPostCountToday
  }

  getLastAutonomousPostAt(): string | undefined {
    return this.store.lastAutonomousPostAt
  }

  recordAutonomousPost(tweetId?: string, text?: string, topic?: string, platform = 'x', accountType: 'bot-own' | 'owner-own' = 'bot-own'): void {
    this.store.autonomousPostCountToday = this.getAutonomousPostCount() + 1
    this.store.lastAutonomousPostAt = new Date().toISOString()
    if (tweetId && text) {
      if (!this.store.autonomousPosts) this.store.autonomousPosts = []
      this.store.autonomousPosts.push({
        tweetId,
        text,
        topic: topic ?? 'unknown',
        postedAt: new Date().toISOString(),
        platform,
        accountType,
      })
      // Keep last 200 only
      if (this.store.autonomousPosts.length > 200) {
        this.store.autonomousPosts = this.store.autonomousPosts.slice(-200)
      }
    }
    this.flush()
  }

  /** Returns the original autonomous post if someone is replying to it — null if it was a regular mention */
  getAutonomousPost(tweetId: string): AutoPost | null {
    return this.store.autonomousPosts?.find(p => p.tweetId === tweetId) ?? null
  }

  // --- Platform Event Log ---

  recordPlatformEvent(event: Omit<PlatformEvent, 'timestamp'>): void {
    const entry: PlatformEvent = { ...event, timestamp: new Date().toISOString() }
    if (!this.store.platformEvents) this.store.platformEvents = []
    this.store.platformEvents.push(entry)
    this.flush()
  }

  getRecentPlatformEvents(n = 20): PlatformEvent[] {
    return (this.store.platformEvents ?? []).slice(-n)
  }

  // --- Smart Memory: Account Slots ---

  /**
   * Get or initialize the memory slot for a given account.
   * accountKey format: "${platform}:${accountType}"
   * Examples: "x:bot-own", "threads:owner-own", "discord:bot-own"
   */
  getAccountMemory(accountKey: string): AccountMemory {
    if (!this.store.accounts[accountKey]) {
      const [platform, accountType] = accountKey.split(':') as [string, 'bot-own' | 'owner-own']
      this.store.accounts[accountKey] = {
        accountKey,
        platform,
        accountType,
        recurringUsers: [],
        topicPerformance: [],
        audienceProfile: '',
        lastProfileUpdatedAt: undefined,
      }
    }
    return this.store.accounts[accountKey]
  }

  /**
   * Track that OsBot interacted with a person on a given account.
   * One-offs (count=1) are stored but only surface in smart context at count >= 2.
   */
  updateRecurringUser(accountKey: string, handle: string, platform: string, topics: string[]): void {
    const acct = this.getAccountMemory(accountKey)
    const existing = acct.recurringUsers.find(u => u.handle === handle)
    if (existing) {
      existing.count++
      existing.lastSeen = new Date().toISOString()
      existing.recentTopics = [...new Set([...topics, ...existing.recentTopics])].slice(0, 5)
    } else {
      acct.recurringUsers.push({
        handle, platform, count: 1,
        lastSeen: new Date().toISOString(),
        recentTopics: topics,
      })
    }
    acct.recurringUsers.sort((a, b) => b.count - a.count)
    if (acct.recurringUsers.length > 50) acct.recurringUsers = acct.recurringUsers.slice(0, 50)
    this.flush()
  }

  /**
   * Record which topics appeared in a post/reply for a given account.
   */
  updateTopicPerformance(accountKey: string, topics: string[]): void {
    if (topics.length === 0) return
    const acct = this.getAccountMemory(accountKey)
    for (const topic of topics) {
      const existing = acct.topicPerformance.find(t => t.topic === topic)
      if (existing) {
        existing.count++
        existing.lastSeen = new Date().toISOString()
      } else {
        acct.topicPerformance.push({ topic, count: 1, lastSeen: new Date().toISOString(), engagement: 0 })
      }
    }
    this._sortTopics(acct)
    if (acct.topicPerformance.length > 20) acct.topicPerformance = acct.topicPerformance.slice(0, 20)
    this.flush()
  }

  /**
   * Called when a reply is received on one of our autonomous posts.
   * Boosts that topic's engagement score so future posts favour it.
   */
  boostTopicEngagement(accountKey: string, topic: string, amount: number = 1): void {
    const acct = this.getAccountMemory(accountKey)
    const existing = acct.topicPerformance.find(t => t.topic === topic)
    if (existing) {
      existing.engagement = (existing.engagement ?? 0) + amount
      this._sortTopics(acct)
      this.flush()
    }
  }

  private _sortTopics(acct: { topicPerformance: import('./types').TopicStat[] }): void {
    // Sort by engagement*2 + count — engagement signal outweighs raw frequency
    acct.topicPerformance.sort((a, b) =>
      ((b.engagement ?? 0) * 2 + b.count) - ((a.engagement ?? 0) * 2 + a.count)
    )
  }

  /**
   * Set the LLM-written audience profile for an account.
   * Called by MemorySummarizer weekly.
   */
  setAudienceProfile(accountKey: string, profile: string): void {
    const acct = this.getAccountMemory(accountKey)
    acct.audienceProfile = profile
    acct.lastProfileUpdatedAt = new Date().toISOString()
    this.flush()
  }

  /**
   * Assemble the full smart context for a given account slot.
   * Only recurring users (count >= 2) surface — one-offs are filtered out.
   */
  getSmartContext(accountKey: string): SmartContext {
    const acct = this.getAccountMemory(accountKey)
    return {
      recurringUsers: acct.recurringUsers.filter(u => u.count >= 2).slice(0, 10),
      topTopics: acct.topicPerformance.slice(0, 8),
      audienceProfile: acct.audienceProfile,
      weeklySummaries: this.getMemorySummaries(8),
      recentRawEvents: this.getRecentPlatformEvents(20).map(e => e.summary),
    }
  }

  // --- Weekly Memory Summaries ---

  addMemorySummary(summary: MemorySummary): void {
    if (!this.store.memorySummaries) this.store.memorySummaries = []
    const idx = this.store.memorySummaries.findIndex(s => s.weekOf === summary.weekOf)
    if (idx >= 0) {
      this.store.memorySummaries[idx] = summary
    } else {
      this.store.memorySummaries.push(summary)
    }
    this.flush()
  }

  getMemorySummaries(n = 8): MemorySummary[] {
    return (this.store.memorySummaries ?? []).slice(-n)
  }

  /**
   * Returns week Monday dates that have platform events but no summary yet.
   * Only returns complete weeks (ended more than 7 days ago).
   */
  getUnsummarizedWeeks(): string[] {
    const events = this.store.platformEvents ?? []
    const summarized = new Set((this.store.memorySummaries ?? []).map(s => s.weekOf))
    const cutoff = new Date(Date.now() - 7 * 86400 * 1000)

    const weekSet = new Set<string>()
    for (const e of events) {
      const d = new Date(e.timestamp)
      if (d > cutoff) continue // skip current/incomplete week
      weekSet.add(getMondayOf(d))
    }

    return [...weekSet].filter(w => !summarized.has(w)).sort()
  }

  /**
   * Get all platform events that fall within a given week (by Monday date).
   */
  getEventsByWeek(weekOf: string): PlatformEvent[] {
    return (this.store.platformEvents ?? []).filter(
      e => getMondayOf(new Date(e.timestamp)) === weekOf
    )
  }

  // --- Pruning ---

  private pruneOldRecords(): void {
    const cutoff = new Date(Date.now() - this.pruneAfterDays * 86400 * 1000)
    this.store.records = this.store.records.filter(r => new Date(r.timestamp) > cutoff)

    if (this.store.records.length > this.maxRecords) {
      this.store.records = this.store.records.slice(-this.maxRecords)
    }

    this.flush()
  }

  private pruneExpiredCooldowns(): void {
    const now = new Date()
    for (const [convId, expiry] of Object.entries(this.store.threadCooldowns)) {
      if (new Date(expiry) <= now) {
        delete this.store.threadCooldowns[convId]
      }
    }
    const sentReplies = this.store.pendingReplies.filter(p => p.sent)
    if (sentReplies.length > 100) {
      const unsent = this.store.pendingReplies.filter(p => !p.sent)
      this.store.pendingReplies = [...sentReplies.slice(-100), ...unsent]
    }
    this.flush()
  }

}

// --- Utility ---

function getMondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}
