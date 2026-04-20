/**
 * ArchiveRelationshipSeeder — bootstrap RelationshipMemory from Twitter archive.
 *
 * Reads tweets.js (the full Twitter data export), finds every reply ever sent,
 * groups by who the owner was talking to, computes reputation scores, and seeds
 * relationships.json. This runs on startup — automatically.
 *
 * When the same person appears in live mentions, OsBot already knows them:
 * how many times they've talked, which topics, how the conversations went.
 *
 * Universal: any user can drop their tweets.js file, this picks it up and seeds
 * their relationship history automatically.
 */

import fs from 'fs'
import path from 'path'

export interface SeededRelationship {
  handle: string
  score: number
  totalInteractions: number
  conversationCount: number
  firstSeenAt: string
  lastSeenAt: string
  highlights: string[]
}

const HOSTILE_PATTERNS = [
  /\bf+u+c+k+\b/i, /\bs+h+i+t+\b/i, /\ba+s+s+h+o+l+e\b/i,
  /\bstfu\b/i, /\bkys\b/i, /\bidiot\b/i, /\bmoron\b/i, /\bstupid\b/i,
]

const AGREEMENT_SIGNALS = ['exactly', 'agree', 'right', 'true', 'facts', 'valid', 'well said', 'good point', 'fair', 'makes sense']

// Score a single reply using same heuristics as RelationshipMemory.scoreInteraction
function scoreReply(text: string): number {
  let score = 1 // baseline: conversation happened
  if (text.length > 150) score += 2
  else if (text.length > 80) score += 1
  const lower = text.toLowerCase()
  if (AGREEMENT_SIGNALS.some(s => lower.includes(s))) score += 1
  if (HOSTILE_PATTERNS.some(p => p.test(text))) score -= 7
  if (text.length < 15) score -= 1
  const words = text.split(/\s+/)
  const capsWords = words.filter(w => w.length > 3 && w === w.toUpperCase())
  if (capsWords.length > words.length * 0.5) score -= 2
  return score
}

// Group replies into conversations: two replies to same handle within 90 min = same conversation
function countConversations(replies: Array<{ date: Date }>): number {
  if (replies.length === 0) return 0
  const sorted = [...replies].sort((a, b) => a.date.getTime() - b.date.getTime())
  let convs = 1
  for (let i = 1; i < sorted.length; i++) {
    const gapMs = sorted[i].date.getTime() - sorted[i - 1].date.getTime()
    if (gapMs > 90 * 60 * 1000) convs++
  }
  return convs
}

