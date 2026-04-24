#!/usr/bin/env npx tsx
/**
 * Standalone script — Voice Mode interview (Part 2).
 * Captures writing style only. Saves to voiceProfile.synthesized.
 * Run this if you skipped the full setup or want to redo your voice.
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

  const topics: string[] = profile.dominantTopics ?? []
  const archiveContext = JSON.stringify({
    writingStats:           profile.writingStats ?? {},
    dominantTopics:         profile.dominantTopics ?? [],
    signaturePatterns:      (profile.signaturePatterns ?? []).slice(0, 8),
    characteristicMentions: profile.writingStats?.characteristicMentions ?? [],
    topReplyExamples:       (profile.replyExamples ?? []).slice(0, 10),
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  VOICE MODE INTERVIEW — Writing Style')
  console.log('  Answer like you\'re texting. No right or wrong answers.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are conducting a voice interview to capture exactly how this person writes on X (Twitter).

You have their archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME to confirm/clarify what the archive found
- Prefix each question with [Q] so it's clear. Nothing else before the question.
- After each answer, output one line starting with "Got it —" summarizing what you learned, then ask the next question
- If an answer is vague (too short, "idk", "depends", etc.) — push for a NUMBER using the QUANTITATIVE RULES below
- Questions must be specific to THIS person's archive data. If archive shows all-lowercase, confirm it. If archive shows no emojis, confirm it. Don't ask generic questions.
- Cover ONLY writing style: case style, apostrophes, punctuation, length, emojis, how they start tweets, opening phrases for agree/disagree/own take. Do NOT ask about tagging patterns or reply-back behavior — covered in separate interviews.
- Ask 8-10 questions total. Track count with [x/10] prefix on each [Q].

QUANTITATIVE RULES — apply to EVERY frequency/style question:
- Always push for a NUMBER. Frame as: "out of 100 replies, how many would [X]?"
- If user says anything vague ("idk", "sometimes", "a little", "not much", "depends"): ask ONCE — "give me your best guess as a number out of 100"
- If they still won't give a number, convert: never→0, rarely/barely→5, sometimes/a little/occasionally→15, often/usually→60, mostly/almost always→80, always→95
- NEVER output vague words for frequency fields — always a number 0-100

OPENER FREQUENCY RULES — when asking about opening phrases for agree/disagree/own take:
- First get the exact phrases
- Then ALWAYS follow up: "Out of 100 replies where you [agree/disagree/have your own take], how many actually start with one of these — vs just responding naturally without a fixed opener?"
- This number goes in onAgreementFrequency / onDisagreementFrequency / onOwnTakeFrequency

EMOJI RULES — when asking about emoji:
- First get which emojis and in what context (e.g. "laughing and yawning in memes")
- Then ALWAYS follow up: "Which one do you use more — [emoji1], [emoji2], or equally?" — get a dominant one
- This goes in dominantEmoji

- When you have enough, output exactly: [INTERVIEW_DONE]
  Then on the next lines, output a JSON block (no markdown, just raw JSON) with this shape:
  {"caseStyle":"...","apostropheStyle":"...","replyLength":"...","emojiUsage":"...","dominantEmoji":"the single emoji used most, or empty","characteristicMentions":"...","onNewsWithTake":"...","onFactualClaim":"...","onAgreement":"exact phrases only","onAgreementFrequency":"number 0-100","onDisagreement":"exact phrases only","onDisagreementFrequency":"number 0-100","onOwnTake":"exact phrases only","onOwnTakeFrequency":"number 0-100","onFunny":"...","onControversial":"...","bannedPhrases":"...","neverTopics":"..."}

Never mention you're an AI. Never say "Great answer!" or "Excellent!". Keep it direct and conversational.`

  const messages: Array<{ role: 'user' | 'assistant', content: string }> = []
  messages.push({ role: 'user', content: 'Start the interview.' })

  // Robust JSON extractor — counts balanced braces so trailing LLM text never breaks parse
  const extractInterviewJSON = (text: string): Record<string, string> | null => {
    const after = text.slice(text.indexOf('[INTERVIEW_DONE]') + '[INTERVIEW_DONE]'.length)
    const cleaned = after.replace(/```(?:json)?\n?/g, '').replace(/```/g, '')
    const start = cleaned.indexOf('{')
    if (start === -1) return null
    let depth = 0, end = -1
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++
      else if (cleaned[i] === '}' && --depth === 0) { end = i; break }
    }
    if (end === -1) return null
    try { return JSON.parse(cleaned.slice(start, end + 1)) }
    catch (e) { console.warn('[Setup] Failed to parse interview JSON:', e); return null }
  }

  let structuredAnswers: Record<string, string> = {}
  let turnCount = 0

  while (turnCount < 30) {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: SYSTEM, messages,
    })
    const block = res.content?.[0]
    if (!block || block.type !== 'text') { turnCount++; continue }
    const claudeMsg = block.text.trim()
    messages.push({ role: 'assistant', content: claudeMsg })

    if (claudeMsg.includes('[INTERVIEW_DONE]')) {
      structuredAnswers = extractInterviewJSON(claudeMsg) ?? {}
      if (!structuredAnswers.caseStyle) console.warn('[Setup] Interview JSON missing fields — LLM may have output malformed JSON')
      break
    }

    claudeMsg.split('\n').filter((l: string) => l.trim()).forEach((l: string) => console.log(`  ${l}`))

    if (claudeMsg.includes('[Q]')) {
      const userInput = await ask('\n  > ')
      console.log()
      while (!userInput.trim()) { userInput = await ask('\n  > ') }
      messages.push({ role: 'user', content: userInput })
    }
    turnCount++
  }

  // ── Golden examples ──────────────────────────────────────────
  console.log('\n  ─ Golden examples — reply to these exactly as you would ─\n')

  let generatedTweets: string[] = []
  try {
    const topicList = topics.slice(0, 6).join(', ') || 'technology, startups, AI'
    const tweetRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{ role: 'user', content: `Generate 5 short realistic X tweets about: ${topicList}\nMix of hot takes, predictions, controversial opinions, wrong takes.\nOne tweet per line, no numbering, no quotes.` }],
    })
    const c = tweetRes.content[0]
    if (c.type === 'text') generatedTweets = c.text.trim().split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 15).slice(0, 5)
  } catch {
    generatedTweets = [
      'AI will replace most knowledge workers within 5 years.',
      'Most startups fail because founders build what they want, not what the market needs.',
      'Bitcoin will hit $500k by 2027.',
      'The best engineers right now can direct AI, not just write code.',
      'Most thought leaders on here have never shipped anything real.',
    ]
  }

  const goldenExamples: string[] = []
  for (let i = 0; i < generatedTweets.length; i++) {
    console.log(`  [${i + 1}/5] "${generatedTweets[i]}"`)
    const reply = await ask('  Your reply > ')
    if (reply && !/^skip$/i.test(reply)) { goldenExamples.push(reply); console.log('  Got it.\n') }
    else console.log('  Skipped.\n')
  }

  // ── Synthesize ───────────────────────────────────────────────
  console.log('  Synthesizing your voice profile...\n')
  let synthesized = ''
  try {
    const synthRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: `You are setting up an autonomous X bot that posts AS this exact person.

Confirmed writing style:
${JSON.stringify(structuredAnswers, null, 2)}

Their actual replies (golden examples — bot must match these exactly):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

Write 2-3 sentences describing exactly how this person writes. Be specific — reference their actual patterns. This gets injected directly into an LLM system prompt.` }],
    })
    const c = synthRes.content[0]
    if (c.type === 'text') synthesized = c.text.trim()
  } catch {
    synthesized = `Writes in ${structuredAnswers.caseStyle || 'mixed case'}. Replies are ${structuredAnswers.replyLength || 'short'}.`
  }

  console.log('─'.repeat(58))
  console.log('  VOICE PROFILE:\n')
  console.log('  ' + synthesized.split('\n').join('\n  '))
  console.log('─'.repeat(58))

  const confirm = await ask('\n  Does this sound like you? (yes / tell me what\'s off): ')
  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(confirm)) {
    synthesized += ` CORRECTION: ${confirm}`
    console.log('  Got it — noted.\n')
  }

  const splitList = (s: string) => (s || '').split(',').map((x: string) => x.trim()).filter(Boolean)

  const voiceProfile = {
    mode: 'interview' as const,
    caseStyle:              structuredAnswers.caseStyle ?? '',
    apostropheStyle:        structuredAnswers.apostropheStyle ?? '',
    replyLength:            structuredAnswers.replyLength ?? '',
    emojiUsage:             structuredAnswers.emojiUsage ?? '',
    dominantEmoji:          structuredAnswers.dominantEmoji ?? '',
    characteristicMentions: splitList(structuredAnswers.characteristicMentions),
    behaviorPatterns: {
      onNewsWithTake:          structuredAnswers.onNewsWithTake ?? '',
      onFactualClaim:          structuredAnswers.onFactualClaim ?? '',
      onAgreement:             structuredAnswers.onAgreement ?? '',
      onAgreementFrequency:    parseInt(structuredAnswers.onAgreementFrequency ?? '30') || 30,
      onDisagreement:          structuredAnswers.onDisagreement ?? '',
      onDisagreementFrequency: parseInt(structuredAnswers.onDisagreementFrequency ?? '30') || 30,
      onOwnTake:               structuredAnswers.onOwnTake ?? '',
      onOwnTakeFrequency:      parseInt(structuredAnswers.onOwnTakeFrequency ?? '30') || 30,
      onFunny:                 structuredAnswers.onFunny ?? '',
      onControversial:         structuredAnswers.onControversial ?? '',
    },
    goldenExamples,
    bannedPhrases: splitList(structuredAnswers.bannedPhrases),
    neverTopics:   splitList(structuredAnswers.neverTopics),
    synthesized,
    confirmedAt: new Date().toISOString(),
    // Preserve existing replyBehavior and originalPostProfile if already set
    replyBehavior:       profile.voiceProfile?.replyBehavior,
    originalPostProfile: profile.voiceProfile?.originalPostProfile,
  }

  if (!profile.voiceProfile) profile.voiceProfile = {}
  Object.assign(profile.voiceProfile, voiceProfile)
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  console.log('\n' + '═'.repeat(58))
  console.log('  Saved to personality_profile.json → voiceProfile')
  console.log('═'.repeat(58) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
