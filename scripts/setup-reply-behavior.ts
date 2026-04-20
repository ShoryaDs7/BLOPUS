#!/usr/bin/env npx tsx
/**
 * Standalone script — "How You Reply" interview (Part 2b).
 * Captures reply-specific behaviors: tagging patterns, reactions, agree/disagree style.
 * Runs AFTER the voice interview. Saves to voiceProfile.replyBehavior.
 * Does NOT touch writing style, original posts, QT/RT/like settings.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import Anthropic from '@anthropic-ai/sdk'
import { config as dotenvConfig } from 'dotenv'

dotenvConfig({ path: path.join(process.cwd(), '.env') })

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
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

  // Archive context — reply-specific data only
  const ws = profile.writingStats ?? {}
  const vp = profile.voiceProfile ?? {}
  const archiveContext = JSON.stringify({
    replyTopics:             profile.replyTopics ?? profile.dominantTopics ?? [],
    characteristicMentions:  ws.characteristicMentions ?? [],
    signaturePatterns:       (profile.signaturePatterns ?? []).slice(0, 6).map((p: any) =>
      typeof p === 'string' ? p : { phrase: p.phrase, usedFor: p.usedFor, neverUsedFor: p.neverUsedFor }
    ),
    replyExamples:           (profile.replyExamples ?? []).slice(0, 10),
    existingBehaviorPatterns: vp.behaviorPatterns ?? null,
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  HOW YOU REPLY')
  console.log('  Reply-specific patterns — separate from your writing style.')
  console.log('  Answer like you\'re texting.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are interviewing a Twitter user about how they REPLY to other people's tweets.
This is NOT about their writing style (already captured elsewhere) — focus ONLY on reply-specific behaviors.

You have their archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME based on what you see in their archive
- Prefix each question with [Q] — nothing else before the question
- After each answer, output one line starting with "Got it —" summarizing what you learned, then ask the next
- If an answer is vague, follow up ONCE
- Cover ONLY reply-specific things — do NOT ask about writing style (case, emojis, length):
  1. Tagging patterns — who do they tag in replies and when? (e.g. @grok for AI comparisons, @elonmusk for company news) — archive has characteristicMentions, confirm/clarify
  2. Reaction to wrong takes — what do they do when someone is wrong or says something dumb?
  3. Reaction to content they agree with — how do they reply when they agree?
  4. Reaction to news/hot takes in their space — do they add their take, quote it, ignore it?
  5. Reply tone vs their posts — are replies more aggressive, more casual, shorter?
  6. Anything they NEVER do in replies (e.g. never argue back, never use sarcasm, never reply to bots)
- Ask 5-7 questions max. Skip anything already clear from the archive.
- When done, output exactly: [INTERVIEW_DONE]
  Then on the next lines output ONLY this raw JSON (no markdown, no backticks):
{
  "synthesized": "2-3 sentence paragraph describing their reply-specific behaviors — tagging patterns, reaction styles, tone in replies. This gets injected directly into the LLM prompt so write it as instructions TO the bot: 'When you disagree, you...', 'You tag @X when...'"
}`

  const messages: { role: 'user' | 'assistant', content: string }[] = []

  const kickoff = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Start the interview.' }],
  })

  let assistantText = kickoff.content[0].type === 'text' ? kickoff.content[0].text.trim() : ''
  messages.push({ role: 'user', content: 'Start the interview.' })
  messages.push({ role: 'assistant', content: assistantText })

  let result: any = null

  while (true) {
    if (assistantText.includes('[INTERVIEW_DONE]')) {
      const jsonStart = assistantText.indexOf('\n', assistantText.indexOf('[INTERVIEW_DONE]'))
      const jsonStr = assistantText.slice(jsonStart).trim()
      try { result = JSON.parse(jsonStr) } catch {
        const match = jsonStr.match(/\{[\s\S]*\}/)
        if (match) { try { result = JSON.parse(match[0]) } catch {} }
      }
      break
    }

    const lines = assistantText.split('\n')
    for (const line of lines) {
      if (line.startsWith('[Q]')) console.log(`\n  ${line.replace('[Q]', '').trim()}`)
      else if (line.startsWith('Got it')) console.log(`  ${line}`)
    }

    let userAnswer = ''
    while (!userAnswer.trim()) { userAnswer = await ask('  > ') }
    messages.push({ role: 'user', content: userAnswer })

    const next = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYSTEM,
      messages,
    })

    assistantText = next.content[0].type === 'text' ? next.content[0].text.trim() : ''
    messages.push({ role: 'assistant', content: assistantText })
  }

  if (!result?.synthesized) {
    console.log('\n  Could not parse result. Try running again.')
    rl.close()
    process.exit(1)
  }

  if (!profile.voiceProfile) profile.voiceProfile = {}
  profile.voiceProfile.replyBehavior = result
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  console.log('\n' + '═'.repeat(58))
  console.log('  Saved to personality_profile.json → voiceProfile.replyBehavior')
  console.log(`\n  ${result.synthesized}`)
  console.log('═'.repeat(58) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
