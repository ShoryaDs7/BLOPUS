#!/usr/bin/env npx tsx
/**
 * Expands each domain topic into 30-50 search keywords and writes
 * domainSearchKeywords into the creator's config.json.
 *
 * Usage:
 *   npm run expand-domains
 *   npm run expand-domains -- drsswaroop
 *   npx tsx scripts/expand-domains.ts drsswaroop
 *
 * Reads creator from CLI arg, then CREATOR env, then root .env.
 * Reads topics from personality_profile.json.
 * Writes domainSearchKeywords to config.json.
 */

import readline from 'readline'
import fs from 'fs'
import path from 'path'
import 'dotenv/config'
import dotenv from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
}

// ── Resolve creator name ───────────────────────────────────────
let creatorArg = process.argv[2]?.trim()

if (!creatorArg) {
  // Try root .env
  const rootEnvPath = path.resolve('.env')
  if (fs.existsSync(rootEnvPath)) {
    const parsed = dotenv.parse(fs.readFileSync(rootEnvPath, 'utf8'))
    creatorArg = parsed.CREATOR ?? process.env.CREATOR ?? ''
  } else {
    creatorArg = process.env.CREATOR ?? ''
  }
}

if (!creatorArg) {
  console.error('\nUsage: npx tsx scripts/expand-domains.ts <creatorName>')
  console.error('Or set CREATOR= in root .env\n')
  process.exit(1)
}

const creatorName = creatorArg
const creatorDir = path.resolve(`creators/${creatorName}`)

if (!fs.existsSync(creatorDir)) {
  console.error(`\nCreator folder not found: ${creatorDir}\n`)
  process.exit(1)
}

// Load creator .env so ANTHROPIC_API_KEY is available
dotenv.config({ path: path.join(creatorDir, '.env'), override: true })

const configPath = path.join(creatorDir, 'config.json')
const profilePath = path.join(creatorDir, 'personality_profile.json')

if (!fs.existsSync(configPath)) {
  console.error(`\nconfig.json not found in ${creatorDir} — run setup first.\n`)
  process.exit(1)
}
if (!fs.existsSync(profilePath)) {
  console.error(`\npersonality_profile.json not found in ${creatorDir} — run setup first.\n`)
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))

const topics: string[] = profile.dominantTopics ?? []
if (!topics.length) {
  console.error('\nNo dominantTopics found in personality_profile.json.\n')
  process.exit(1)
}

const anthropicKey = process.env.ANTHROPIC_API_KEY ?? ''
if (!anthropicKey) {
  console.error('\nANTHROPIC_API_KEY not found in creator .env.\n')
  process.exit(1)
}

// ── Keyword expander ──────────────────────────────────────────
async function expandDomainKeywords(topic: string, userContext: string): Promise<string[]> {
  const client = new Anthropic({ apiKey: anthropicKey })
  console.log(`\n  Expanding "${topic}"...`)

  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are building a keyword list to FIND tweets about "${topic}" on X (Twitter) for this user.

User context (their background, writing style, dominant interests):
${userContext}

Rules:
- Stay at the SAME level or MORE specific than "${topic}" — never go up to broader/parent categories
- Example: "startup" → founding, fundraising, YC, seed round, pivot, runway, product-market fit — NOT tech (parent)
- Example: "politics" → trump, election, BJP, Modi, congress, senate — those ARE politics so include them
- Example: "AI" → LLMs, GPT, Claude, Gemini, machine learning, fine-tuning — NOT tech (parent)
- Be context-aware: if user seems Indian, include Indian-relevant terms (e.g. for politics: BJPvsINC, NDA, not just congress)
- Include: the term itself, aliases, acronyms, slang, sub-topics, brand names, notable people IN this topic
- These are Twitter search terms — short phrases and keywords work better than long sentences
- Aim for 30-50 keywords. Return ONLY a JSON array of strings, no explanation.`
    }]
  })

  let keywords: string[] = []
  try {
    const text = res.content[0].type === 'text' ? res.content[0].text : ''
    const match = text.match(/\[[\s\S]*\]/)
    if (match) keywords = JSON.parse(match[0])
  } catch {}

  if (!keywords.length) return [topic]

  console.log(`\n  Keywords for "${topic}":\n  ${keywords.join(', ')}\n`)
  console.log('  Remove any that look wrong (comma-separated), or press Enter to keep all:')
  const edit = await ask('  > ')

  if (edit.trim()) {
    const removed = edit.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    keywords = keywords.filter(k => !removed.some(r => k.toLowerCase().includes(r)))
  }

  return [...new Set(keywords)]
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(58))
  console.log(`  Blopus — Domain keyword expansion`)
  console.log(`  Creator: ${creatorName}`)
  console.log('═'.repeat(58))
  console.log(`\n  Found ${topics.length} topics:\n${topics.map((t, i) => `    ${i + 1}. ${t}`).join('\n')}\n`)

  const existing = config.domainSearchKeywords as Record<string, string[]> | undefined
  if (existing && Object.keys(existing).length > 0) {
    console.log('  domainSearchKeywords already exists in config.json.')
    const overwrite = await ask('  Re-expand all topics? (yes / no): ')
    if (!/^y/i.test(overwrite)) {
      console.log('  Aborted — no changes made.\n')
      rl.close()
      return
    }
  }

  const userContext = JSON.stringify({
    dominantTopics: topics,
    writingStats: profile.writingStats ?? {},
    signaturePatterns: (profile.signaturePatterns ?? []).slice(0, 5),
  })

  const domainSearchKeywords: Record<string, string[]> = {}
  for (const topic of topics) {
    try {
      domainSearchKeywords[topic] = await expandDomainKeywords(topic, userContext)
    } catch (err) {
      console.warn(`  ⚠ Failed to expand "${topic}": ${err}`)
      domainSearchKeywords[topic] = [topic]
    }
  }

  config.domainSearchKeywords = domainSearchKeywords
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

  console.log('\n' + '─'.repeat(58))
  console.log(`  ✓ domainSearchKeywords written to creators/${creatorName}/config.json`)
  console.log(`  ${topics.length} topics expanded, ${Object.values(domainSearchKeywords).reduce((s, k) => s + k.length, 0)} total keywords`)
  console.log('─'.repeat(58) + '\n')

  rl.close()
}

main().catch(err => { console.error(err); process.exit(1) })
