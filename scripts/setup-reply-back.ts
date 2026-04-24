#!/usr/bin/env npx tsx
/**
 * Reply Back interview — who you reply to and when.
 * Covers: own post comments, replies to your replies, mentions, conversation limits, blocklist.
 * Saves to voiceProfile.replyBackRules in personality_profile.json
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

  console.log('\n' + '═'.repeat(58))
  console.log('  REPLY BACK')
  console.log('  Who you reply to and when.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are interviewing a Twitter/X user to capture exactly who they reply back to and under what conditions.

Your job:
- Ask questions ONE AT A TIME
- Prefix each question with [Q]
- Every question requires a clear YES or NO answer first. Do not accept vague answers like "depends", "maybe", "sometimes". If the answer is vague, follow up immediately: "Just to confirm — yes or no?"
- After getting yes/no, ask follow-up only if needed (e.g. if yes to conditions, ask what the condition is)
- After each answer, output one line starting with "Got it —" then ask the next question
- Cover ALL of these in order — none are skippable:

  1. Do they reply to comments on their OWN original posts? (yes/no required)
     - If yes: do they reply to ALL comments or only ones that meet a condition? If condition, what is it?
  2. Do they reply when someone replies to THEIR reply on someone else's tweet? (yes/no required)
     - If yes: do they reply to ALL such replies or only ones that meet a condition? If condition, what is it?
  3. Conversation limit — after how many back-and-forth exchanges with the same person do they stop replying? (must give a number)
  4. Are there specific accounts they NEVER reply to? (yes/no required)
     - If yes: which @handles?

- Ask 4-6 questions total (follow-ups count). Track with [Q x/6].
- When done output exactly: [INTERVIEW_DONE]
  Then ONLY this raw JSON (no markdown, no backticks):
{
  "replyToOwnPostComments": true or false,
  "ownPostCommentCondition": "describe condition or empty string if reply to all",
  "replyToRepliesOnOthers": true or false,
  "replyToRepliesCondition": "describe condition or empty string if reply to all",
  "conversationLimit": number (how many back-and-forth before stopping),
  "neverReplyTo": ["@handle1", "@handle2"] or []
}

Never say you're an AI. No "Great answer!" Keep it direct. Force yes/no — never accept vague answers.`

  const messages: Array<{ role: 'user' | 'assistant', content: string }> = []

  const kickoff = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 350, system: SYSTEM,
    messages: [{ role: 'user', content: 'Start the interview.' }],
  })
  let assistantText = kickoff.content?.[0]?.type === 'text' ? kickoff.content[0].text.trim() : ''
  messages.push({ role: 'user', content: 'Start the interview.' })
  messages.push({ role: 'assistant', content: assistantText })

  let structuredAnswers: any = {}

  while (true) {
    if (assistantText.includes('[INTERVIEW_DONE]')) {
      const clean = assistantText.replace(/```json\s*/g, '').replace(/```\s*/g, '')
      const jsonStart = clean.indexOf('{', clean.indexOf('[INTERVIEW_DONE]'))
      if (jsonStart !== -1) {
        try { structuredAnswers = JSON.parse(clean.slice(jsonStart)) } catch {
          const match = clean.slice(jsonStart).match(/\{[\s\S]*\}/)
          if (match) { try { structuredAnswers = JSON.parse(match[0]) } catch {} }
        }
      }
      break
    }

    assistantText.split('\n').filter((l: string) => l.trim()).forEach((l: string) => console.log(`  ${l}`))

    let userInput = ''
    while (!userInput.trim()) { userInput = await ask('\n  > ') }
    console.log()
    messages.push({ role: 'user', content: userInput })

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 350, system: SYSTEM, messages,
    })
    assistantText = res.content?.[0]?.type === 'text' ? res.content[0].text.trim() : ''
    messages.push({ role: 'assistant', content: assistantText })
  }

  console.log('\n' + '─'.repeat(58))
  console.log('  REPLY BACK RULES:\n')
  console.log(`  Own post comments:      ${structuredAnswers.replyToOwnPostComments ? 'YES' : 'NO'}${structuredAnswers.ownPostCommentCondition ? ` — only if: ${structuredAnswers.ownPostCommentCondition}` : ''}`)
  console.log(`  Replies on others:      ${structuredAnswers.replyToRepliesOnOthers ? 'YES' : 'NO'}${structuredAnswers.replyToRepliesCondition ? ` — only if: ${structuredAnswers.replyToRepliesCondition}` : ''}`)
  console.log(`  Conversation limit:     ${structuredAnswers.conversationLimit} back-and-forth`)
  console.log(`  Never reply to:         ${structuredAnswers.neverReplyTo?.length ? structuredAnswers.neverReplyTo.join(', ') : 'none'}`)
  console.log('─'.repeat(58))

  const confirm = await ask('\n  Save these rules? (yes/no): ')
  if (/^yes|^y$|^yep|^yeah/i.test(confirm)) {
    if (!profile.voiceProfile) profile.voiceProfile = {}
    profile.voiceProfile.replyBackRules = {
      replyToOwnPostComments:   structuredAnswers.replyToOwnPostComments ?? false,
      ownPostCommentCondition:  structuredAnswers.ownPostCommentCondition ?? '',
      replyToRepliesOnOthers:   structuredAnswers.replyToRepliesOnOthers ?? false,
      replyToRepliesCondition:  structuredAnswers.replyToRepliesCondition ?? '',
      conversationLimit:        structuredAnswers.conversationLimit ?? 3,
      neverReplyTo:             structuredAnswers.neverReplyTo ?? [],
      confirmedAt:              new Date().toISOString(),
    }
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')
    console.log('\n  Saved → voiceProfile.replyBackRules')
  } else {
    console.log('\n  Not saved.')
  }

  console.log('\n' + '═'.repeat(58) + '\n')
  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
