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
      system: `Read the ENTIRE message carefully. The user may be adding, removing, or editing topics — figure out which.
CRITICAL RULE: If the user says "remove X" and X is a WORD that appears inside a topic name but is not the ENTIRE topic name, you must RENAME that topic by removing just that word — NOT delete the whole topic.
Examples:
- Topics: ["Religion and politics", "Food"] + user says "remove politics" → ["Religion", "Food"] (renamed, not deleted)
- Topics: ["Religion and politics in India", "Food"] + user says "remove politics" → ["Religion in India", "Food"] (renamed)
- Topics: ["Religion and politics", "Justice"] + user says "remove 2nd" → ["Religion and politics"] (deleted by position)
- Topics: ["Religion", "Politics", "Food"] + user says "remove politics" → ["Religion", "Food"] (deleted because it IS the full topic)
A single word or short phrase IS a valid topic. Return ONLY what is asked — no markdown, no explanation, no backticks.`,
      messages: [{ role: 'user', content: `Context: ${context}\nUser said: "${userSaid}"\nReturn: ${returnFormat}` }],
    })
    const raw = res.content[0].type === 'text' ? res.content[0].text.trim() : ''
    return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  } catch { return '' }
}

async function askTopicProfiles(
  client: Anthropic,
  topics: string[]
): Promise<Record<string, { engagementShare: number; knowledgeDepth: 'basic' | 'intermediate' | 'expert' }>> {
  const profiles: Record<string, { engagementShare: number; knowledgeDepth: 'basic' | 'intermediate' | 'expert' }> = {}

  console.log('\n  ─ Topic profiles — helps LLM know how deep to go per topic ─\n')
  console.log('  Your topics:')
  topics.forEach((t, i) => console.log(`    ${i + 1}. ${t}`))

  // Engagement share
  console.log('\n  Out of 100 replies, how many go to each topic?')
  console.log('  e.g. "1:40, 2:20, 3:15, 4:10, 5:10, 6:5" — or press Enter to split evenly')
  const shareInput = await ask('  > ')

  let shares: number[] = topics.map(() => Math.round(100 / topics.length))
  if (shareInput.trim()) {
    try {
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{ role: 'user', content: `Topics: ${JSON.stringify(topics)}\nUser said: "${shareInput}"\nReturn a JSON array of numbers (one per topic, in order) representing engagement share out of 100. Numbers must sum to ~100. Return ONLY a valid JSON array.` }],
      })
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const match = text.match(/\[[\s\S]*?\]/)
      if (match) { const p = JSON.parse(match[0]); if (Array.isArray(p) && p.length === topics.length) shares = p }
    } catch {}
  }

  // Knowledge depth
  console.log('\n  For each topic, your knowledge level:')
  console.log('    1 = basic (general takes only, don\'t go deep)')
  console.log('    2 = follows it closely (moderate depth ok)')
  console.log('    3 = deep expert (detailed, specific, confident)')
  console.log(`  e.g. "1:3, 2:2, 3:1, 4:1, 5:2, 6:2" — or describe: "expert in ${topics[0]}, basic in AI"`)
  const depthInput = await ask('  > ')

  let depths: ('basic' | 'intermediate' | 'expert')[] = topics.map(() => 'intermediate')
  if (depthInput.trim()) {
    try {
      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 200,
        messages: [{ role: 'user', content: `Topics: ${JSON.stringify(topics)}\nUser said: "${depthInput}"\nMap 1=basic, 2=intermediate, 3=expert. Return a JSON array of strings (one per topic, in order) — each value must be exactly "basic", "intermediate", or "expert". Return ONLY a valid JSON array.` }],
      })
      const text = res.content[0].type === 'text' ? res.content[0].text : ''
      const match = text.match(/\[[\s\S]*?\]/)
      if (match) { const p = JSON.parse(match[0]); if (Array.isArray(p) && p.length === topics.length) depths = p }
    } catch {}
  }

  topics.forEach((t, i) => {
    profiles[t] = {
      engagementShare: shares[i] ?? Math.round(100 / topics.length),
      knowledgeDepth: depths[i] ?? 'intermediate',
    }
  })

  console.log('\n  Topic profiles:')
  topics.forEach(t => {
    const pr = profiles[t]
    console.log(`    ${t}: ${pr.engagementShare}/100 replies, ${pr.knowledgeDepth}`)
  })
  console.log()

  return profiles
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

    // Q3 — Never (domain mode) — examples built from their actual chosen topics
    const neverExamples = domainTopics.slice(0, 2).map(t => {
      const tl = t.toLowerCase()
      if (tl.includes('gender') || tl.includes('relationship')) return `inside "${t}" — skip nsfw or explicit content`
      if (tl.includes('ai') || tl.includes('tech')) return `inside "${t}" — skip crypto debates`
      if (tl.includes('food') || tl.includes('lifestyle')) return `inside "${t}" — skip diet culture or weight loss content`
      if (tl.includes('animal') || tl.includes('nature')) return `inside "${t}" — skip hunting or animal farming debates`
      if (tl.includes('viral') || tl.includes('internet')) return `inside "${t}" — skip hate speech or slur-heavy content`
      if (tl.includes('indian') || tl.includes('society')) return `inside "${t}" — skip caste debates`
      if (tl.includes('justice') || tl.includes('account')) return `inside "${t}" — skip politically partisan takes`
      return `inside "${t}" — skip any sub-topic you find toxic or draining`
    })
    console.log('  [3] Any sub-topics to ALWAYS skip — even inside your chosen topics?')
    neverExamples.forEach(e => console.log(`      e.g. ${e}`))
    console.log('      Press Enter to skip if nothing comes to mind.')
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
    console.log('  [2] Any topics or content types Blopus should ALWAYS skip — even if they trend?')
    console.log('      e.g. "politics, religion, nsfw, crypto debates" — or press Enter to skip')
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

  // Topic profiles (engagement share + knowledge depth per topic)
  const topicProfiles = domainTopics.length ? await askTopicProfiles(client, domainTopics) : {}

  // Save
  if (replyMode === 'domain') profile.dominantTopics = domainTopics
  if (!profile.voiceProfile) profile.voiceProfile = {}
  profile.voiceProfile.neverTopics = neverKeywords
  profile.voiceProfile.replyMode = replyMode
  profile.voiceProfile.repliesPerDay = repliesPerDay
  profile.topicProfiles = topicProfiles
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  console.log('═'.repeat(58))
  console.log('  Saved to personality_profile.json')
  console.log(`  · Mode:         ${replyMode}`)
  if (replyMode === 'domain') console.log(`  · Topics:       ${domainTopics.slice(0, 4).join(', ')}`)
  console.log(`  · Never:        ${neverKeywords.slice(0, 6).join(', ') || 'nothing'}${neverKeywords.length > 6 ? ` (+${neverKeywords.length - 6} more)` : ''}`)
  console.log(`  · Replies/day:  ${repliesPerDay}`)
  if (Object.keys(topicProfiles).length) {
    console.log('  · Topic profiles:')
    Object.entries(topicProfiles).forEach(([t, p]) => console.log(`      ${t}: ${p.engagementShare}/100, ${p.knowledgeDepth}`))
  }
  console.log('═'.repeat(58) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