export function seedRelationshipsFromArchive(
  archivePath: string,
  relationshipsPath: string,
): { added: number; merged: number; total: number } {
  if (!fs.existsSync(archivePath)) {
    console.log('[ArchiveSeeder] Archive not found, skipping:', archivePath)
    return { added: 0, merged: 0, total: 0 }
  }

  // Check if already seeded — skip if seeded flag exists and archive hasn't changed
  const flagPath = relationshipsPath + '.seed_hash'
  const stat = fs.statSync(archivePath)
  const archiveHash = `${stat.size}-${stat.mtimeMs}`
  if (fs.existsSync(flagPath) && fs.readFileSync(flagPath, 'utf-8') === archiveHash) {
    return { added: 0, merged: 0, total: 0 } // already seeded this archive version
  }

  console.log('[ArchiveSeeder] Seeding relationships from archive...')

  // Parse archive
  const raw = fs.readFileSync(archivePath, 'utf-8').replace(/^window\.YTD\.tweets\.part0\s*=\s*/, '')
  const tweets: any[] = JSON.parse(raw).map((t: any) => t.tweet)

  // Find all reply tweets
  const replies = tweets.filter(t =>
    t.in_reply_to_screen_name &&
    t.in_reply_to_screen_name.trim() !== '',
  )

  // Group replies by handle
  const byHandle: Record<string, Array<{ text: string; date: Date; parentId: string }>> = {}
  for (const t of replies) {
    const h = t.in_reply_to_screen_name.toLowerCase().replace(/^@/, '')
    if (!byHandle[h]) byHandle[h] = []
    byHandle[h].push({
      text: t.full_text,
      date: new Date(t.created_at),
      parentId: t.in_reply_to_status_id_str ?? '',
    })
  }

  // Also extract @mentions from original posts (non-reply tweets)
  // e.g. "@elonmusk this is exactly what I thought" — elonmusk gets a mention entry
  const originalTweets = tweets.filter(t =>
    !t.in_reply_to_screen_name || t.in_reply_to_screen_name.trim() === '',
  )
  // Track mention-only handles separately — lower weight than real conversations
  const mentionOnly: Record<string, Array<{ date: Date }>> = {}
  for (const t of originalTweets) {
    const body = (t.full_text ?? '').replace(/https:\/\/t\.co\/\S+/g, '')
    const handles = (body.match(/@(\w+)/g) ?? []).map((m: string) => m.toLowerCase().replace('@', ''))
    const date = new Date(t.created_at)
    for (const h of handles) {
      if (h === process.env.OWNER_HANDLE?.toLowerCase()) continue // skip self
      if (!mentionOnly[h]) mentionOnly[h] = []
      mentionOnly[h].push({ date })
    }
  }

  // Load existing relationships (live data — don't lose it)
  let existing: Record<string, any> = {}
  if (fs.existsSync(relationshipsPath)) {
    try { existing = JSON.parse(fs.readFileSync(relationshipsPath, 'utf-8')) } catch {}
  }

  let added = 0
  let merged = 0

  for (const [handle, handleReplies] of Object.entries(byHandle)) {
    const sorted = handleReplies.sort((a, b) => a.date.getTime() - b.date.getTime())
    const totalInteractions = sorted.length
    const conversationCount = countConversations(sorted)

    // Compute score from all replies
    const score = sorted.reduce((sum, r) => sum + scoreReply(r.text), 0)

    // Back-and-forth bonus: multiple replies in same conversation window
    if (conversationCount > 1) {
      // Already counted through individual scores
    }

    const firstSeenAt = sorted[0].date.toISOString()
    const lastSeenAt = sorted[sorted.length - 1].date.toISOString()

    // Extract actual conversation snippets — what was said, not just counts
    // Pick up to 3 of the most substantive replies (longest = most content)
    const substantive = [...sorted]
      .filter(r => r.text.length > 40)
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, 3)

    const snippets = substantive.map(r => {
      // Strip leading @handles, strip t.co links, trim to 80 chars
      const clean = r.text
        .replace(/^(@\w+\s*)+/, '')
        .replace(/https:\/\/t\.co\/\S+/g, '')
        .trim()
        .slice(0, 80)
      const month = r.date.toLocaleString('default', { month: 'short', year: 'numeric' })
      return `[${month}] you said: "${clean}"`
    })

    const countSummary = `[archive] ${totalInteractions} replies across ${conversationCount} conversations (${sorted[0].date.getFullYear()}–${sorted[sorted.length - 1].date.getFullYear()})`
    const highlights = [countSummary, ...snippets]

    if (existing[handle]) {
      // Only skip if snippets ("you said:") already exist — count-only entries get upgraded
      const alreadyHasSnippets = existing[handle].highlights?.some((h: string) => h.includes('you said:'))
      if (!alreadyHasSnippets) {
        existing[handle].score += score
        existing[handle].totalInteractions += totalInteractions
        existing[handle].conversationCount += conversationCount
        if (new Date(firstSeenAt) < new Date(existing[handle].firstSeenAt)) {
          existing[handle].firstSeenAt = firstSeenAt
        }
        if (!existing[handle].highlights) existing[handle].highlights = []
        existing[handle].highlights.unshift(...highlights)
        if (existing[handle].highlights.length > 10) existing[handle].highlights = existing[handle].highlights.slice(-10)
        merged++
      }
    } else {
      existing[handle] = {
        handle,
        score,
        totalInteractions,
        conversationCount,
        firstSeenAt,
        lastSeenAt,
        highlights,
      }
      added++
    }
  }

  // Merge mention-only handles — weaker signal than replies (+1 per mention, max +5)
  for (const [handle, mentions] of Object.entries(mentionOnly)) {
    const mentionScore = Math.min(mentions.length, 5)
    const dates = mentions.map(m => m.date).sort((a, b) => a.getTime() - b.getTime())
    const firstSeenAt = dates[0].toISOString()
    const lastSeenAt = dates[dates.length - 1].toISOString()
    const highlight = `[archive] mentioned in ${mentions.length} original post${mentions.length > 1 ? 's' : ''}`

    if (existing[handle]) {
      // Already has reply data — just note that owner also mentioned them in posts
      const alreadyHasMentionNote = existing[handle].highlights?.some((h: string) => h.includes('mentioned in'))
      if (!alreadyHasMentionNote) {
        existing[handle].score += mentionScore
        if (!existing[handle].highlights) existing[handle].highlights = []
        existing[handle].highlights.push(highlight)
      }
    } else {
      // New handle — only known from mentions in original posts
      existing[handle] = {
        handle,
        score: mentionScore,
        totalInteractions: mentions.length,
        conversationCount: 0,
        firstSeenAt,
        lastSeenAt,
        highlights: [highlight],
      }
      added++
    }
  }

  fs.mkdirSync(path.dirname(relationshipsPath), { recursive: true })
  fs.writeFileSync(relationshipsPath, JSON.stringify(existing, null, 2))

  // Write seed flag so we don't re-seed same archive
  fs.writeFileSync(flagPath, archiveHash)

  const total = Object.keys(existing).length
  console.log(`[ArchiveSeeder] Done — added ${added} new, merged ${merged} existing. Total handles tracked: ${total}`)
  return { added, merged, total }
}
