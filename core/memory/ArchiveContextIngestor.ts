/**
 * ArchiveContextIngestor — automatically learns who the user is from their archive.
 *
 * Reads the most recent original tweets, asks Claude to infer:
 * - What they're currently working on
 * - Their goals and projects
 * - Key personal context
 *
 * Seeds UserContext so OsBot can answer personal questions accurately
 * from day one — no manual onboarding needed.
 *
 * Runs once per archive version at startup. Skips if already done.
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { UserContext } from '../../adapters/control/UserContext'

const client = new Anthropic()

export async function ingestContextFromArchive(
  archivePath: string,
  userContext: UserContext,
  ownerHandle: string,
  flagDir: string,
): Promise<boolean> {
  if (!fs.existsSync(archivePath)) return false

  // Skip if already ingested this archive version
  const flagPath = path.join(flagDir, 'archive_context_seed.hash')
  const stat = fs.statSync(archivePath)
  const archiveHash = `${stat.size}-${stat.mtimeMs}`
  if (fs.existsSync(flagPath) && fs.readFileSync(flagPath, 'utf-8') === archiveHash) {
    return false
  }

  console.log('[ArchiveContextIngestor] Reading recent tweets to infer user context...')

  // Parse archive
  const raw = fs.readFileSync(archivePath, 'utf-8').replace(/^window\.YTD\.tweets\.part0\s*=\s*/, '')
  const tweets: any[] = JSON.parse(raw).map((t: any) => t.tweet)

  // Get only original tweets (not replies, not starting with @handle)
  const originals = tweets
    .filter(t => !t.in_reply_to_screen_name || t.in_reply_to_screen_name.trim() === '')
    .filter(t => !t.full_text.startsWith('RT @'))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 40)  // most recent 40 originals

  if (originals.length === 0) {
    console.log('[ArchiveContextIngestor] No original tweets found in archive')
    return false
  }

  const tweetList = originals
    .map((t, i) => `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] ${t.full_text.replace(/https?:\/\/\S+/g, '').trim()}`)
    .join('\n')

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: `You extract key facts about a person from their Twitter posts.
Return ONLY a JSON array of fact objects. Each object has:
- "text": the fact, written in third person, concise (e.g. "Building Blopus — an autonomous AI agent framework for social media")
- "category": one of "work" | "goal" | "personal"

Rules:
- Only extract things clearly evident from multiple tweets — no guessing
- Focus on: current projects, what they're building, their goals, their industry/domain
- 3-6 facts maximum
- Omit generic things like "interested in AI" if everyone in tech is
- Return ONLY valid JSON array, no explanation`,
      messages: [{
        role: 'user',
        content: `Twitter handle: @${ownerHandle}\n\nTheir most recent original tweets:\n${tweetList}\n\nExtract key facts about what they're working on and their goals:`,
      }],
    })

    const content = response.content[0]
    if (content.type !== 'text') return false

    // Parse the JSON response — strip markdown fences if Claude wrapped it
    let jsonText = content.text.trim()
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const facts = JSON.parse(jsonText) as Array<{ text: string; category: string }>

    if (!Array.isArray(facts) || facts.length === 0) return false

    // Seed into UserContext — these are archive-derived, mark them as such
    for (const fact of facts) {
      const category = ['work', 'goal', 'personal'].includes(fact.category)
        ? fact.category as 'work' | 'goal' | 'personal'
        : 'work'
      userContext.addFact(`[from archive] ${fact.text}`, category)
    }

    // Write seed flag
    fs.mkdirSync(flagDir, { recursive: true })
    fs.writeFileSync(flagPath, archiveHash)

    console.log(`[ArchiveContextIngestor] Seeded ${facts.length} context facts from archive`)
    return true
  } catch (err) {
    console.warn('[ArchiveContextIngestor] Failed to ingest context:', err)
    return false
  }
}
