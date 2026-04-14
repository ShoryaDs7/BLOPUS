/**
 * OwnerPostIndex — raw post history for the owner, searchable by date or keyword.
 *
 * Every original tweet, reply, and autonomous post stored with exact timestamp.
 * Seeded from archive on first run. Grows forever as OsBot posts/replies.
 *
 * Powers WizardBrain answers like:
 * - "what was my first post?" → getFirst()
 * - "what did I post on Nov 19?" → searchByDate("Nov 19")
 * - "when did I launch my SDK?" → searchByKeyword("SDK")
 * - "what did I post about agents?" → searchByKeyword("agent")
 */

import fs from 'fs'
import path from 'path'

export interface OwnerPost {
  id: string
  text: string
  date: string        // ISO 8601 timestamp
  type: 'original' | 'reply' | 'quote' | 'autonomous'
  replyTo?: string    // @handle if reply
}

export class OwnerPostIndex {
  private posts: OwnerPost[] = []
  private indexPath: string
  private seedHashPath: string

  constructor(memStoreDir: string) {
    fs.mkdirSync(memStoreDir, { recursive: true })
    this.indexPath = path.join(memStoreDir, 'owner_posts.json')
    this.seedHashPath = path.join(memStoreDir, 'owner_posts.seed_hash')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        this.posts = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'))
      }
    } catch { this.posts = [] }
  }

  private save(): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(this.posts, null, 2))
  }

  /** Seed from Twitter archive. Runs once per archive version. */
  seedFromArchive(archivePath: string): { seeded: number; skipped: boolean } {
    if (!fs.existsSync(archivePath)) return { seeded: 0, skipped: true }

    const stat = fs.statSync(archivePath)
    const hash = `${stat.size}-${stat.mtimeMs}`
    if (fs.existsSync(this.seedHashPath) && fs.readFileSync(this.seedHashPath, 'utf-8') === hash) {
      return { seeded: 0, skipped: true }
    }

    console.log('[OwnerPostIndex] Seeding from archive...')
    const raw = fs.readFileSync(archivePath, 'utf-8').replace(/^window\.YTD\.tweets\.part0\s*=\s*/, '')
    const tweets: any[] = JSON.parse(raw).map((t: any) => t.tweet)

    // Build a set of existing IDs so we don't double-add on re-seed
    const existingIds = new Set(this.posts.map(p => p.id))
    let added = 0

    for (const t of tweets) {
      const id = t.id_str ?? t.id
      if (!id || existingIds.has(id)) continue

      const text: string = t.full_text ?? t.text ?? ''
      if (!text || text.length < 3) continue

      const date = t.created_at ? new Date(t.created_at).toISOString() : new Date(0).toISOString()
      const isRT = text.startsWith('RT @')
      if (isRT) continue  // skip retweets — not owner's words

      const isReply = !!(t.in_reply_to_screen_name && t.in_reply_to_screen_name.trim() !== '')
      const isQuote = !isReply && /https:\/\/t\.co\/\S+$/.test(text.trim()) && !t.extended_entities

      const type: OwnerPost['type'] = isReply ? 'reply' : isQuote ? 'quote' : 'original'

      this.posts.push({
        id,
        text: text.replace(/https?:\/\/\S+/g, '').trim(),
        date,
        type,
        replyTo: isReply ? t.in_reply_to_screen_name.toLowerCase() : undefined,
      })
      existingIds.add(id)
      added++
    }

    // Sort oldest first
    this.posts.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    this.save()
    fs.writeFileSync(this.seedHashPath, hash)
    console.log(`[OwnerPostIndex] Seeded ${added} posts. Total: ${this.posts.length}`)
    return { seeded: added, skipped: false }
  }

  /** Append a new post as OsBot runs (autonomous posts, replies). */
  append(post: Omit<OwnerPost, 'id'> & { id?: string }): void {
    const id = post.id ?? `live-${Date.now()}`
    // No duplicates
    if (this.posts.some(p => p.id === id)) return
    this.posts.push({ ...post, id })
    this.save()
  }

  /** First post ever (oldest). */
  getFirst(): OwnerPost | null {
    return this.posts[0] ?? null
  }

  /** Most recent N posts. */
  getRecent(n: number): OwnerPost[] {
    return this.posts.slice(-n).reverse()
  }

  /** Search by keyword — case-insensitive, returns up to 15 matches (most recent first). */
  searchByKeyword(keyword: string): OwnerPost[] {
    const kw = keyword.toLowerCase()
    return this.posts
      .filter(p => p.text.toLowerCase().includes(kw))
      .slice(-30)
      .reverse()
      .slice(0, 15)
  }

  /**
   * Search by date string — flexible, handles:
   * "Nov 19", "Nov 19 2025", "19 November", "2025-11-19", "November 2025", "2025"
   * Returns all posts on that day/month/year.
   */
  searchByDate(dateStr: string): OwnerPost[] {
    const lower = dateStr.toLowerCase().trim()

    // Exact ISO date match (YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
      const parsed = new Date(dateStr.trim())
      if (!isNaN(parsed.getTime())) {
        const prefix = dateStr.trim()
        return this.posts.filter(p => p.date.startsWith(prefix))
      }
    }

    // Month name map — longer names first to prevent "nov" matching before "november"
    const MONTH_NAMES: [string, number][] = [
      ['january', 0], ['february', 1], ['march', 2], ['april', 3],
      ['may', 4], ['june', 5], ['july', 6], ['august', 7],
      ['september', 8], ['october', 9], ['november', 10], ['december', 11],
      ['jan', 0], ['feb', 1], ['mar', 2], ['apr', 3],
      ['jun', 5], ['jul', 6], ['aug', 7], ['sep', 8], ['oct', 9], ['nov', 10], ['dec', 11],
    ]

    // Extract year (4-digit number)
    const yearMatch = lower.match(/\b(202[0-9])\b/)
    const year = yearMatch ? parseInt(yearMatch[1]) : -1

    // Extract month name
    let month = -1
    for (const [name, idx] of MONTH_NAMES) {
      if (lower.includes(name)) { month = idx; break }
    }

    // Extract day — 1-2 digit number that is NOT the year and NOT adjacent to more digits
    let day = -1
    if (month !== -1) {
      // Remove year and month name from string, then look for a standalone 1-2 digit number
      let remaining = lower
      if (yearMatch) remaining = remaining.replace(yearMatch[1], '')
      for (const [name] of MONTH_NAMES) remaining = remaining.replace(name, '')
      const dayMatch = remaining.match(/\b(\d{1,2})\b/)
      if (dayMatch) {
        const d = parseInt(dayMatch[1])
        if (d >= 1 && d <= 31) day = d
      }
    }

    return this.posts.filter(p => {
      const d = new Date(p.date)
      const pYear = d.getUTCFullYear()
      const pMonth = d.getUTCMonth()
      const pDay = d.getUTCDate()

      // Only year specified
      if (month === -1 && year !== -1) return pYear === year

      // Only month specified (no year)
      if (month !== -1 && year === -1 && day === -1) return pMonth === month

      // Month + year (most common: "November 2025", "Jan 2026")
      if (month !== -1 && year !== -1 && day === -1) return pMonth === month && pYear === year

      // Month + day (no year)
      if (month !== -1 && day !== -1 && year === -1) return pMonth === month && pDay === day

      // Month + day + year (most specific: "Nov 19 2025")
      if (month !== -1 && day !== -1 && year !== -1) return pMonth === month && pDay === day && pYear === year

      return false
    })
  }

  /**
   * Main search — tries keyword and date together.
   * Returns formatted string ready for Claude to read.
   */
  search(query: string): string {
    const lower = query.toLowerCase()

    // "first post" / "first tweet"
    if (lower.includes('first post') || lower.includes('first tweet') || lower.includes('first ever')) {
      const first = this.getFirst()
      if (!first) return 'No posts found in archive.'
      return `First ever post (${new Date(first.date).toDateString()}):\n"${first.text}"`
    }

    // Check if it looks like a date query
    const DATE_SIGNALS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|\d{4}|\d{1,2}\/\d{1,2})\b/i
    const isDateQuery = DATE_SIGNALS.test(query)

    let results: OwnerPost[] = []

    if (isDateQuery) {
      results = this.searchByDate(query)
      // Also layer in keyword if there are extra non-date words
      const extraWords = query.replace(new RegExp(DATE_SIGNALS.source, 'gi'), '').replace(/\b(post|posts|tweet|tweets|say|said|wrote|write|about|on|the|my|i|did|do|what|when|where|which|how|in|at|of|a|an|ever|all|any)\b/gi, '').trim()
      if (extraWords.length > 2 && results.length > 10) {
        const kw = extraWords.toLowerCase()
        results = results.filter(p => p.text.toLowerCase().includes(kw))
      }
    } else {
      // Pure keyword search — strip question/filler words first, keep meaningful terms
      const FILLER = /\b(what|when|where|which|how|did|do|does|was|were|is|are|have|had|i|my|the|a|an|in|on|at|of|to|for|about|ever|all|any|post|posts|tweet|tweets|say|said|wrote|write|launch|launched|build|built|ship|shipped|release|released|publish|published)\b/gi
      const stripped = query.replace(FILLER, '').replace(/\s+/g, ' ').trim()
      const kw = stripped.length > 1 ? stripped : query
      results = this.searchByKeyword(kw)
    }

    if (results.length === 0) {
      return isDateQuery
        ? `No posts found matching "${query}". The archive covers ${this.posts.length} total posts from ${this.getFirst() ? new Date(this.getFirst()!.date).toDateString() : 'unknown'} onward.`
        : `No posts found matching "${query}".`
    }

    const lines = results.slice(0, 10).map(p => {
      const when = new Date(p.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
      const label = p.type === 'reply' ? ` [reply to @${p.replyTo}]` : p.type === 'autonomous' ? ' [auto-posted]' : ''
      return `[${when}]${label} "${p.text.slice(0, 200)}${p.text.length > 200 ? '...' : ''}"`
    })

    return `Found ${results.length} post${results.length > 1 ? 's' : ''} matching "${query}":\n\n${lines.join('\n\n')}`
  }

  get totalCount(): number { return this.posts.length }
}
