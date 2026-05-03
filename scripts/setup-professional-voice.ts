#!/usr/bin/env npx tsx
/**
 * Professional voice interview — captures how the owner writes in formal contexts:
 * emails, GitHub comments, HN posts, Slack messages to strangers.
 * Run: npm run setup:pro-voice
 * Or called automatically from npm run setup (step after social voice).
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

export async function runProfessionalVoiceInterview(
  profilePath: string,
  apiKey: string,
  askFn: (q: string) => Promise<string> = ask
): Promise<void> {
  const client = new Anthropic({ apiKey })
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'))

  console.log('\n' + '═'.repeat(58))
  console.log('  PROFESSIONAL VOICE — Email / GitHub / HN')
  console.log('  Write exactly how you actually would. No need to')
  console.log('  sound formal — just be you in a work context.')
  console.log('═'.repeat(58) + '\n')

  const examples: { context: string; text: string }[] = []

  // Q1 — cold email opener
  console.log('  [1/4] You\'re emailing an investor or someone you\'ve')
  console.log('  never met, asking for 15 minutes.')
  console.log('  Write the opening 1-2 sentences exactly as you would.\n')
  const coldEmail = await askFn('  > ')
  if (coldEmail && !/^skip$/i.test(coldEmail)) {
    examples.push({ context: 'cold email opener to investor/stranger', text: coldEmail })
    console.log('  Got it.\n')
  }

  // Q2 — GitHub PR comment
  console.log('  [2/4] You\'re reviewing a GitHub PR. The code is good')
  console.log('  but you have one small suggestion.')
  console.log('  Write your comment.\n')
  const githubComment = await askFn('  > ')
  if (githubComment && !/^skip$/i.test(githubComment)) {
    examples.push({ context: 'GitHub PR review comment with suggestion', text: githubComment })
    console.log('  Got it.\n')
  }

  // Q3 — HN or forum disagreement
  console.log('  [3/4] Someone posted on HN: "TypeScript is pointless')
  console.log('  for startups, just use plain JS and ship faster."')
  console.log('  You disagree. Write your reply.\n')
  const hnComment = await askFn('  > ')
  if (hnComment && !/^skip$/i.test(hnComment)) {
    examples.push({ context: 'HN comment disagreeing with a take', text: hnComment })
    console.log('  Got it.\n')
  }

  // Q4 — sign-off + formality
  console.log('  [4/4] Two quick ones:')
  console.log('  a) How do you sign off emails? (e.g. "Best,", "Cheers,", just your name, nothing)')
  const signOff = await askFn('  > ')
  console.log()
  console.log('  b) Formality level 0-10 (0 = totally casual like texting a friend,')
  console.log('  10 = suit-and-tie corporate). What\'s your number for work emails?\n')
  const formalityRaw = await askFn('  > ')
  const formality = Math.min(10, Math.max(0, parseInt(formalityRaw.match(/\d+/)?.[0] ?? '5') || 5))
  console.log('  Got it.\n')

  if (examples.length === 0) {
    console.log('  No examples provided — skipping professional voice setup.')
    rl.close()
    return
  }

  // Synthesize from examples
  console.log('  Synthesizing your professional voice...\n')
  let synthesized = ''
  try {
    const examplesText = examples.map((e, i) => `Example ${i + 1} (${e.context}):\n"${e.text}"`).join('\n\n')
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `You are setting up an AI agent that writes emails, GitHub comments, and forum posts AS this exact person.

Here are their real examples of professional writing:
${examplesText}

Formality level they self-reported: ${formality}/10
Sign-off: "${signOff || 'none'}"

Write 2-3 sentences describing exactly how this person writes in professional contexts. Be specific — reference their actual patterns from the examples (sentence length, directness, tone, punctuation, how formal they really are). This gets injected directly into an LLM system prompt so it must be precise and actionable.

Do NOT say "the person writes" — write it as instructions, e.g. "Write in a direct, slightly casual tone..."`,
      }],
    })
    const c = res.content[0]
    if (c.type === 'text') synthesized = c.text.trim()
  } catch {
    synthesized = `Write in a direct, professional tone at formality level ${formality}/10. Sign off with "${signOff || 'your name'}".`
  }

  console.log('─'.repeat(58))
  console.log('  PROFESSIONAL VOICE:\n')
  console.log('  ' + synthesized.split('\n').join('\n  '))
  console.log('─'.repeat(58))

  const confirm = await askFn('\n  Does this capture how you write professionally? (yes / what\'s off): ')
  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(confirm.trim())) {
    synthesized += ` CORRECTION: ${confirm}`
    console.log('  Got it — noted.\n')
  }

  const professionalVoice = {
    synthesized,
    formality,
    signOff: signOff || '',
    goldenExamples: examples,
    confirmedAt: new Date().toISOString(),
  }

  if (!profile.professionalVoice) profile.professionalVoice = {}
  Object.assign(profile.professionalVoice, professionalVoice)
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8')

  console.log('\n' + '═'.repeat(58))
  console.log('  Saved to personality_profile.json → professionalVoice')
  console.log('═'.repeat(58) + '\n')
}

// ── Standalone runner ─────────────────────────────────────────
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.log('ANTHROPIC_API_KEY not found in .env'); process.exit(1) }

  const creatorsDir = path.join(process.cwd(), 'creators')
  const creators = fs.readdirSync(creatorsDir).filter(d =>
    fs.existsSync(path.join(creatorsDir, d, 'personality_profile.json'))
  )
  if (!creators.length) { console.log('No creator profiles found. Run npm run setup first.'); process.exit(1) }

  let creatorName = creators[0]
  if (creators.length > 1) {
    console.log('Multiple creators found:')
    creators.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
    const pick = await ask('Pick number: ')
    creatorName = creators[parseInt(pick) - 1] ?? creators[0]
  }

  const profilePath = path.join(creatorsDir, creatorName, 'personality_profile.json')
  await runProfessionalVoiceInterview(profilePath, apiKey)
  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
