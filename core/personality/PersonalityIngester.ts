/**
 * Shared personality ingestion logic.
 * Used by both the CLI script and the Telegram setup wizard.
 */

import Anthropic from '@anthropic-ai/sdk'
import { PersonalityProfile, WritingStats, BehaviorProfile } from './LLMReplyEngine'

const MAX_ORIGINALS = 500   // cap — take all if fewer
const MAX_REPLIES   = 800   // replies are the most important signal for a reply bot

export interface TweetEntry {
  text: string
  createdAt: Date
  isQuote: boolean
}

interface ParsedTweets {
  originals: string[]
  replies: string[]
  behaviorProfile: BehaviorProfile
}

export function parseTweetsJs(content: string): string[] {
  return parseTweetsJsFull(content).originals
}

// Twitter archive exports do NOT include is_quote_status or quoted_status_id_str fields.
// QTs appear as original tweets ending with a t.co URL but with no extended_entities (media).
// This is the only reliable QT signal in the archive format.
const TCO_TAIL = /https:\/\/t\.co\/\S+$/

function isQuoteTweet(tweet: { full_text: string; extended_entities?: unknown }): boolean {
  // Must end with a t.co URL (the link to the quoted tweet)
  if (!TCO_TAIL.test(tweet.full_text.trim())) return false
  // If extended_entities is present, the URL is a media attachment not a QT link
  if (tweet.extended_entities) return false
  return true
}

export function parseTweetsJsFull(content: string): ParsedTweets {
  const jsonStart = content.indexOf('[')
  if (jsonStart === -1) throw new Error('Invalid tweets.js — could not find tweet array.')
  const parsed = JSON.parse(content.slice(jsonStart)) as Array<{
    tweet: { full_text: string; created_at?: string; extended_entities?: unknown }
  }>

  const entries: TweetEntry[] = parsed
    .filter(e => e.tweet?.full_text && e.tweet.full_text.length > 5)
    .map(e => ({
      text: e.tweet.full_text,
      createdAt: e.tweet.created_at ? new Date(e.tweet.created_at) : new Date(0),
      isQuote: isQuoteTweet(e.tweet),
    }))
    .filter(e => !isNaN(e.createdAt.getTime()))

  const originalEntries = entries.filter(e => !e.text.startsWith('RT @') && !e.text.startsWith('@'))
  const originals = originalEntries.map(e => e.text).slice(-MAX_ORIGINALS)

  const replyPool = entries.filter(e => e.text.startsWith('@') && e.text.length > 10).map(e => e.text)
  const replies = sampleEvenly(replyPool, MAX_REPLIES)

  const replyEntries = entries.filter(e => e.text.startsWith('@') && e.text.length > 10)
  const behaviorProfile = computeBehaviorProfile(originalEntries, replyEntries)

  return { originals, replies, behaviorProfile }
}

