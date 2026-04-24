#!/usr/bin/env npx tsx
/**
 * Standalone script — Domain filter interview.
 * Q1: mode (domain vs viral)
 * Domain mode → Q2: confirm/edit topics, Q3: never-reply topics
 * Viral mode  → Q2: never-reply topics only
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import Anthropic from '@anthropic-ai/sdk'
import { config as dotenvConfig } from 'dotenv'

dotenvConfig({ path: path.join(process.cwd(), '.env') })
if (!process.env.ANTHROPIC_API_KEY) {
  const creatorsDir = path.join(process.cwd(), 'creators')
  if (fs.existsSync(creatorsDir)) {
    for (const d of fs.readdirSync(creatorsDir)) {
      const ep = path.join(creatorsDir, d, '.env')
      if (fs.existsSync(ep)) { dotenvConfig({ path: ep, override: false }); if (process.env.ANTHROPIC_API_KEY) break }
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
}

async function expandNeverKeywords(client: Anthropic, topics: string[]): Promise<string[]> {
  if (!topics.length) return []

  const allKeywords: string[] = []

  for (const topic of topics) {
    console.log(`\n  Expanding "${topic}"...`)

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Generate a keyword list for blocking "${topic}" content on Twitter.
Rules:
- Stay at the SAME level or MORE specific than "${topic}" — never go up to broader/parent categories
- Example: "bitcoin" → btc, satoshi, #bitcoin, lightning network — NOT crypto or blockchain (those are parent categories)
- Example: "politics" → trump, election, democrat, congress, senate — those ARE politics so include them
- Example: "trump" → maga, donald trump, trump coin — NOT politics (that is the parent)
Include: the term itself, aliases, acronyms, slang, hashtags, sub-topics, brand names directly under "${topic}".
Return ONLY a JSON array of strings, no explanation. Aim for 20-40 keywords.`
      }]
    })

    let keywords: string[] = []
    try {
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const match = text.match(/\[[\s\S]*\]/)
      if (match) keywords = JSON.parse(match[0])
    } catch {}

    if (!keywords.length) { allKeywords.push(topic); continue }

    console.log(`  "${topic}" keywords: ${keywords.join(', ')}\n`)
    console.log('  Remove any that look wrong, or press Enter to keep all:')
    const edit = await ask('  > ')

    if (edit.trim()) {
      const removed = edit.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      keywords = keywords.filter(k => !removed.some(r => k.toLowerCase().includes(r)))
      console.log(`  Got it.\n`)
    }

    allKeywords.push(...keywords)
  }

  return [...new Set(allKeywords)]
}

async function claudeInterpret(client: Anthropic, userSaid: string, context: string, returnFormat: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      system: 'Read the ENTIRE message carefully. The user may be adding, removing, or listing topics — figure out which. A single word or short phrase IS a valid topic. Return ONLY what is asked — no markdown, no explanation, no backticks.',
      messages: [{ role: 'user', content: `Context: ${context}\nUser said: "${userSaid}"\nReturn: ${returnFormat}` }],
    })
    const raw = res.content[0].type === 'text' ? res.content[0].text.trim() : ''
    return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  } catch { return '' }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.log('ANTHROPIC_API_KEY not found in .env'); process.exit(1) }
  const client = new Anthropic({ apiKey })

  const creatorsDir = path.join(process.cwd(), 'creators')
  const creators = fs.readdirSync(creatorsDir).filter(d =>
    fs.existsSync(path.join(creatorsDir, d, 'personality_profile.json'))
  )
  if (!creators.length) { console.log('No creator profiles found.'); process.exit(1) }

  let creatorName = creators[0]
  if (creators.length > 1) {
    console.log('Multiple creators found:')
    creators.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
    const pick = await ask('Pick number: ')
    creatorName = creators[parseInt(pick) - 1] ?? creators[0]
  }

  const profilePath = path.join(creatorsDir, creatorName, 'personality_profile.json')
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))

  const archiveTopics: string[] = profile.replyTopics ?? profile.dominantTopics ?? []

  console.log('\n' + '═'.repeat(58))
  console.log('  REPLY TARGETING')
  console.log('  Which tweets should Blopus reply to?')
  console.log('═'.repeat(58) + '\n')

  // Q1 — Mode first
  console.log('  [1] How should Blopus find tweets to reply to?')
  console.log('        1 · Domain mode — only tweets matching your topics (recommended)')
  console.log('        2 · Viral mode  — anything trending on your home timeline')
  let modeRaw = ''
  while (!['1', '2'].includes(modeRaw)) { modeRaw = await ask('  > ') }
  const replyMode = modeRaw === '1' ? 'domain' : 'viral'
  console.log(`  Got it — ${replyMode} mode\n`)

  let domainTopics = archiveTopics
  let neverTopics: string[] = []

  if (replyMode === 'domain') {
    // Q2 — Topics (only relevant in domain mode)
    console.log('  Your archive shows you engage with these topics:')
    archiveTopics.forEach((t, i) => console.log(`    ${i + 1}. ${t}`))
    console.log('\n  [2] Are these the right topics? Say what to keep, remove, or add.')
    console.log('      You can also just name topics you want — or press Enter to use all.')
    const q2 = await ask('  > ')

    if (q2.trim()) {
      const json = await claudeInterpret(
        client, q2,
        `Current archive topics: ${JSON.stringify(archiveTopics)}. The user may want to keep all, remove some, add new ones (including topics NOT in the archive like "food", "fitness", etc.), or replace the list entirely. Honor whatever they say.`,
        'A JSON array of the final list of topics. If user adds a new topic not in the archive, include it. Return ONLY a valid JSON array of strings.'
      )
      try { const p = JSON.parse(json); if (Array.isArray(p) && p.length) domainTopics = p } catch {}
    }
    console.log(`  Got it — topics: ${domainTopics.slice(0, 5).join(', ')}\n`)

    // Q3 — Never (domain mode)
    console.log('  [3] Any topics Blopus should NEVER reply to — even if they match your topics?')
    console.log('      e.g. "politics, religion, nsfw" — or press Enter to skip')
    const q3 = await ask('  > ')
    if (q3.trim()) {
      const json = await claudeInterpret(
        client, q3,
        'The user is listing topics they never want to reply to. Each word or phrase is a topic.',
        'A JSON array of never-reply topics. Return ONLY a valid JSON array of strings.'
      )
      try { neverTopics = JSON.parse(json) } catch { neverTopics = q3.split(',').map(t => t.trim()).filter(Boolean) }
    }
    if (neverTopics.length) console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)

  } else {
    // Viral mode — only ask never-topics
    console.log('  [2] Any topics Blopus should NEVER reply to — even if they trend?')
    console.log('      e.g. "politics, religion, nsfw" — or press Enter to skip')
    const q2 = await ask('  > ')
    if (q2.trim()) {
      const json = await claudeInterpret(
        client, q2,
        'The user is listing topics they never want to reply to. Each word or phrase is a topic.',
        'A JSON array of never-reply topics. Return ONLY a valid JSON array of strings.'
      )
      try { neverTopics = JSON.parse(json) } catch { neverTopics = q2.split(',').map(t => t.trim()).filter(Boolean) }
    }
    if (neverTopics.length) console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)
  }

  // Q — Replies per day (computed from archive reply data only)
  const bp = profile.behaviorProfile ?? {}
  const archiveRpd: number = bp.avgRepliesPerDay ?? 0
  const suggestedRpd = archiveRpd > 0 ? Math.round(archiveRpd) : null

  if (suggestedRpd) {
    console.log(`  Your archive shows you replied ~${suggestedRpd} times/day on average.`)
    console.log('  How many replies per day should Blopus send?')
    console.log(`      Press Enter to match your archive (${suggestedRpd}/day), or type a number.`)
  } else {
    console.log('  How many replies per day should Blopus send?')
    console.log('      e.g. "10", "20"')
  }
  const qRpd = await ask('  > ')
  let repliesPerDay: number
  if (qRpd.trim()) {
    const match = qRpd.match(/\d+/)
    repliesPerDay = match ? parseInt(match[0]) : suggestedRpd ?? 10
  } else {
    repliesPerDay = suggestedRpd ?? 10
  }
  console.log(`  Got it — ${repliesPerDay} replies/day\n`)

  // Expand never topics into full keyword list
  const neverKeywords = neverTopics.length ? await expandNeverKeywords(client, neverTopics) : []

  // Save
  if (replyMode === 'domain') profile.dominantTopics = domainTopics
  if (!profile.voiceProfile) profile.voiceProfile = {}
  profile.voiceProfile.neverTopics = neverKeywords
  profile.voiceProfile.replyMode = replyMode
  profile.voiceProfile.repliesPerDay = repliesPerDay
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  console.log('═'.repeat(58))
  console.log('  Saved to personality_profile.json')
  console.log(`  · Mode:         ${replyMode}`)
  if (replyMode === 'domain') console.log(`  · Topics:       ${domainTopics.slice(0, 4).join(', ')}`)
  console.log(`  · Never:        ${neverKeywords.slice(0, 6).join(', ') || 'nothing'}${neverKeywords.length > 6 ? ` (+${neverKeywords.length - 6} more)` : ''}`)
  console.log(`  · Replies/day:  ${repliesPerDay}`)
  console.log('═'.repeat(58) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
