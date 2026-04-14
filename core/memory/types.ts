export type Mood = 'chill' | 'defensive' | 'snarky' | 'distracted' | 'heated'

export interface TraitVector {
  aggression: number   // 0-1
  warmth: number       // 0-1
  humor: number        // 0-1
  formality: number    // 0-1
  verbosity: number    // 0-1
}

export interface MemoryRecord {
  tweetId: string
  replyTweetId: string
  authorId: string
  authorHandle: string
  conversationId: string
  mentionText: string
  replyText: string
  timestamp: string        // ISO 8601
  traitSnapshot: TraitVector
  mood: Mood
}

export interface PendingReply {
  id: string
  replyText: string
  inReplyToTweetId: string
  fireAt: string           // ISO 8601
  sent: boolean
}

export interface PlatformEvent {
  timestamp: string        // ISO 8601
  platform: string         // 'x' | 'threads' | 'discord' | etc.
  type: 'post_published' | 'reply_given' | 'notable_mention' | 'followers_gained' | 'custom'
  summary: string          // human-readable, fed directly into LLM context
}

// ─── Smart Memory Types ───────────────────────────────────────────────────────

/**
 * A person who has engaged with an account multiple times.
 * One-off interactions are not tracked — only count >= 2 meaningful.
 */
export interface RecurringUser {
  handle: string
  platform: string
  count: number
  lastSeen: string         // ISO 8601
  recentTopics: string[]   // topics they commonly engage on
}

/**
 * How frequently a topic appears across an account's activity.
 */
export interface TopicStat {
  topic: string
  count: number
  lastSeen: string         // ISO 8601
  engagement: number       // reply signals received on posts about this topic — higher = post more
}

/**
 * Per-account brain slot. Key format: "${platform}:${accountType}"
 * Examples: "x:bot-own", "threads:owner-own", "discord:bot-own"
 * Add a new platform = just add a new key. Zero architecture change.
 */
export interface AccountMemory {
  accountKey: string
  platform: string
  accountType: 'bot-own' | 'owner-own'
  recurringUsers: RecurringUser[]    // sorted by count desc, capped at 50
  topicPerformance: TopicStat[]      // sorted by count desc, capped at 20
  audienceProfile: string            // LLM-written paragraph, updated weekly
  lastProfileUpdatedAt?: string      // ISO 8601
}

/**
 * Weekly curated digest — LLM extracts only high-signal patterns from raw events.
 * Stored forever. Fed into every autonomous post as compressed episodic memory.
 */
export interface MemorySummary {
  weekOf: string     // "YYYY-MM-DD" — Monday of that week
  summary: string    // LLM-curated paragraph (≤150 words)
  createdAt: string  // ISO 8601
}

/**
 * Full assembled smart context for one account slot — passed to LLM.
 * Replaces the old flat platformEvents list.
 */
export interface SmartContext {
  recurringUsers: RecurringUser[]
  topTopics: TopicStat[]
  audienceProfile: string
  weeklySummaries: MemorySummary[]
  recentRawEvents: string[]
}

/**
 * A record of every tweet OsBot posted autonomously.
 * Used to recognise when someone replies to one of OsBot's own posts
 * and inject that original context into the reply.
 */
export interface AutoPost {
  tweetId: string        // the posted tweet's ID
  text: string           // full text of what was posted
  topic: string          // the topic/current event that triggered it
  postedAt: string       // ISO 8601
  platform: string       // 'x' | 'threads'
  accountType: 'bot-own' | 'owner-own'
}

// ─── Memory Store ─────────────────────────────────────────────────────────────

export interface MemoryStore {
  sinceId: string | undefined
  mood: Mood
  moodUpdatedAt: string
  threadCooldowns: Record<string, string>   // conversationId → ISO expiry timestamp
  pendingReplies: PendingReply[]
  records: MemoryRecord[]
  monthlyCounts: Record<string, number>     // "YYYY-MM" → count
  autonomousPostCountToday: number
  lastAutonomousPostAt: string | undefined
  lastViralSearchAt: string | undefined
  mutedUntil: string | null
  platformEvents: PlatformEvent[]           // raw cross-platform log — stored forever
  accounts: Record<string, AccountMemory>   // per-account smart memory slots
  memorySummaries: MemorySummary[]          // curated weekly digests — stored forever
  autonomousPosts: AutoPost[]               // every tweet OsBot posted autonomously (last 200)
}