export function computeBehaviorProfile(originalEntries: TweetEntry[], replyEntries: TweetEntry[] = []): BehaviorProfile {
  const DEFAULT: BehaviorProfile = {
    avgPostsPerDay: 3, avgRepliesPerDay: 10, quoteTweetRatio: 0.15, typicalPostingHours: [],
    avgIntervalHours: 8, burstSampleTweets: [], sampleOriginals: [],
  }
  if (originalEntries.length === 0) return DEFAULT

  // Group by date
  const dateGroups: Record<string, TweetEntry[]> = {}
  for (const e of originalEntries) {
    const key = e.createdAt.toISOString().split('T')[0]
    if (!dateGroups[key]) dateGroups[key] = []
    dateGroups[key].push(e)
  }

  const dailyCounts = Object.values(dateGroups).map(g => g.length)
  const avgPostsPerDay = Math.round(
    (dailyCounts.reduce((a, b) => a + b, 0) / dailyCounts.length) * 10
  ) / 10

  // QT ratio
  const quoteTweetRatio = Math.round(
    (originalEntries.filter(e => e.isQuote).length / originalEntries.length) * 100
  ) / 100

  // Avg replies per day — group reply entries by date
  let avgRepliesPerDay = 0
  if (replyEntries.length > 0) {
    const replyDateGroups: Record<string, number> = {}
    for (const e of replyEntries) {
      const key = e.createdAt.toISOString().split('T')[0]
      replyDateGroups[key] = (replyDateGroups[key] ?? 0) + 1
    }
    const replyCounts = Object.values(replyDateGroups)
    avgRepliesPerDay = Math.round(
      (replyCounts.reduce((a, b) => a + b, 0) / replyCounts.length) * 10
    ) / 10
  }

  // Top posting hours (UTC)
  const hourCounts: Record<number, number> = {}
  for (const e of originalEntries) {
    const h = e.createdAt.getUTCHours()
    hourCounts[h] = (hourCounts[h] ?? 0) + 1
  }
  const typicalPostingHours = Object.entries(hourCounts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([h]) => Number(h))

  // Avg interval between consecutive posts (ignore gaps > 48h — those are breaks, not patterns)
  const sorted = [...originalEntries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const diff = (sorted[i].createdAt.getTime() - sorted[i - 1].createdAt.getTime()) / 3_600_000
    if (diff > 0 && diff < 48) intervals.push(diff)
  }
  const avgIntervalHours = intervals.length > 0
    ? Math.round((intervals.reduce((a, b) => a + b, 0) / intervals.length) * 10) / 10
    : 8

  // Burst days: days where post count >= 1.5x average (unusual activity)
  const burstThreshold = Math.max(3, avgPostsPerDay * 1.5)
  const burstTweets: string[] = []
  for (const group of Object.values(dateGroups)) {
    if (group.length >= burstThreshold) {
      burstTweets.push(...group.map(e => e.text.replace(/https?:\/\/\S+/g, '').trim()).filter(t => t.length > 10))
    }
  }

  // 15 evenly sampled originals for style reference
  const cleanOriginals = originalEntries
    .map(e => e.text.replace(/https?:\/\/\S+/g, '').trim())
    .filter(t => t.length > 15)
  const sampleOriginals = sampleEvenly(cleanOriginals, 15)

  return {
    avgPostsPerDay,
    avgRepliesPerDay,
    quoteTweetRatio,
    typicalPostingHours,
    avgIntervalHours,
    burstSampleTweets: burstTweets.slice(0, 20),
    sampleOriginals,
  }
}

function sampleEvenly(arr: string[], n: number): string[] {
  if (arr.length <= n) return arr
  const step = arr.length / n
  const result: string[] = []
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.floor(i * step)])
  }
  return result
}

/**
 * Programmatically compute exact writing stats from the raw reply corpus.
 * These are precise counts — not LLM estimates.
 */
