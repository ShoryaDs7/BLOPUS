/**
 * OwnerBiography — automatically builds a full chronological story of the owner
 * from their archive. Runs once on startup when any user uploads their tweets.js.
 *
 * Reads ALL original tweets, groups by month, extracts what was happening
 * each period. Answers questions like:
 * - "what was my first project?"
 * - "how did I evolve?"
 * - "when did I start caring about AI?"
 * - "tell me my full story"
 *
 * Stored at: creators/memory-store/owner_biography.json
 * Auto-rebuilds only when archive file changes.
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

export interface BiographyPeriod {
  period: string
  tweetCount: number
  summary: string
  keyTopics: string[]
  notableQuotes: string[]
}

export interface OwnerBiography {
  handle: string
  builtAt: string
  archiveHash: string
  totalTweets: number
  firstTweetDate: string
  latestTweetDate: string
  evolution: string
  periods: BiographyPeriod[]
}

function groupByMonth(tweets: any[]): Record<string, any[]> {
  const groups: Record<string, any[]> = {}
  for (const t of tweets) {
    const d = new Date(t.created_at)
    const key = d.toLocaleString('default', { month: 'short', year: 'numeric' })
    if (!groups[key]) groups[key] = []
    groups[key].push(t)
  }
  return groups
}

export async function buildOwnerBiography(
  archivePath: string,
  ownerHandle: string,
  outputPath: string,
): Promise<OwnerBiography | null> {
  if (!fs.existsSync(archivePath)) return null

  const stat = fs.statSync(archivePath)
  const archiveHash = `${stat.size}-${stat.mtimeMs}`

  // Skip if already built for this exact archive version
  if (fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as OwnerBiography
      if (existing.archiveHash === archiveHash) return existing
    } catch {}
  }

  console.log('[OwnerBiography] Building full biography from all tweets...')

  const raw = fs.readFileSync(archivePath, 'utf-8').replace(/^window\.YTD\.tweets\.part0\s*=\s*/, '')
  const tweets: any[] = JSON.parse(raw).map((t: any) => t.tweet)

  // All original tweets — oldest first — full history not just recent
  const originals = tweets
    .filter(t => !t.in_reply_to_screen_name || t.in_reply_to_screen_name.trim() === '')
    .filter(t => !t.full_text.startsWith('RT @'))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  if (originals.length === 0) return null

  const byMonth = groupByMonth(originals)
  const periods: BiographyPeriod[] = []

  for (const month of Object.keys(byMonth)) {
    const monthTweets = byMonth[month]
    const texts = monthTweets
      .map(t => t.full_text.replace(/https?:\/\/\S+/g, '').replace(/^(@\w+\s*)+/, '').trim())
      .filter(t => t.length > 20)
      .slice(0, 25)

    if (texts.length === 0) continue

    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `You summarize a person's tweets from one month. Respond with ONLY valid JSON, no markdown, no explanation.\nFormat: {"summary":"1-2 sentence description of what they focused on","keyTopics":["topic1","topic2","topic3"],"notableQuotes":["exact short quote from their tweets"]}`,
        messages: [{ role: 'user', content: `Month: ${month}\nTweets:\n${texts.map((t,i)=>`${i+1}. "${t}"`).join('\n')}\n\nRespond with JSON only.` }],
      })

      const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : null
      if (!raw) { console.warn(`[OwnerBiography] No text for ${month}`); continue }
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (!jsonMatch) { console.warn(`[OwnerBiography] No JSON for ${month}: ${raw.slice(0, 150)}`); continue }
      const parsed = JSON.parse(jsonMatch[0])
      periods.push({ period: month, tweetCount: monthTweets.length, summary: parsed.summary ?? '', keyTopics: parsed.keyTopics ?? [], notableQuotes: parsed.notableQuotes ?? [] })
    } catch (err) {
      console.warn(`[OwnerBiography] Failed ${month}:`, err)
      periods.push({ period: month, tweetCount: monthTweets.length, summary: `${monthTweets.length} tweets`, keyTopics: [], notableQuotes: [] })
    }
  }

  // Full evolution arc from all periods
  let evolution = ''
  try {
    const evoResp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: `Write ONE paragraph (4-5 sentences) describing how this person evolved over time. Focus on: what they started with, key transitions, what they became. Be specific — mention actual projects, topics, shifts. Third person.`,
      messages: [{ role: 'user', content: `@${ownerHandle} month by month:\n${periods.map(p=>`[${p.period}] ${p.summary}`).join('\n')}` }],
    })
    evolution = evoResp.content[0].type === 'text' ? evoResp.content[0].text.trim() : ''
  } catch (err) { console.warn('[OwnerBiography] Evolution failed:', err) }

  const bio: OwnerBiography = {
    handle: ownerHandle,
    builtAt: new Date().toISOString(),
    archiveHash,
    totalTweets: originals.length,
    firstTweetDate: originals[0].created_at,
    latestTweetDate: originals[originals.length - 1].created_at,
    evolution,
    periods,
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(bio, null, 2))
  console.log(`[OwnerBiography] Built — ${periods.length} months, ${originals.length} total tweets`)
  return bio
}

export function getBiographyContext(biographyPath: string): string {
  if (!fs.existsSync(biographyPath)) return ''
  try {
    const bio = JSON.parse(fs.readFileSync(biographyPath, 'utf-8')) as OwnerBiography
    const lines: string[] = [
      `=== @${bio.handle} full story from archive ===`,
      `First ever tweet: ${new Date(bio.firstTweetDate).toDateString()}`,
      `Total original posts: ${bio.totalTweets}`,
      `\nEvolution:\n${bio.evolution}`,
      '\nMonth by month:',
    ]
    for (const p of bio.periods) {
      lines.push(`\n[${p.period} — ${p.tweetCount} tweets] ${p.summary}`)
      if (p.keyTopics.length) lines.push(`  Topics: ${p.keyTopics.join(', ')}`)
      p.notableQuotes.forEach(q => lines.push(`  "${q}"`))
    }
    return lines.join('\n')
  } catch { return '' }
}