export function computeWritingStats(replies: string[]): WritingStats {
  if (replies.length === 0) return {}

  // Strip leading @handles and URLs to get actual reply text
  const cleaned = replies.map(r =>
    r.replace(/^(@\w+\s*)+/, '').replace(/https?:\/\/\S+/g, '').trim()
  ).filter(r => r.length > 0)

  // Median reply length in characters
  const lengths = cleaned.map(r => r.length).sort((a, b) => a - b)
  const medianChars = lengths[Math.floor(lengths.length / 2)]
  const medianReplyLength =
    medianChars < 50  ? 'very short' :
    medianChars < 100 ? 'short' :
    medianChars < 180 ? 'medium' : 'long'

  // Case style — what % start with lowercase vs uppercase
  const startsLower = cleaned.filter(r => /^[a-z]/.test(r)).length
  const pctLower = Math.round((startsLower / cleaned.length) * 100)
  const caseStyle =
    pctLower >= 70 ? `mostly lowercase (${pctLower}% of replies start lowercase)` :
    pctLower >= 40 ? `mixed case (${pctLower}% lowercase, ${100 - pctLower}% sentence-case)` :
    `mostly sentence-case (${100 - pctLower}% start with capital letter)`

  // Apostrophe style — check contraction patterns
  const withApostrophe = cleaned.filter(r => /\b(don't|isn't|won't|can't|didn't|doesn't|it's|that's|i'm|i've|i'll)\b/i.test(r)).length
  const withoutApostrophe = cleaned.filter(r => /\b(dont|isnt|wont|cant|didnt|doesnt|thats|im |ive |ill )\b/i.test(r)).length
  const apostropheStyle =
    withoutApostrophe > withApostrophe * 2
      ? `omits apostrophes in contractions (writes "dont" "isnt" "wont" not "don't" "isn't")`
      : withApostrophe > withoutApostrophe * 2
      ? `uses apostrophes in contractions (writes "don't" "isn't" "won't")`
      : `mixed apostrophe usage`

  // Emoji usage
  const emojiRegex = /[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u
  const withEmoji = cleaned.filter(r => emojiRegex.test(r)).length
  const pctEmoji = Math.round((withEmoji / cleaned.length) * 100)
  const emojiUsage =
    pctEmoji < 10 ? `rare (${pctEmoji}% of replies)` :
    pctEmoji < 30 ? `moderate (${pctEmoji}% of replies)` :
    `frequent (${pctEmoji}% of replies)`

  // Uncertainty phrases — find actual ones used
  const uncertaintyCandidates = ['i guess', 'idk', 'maybe', 'not sure', 'could be', 'might be', 'probably', 'i think', 'tbh', 'honestly']
  const uncertaintyPhrases = uncertaintyCandidates.filter(phrase => {
    const count = cleaned.filter(r => r.toLowerCase().includes(phrase)).length
    return count >= Math.max(2, cleaned.length * 0.01) // used in at least 1% of replies
  })

  return { medianReplyLength, caseStyle, apostropheStyle, emojiUsage, uncertaintyPhrases, characteristicMentions: computeCharacteristicMentions(replies) }
}

/**
 * Find @handles the user frequently tags mid-tweet (not just the opening reply-to handle).
 * These are characteristic engagement patterns — e.g. tagging @grok for AI comparisons.
 * Returns handles used in at least 2% of replies, sorted by frequency.
 */
export function computeCharacteristicMentions(replies: string[]): string[] {
  if (replies.length === 0) return []

  const mentionCount: Record<string, number> = {}
  for (const r of replies) {
    // Strip the leading reply-to handles (@handle at the very start)
    const body = r.replace(/^(@\w+\s*)+/, '')
    // Find all @mentions remaining in the body
    const mentions = body.match(/@\w+/g) ?? []
    for (const m of mentions) {
      const handle = m.toLowerCase()
      mentionCount[handle] = (mentionCount[handle] ?? 0) + 1
    }
  }

  const threshold = Math.max(3, replies.length * 0.02)  // used in 2%+ of replies
  return Object.entries(mentionCount)
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([handle]) => handle)
}

/**
 * Find the most frequent opener phrases in replies.
 * Returns top phrases with how often they appear.
 */
export function computeSignatureOpeners(replies: string[]): string[] {
  const cleaned = replies.map(r =>
    r.replace(/^(@\w+\s*)+/, '').replace(/https?:\/\/\S+/g, '').trim().toLowerCase()
  ).filter(r => r.length > 5)

  // Count first 3-word phrases
  const phraseCount: Record<string, number> = {}
  for (const r of cleaned) {
    const words = r.split(/\s+/)
    if (words.length >= 3) {
      const two = words.slice(0, 2).join(' ')
      const three = words.slice(0, 3).join(' ')
      phraseCount[two] = (phraseCount[two] ?? 0) + 1
      phraseCount[three] = (phraseCount[three] ?? 0) + 1
    }
  }

  // Return phrases used at least 3 times, sorted by frequency
  return Object.entries(phraseCount)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase, count]) => `"${phrase}" (${count}x)`)
}

export async function analyzePersonality(tweets: string[], handle: string): Promise<PersonalityProfile> {
  // Legacy single-array path — wraps into full analysis treating all as originals
  const entries: TweetEntry[] = tweets.map(t => ({ text: t, createdAt: new Date(0), isQuote: false }))
  return analyzePersonalityFull({ originals: tweets, replies: [], behaviorProfile: computeBehaviorProfile(entries, []) }, handle)
}

async function computeKeywordsForTopics(client: Anthropic, topics: string[], replies: string[]): Promise<Record<string, string[]>> {
  const replySample = replies.slice(0, 200).join('\n')
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content:
        `A Twitter user has these reply topics: ${JSON.stringify(topics)}\n\n` +
        `Here are samples of their actual replies:\n${replySample}\n\n` +
        `For each topic, list 30-50 keywords and phrases that commonly appear in real tweets about that topic on X/Twitter. ` +
        `Think about: specific names (people, teams, companies, products), slang, abbreviations, event terms, platform-specific language.\n\n` +
        `STRICT RULES — violating these causes false-positive matches in production:\n` +
        `1. Single-word keywords must be at least 5 characters. Short abbreviations 2-4 chars (like "eth","sol","war","win","api","vc","ta","un","ban","ads","nft","btc") match as substrings inside unrelated words — DO NOT include them as standalone keywords. Use the full word instead (ethereum, solana, bitcoin, united nations).\n` +
        `2. NO generic words that appear in any tweet regardless of topic: "imagine","wild","insane","opinion","society","culture","class","post","reply","thread","list","trending","viral","score","win","loss","stats","logic","solve","formula","experiment","cloud","stack","agent","source","breaking news","intelligence","revolution","protest".\n` +
        `3. NO cross-domain ambiguous words shared across multiple topics — use specific compound phrases instead: write "crypto token" not "token", "sports mvp" not "mvp", "player stats" not "stats", "ai agent" not "agent", "drone strike" not "strike".\n` +
        `4. Prefer multi-word phrases over bare generic nouns whenever possible.\n` +
        `5. Use the reply samples for context but generate keywords broadly for the topic — not just words from these replies.\n\n` +
        `Return JSON only — object where key is the exact topic string and value is array of lowercase keyword strings:\n` +
        `{"topic1": ["kw1","kw2",...], "topic2": [...]}`,
    }],
  })
  const text = (res.content[0] as { type: 'text'; text: string }).text.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return {}
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, string[]>
  } catch { return {} }
}

async function computeTopicsForCorpus(client: Anthropic, label: string, tweets: string[]): Promise<string[]> {
  const block = tweets.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content:
        `Here are ${tweets.length} Twitter ${label}. What are the distinct topics this person tweets about?\n\n` +
        `${block}\n\n` +
        `Return JSON array only — up to 8 topics, no padding, only genuinely present themes:\n` +
        `["topic1", "topic2", ...]`,
    }],
  })
  const text = (res.content[0] as { type: 'text'; text: string }).text.trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1) return []
  return JSON.parse(text.slice(start, end + 1)) as string[]
}

export async function analyzePersonalityFull(tweets: ParsedTweets, handle: string): Promise<PersonalityProfile> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Compute exact stats programmatically BEFORE asking LLM
  const computedStats = computeWritingStats(tweets.replies)
  const topOpeners = computeSignatureOpeners(tweets.replies)

  console.log(`[Ingester] Computed stats: median=${computedStats.medianReplyLength}, case=${computedStats.caseStyle?.split('(')[0].trim()}, apostrophe=${computedStats.apostropheStyle?.split('(')[0].trim()}`)
  console.log(`[Ingester] Top opener phrases: ${topOpeners.slice(0, 5).join(', ')}`)
  console.log(`[Ingester] Characteristic mentions: ${computedStats.characteristicMentions?.join(', ') || 'none'}`)

  // ── Compute post topics and reply topics SEPARATELY ──────────
  console.log('[Ingester] Computing post topics...')
  const postTopics = await computeTopicsForCorpus(client, 'original posts', tweets.originals)
  console.log(`[Ingester] Post topics: ${postTopics.join(', ')}`)

  console.log('[Ingester] Computing reply topics...')
  const replyTopics = await computeTopicsForCorpus(client, 'replies', tweets.replies)
  console.log(`[Ingester] Reply topics: ${replyTopics.join(', ')}`)

  console.log('[Ingester] Computing topic keywords from reply corpus...')
  const topicKeywords = await computeKeywordsForTopics(client, replyTopics, tweets.replies)
  console.log(`[Ingester] Keywords computed for ${Object.keys(topicKeywords).length} topics`)

  const originalsBlock = tweets.originals.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const repliesBlock   = tweets.replies.map((t, i) => `${i + 1}. ${t}`).join('\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content:
        `Analyze @${handle}'s personality from their REAL Twitter archive.\n\n` +
        `=== ORIGINAL POSTS (${tweets.originals.length} tweets) ===\n` +
        `${originalsBlock}\n\n` +
        `=== REPLIES TO OTHERS (${tweets.replies.length} replies) ===\n` +
        `${repliesBlock}\n\n` +
        `COMPUTED STATS (exact counts from the archive — use these verbatim in writingStats):\n` +
        `- medianReplyLength: "${computedStats.medianReplyLength}"\n` +
        `- caseStyle: "${computedStats.caseStyle}"\n` +
        `- apostropheStyle: "${computedStats.apostropheStyle}"\n` +
        `- emojiUsage: "${computedStats.emojiUsage}"\n` +
        `- uncertaintyPhrases: ${JSON.stringify(computedStats.uncertaintyPhrases)}\n` +
        `- most frequent reply openers: ${topOpeners.slice(0, 8).join(', ')}\n\n` +
        `Return JSON only — no explanation, no markdown, just the object:\n` +
        `{\n` +
        `  "writingStyle": "one sentence about their posting style in original tweets",\n` +
        `  "dominantTopics": ["topic1", "topic2", ...up to 8 topics — include as many genuinely distinct themes as the archive shows, no padding"],\n` +
        `  "opinionStyle": "how they form and express opinions",\n` +
        `  "humorStyle": "their specific humor pattern",\n` +
        `  "examplePhrases": ["exact phrase from their posts", "exact phrase", "exact phrase", "exact phrase"],\n` +
        `  "avoids": ["thing1", "thing2", "thing3"],\n` +
        `  "replyStyle": "one sentence about how they reply to others — tone, length, aggression level, patterns",\n` +
        `  "replyExamples": ["exact reply they sent", "exact reply", "exact reply", "exact reply"],\n` +
        `  "signaturePatterns": [\n` +
        `    { "phrase": "exact opener phrase from the frequent openers list above", "usedFor": "what type of tweet triggers this e.g. explaining a concept, adding context to data", "neverUsedFor": "what this would NOT fit e.g. breaking news, giveaways, casual chat" }\n` +
        `  ],\n` +
        `  "writingStats": {\n` +
        `    "apostropheStyle": "copy verbatim from COMPUTED STATS above",\n` +
        `    "caseStyle": "copy verbatim from COMPUTED STATS above",\n` +
        `    "uncertaintyPhrases": ["copy verbatim from COMPUTED STATS above"],\n` +
        `    "medianReplyLength": "copy verbatim from COMPUTED STATS above",\n` +
        `    "emojiUsage": "copy verbatim from COMPUTED STATS above"\n` +
        `  }\n` +
        `}`,
    }],
  })

  const text = (response.content[0] as { type: 'text'; text: string }).text.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON found in Claude response')

  const profile = JSON.parse(text.slice(start, end + 1)) as PersonalityProfile

  // Always override writingStats with computed values — never trust LLM estimates over exact counts
  profile.writingStats = computedStats
  // Attach behavior profile — derived purely from archive data, not LLM estimates
  profile.behaviorProfile = tweets.behaviorProfile
  // Attach separately computed topic lists
  profile.postTopics = postTopics
  profile.replyTopics = replyTopics
  profile.topicKeywords = topicKeywords

  console.log(`[Ingester] Behavior profile: avgPostsPerDay=${tweets.behaviorProfile.avgPostsPerDay}, avgRepliesPerDay=${tweets.behaviorProfile.avgRepliesPerDay}, qtRatio=${tweets.behaviorProfile.quoteTweetRatio}, avgInterval=${tweets.behaviorProfile.avgIntervalHours}h`)

  return profile
}
