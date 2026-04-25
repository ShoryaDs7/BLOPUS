#!/usr/bin/env npx tsx
/**
 * Blopus Setup — run once to configure your Blopus instance.
 * Usage: npm run setup
 */

import readline from 'readline'
import fs from 'fs'
import path from 'path'
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

async function askRequired(label: string, hint?: string): Promise<string> {
  while (true) {
    if (hint) console.log(`\n  ${hint}`)
    const val = await ask(`  ${label}: `)
    if (val) return val
    console.log('  (required — cannot be empty)')
  }
}

async function askOptional(label: string, hint?: string): Promise<string> {
  if (hint) console.log(`\n  ${hint}`)
  return ask(`  ${label} (Enter to skip): `)
}

async function askOrEnv(label: string, envKey: string, hint?: string): Promise<string> {
  const existing = process.env[envKey]?.trim()
  if (existing) { console.log(`  ✓ ${label}: found in .env\n`); return existing }
  return askRequired(label, hint)
}

async function askOptionalOrEnv(label: string, envKey: string): Promise<string> {
  const existing = process.env[envKey]?.trim()
  if (existing) { console.log(`  ✓ ${label}: found in .env\n`); return existing }
  return askOptional(label)
}

function hr() { console.log('─'.repeat(58)) }
function section(n: number, title: string) {
  console.log(`\n${'─'.repeat(58)}\n  Step ${n} — ${title}\n${'─'.repeat(58)}`)
}
async function askSkip(title: string, askFn: (q: string) => Promise<string>): Promise<boolean> {
  console.log(`\n${'─'.repeat(58)}`)
  console.log(`  ${title}`)
  const ans = await askFn('  Press Enter to do this now, or type "skip" to skip: ')
  return /^skip$/i.test(ans.trim())
}

// ─── Claude interpreter — used throughout setup ───────────────
async function claudeInterpret(client: Anthropic, userSaid: string, context: string, returnFormat: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: `You extract structured data from a person's natural language answer. CRITICAL: Read the ENTIRE sentence — do not latch onto the first word. If they say "yes but only X now", they mean ONLY X. If they say "yes" with nothing after, they accept the default. Never assume "yes" at the start means full acceptance if the rest of the sentence modifies it.
TOPIC EDITING RULE: If the user says "remove X" and X is a WORD that appears inside a topic name but is NOT the entire topic name, RENAME that topic by removing just that word — do NOT delete the whole topic.
Examples:
- Topics: ["Religion and communal politics", "Food"] + user says "remove communal politics" → ["Religion", "Food"] (renamed)
- Topics: ["Religion and politics", "Justice"] + user says "remove 2nd" → ["Religion and politics"] (deleted by position)
- Topics: ["Politics", "Food"] + user says "remove politics" → ["Food"] (deleted because it IS the full topic name)
Return ONLY what is asked — no markdown, no fences, no explanations.`,
      messages: [{ role: 'user', content: `Context: ${context}\nUser said: "${userSaid}"\nReturn: ${returnFormat}` }],
    })
    const raw = res.content[0].type === 'text' ? res.content[0].text.trim() : ''
    // Strip markdown code fences if Claude wraps JSON
    return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  } catch { return '' }
}

// Robust JSON extractor — counts balanced braces so trailing LLM text never breaks parse
function extractInterviewJSON(text: string): Record<string, string> | null {
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

// ─────────────────────────────────────────────────────────────
// Helper: follow-up if answer is too vague
function needsFollowUp(answer: string): boolean {
  return answer.trim().length < 6 || /^(depends|idk|not sure|maybe|dunno|unclear)$/i.test(answer.trim())
}

// ─── Part 2: Voice Mode Interview ────────────────────────────
async function runVoiceInterview(
  apiKey: string,
  computed: any,
  _ownerHandle: string,
  askFn: (q: string) => Promise<string>
): Promise<any> {
  const goldenExamples: string[] = []
  const topics: string[] = computed?.dominantTopics ?? []
  const client = new Anthropic({ apiKey })

  // Full computed context passed to Claude so it knows what was found
  const archiveContext = JSON.stringify({
    writingStats:            computed?.writingStats ?? {},
    dominantTopics:          computed?.dominantTopics ?? [],
    signaturePatterns:       (computed?.signaturePatterns ?? []).slice(0, 8),
    characteristicMentions:  computed?.writingStats?.characteristicMentions ?? [],
    topReplyExamples:        (computed?.replyExamples ?? []).slice(0, 10),
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 2 — VOICE MODE INTERVIEW')
  console.log('  Answer like you\'re texting. No right or wrong answers.')
  console.log('═'.repeat(58) + '\n')

  // ── Section 1+2: Claude conducts the interview ──────────────
  // Multi-turn: Claude generates each question based on archive data.
  // User answers via readline. Claude follows up if vague.
  // Ends when Claude outputs [INTERVIEW_DONE] with structured JSON.

  const SYSTEM = `You are conducting a voice interview to capture exactly how this person writes on X (Twitter).

You have their archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME to confirm/clarify what the archive found, and uncover things the archive can't detect (intent, reasoning, mechanics behind patterns)
- Prefix each question with [Q] so it's clear. Nothing else before the question.
- After each answer, output one line starting with "Got it —" summarizing what you learned, then ask the next question
- If an answer is vague (too short, "idk", "depends", etc.) — follow up ONCE before moving on
- Questions must be specific to THIS person's archive data. If archive shows all-lowercase, confirm it. If archive shows no emojis, confirm it. Don't ask generic questions that don't apply to what was found.
- Cover ONLY writing style: case style, apostrophes, punctuation, length, emojis, how they start tweets, line breaks, threads vs single tweets. Do NOT ask about tagging patterns, reactions to content, or reply behavior — that is covered in a separate interview.
- Ask 6-8 questions total. Track count with [x/8] prefix on each [Q].
- When you have enough, output exactly one line: [INTERVIEW_DONE]
  Nothing else — no JSON, no summary. The system extracts data separately.

Never mention you're an AI. Never say "Great answer!" or "Excellent!". Keep it direct and conversational.`

  const messages: Array<{ role: 'user' | 'assistant', content: string }> = []

  // Kick off the interview
  messages.push({ role: 'user', content: 'Start the interview.' })

  let structuredAnswers: Record<string, string> = {}
  let turnCount = 0
  const MAX_TURNS = 30

  while (turnCount < MAX_TURNS) {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: SYSTEM,
      messages,
    })
    const block = res.content?.[0]
    if (!block || block.type !== 'text') { turnCount++; continue }
    const claudeMsg = block.text.trim()
    messages.push({ role: 'assistant', content: claudeMsg })

    if (claudeMsg.includes('[INTERVIEW_DONE]')) break

    const lines = claudeMsg.split('\n').filter((l: string) => l.trim())
    for (const line of lines) console.log(`  ${line}`)

    const userInput = await askFn('\n  > ')
    console.log()
    messages.push({ role: 'user', content: userInput || '(no answer)' })
    turnCount++
  }

  // Dedicated extraction call — only job is outputting JSON, never truncated
  console.log('  Processing answers...')
  const VOICE_JSON_SCHEMA = `{"caseStyle":"","apostropheStyle":"","replyLength":"","emojiUsage":"","characteristicMentions":"","onNewsWithTake":"","onFactualClaim":"","onAgreement":"","onDisagreement":"","onFunny":"","onControversial":"","bannedPhrases":"","neverTopics":""}`
  try {
    const extractRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 800,
      messages: [...messages, { role: 'user', content: `Based on the interview above, fill in this JSON with what you learned. Output ONLY the JSON — no explanation, no markdown, no backticks:\n${VOICE_JSON_SCHEMA}` }]
    })
    const raw = extractRes.content?.[0]?.type === 'text' ? extractRes.content[0].text.trim() : ''
    const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim()
    const s = cleaned.indexOf('{')
    if (s !== -1) {
      let depth = 0, e = -1
      for (let i = s; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++
        else if (cleaned[i] === '}' && --depth === 0) { e = i; break }
      }
      if (e !== -1) { try { structuredAnswers = JSON.parse(cleaned.slice(s, e + 1)) } catch {} }
    }
  } catch {}

  // ── Hardcoded follow-ups — always asked, never delegated to Haiku ──────────
  const toNum = (s: string, fallback: number) => { const n = parseInt(s.match(/\d+/)?.[0] ?? ''); return isNaN(n) ? fallback : n }
  const skipRe = /^(skip|none|n\/a|no|-)$/i
  const archiveEmojiPct = parseInt(String(computed?.writingStats?.emojiUsage ?? '').match(/\d+/)?.[0] ?? '0')

  console.log('\n' + '─'.repeat(58))
  console.log('  A few quick follow-ups:\n')

  // Opener frequencies — always ask, ignore what Haiku may have extracted
  if (structuredAnswers.onAgreement) {
    const phrase = structuredAnswers.onAgreement.split(',')[0].trim()
    console.log(`  Out of 100 agreeing replies, how many start with "${phrase}" vs just responding naturally? [number]`)
    const f = await askFn('  > ')
    structuredAnswers.onAgreementFrequency = String(toNum(f, 30))
  }
  if (structuredAnswers.onDisagreement) {
    const phrase = structuredAnswers.onDisagreement.split(',')[0].trim()
    console.log(`\n  Out of 100 disagreeing replies, how many start with "${phrase}"? [number]`)
    const f = await askFn('  > ')
    structuredAnswers.onDisagreementFrequency = String(toNum(f, 30))
  }

  // Emoji follow-ups — always ask if archive shows any emoji usage
  if (archiveEmojiPct > 0 || structuredAnswers.emojiUsage) {
    if (!structuredAnswers.dominantEmoji) {
      console.log('\n  Which single emoji do you use most overall? (or "skip")')
      const e = await askFn('  > ')
      if (!skipRe.test(e.trim())) structuredAnswers.dominantEmoji = e.trim()
    }
    console.log('\n  Per-context emoji frequency — e.g. "laughing in ~60% of meme replies / yawning in ~30% of disagreeing"')
    console.log('  (or "skip" if you only use one emoji in one situation)')
    const ep = await askFn('  > ')
    if (!skipRe.test(ep.trim())) structuredAnswers.emojiPerContext = ep.trim()
  }

  // ── Section 3: Golden examples — bot generates tweets in user's topics ──
  console.log('\n  ─ Section 3: Your golden examples ─\n')
  console.log('  Generating 5 tweets in your topics...\n')

  let generatedTweets: string[] = []
  try {
    const topicList = topics.slice(0, 6).join(', ') || 'technology, startups, AI'
    const tweetRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Generate 5 short realistic X (Twitter) tweets about: ${topicList}

Mix of hot takes, factual claims, predictions, controversial opinions, wrong takes.
Make them feel like real tweets someone would post — specific, opinionated, not generic.
Output one tweet per line, no numbering, no quotes, no labels.`,
      }],
    })
    const c = tweetRes.content[0]
    if (c.type === 'text') {
      generatedTweets = c.text.trim().split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 15).slice(0, 5)
    }
  } catch {
    generatedTweets = [
      'AI will replace most knowledge workers within 5 years. The math is inevitable.',
      'Most startups fail because founders build what they want, not what the market needs.',
      'Bitcoin will hit $500k by 2027. The halving cycle is not a coincidence.',
      'The best engineers right now are the ones who can direct AI, not just write code.',
      'Most thought leaders on here have never actually shipped anything real.',
    ]
  }

  console.log('  Reply to each exactly how you would on X. Type "skip" to skip one.\n')
  for (let i = 0; i < generatedTweets.length; i++) {
    console.log(`  [${i + 1}/5] Tweet: "${generatedTweets[i]}"`)
    const reply = await askFn('  Your reply > ')
    if (reply.trim() && !/^skip$/i.test(reply.trim())) {
      goldenExamples.push(reply.trim())
      console.log(`  Got it — saved.\n`)
    } else {
      console.log('  Skipped.\n')
    }
  }

  // ── Synthesize with Claude ───────────────────────────────────
  console.log('  Synthesizing your voice profile...\n')

  let synthesized = ''
  try {
    const synthRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are setting up an autonomous X bot that posts AS this exact person.

Confirmed style:
${JSON.stringify(structuredAnswers, null, 2)}

Their actual replies (golden examples — bot must match these exactly):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

Write 2-3 sentences describing exactly how this person writes. Be specific — reference their actual patterns and examples. This gets injected directly into an LLM system prompt.`
      }]
    })
    const c = synthRes.content[0]
    if (c.type === 'text') synthesized = c.text.trim()
  } catch {
    synthesized = `Writes in ${structuredAnswers.caseStyle || 'lowercase'}. Replies are ${structuredAnswers.replyLength || 'short'}. ${structuredAnswers.onDisagreement ? 'When someone is wrong: ' + structuredAnswers.onDisagreement + '.' : ''}`
  }

  console.log('─'.repeat(58))
  console.log('  VOICE PROFILE:\n')
  console.log('  ' + synthesized.split('\n').join('\n  '))
  console.log('─'.repeat(58))

  const confirm = await askFn('\n  Does this sound like you? (yes / tell me what\'s off): ')
  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(confirm)) {
    synthesized += ` CORRECTION: ${confirm}`
    console.log('  Got it — noted.\n')
  }

  const splitList = (s: string) => (s || '').split(',').map((x: string) => x.trim()).filter(Boolean)

  return {
    mode: 'interview' as const,
    caseStyle:              structuredAnswers.caseStyle ?? '',
    apostropheStyle:        structuredAnswers.apostropheStyle ?? '',
    replyLength:            structuredAnswers.replyLength ?? '',
    emojiUsage:             structuredAnswers.emojiUsage ?? '',
    characteristicMentions: splitList(structuredAnswers.characteristicMentions),
    behaviorPatterns: {
      onNewsWithTake: structuredAnswers.onNewsWithTake ?? '',
      onFactualClaim: structuredAnswers.onFactualClaim ?? '',
      onAgreement:    structuredAnswers.onAgreement ?? '',
      onDisagreement: structuredAnswers.onDisagreement ?? '',
      onFunny:        structuredAnswers.onFunny ?? '',
      onControversial:structuredAnswers.onControversial ?? '',
    },
    goldenExamples,
    bannedPhrases: splitList(structuredAnswers.bannedPhrases),
    neverTopics:   splitList(structuredAnswers.neverTopics),
    synthesized,
    confirmedAt: new Date().toISOString(),
  }
}


// ─── Helper: map probability answer → 0.0–1.0 ────────────────
function parseProbability(answer: string): number {
  const a = answer.toLowerCase()
  if (/always|every|definitely|100/.test(a)) return 1.0
  if (/usually|most|often|80|70/.test(a)) return 0.75
  if (/sometimes|half|50/.test(a)) return 0.5
  if (/rarely|occasionally|seldom|25|20/.test(a)) return 0.25
  return 0.5  // default
}

function parseCooldown(answer: string): number {
  const a = answer.toLowerCase()
  // per-minute
  const perMin = a.match(/(\d+)\s*(?:times?\s+(?:a|per)\s+minute|\/min)/)
  if (perMin) return Math.round(60_000 / parseInt(perMin[1]))
  // every N minutes
  const evMin = a.match(/every\s+(\d+)\s*min/)
  if (evMin) return parseInt(evMin[1]) * 60_000
  // per hour variants: "X times an hour", "X/hr", "X an hour"
  const perHr = a.match(/(\d+)\s*(?:times?\s+(?:a|an|per)\s+hour|\/h(?:r|our)?)/)
  if (perHr) return Math.round(3_600_000 / parseInt(perHr[1]))
  // once an hour / every hour
  if (/once\s+(?:a|an|per)\s+hour|every\s+hour|hourly/.test(a)) return 3_600_000
  // every N hours
  const evHr = a.match(/every\s+(\d+)\s*h(?:r|ours?)?/)
  if (evHr) return parseInt(evHr[1]) * 3_600_000
  // per day variants: "X times a day", "X/day"
  const perDay = a.match(/(\d+)\s*(?:times?\s+(?:a|per)\s+day|\/day)/)
  if (perDay) return Math.round(86_400_000 / parseInt(perDay[1]))
  // once a day / daily
  if (/once\s+(?:a|per)\s+day|daily/.test(a)) return 86_400_000
  // twice / a couple
  if (/twice\s+(?:a|per)\s+day|2\s+(?:times?\s+)?(?:a|per)\s+day/.test(a)) return 43_200_000
  // few times a day
  if (/few\s+times\s+(?:a|per)\s+day|3\s+times\s+(?:a|per)\s+day/.test(a)) return 28_800_000
  // per week
  const perWeek = a.match(/(\d+)\s*(?:times?\s+(?:a|per)\s+week|\/week)/)
  if (perWeek) return Math.round(604_800_000 / parseInt(perWeek[1]))
  if (/once\s+(?:a|per)\s+week|weekly/.test(a)) return 604_800_000
  // fallback: try to extract a plain number (treat as minutes)
  const plain = a.match(/^(\d+)$/)
  if (plain) return parseInt(plain[1]) * 60_000
  return 3_600_000  // default 1 hour
}

// ─── Domain search keyword expander ──────────────────────────
async function expandDomainKeywords(
  topic: string,
  userContext: string,
  askFn: (q: string) => Promise<string>
): Promise<string[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  console.log(`\n  Expanding "${topic}" into search keywords...`)

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
- Be context-aware: infer the user's country/region from their archive topics and phrases, then include region-relevant terms (local parties, local slang, local platforms, local figures)
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
  const edit = await askFn('  > ')

  if (edit.trim()) {
    const removed = edit.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    keywords = keywords.filter(k => !removed.some(r => k.toLowerCase().includes(r)))
    console.log(`  Got it.\n`)
  }

  return [...new Set(keywords)]
}

// ─── Never keyword expander ───────────────────────────────────
async function expandNeverKeywords(input: string, askFn: (q: string) => Promise<string>): Promise<string[]> {
  if (!input || /^nothing$/i.test(input.trim())) return []

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const topics = input.split(',').map(s => s.trim()).filter(Boolean)
  const allKeywords: string[] = []

  // Each topic gets its own keyword set — no mixing
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
    const edit = await askFn('  > ')

    if (edit.trim()) {
      const removed = edit.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      keywords = keywords.filter(k => !removed.some(r => k.toLowerCase().includes(r)))
      console.log(`  Got it.\n`)
    }

    allKeywords.push(...keywords)
  }

  return [...new Set(allKeywords)]
}

// ─── Voice Validation ─────────────────────────────────────────
async function runVoiceValidation(
  apiKey: string,
  voiceProfile: any,
  personalityProfile: any,
  ownerHandle: string,
  askFn: (q: string) => Promise<string>,
): Promise<boolean> {
  const client = new Anthropic({ apiKey })
  const topics: string[] = personalityProfile?.dominantTopics ?? []
  const topicsToUse = topics.slice(0, 10)

  // Step 1: Generate sample tweets once — reused across feedback rounds
  console.log('\n' + '═'.repeat(58))
  console.log('  VOICE VALIDATION — Does this sound like you?')
  console.log('═'.repeat(58))
  console.log('\n  Generating 10 sample tweets across your topics...\n')

  const tweetGenRes = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Generate exactly ${topicsToUse.length} realistic tweets that someone might post on X, one for each of these topics:
${topicsToUse.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Rules:
- Each tweet should be a real opinion, hot take, news reaction, or question about that topic
- Varied styles: some short, some with stats, some controversial, some questions
- Do NOT write them as @${ownerHandle} — write them as other random users
- Return as JSON array of objects: [{"topic": "...", "author": "@randomuser", "text": "..."}]`
    }]
  })

  let sampleTweets: Array<{topic: string, author: string, text: string}> = []
  try {
    const raw = tweetGenRes.content[0].type === 'text' ? tweetGenRes.content[0].text : ''
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) sampleTweets = JSON.parse(match[0])
  } catch {}

  if (!sampleTweets.length) {
    console.log('  Could not generate sample tweets — skipping validation.')
    return true
  }

  // Helper: generate replies using current voice profile
  async function generateReplies(vp: any): Promise<Array<{topic: string, tweet: string, reply: string}>> {
    const pairs: Array<{topic: string, tweet: string, reply: string}> = []
    for (const t of sampleTweets) {
      try {
        const replyRes = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          system: `You are @${ownerHandle} — a real human on X. NOT a bot.
Voice profile: ${vp.synthesized}
Golden examples of how you reply:
${(vp.goldenExamples ?? []).map((e: string, i: number) => `${i + 1}. "${e}"`).join('\n')}
${vp.bannedPhrases?.length ? `NEVER do these (user said so): ${vp.bannedPhrases.join(', ')}` : ''}
${vp.characteristicMentions?.length ? `Only mention these accounts when genuinely relevant, not on every reply: ${vp.characteristicMentions.join(', ')}` : ''}
Write ONE reply in your exact voice. No explanation.`,
          messages: [{
            role: 'user',
            content: `Tweet by ${t.author}: "${t.text}"\n\nYour reply:`
          }]
        })
        const block = replyRes.content[0]
        const reply = block.type === 'text' ? block.text.trim() : ''
        if (reply) pairs.push({ topic: t.topic, tweet: t.text, reply })
      } catch {}
    }
    return pairs
  }

  // Helper: show pairs to user
  function showPairs(pairs: Array<{topic: string, tweet: string, reply: string}>) {
    console.log('\n  Here are 10 tweets and how the bot would reply as you:\n')
    pairs.forEach((p, i) => {
      console.log(`  [${i + 1}] Topic: ${p.topic.split('(')[0].trim()}`)
      console.log(`      Tweet: "${p.tweet.slice(0, 100)}${p.tweet.length > 100 ? '...' : ''}"`)
      console.log(`      Your reply: "${p.reply}"`)
      console.log()
    })
  }

  // Helper: patch voice profile using Claude based on user feedback
  async function patchVoiceProfile(vp: any, feedback: string): Promise<any> {
    console.log('\n  Updating voice profile based on your feedback...\n')
    const patchRes = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: `You are updating a Twitter bot's voice profile based on user feedback.
The voice profile controls how the bot sounds — its style, examples, banned phrases, mentions, etc.
Make surgical changes only — don't rewrite everything, just fix what the user complained about.
Return the FULL updated voice profile as valid JSON.`,
      messages: [{
        role: 'user',
        content: `Current voice profile:
${JSON.stringify(vp, null, 2)}

User feedback: "${feedback}"

Instructions:
- If user says "don't use @X every time" → remove @X from characteristicMentions OR add a note to synthesized like "only mentions @X occasionally, not on every reply"
- If user says replies are too long/short → update replyLength field and note in synthesized
- If user says "never say X" → add X to bannedPhrases
- If user says golden examples are wrong → remove bad ones, they'll add new ones
- If user says tone is off → update synthesized and behaviorPatterns accordingly
- Be specific and surgical — only change what the feedback targets

Return the complete updated voice profile JSON:`
      }]
    })

    try {
      const raw = patchRes.content[0].type === 'text' ? patchRes.content[0].text : ''
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) return JSON.parse(match[0])
    } catch {}
    return vp // fallback: unchanged
  }

  // Main feedback loop
  let currentProfile = { ...voiceProfile }
  let round = 0

  while (true) {
    round++
    if (round > 1) console.log('\n  Regenerating replies with updated voice...\n')
    else console.log('  Generating your replies in voice mode...\n')

    const pairs = await generateReplies(currentProfile)
    showPairs(pairs)

    console.log('  ─'.repeat(29))
    console.log('  Does this sound like you?')
    console.log('  • Type "yes" to save and continue')
    console.log('  • Type "redo" to redo the voice interview from scratch')
    console.log('  • Or just tell me what to fix (e.g. "don\'t use @grok every time", "make replies shorter")')
    console.log()
    const answer = await askFn('  > ')

    // Approved
    if (/^(yes|y|yeah|yep|correct|good|looks good|perfect|done|ok|okay|approve)/i.test(answer.trim())) {
      // Save patched profile back
      Object.assign(voiceProfile, currentProfile)
      console.log('\n  ✓ Voice profile saved.\n')
      return true
    }

    // Redo interview
    if (/^redo/i.test(answer.trim())) {
      return false
    }

    // Feedback — patch and re-show
    currentProfile = await patchVoiceProfile(currentProfile, answer)
    console.log('\n  Got it. Here\'s what changed:')

    // Show a brief summary of what was patched
    if (currentProfile.bannedPhrases?.length !== voiceProfile.bannedPhrases?.length) {
      console.log(`  → bannedPhrases updated: ${currentProfile.bannedPhrases?.join(', ')}`)
    }
    if (JSON.stringify(currentProfile.characteristicMentions) !== JSON.stringify(voiceProfile.characteristicMentions)) {
      console.log(`  → characteristicMentions updated: ${currentProfile.characteristicMentions?.join(', ') || 'none'}`)
    }
    if (currentProfile.replyLength !== voiceProfile.replyLength) {
      console.log(`  → replyLength updated: ${currentProfile.replyLength}`)
    }
  }
}

// ─── Part 4: Quote Tweet Interview ───────────────────────────
async function runQuoteTweetInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic): Promise<any> {
  const topics: string[] = computed?.dominantTopics ?? []
  const topicList = topics.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
  const topicsContext = `Archive topics (numbered):\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nRaw array: ${JSON.stringify(topics)}`

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 4 — QUOTE TWEETS')
  console.log('═'.repeat(58) + '\n')
  console.log('  Your computed topics from archive:')
  console.log(topicList + '\n')

  console.log('  [1/4] Which of these topics make you want to add your own take?')
  console.log('        (type the topics, "all", "none", or numbers like "1,3" or "only 2")')
  const q1 = await askFn('  > ')
  const topicsJson = await claudeInterpret(client, q1, topicsContext, 'A JSON array of topics the user wants to quote tweet about. IMPORTANT: if they said a number like "only 4" or "just 4" they mean topic #4 by its position number. If "all" return all. If "none" return []. Return ONLY a valid JSON array.')
  let quoteTopics: string[] = []
  try { quoteTopics = JSON.parse(topicsJson) } catch { quoteTopics = [] }
  console.log(`  Got it — quote tweet topics: ${quoteTopics.join(', ') || 'none'}\n`)

  console.log('  [2/4] What would you NEVER quote tweet? (topic, type, or "nothing")')
  const q2 = await askFn('  > ')
  const neverKeywords = await expandNeverKeywords(q2, askFn)
  console.log(`  Got it — ${q2}\n`)

  console.log('  [3/4] When a matching tweet shows up, how likely are you to quote it?')
  console.log('        (always / usually / sometimes / rarely) — be specific, not "depends"')
  const q3 = await askFn('  > ')
  const probStr = await claudeInterpret(client, q3, 'Question about likelihood of quoting a matching tweet', 'A decimal number between 0 and 1 representing probability. "always"=1.0, "usually"=0.75, "sometimes"=0.5, "rarely"=0.25. Return ONLY the number.')
  const probability = parseFloat(probStr) || 0.5
  console.log(`  Got it — probability: ${Math.round(probability * 100)}%\n`)

  console.log('  [4/4] How often do you quote tweet? (e.g. "once a day", "2 times a day", "every 4 hours")')
  console.log('        Be specific — not "it depends"')
  const q4 = await askFn('  > ')
  const cooldownStr = await claudeInterpret(client, q4, 'Question about quote tweet frequency', 'A number representing milliseconds between quote tweets. "once a day"=86400000, "twice a day"=43200000, "every 4 hours"=14400000, "2 times a day"=43200000. Return ONLY the number.')
  const cooldownMs = parseInt(cooldownStr) || 3_600_000
  console.log(`  Got it — cooldown: ${Math.round(cooldownMs / 60_000)} min between quote tweets\n`)

  return {
    topics: quoteTopics.length ? quoteTopics : (q1.toLowerCase() === 'none' ? [] : topics),
    never: neverKeywords,
    probability,
    cooldownMs,
    enabled: q1.toLowerCase() !== 'none',
  }
}

// ─── Part 5: Retweet Interview ────────────────────────────────
async function runRetweetInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic): Promise<any> {
  const topics: string[] = computed?.dominantTopics ?? []
  const topicList = topics.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
  const topicsContext = `Archive topics (numbered):\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nRaw array: ${JSON.stringify(topics)}`

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 5 — RETWEETS')
  console.log('═'.repeat(58) + '\n')
  console.log('  Your computed topics from archive:')
  console.log(topicList + '\n')

  console.log('  [1/4] Which of these topics do you retweet?')
  console.log('        (type the topics, "all", "none", or numbers like "1,3" or "only 2")')
  const q1 = await askFn('  > ')
  const topicsJson = await claudeInterpret(client, q1, topicsContext, 'A JSON array of topics the user retweets. IMPORTANT: if they said a number like "only 4" or "just 4" they mean topic #4 by its position number. If "all" return all. If "none" return []. Return ONLY a valid JSON array.')
  let retweetTopics: string[] = []
  try { retweetTopics = JSON.parse(topicsJson) } catch { retweetTopics = [] }
  console.log(`  Got it — retweet topics: ${retweetTopics.join(', ') || 'none'}\n`)

  console.log('  [2/4] What would you NEVER retweet? (topic, type, or "nothing")')
  const q2 = await askFn('  > ')
  const neverKeywords = await expandNeverKeywords(q2, askFn)
  console.log(`  Got it — ${q2}\n`)

  console.log('  [3/4] When a matching tweet shows up, how likely are you to retweet it?')
  console.log('        (always / usually / sometimes / rarely) — be specific, not "depends"')
  const q3 = await askFn('  > ')
  const probStr = await claudeInterpret(client, q3, 'Likelihood of retweeting a matching tweet', 'A decimal 0-1. "always"=1.0, "usually"=0.75, "sometimes"=0.5, "rarely"=0.25. Return ONLY the number.')
  const probability = parseFloat(probStr) || 0.5
  console.log(`  Got it — probability: ${Math.round(probability * 100)}%\n`)

  console.log('  [4/4] How often do you retweet? (e.g. "once a day", "2 times a day", "every 2 hours")')
  console.log('        Be specific — not "it depends"')
  const q4 = await askFn('  > ')
  const cooldownStr = await claudeInterpret(client, q4, 'Retweet frequency', 'Milliseconds between retweets. "once a day"=86400000, "twice a day"=43200000, "every 2 hours"=7200000. Return ONLY the number.')
  const cooldownMs = parseInt(cooldownStr) || 3_600_000
  console.log(`  Got it — cooldown: ${Math.round(cooldownMs / 60_000)} min between retweets\n`)

  return {
    topics: retweetTopics.length ? retweetTopics : (q1.toLowerCase() === 'none' ? [] : topics),
    never: neverKeywords,
    probability,
    cooldownMs,
    enabled: q1.toLowerCase() !== 'none',
  }
}

// ─── Part 6: Like Behavior Interview ─────────────────────────
async function runLikeInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic): Promise<any> {
  const topics: string[] = computed?.dominantTopics ?? []
  const topicList = topics.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
  const topicsContext = `Archive topics (numbered):\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nRaw array: ${JSON.stringify(topics)}`

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 6 — LIKES')
  console.log('═'.repeat(58) + '\n')
  console.log('  Your computed topics from archive:')
  console.log(topicList + '\n')

  console.log('  [1/4] Which of these topics do you like tweets about?')
  console.log('        (type the topics, "all", "none", or numbers like "1,3" or "only 2")')
  const q1 = await askFn('  > ')
  const topicsJson = await claudeInterpret(client, q1, topicsContext, 'A JSON array of topics the user likes tweets about. IMPORTANT: if they said a number like "only 4" or "just 4" they mean topic #4 by its position number. If "all" return all. If "none" return []. Return ONLY a valid JSON array.')
  let likeTopics: string[] = []
  try { likeTopics = JSON.parse(topicsJson) } catch { likeTopics = [] }
  console.log(`  Got it — like topics: ${likeTopics.join(', ') || 'none'}\n`)

  console.log('  [2/4] What would you NEVER like? (topic, type, or "nothing")')
  const q2 = await askFn('  > ')
  const neverKeywords = await expandNeverKeywords(q2, askFn)
  console.log(`  Got it — ${q2}\n`)

  console.log('  [3/4] When a matching tweet shows up, how likely are you to like it?')
  console.log('        (always / usually / sometimes / rarely) — be specific, not "depends"')
  const q3 = await askFn('  > ')
  const probStr = await claudeInterpret(client, q3, 'Likelihood of liking a matching tweet', 'A decimal 0-1. "always"=1.0, "usually"=0.75, "sometimes"=0.5, "rarely"=0.25. Return ONLY the number.')
  const probability = parseFloat(probStr) || 0.5
  console.log(`  Got it — probability: ${Math.round(probability * 100)}%\n`)

  console.log('  [4/4] How often do you like tweets? (e.g. "5 times an hour", "few times a day", "once an hour")')
  console.log('        Be specific — not "it depends"')
  const q4 = await askFn('  > ')
  const cooldownStr = await claudeInterpret(client, q4, 'Like frequency', 'Milliseconds between likes. "5 times an hour"=720000, "once an hour"=3600000, "few times a day"=28800000. Return ONLY the number.')
  const cooldownMs = parseInt(cooldownStr) || 3_600_000
  console.log(`  Got it — cooldown: ${Math.round(cooldownMs / 60_000)} min between likes\n`)

  return {
    topics: likeTopics.length ? likeTopics : (q1.toLowerCase() === 'none' ? [] : topics),
    never: neverKeywords,
    probability,
    cooldownMs,
    enabled: q1.toLowerCase() !== 'none',
  }
}

// ─── Part 2: How You Reply (merged voice + reply behavior) ───
async function runReplyInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic, replyModel: string): Promise<any> {
  const topics: string[] = computed?.dominantTopics ?? []
  const ws = computed?.writingStats ?? {}
  const archiveContext = JSON.stringify({
    writingStats:           ws,
    dominantTopics:         computed?.dominantTopics ?? [],
    replyTopics:            computed?.replyTopics ?? [],
    signaturePatterns:      (computed?.signaturePatterns ?? []).slice(0, 8).map((p: any) =>
      typeof p === 'string' ? p : { phrase: p.phrase, usedFor: p.usedFor, neverUsedFor: p.neverUsedFor }
    ),
    characteristicMentions: ws.characteristicMentions ?? [],
    replyExamples:          (computed?.replyExamples ?? []).slice(0, 10),
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  HOW YOU REPLY')
  console.log('  Writing style + reply patterns in one interview.')
  console.log('  Answer like you\'re texting.')
  console.log('═'.repeat(58) + '\n')

  // ── Skip menu if saved profile exists ───────────────────────
  const existingVP = computed?.voiceProfile
  let skipTo = ''
  if (existingVP?.synthesized) {
    console.log('  Saved profile found. Jump to:')
    console.log('  [1] Full interview (start over)')
    console.log('  [2] Golden examples only (keep saved interview answers)')
    console.log('  [3] Sample replies only (keep everything, just redo validation)')
    const pick = await askFn('\n  > ')
    if (pick.trim() === '2') skipTo = 'golden'
    else if (pick.trim() === '3') skipTo = 'samples'
    console.log()
  }

  const SYSTEM = `You are interviewing a Twitter user to capture exactly how they write and reply on X (Twitter).

You have their archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME based on what you see in the archive
- Prefix each question with [Q] — nothing else before it
- After each answer, output one line starting with "Got it —" then ask the next
- If an answer is vague ("depends", "it depends", "varies", "sometimes"), ALWAYS follow up: "Can you be more specific? Give me a concrete rule — e.g. 'short for hot takes, 2-3 sentences when explaining'. Don't say depends — give me the actual rule."
- Cover ALL of these (skip what's already obvious from the archive):
  WRITING STYLE:
  1. Case style — lowercase, mixed, proper? Archive has a reading, confirm it
  2. Apostrophes — "dont" or "don't"? Archive has a reading, confirm it
  3. Emojis — how often, which ones, or never?
  4. Reply length — one-liners vs sentences vs bullet points? If they say "depends on topic" push back: what's the rule? Short for X, longer for Y?
  5. How they start replies — signature openers or no fixed pattern?

  REPLY BEHAVIOR:
  6. Tagging patterns — who do they tag and when? Archive has characteristicMentions, confirm/clarify
     CRITICAL: If they mention ANY specific account (e.g. @grok, @elonmusk, @sama), immediately ask 3 follow-up questions before moving on:
       a. Which topics/domains do you use @[account] in?
       b. What type of tweet makes you tag them? (factual claim? wrong take? engagement?)
       c. Out of 100 replies, roughly how many would have @[account]?
  7. Wrong takes — what do they do when someone is wrong?
  8. Agreement — how do they reply when they agree?
  9. Hot takes / breaking news — do they jump in or stay out?
  10. What they NEVER do in replies
  11. How they OPEN a reply — exact first words or patterns when agreeing, disagreeing, or adding their own take. This is critical — ask explicitly: "What's the first thing you usually write when you agree with someone? When you disagree? When you have your own take?"
- Ask 8-12 questions total. Track count with [x/12] prefix on each [Q].
- When done output exactly one line: [INTERVIEW_DONE]
  Nothing else — no JSON, no summary. The system extracts data separately.

Never say you're an AI. No "Great answer!" Keep it direct.`

  let structuredAnswers: Record<string, string> = {}

  if (skipTo === 'golden' || skipTo === 'samples') {
    structuredAnswers = {
      caseStyle:               existingVP.caseStyle ?? '',
      apostropheStyle:         existingVP.apostropheStyle ?? '',
      replyLength:             existingVP.replyLength ?? '',
      emojiUsage:              existingVP.emojiUsage ?? '',
      onNewsWithTake:          existingVP.behaviorPatterns?.onNewsWithTake ?? '',
      onFactualClaim:          existingVP.behaviorPatterns?.onFactualClaim ?? '',
      onAgreement:             existingVP.behaviorPatterns?.onAgreement ?? '',
      onDisagreement:          existingVP.behaviorPatterns?.onDisagreement ?? '',
      onFunny:                 existingVP.behaviorPatterns?.onFunny ?? '',
      onControversial:         existingVP.behaviorPatterns?.onControversial ?? '',
      bannedPhrases:           (existingVP.bannedPhrases ?? []).join(','),
      tagUsagePattern:         existingVP.tagUsagePattern ?? '',
      replyBehaviorSynthesized: existingVP.replyBehavior?.synthesized ?? '',
    }
    console.log('  Using saved interview answers.\n')
  } else {
    const messages: Array<{ role: 'user' | 'assistant', content: string }> = []

    const kickoff = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 350, system: SYSTEM,
      messages: [{ role: 'user', content: 'Start the interview.' }],
    })
    let assistantText = kickoff.content?.[0]?.type === 'text' ? kickoff.content[0].text.trim() : ''
    messages.push({ role: 'user', content: 'Start the interview.' })
    messages.push({ role: 'assistant', content: assistantText })

    while (true) {
      if (assistantText.includes('[INTERVIEW_DONE]')) break

      assistantText.split('\n').filter((l: string) => l.trim()).forEach((l: string) => console.log(`  ${l}`))

      let userInput = ''
      while (!userInput.trim()) { userInput = await askFn('\n  > ') }
      console.log()
      messages.push({ role: 'user', content: userInput })

      const res = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: SYSTEM, messages,
      })
      assistantText = res.content?.[0]?.type === 'text' ? res.content[0].text.trim() : ''
      messages.push({ role: 'assistant', content: assistantText })
    }

    // Dedicated extraction call
    console.log('  Processing answers...')
    const REPLY_JSON_SCHEMA = `{"caseStyle":"","apostropheStyle":"","replyLength":"","emojiUsage":"","onNewsWithTake":"","onFactualClaim":"","onAgreement":"exact phrases comma separated","onAgreementFrequency":"number 0-100","onDisagreement":"exact phrases comma separated","onDisagreementFrequency":"number 0-100","onOwnTake":"exact phrases comma separated","onOwnTakeFrequency":"number 0-100","onFunny":"","onControversial":"","openingStyle":"exact openers: when agreeing: ..., when disagreeing: ..., when own take: ...","bannedPhrases":"","tagUsagePattern":"","replyBehaviorSynthesized":""}`
    try {
      const extractRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 800,
        messages: [...messages, { role: 'user', content: `Based on the interview above, fill in this JSON with what you learned. Output ONLY the JSON — no explanation, no markdown, no backticks:\n${REPLY_JSON_SCHEMA}` }]
      })
      const raw = extractRes.content?.[0]?.type === 'text' ? extractRes.content[0].text.trim() : ''
      const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim()
      const s = cleaned.indexOf('{')
      if (s !== -1) {
        let depth = 0, e = -1
        for (let i = s; i < cleaned.length; i++) {
          if (cleaned[i] === '{') depth++
          else if (cleaned[i] === '}' && --depth === 0) { e = i; break }
        }
        if (e !== -1) { try { structuredAnswers = JSON.parse(cleaned.slice(s, e + 1)) } catch {} }
      }
    } catch {}
  }

  // ── Golden examples — dynamic per domain (Math.max(2, round(8/domains))) ──
  console.log('\n  ─ Golden examples — reply exactly as you would ─\n')

  // dominantTopics is already updated by step 12 before runReplyInterview is called
  const confirmedReplyTopics: string[] = (computed?.dominantTopics ?? computed?.replyTopics ?? topics).filter((t: string) => t)

  const perDomain = Math.max(2, Math.round(8 / confirmedReplyTopics.length))

  let tweetPairs: { tweet: string, label: string }[] = []
  try {
    const tweetRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
      messages: [{ role: 'user', content:
        `Generate ${perDomain} short realistic X tweets per topic. Topics: ${confirmedReplyTopics.join(', ')}

For each topic output exactly ${perDomain} tweets, alternating:
- Odd position: a wrong or dumb take about that topic (something this person would want to correct)
- Even position: a tweet they'd strongly agree with OR breaking news in that topic

RULES: output ONLY the tweet text. No topic labels, no headers, no numbering, no quotes, no lines ending with a colon. Every line must be a complete tweet someone would actually post.`
      }],
    })
    const c = tweetRes.content[0]
    if (c.type === 'text') {
      const lines = c.text.trim().split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 15 && !l.startsWith('#') && !l.startsWith('*') && !/^\d+\./.test(l) && !l.endsWith(':'))
      lines.forEach((tweet, i) => tweetPairs.push({
        tweet,
        label: i % 2 === 0 ? '[wrong take]' : '[agree/news]',
      }))
    }
  } catch {
    confirmedReplyTopics.forEach(t => {
      for (let j = 0; j < perDomain; j++) {
        tweetPairs.push({
          tweet: j % 2 === 0 ? `Hot take: most people misunderstand ${t} completely.` : `This is the most underrated thing about ${t}.`,
          label: j % 2 === 0 ? '[wrong take]' : '[agree/news]',
        })
      }
    })
  }

  let goldenExamples: string[] = []
  let neverReplyTypes: string[] = []

  if (skipTo === 'samples') {
    goldenExamples = existingVP?.goldenExamples ?? []
    neverReplyTypes = existingVP?.neverReplyTypes ?? []
    console.log(`  Using ${goldenExamples.length} saved golden examples.\n`)
  } else {
    console.log('  (type "na" if you wouldn\'t reply to a tweet at all)\n')
    for (let i = 0; i < tweetPairs.length; i++) {
      const { tweet } = tweetPairs[i]
      console.log(`  [${i + 1}/${tweetPairs.length}] "${tweet}"`)
      let userInput = ''
      while (!userInput.trim()) { userInput = await askFn('\n  > ') }
      console.log()
      if (/^na$/i.test(userInput)) { neverReplyTypes.push(tweet); console.log('  Got it — skipping this type.\n') }
      else if (/^skip$/i.test(userInput)) { console.log('  Skipped.\n') }
      else { goldenExamples.push(userInput); console.log('  Got it.\n') }
    }
  }

  // ── Synthesize writing style ─────────────────────────────────
  const splitList = (s: string) => (s || '').split(',').map((x: string) => x.trim()).filter(Boolean)

  let synthesized = (existingVP?.synthesized ?? '').split('\n').filter((l: string) => !l.startsWith('#')).join('\n').trim()
  if (skipTo === 'samples' && synthesized) {
    console.log('  Using saved synthesized style.\n')
  } else {
    console.log('  Synthesizing your voice profile...\n')
    synthesized = ''
    try {
      const synthRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: `You are setting up an autonomous X bot posting AS this exact person.

Confirmed writing style:
${JSON.stringify(structuredAnswers, null, 2)}

Their actual replies (golden examples — bot must match these exactly):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}
${neverReplyTypes.length ? `\nTweet types they do NOT reply to:\n${neverReplyTypes.map((t, i) => `${i + 1}. "${t}"`).join('\n')}` : ''}

Write 2-3 sentences describing ONLY how this person writes (style, tone, structure, length). No reply behaviors. Injected into every LLM prompt.` }],
      })
      const c = synthRes.content[0]
      if (c.type === 'text') synthesized = c.text.trim().split('\n').filter((l: string) => !l.startsWith('#')).join('\n').trim()
    } catch {
      synthesized = `Writes in ${structuredAnswers.caseStyle || 'mixed case'}. Replies are ${structuredAnswers.replyLength || 'short'}.`
    }
  }

  console.log('─'.repeat(58))
  console.log('  YOUR WRITING STYLE:\n')
  console.log('  ' + synthesized.split('\n').join('\n  '))
  console.log('─'.repeat(58))

  const confirm = await askFn('\n  Does this sound like you? (yes / tell me what\'s off): ')
  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(confirm)) {
    synthesized += ` CORRECTION: ${confirm}`
    console.log('  Got it — noted.\n')
  }

  // ── Sample reply validation — one per topic, retry until approved ──
  console.log('\n' + '─'.repeat(58))
  console.log('  Here\'s how I\'d reply on each of your topics.\n  Tell me if any don\'t sound like you.\n')

  const globalCorrections: string[] = []

  const openerFreqLine = (() => {
    const parts: string[] = []
    if (structuredAnswers.onAgreement) parts.push(`when agreeing (~${structuredAnswers.onAgreementFrequency ?? 30}/100 replies use an opener): occasionally open with one of: ${structuredAnswers.onAgreement} — the rest jump straight to the point`)
    if (structuredAnswers.onDisagreement) parts.push(`when disagreeing (~${structuredAnswers.onDisagreementFrequency ?? 30}/100): occasionally open with one of: ${structuredAnswers.onDisagreement} — the rest jump straight in`)
    if (structuredAnswers.onOwnTake) parts.push(`when adding own take (~${structuredAnswers.onOwnTakeFrequency ?? 30}/100): occasionally open with one of: ${structuredAnswers.onOwnTake} — the rest jump straight in`)
    return parts.length ? `OPENERS (occasional, not always — follow the frequencies):\n${parts.map(p => `- ${p}`).join('\n')}` : ''
  })()

  const buildReplyPrompt = (tweet: string, topicCorrection?: string) => `Reply to this tweet AS this person. Be them exactly.

Tweet: "${tweet}"

Writing style: ${synthesized}
Case: ${structuredAnswers.caseStyle || 'lowercase'}
STRICT LENGTH RULE: ${structuredAnswers.replyLength || 'short one-liners by default. Only expand to 2-3 sentences when explaining something. Never more than 3 sentences.'}
${openerFreqLine}
${structuredAnswers.tagUsagePattern ? `Tagging rule: ${structuredAnswers.tagUsagePattern}` : ''}
NEVER use: ${splitList(structuredAnswers.bannedPhrases ?? '').join(', ') || 'nothing specified'}
Reply behavior: ${structuredAnswers.replyBehaviorSynthesized ?? ''}
${globalCorrections.length ? `\nRULES FROM PREVIOUS CORRECTIONS (apply to ALL replies):\n${globalCorrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : ''}

Golden examples — match this exact voice and length:
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}
${topicCorrection ? `\nPrevious attempt was wrong — fix this: ${topicCorrection}` : ''}

Return ONLY the reply text.`

  for (const topic of confirmedReplyTopics) {
    try {
      const tweetRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 80,
        messages: [{ role: 'user', content: `Write one short realistic X tweet about "${topic}" — a hot take, opinion, or claim. Under 20 words. No quotes, no numbering.` }],
      })
      const tc = tweetRes.content[0]
      if (!tc || tc.type !== 'text') continue
      const sampleTweet = tc.text.trim()

      console.log(`  [${topic}]`)
      console.log(`  Tweet: "${sampleTweet}"`)

      let topicCorrection = ''
      let approved = false
      while (!approved) {
        const replyRes = await client.messages.create({
          model: replyModel, max_tokens: 120,
          messages: [{ role: 'user', content: buildReplyPrompt(sampleTweet, topicCorrection || undefined) }],
        })
        const rc = replyRes.content[0]
        if (!rc || rc.type !== 'text') break
        console.log(`  Reply: "${rc.text.trim()}"`)
        const fb = await askFn('  Correct? (yes / tell me what\'s off): ')
        if (/^yes|^y$|^yep|^yeah/i.test(fb.trim())) {
          approved = true
          console.log()
        } else if (fb.trim()) {
          topicCorrection = fb.trim()
          globalCorrections.push(fb.trim())
          synthesized += ` RULE: ${fb.trim()}`
          console.log('  Retrying...\n')
        } else {
          break
        }
      }
    } catch {}
  }

  return {
    mode: 'interview' as const,
    caseStyle:              structuredAnswers.caseStyle ?? '',
    apostropheStyle:        structuredAnswers.apostropheStyle ?? '',
    replyLength:            structuredAnswers.replyLength ?? '',
    emojiUsage:             structuredAnswers.emojiUsage ?? '',
    characteristicMentions: splitList(structuredAnswers.characteristicMentions ?? ''),
    behaviorPatterns: {
      onNewsWithTake:  structuredAnswers.onNewsWithTake ?? '',
      onFactualClaim:  structuredAnswers.onFactualClaim ?? '',
      onAgreement:     structuredAnswers.onAgreement ?? '',
      onDisagreement:  structuredAnswers.onDisagreement ?? '',
      onFunny:         structuredAnswers.onFunny ?? '',
      onControversial: structuredAnswers.onControversial ?? '',
    },
    goldenExamples,
    neverReplyTypes,
    tagUsagePattern: structuredAnswers.tagUsagePattern ?? '',
    bannedPhrases:   splitList(structuredAnswers.bannedPhrases ?? ''),
    neverTopics:     [],
    synthesized,
    confirmedAt:     new Date().toISOString(),
    replyBehavior:   structuredAnswers.replyBehaviorSynthesized
      ? { synthesized: structuredAnswers.replyBehaviorSynthesized }
      : existingVP?.replyBehavior,
    originalPostProfile: existingVP?.originalPostProfile,
  }
}

// ─── Part 2b: How You Reply Interview ────────────────────────
async function runReplyBehaviorInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic): Promise<{ synthesized: string } | null> {
  const ws = computed?.writingStats ?? {}
  const vp = computed?.voiceProfile ?? {}
  const archiveContext = JSON.stringify({
    replyTopics:             computed?.replyTopics ?? computed?.dominantTopics ?? [],
    characteristicMentions:  ws.characteristicMentions ?? [],
    signaturePatterns:       (computed?.signaturePatterns ?? []).slice(0, 6).map((p: any) =>
      typeof p === 'string' ? p : { phrase: p.phrase, usedFor: p.usedFor, neverUsedFor: p.neverUsedFor }
    ),
    replyExamples:           (computed?.replyExamples ?? []).slice(0, 10),
    existingBehaviorPatterns: vp.behaviorPatterns ?? null,
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  HOW YOU REPLY')
  console.log('  Reply-specific patterns — separate from your writing style.')
  console.log('  Answer like you\'re texting.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are interviewing a Twitter user about how they REPLY to other people's tweets.
This is NOT about writing style (already captured) — focus ONLY on reply-specific behaviors.

Archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME based on what you see in their archive
- Prefix each question with [Q] — nothing else before the question
- After each answer, output one line starting with "Got it —" then ask the next
- If answer is vague, follow up ONCE
- Cover ONLY reply-specific things — do NOT ask about case style, emojis, or length:
  1. Tagging patterns — who do they tag in replies and when? Archive has characteristicMentions — confirm/clarify
  2. Reaction to wrong takes — what do they do when someone is wrong?
  3. Reaction to content they agree with
  4. Reply tone vs their posts — more aggressive? more casual?
  5. Anything they NEVER do in replies
- Ask 5-7 questions max. Skip anything clear from archive.
- When done, output exactly: [INTERVIEW_DONE]
  Then ONLY this raw JSON (no markdown, no backticks):
{
  "synthesized": "2-3 sentence paragraph describing reply-specific behaviors. Write as instructions TO the bot: 'When you disagree, you...', 'You tag @X when...'"
}`

  const messages: { role: 'user' | 'assistant', content: string }[] = []

  const kickoff = await client.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: SYSTEM,
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
    while (!userAnswer.trim()) { userAnswer = await askFn('  > ') }
    messages.push({ role: 'user', content: userAnswer })

    const next = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: SYSTEM, messages,
    })

    assistantText = next.content[0].type === 'text' ? next.content[0].text.trim() : ''
    messages.push({ role: 'assistant', content: assistantText })
  }

  return result?.synthesized ? result : null
}

// ─── Part 7: DM Style Interview (engagement mode) ────────────

// ─── Part 7: Reply Back Interview ────────────────────────────
async function runReplyBackInterview(askFn: (q: string) => Promise<string>, client: Anthropic): Promise<any> {
  console.log('\n' + '═'.repeat(58))
  console.log('  REPLY BACK')
  console.log('  Who you reply to and when.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are interviewing a Twitter/X user to capture exactly who they reply back to and under what conditions.

Your job:
- Ask questions ONE AT A TIME
- Prefix each question with [Q]
- Every question requires a clear YES or NO answer first. Do not accept vague answers like "depends", "maybe", "sometimes". If the answer is vague, follow up immediately: "Just to confirm — yes or no?"
- After getting yes/no, ask follow-up only if needed
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
  "conversationLimit": number,
  "neverReplyTo": ["@handle1"] or []
}

Never say you're an AI. No "Great answer!" Keep it direct. Force yes/no — never accept vague answers.`

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
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
    while (!userInput.trim()) { userInput = await askFn('\n  > ') }
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
  console.log(`  Own post comments:  ${structuredAnswers.replyToOwnPostComments ? 'YES' : 'NO'}${structuredAnswers.ownPostCommentCondition ? ` — only if: ${structuredAnswers.ownPostCommentCondition}` : ''}`)
  console.log(`  Replies on others:  ${structuredAnswers.replyToRepliesOnOthers ? 'YES' : 'NO'}${structuredAnswers.replyToRepliesCondition ? ` — only if: ${structuredAnswers.replyToRepliesCondition}` : ''}`)
  console.log(`  Conversation limit: ${structuredAnswers.conversationLimit} back-and-forth`)
  console.log(`  Never reply to:     ${structuredAnswers.neverReplyTo?.length ? structuredAnswers.neverReplyTo.join(', ') : 'none'}`)
  console.log('─'.repeat(58))

  return {
    replyToOwnPostComments:  structuredAnswers.replyToOwnPostComments ?? false,
    ownPostCommentCondition: structuredAnswers.ownPostCommentCondition ?? '',
    replyToRepliesOnOthers:  structuredAnswers.replyToRepliesOnOthers ?? false,
    replyToRepliesCondition: structuredAnswers.replyToRepliesCondition ?? '',
    conversationLimit:       structuredAnswers.conversationLimit ?? 3,
    neverReplyTo:            structuredAnswers.neverReplyTo ?? [],
    confirmedAt:             new Date().toISOString(),
  }
}

// ─── Part 8: Original Post Interview ─────────────────────────
async function runOriginalPostInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic): Promise<any> {
  const ws = computed?.writingStats ?? {}
  const bp = computed?.behaviorProfile ?? {}
  const archiveContext = JSON.stringify({
    postTopics:          computed?.postTopics ?? computed?.dominantTopics ?? [],
    avgPostsPerDay:      bp.avgPostsPerDay ?? 2,
    typicalPostingHours: bp.typicalPostingHours ?? [],
    sampleOriginals:     (bp.sampleOriginals ?? []).slice(0, 8),
    writingStyle: {
      caseStyle:       ws.caseStyle,
      apostropheStyle: ws.apostropheStyle,
      emojiUsage:      ws.emojiUsage,
      medianLength:    ws.medianReplyLength,
    },
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 7 — ORIGINAL POSTS')
  console.log('  Answer like you\'re texting. Claude will ask what it needs.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are interviewing a Twitter user about their ORIGINAL posts (not replies, not retweets).

You have their archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME based on what you see in their archive
- Prefix each question with [Q] — nothing else before the question
- After each answer, output one line starting with "Got it —" summarizing what you learned, then ask the next
- If an answer is vague ("depends", "it depends", "varies") ALWAYS follow up: "Give me a specific rule — e.g. 'only tech news, not personal stuff'. Don't say depends."
- Cover ALL of these areas (ask only what's needed based on the archive):
  1. Topics — what they actually post about NOW (archive may be outdated)
  2. Post SOURCE TYPE — do they post news reactions, personal thoughts/life updates, hot takes, opinions, questions to followers, random observations? This determines if web search is needed.
  3. Writing format — structure (bullet points, threads, one-liners), tone
  4. What triggers them to post — news, mood, time of day, events
  5. What they NEVER post about
  6. How often (confirm or correct archive's avg)
- Ask 5-7 questions max. Don't ask about things already clear from the archive.
- When done, output exactly: [INTERVIEW_DONE]
  Then on the next lines output ONLY this raw JSON (no markdown, no backticks):
{
  "topics": ["topic1", "topic2"],
  "postSourceType": "one of: news-driven | personal-thoughts | opinions-hot-takes | mixed | questions-polls | life-updates",
  "formatStyle": "one sentence about how they write",
  "triggers": "one sentence about what makes them post",
  "neverAbout": ["topic1"],
  "confirmedPostsPerDay": 2.0
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
    while (!userAnswer.trim()) { userAnswer = await askFn('  > ') }
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

  return result ?? {}
}

// ─────────────────────────────────────────────────────────────

async function main() {
  console.clear()
  console.log('\n' + '═'.repeat(58))
  console.log('  Blopus Setup')
  console.log('  Autonomous X agent — configured in minutes.')
  console.log('═'.repeat(58))
  console.log(`
  This wizard sets up your Blopus instance.
  All credentials stay on your machine — nothing is sent anywhere.
`)

  // ── Step 1: Anthropic API key — activates Claude for all remaining steps ──

  section(1, 'Anthropic API key')
  console.log(`
  This is the first thing you need — Claude will guide you through
  the rest of the setup once this is entered.

  Get yours free at: https://console.anthropic.com → API Keys → Create Key
  The key starts with: sk-ant-...
`)
  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? ''
  let setupClient!: Anthropic
  if (anthropicKey) {
    console.log(`  Found existing API key in .env — using it.\n`)
    setupClient = new Anthropic({ apiKey: anthropicKey })
  }
  while (!anthropicKey) {
    anthropicKey = await askRequired('Anthropic API Key (sk-ant-...)')
    process.env.ANTHROPIC_API_KEY = anthropicKey
    setupClient = new Anthropic({ apiKey: anthropicKey })
    console.log('  Verifying API key...')
    try {
      await setupClient.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
      console.log('  ✓ API key valid — Claude activated.\n')
      break
    } catch (e: any) {
      const msg = (e.message ?? '').toLowerCase()
      if (msg.includes('credit') || msg.includes('balance') || msg.includes('billing')) {
        console.log('  ✗ No credits: Your Anthropic account has no credit balance.')
        console.log('  Add credits at: https://console.anthropic.com → Billing\n')
      } else if (msg.includes('auth') || msg.includes('api_key') || msg.includes('401')) {
        console.log('  ✗ Invalid key: Double-check you copied the full key (sk-ant-...).')
        console.log('  Get your key at: https://console.anthropic.com → API Keys\n')
      } else {
        console.log(`  ✗ API error: ${(e.message ?? '').slice(0, 100)}`)
        console.log('  Check https://console.anthropic.com → Billing and API Keys\n')
      }
    }
  }

  // ── Step 1b: Reply model ──────────────────────────────────────

  console.log('\n' + '─'.repeat(58))
  console.log('  Which model should Blopus use for reply posting?\n')
  console.log('  1 · Haiku   — fast, cheap (~$0.001/reply). Great for high volume.')
  console.log('  2 · Sonnet  — higher quality, costs more (~$0.01/reply). Better voice matching.')
  console.log()
  console.log('  Note: Telegram control (SessionBrain) uses Sonnet by default.')
  console.log('        To change it, edit SESSIONBRAIN_MODEL= in your .env file directly.')
  console.log('─'.repeat(58))
  const existingReplyModel = process.env.REPLY_MODEL?.trim()
  let replyModel = existingReplyModel ?? ''
  if (replyModel) {
    console.log(`  ✓ Reply model: found in .env (${replyModel})\n`)
  } else {
    let replyModelRaw = ''
    while (!['1', '2'].includes(replyModelRaw)) { replyModelRaw = await ask('  Enter 1 or 2: ') }
    replyModel = replyModelRaw === '1' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-6'
    console.log(`  ✓ Reply model: ${replyModelRaw === '1' ? 'Haiku' : 'Sonnet'}`)
  }

  // ── Step 2: Mode ─────────────────────────────────────────────

  section(2, 'Choose your mode')
  console.log(`
  1 · Owner mode   — Blopus posts AS YOU on your real X account
                     Learns your exact voice from your tweet archive.

  2 · Bot mode     — Blopus runs its OWN separate X bot account
                     Has its own handle and personality.
`)

  const existingMode = process.env.BLOPUS_MODE?.trim()
  let modeRaw = existingMode === 'owner' ? '1' : existingMode === 'bot' ? '2' : ''
  if (modeRaw) { console.log(`  ✓ Mode: found in .env (${existingMode})\n`) }
  while (!['1','2'].includes(modeRaw)) {
    modeRaw = await ask('  Enter 1 or 2: ')
  }
  const mode = modeRaw === '1' ? 'owner' : 'bot'
  console.log(`  ✓ Mode: ${mode}`)

  // ── Step 2: Handles ──────────────────────────────────────────

  section(3, 'Your X handles')

  const ownerHandle = await askOrEnv('Your real X handle (no @)', 'X_HANDLE',
    'e.g.  johndoe   — this is YOUR real account'
  )

  const creatorName = ownerHandle.toLowerCase()
  const creatorDir  = path.resolve(`./creators/${creatorName}`)
  fs.mkdirSync(creatorDir, { recursive: true })
  fs.mkdirSync(path.resolve('./creators/memory-store'), { recursive: true })

  // Write CREATOR to root .env immediately — bot needs this to find the creator even if setup crashes later
  {
    const rp = path.resolve('.env')
    let re = fs.existsSync(rp) ? fs.readFileSync(rp, 'utf8') : ''
    if (/^CREATOR=/m.test(re)) re = re.replace(/^CREATOR=.*/m, `CREATOR=${creatorName}`)
    else re = `CREATOR=${creatorName}\n` + re
    fs.writeFileSync(rp, re, 'utf8')
  }

  // ── Step 3: Twitter API keys ──────────────────────────────────

  section(4, 'Twitter / X API keys')
  console.log(`
  ── STEP-BY-STEP ──────────────────────────────────────────

  1. Go to:  https://developer.twitter.com/en/portal/dashboard
     Sign in with the X account Blopus will post from.

  2. If you already have an app listed under "Pay Per Use":
     → Click it → scroll to "Access Token" → check if it says "Read"
     → If it says "Read" only, you must fix this before continuing.
       Click "User authentication settings" → Set up
       Set "App permissions" to "Read and write and Direct message" → Save
       Then come back and regenerate the Access Token.
     → If no app exists, click "Create App" at the top.

  3. Creating a new app:
     · App name: anything (e.g. "blopus-yourhandle")
     · Description box — paste this exactly:
       "I am building a personal automation tool to manage my own X
        account. It posts content, replies to mentions, and reads my
        timeline — all on my own account only. No data is collected,
        sold, or shared. This is for personal use only."
     · Check all 3 boxes → Submit

  4. IMPORTANT — set permissions BEFORE generating tokens:
     → After app is created, go to "User authentication settings" → Set up
     → App permissions: select "Read and write and Direct message"
       (NOT just "Read and write" — you need DM access too)
     → Type of App: select "Web App, Automated App or Bot"
     → App info:
         Callback URI:  https://example.com
         Website URL:   https://example.com
         (everything else leave blank)
     → Save Changes
     (If you skip this step, your token will be Read-only and posting will fail)

  5. Go to "Keys and Tokens" tab:
     · Under "OAuth 1.0 Keys" → click Show to reveal Consumer Key + Secret
       (if Show is not visible or fields look empty → click Regenerate)
     · Under "Access Token" → click Generate to create it
       (if a token already exists but says "Read" → click Regenerate after
        completing step 4, otherwise posting will fail)
       Copy both the Access Token and Access Token Secret — Secret only shows once

  6. Add credits (required to use the API):
     → Left sidebar → Billing → Credits → add at least $5
     (Without credits the API will reject all requests)

  ──────────────────────────────────────────────────────────
`)

  const apiKey            = await askOrEnv('API Key (Consumer Key)',       'TWITTER_API_KEY')
  const apiSecret         = await askOrEnv('API Secret (Consumer Secret)', 'TWITTER_API_SECRET')
  const accessToken       = await askOrEnv('Access Token',                 'TWITTER_ACCESS_TOKEN')
  const accessTokenSecret = await askOrEnv('Access Token Secret',          'TWITTER_ACCESS_TOKEN_SECRET')

  // ── Step 5: X login for Playwright ───────────────────────────

  section(5, 'X login credentials')
  console.log(`
  Blopus uses a hidden browser to read your X home timeline
  and post as you. It needs your X login to do this.
  Stored locally only — never sent anywhere.
`)

  const xEmail    = await askOrEnv('X account email',    'X_AUTH_EMAIL')
  const xPassword = await askOrEnv('X account password', 'X_PASSWORD')

  // ── Step 5b: X session cookies ────────────────────────────────

  section(6, 'X session cookies — for home timeline reading')
  console.log(`
  Blopus reads your X home timeline using session cookies from your browser.
  Takes 30 seconds to grab.

  How to get them:
  1. Open x.com in Chrome/Edge/Brave — make sure you are logged in as yourself
  2. Open DevTools:
       Windows/Linux: press F12  (if F12 doesn't work: press Fn+F12)
       Mac:           press Cmd+Option+I
       Any browser:   right-click anywhere on the page → "Inspect"
  3. Click the "Application" tab in the top menu bar of DevTools
  4. Left sidebar → Storage → Cookies → click "https://x.com"
  5. Find "auth_token" in the list → click it → copy the entire Value
  6. Find "ct0" in the list → click it → copy the entire Value
`)
  const xAuthToken = await askOrEnv('auth_token value (long string of letters/numbers)', 'X_AUTH_TOKEN')
  const xCt0       = await askOrEnv('ct0 value (very long string)',                      'X_CT0')

  console.log(`
  ⚠  These cookies expire periodically (every few weeks).
  When they expire, home timeline and search silently return 0 results —
  the bot will stop finding tweets to reply to with no error message.

  When that happens: repeat this step — grab fresh auth_token + ct0
  from x.com → F12 → Application → Cookies → update your .env file.
`)

  console.log(`
  X DM passcode — only needed if you have "Additional password protection" enabled on X.
  To check: x.com → Settings → Security and account access → Security
            → look for "Additional password protection" — if it is ON enter the code below.
  If it is OFF or you are unsure, just press Enter to skip.
`)
  const xDmPasscode = await askOptionalOrEnv('X DM passcode (Enter to skip if not set)', 'X_DM_PASSCODE')

  // ── Step 7: Tavily ─────────────────────────────────────────────

  section(7, 'Tavily API key')
  console.log(`
  Required for autonomous posting and factual replies to work properly.

  Blopus uses Tavily internally to:
  - Ground every original post with real current news before posting
  - Answer factual mentions with live web search instead of guessing

  Without it: autonomous posts have no news grounding, factual replies
  will hallucinate outdated info.

  Free tier (1000 searches/month) at: https://tavily.com
  Sign up → API Keys → Create → paste below.
`)

  const tavilyKey = await askOrEnv('Tavily API Key', 'TAVILY_API_KEY')

  // ── Step 7: Gemini (optional) ─────────────────────────────────

  section(8, 'Gemini API key  (optional)')
  console.log(`
  Skip if you don't need it.
  With it: send any YouTube link to Telegram, ask anything about
  the video — Blopus watches it and answers accurately.
  Without it: still works but less accurate (transcript only).

  Free at: https://aistudio.google.com → Get API Key
  Free tier: 1,500 requests/day — more than enough.
`)

  const geminiKey = await askOptionalOrEnv('Gemini API Key', 'GEMINI_API_KEY')

  // ── Step 8: Telegram ──────────────────────────────────────────

  section(9, 'Telegram control bot')
  console.log(`
  HOW THIS TELEGRAM BOT WORKS:
  When your agent runs, this bot becomes its control panel.
  Message it to post, search — anything.

  Running owner account only → one Telegram bot is all you need.

  Running a bot account too (npm run bot-setup)?
  → Run one at a time: same token is fine
  → Run both simultaneously: create a SEPARATE bot on @BotFather
    Same token + both running = Telegram splits your messages
    randomly between accounts. Autonomous posting still works fine,
    only your manual control gets confused.

  ─────────────────────────────────────────────────────
  Get your bot token:
  1. Open Telegram → search @BotFather
  2. Send:  /newbot
  3. Name it (e.g. "My Blopus")
  4. Username must end in _bot (e.g. myblopus_ctrl_bot)
  5. BotFather gives you a token — paste below

  Get your chat ID:
  1. Open Telegram → search @userinfobot
  2. Send:  /start
  3. It shows your ID number — paste below
`)

  const telegramToken  = await askOrEnv('Telegram bot token',    'TELEGRAM_BOT_TOKEN')
  const telegramChatId = await askOrEnv('Your Telegram chat ID', 'TELEGRAM_OWNER_CHAT_ID')

  // ── Checkpoint save — all credentials collected so far ────────
  fs.mkdirSync(creatorDir, { recursive: true })
  const checkpointEnv = [
    `OWNER_HANDLE=${ownerHandle}`,
    `TWITTER_API_KEY=${apiKey}`,
    `TWITTER_API_SECRET=${apiSecret}`,
    `TWITTER_ACCESS_TOKEN=${accessToken}`,
    `TWITTER_ACCESS_TOKEN_SECRET=${accessTokenSecret}`,
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    `X_AUTH_EMAIL=${xEmail}`,
    `X_PASSWORD=${xPassword}`,
    `X_AUTH_TOKEN=${xAuthToken}`,
    `X_CT0=${xCt0}`,
    xDmPasscode ? `X_DM_PASSCODE=${xDmPasscode}` : `# X_DM_PASSCODE=`,
    `TAVILY_API_KEY=${tavilyKey}`,
    geminiKey ? `GEMINI_API_KEY=${geminiKey}` : `# GEMINI_API_KEY=`,
    `TELEGRAM_BOT_TOKEN=${telegramToken}`,
    `TELEGRAM_OWNER_CHAT_ID=${telegramChatId}`,
    `X_HANDLE=${ownerHandle}`,
    `BLOPUS_MODE=${mode}`,
    `OSBOT_CONFIG_PATH=./creators/${creatorName}/config.json`,
    `X_SEARCH_TIMELINE_HASH=AIdc203rPpK_k_2KWSdm7g`,
    `X_TWEET_DETAIL_HASH=nBS-WpgA6ZG0CyNHD517JQ`,
    `REPLY_MODEL=${replyModel}`,
    `SESSIONBRAIN_MODEL=claude-sonnet-4-6`,
  ]
  fs.writeFileSync(path.join(creatorDir, '.env'), checkpointEnv.join('\n') + '\n', 'utf8')
  console.log(`\n  ✓ Credentials saved to creators/${creatorName}/.env`)

  // Write a minimal config.json checkpoint so the agent can boot even if setup crashes before the final write
  const configCheckpointPath = path.join(creatorDir, 'config.json')
  if (!fs.existsSync(configCheckpointPath)) {
    const minCfg = {
      blopus:   { handle: ownerHandle, userId: '', displayName: ownerHandle },
      owner:    { handle: ownerHandle, displayName: ownerHandle },
      platform: { primary: 'x', pollIntervalMinutes: 5, maxRepliesPerPollCycle: 1, maxRepliesPerDay: 10, replyDelayMinutes: { min: 1, max: 5 } },
      personality: { traits: { aggression: 0.3, warmth: 0.6, humor: 0.5, formality: 0.4, verbosity: 0.5 }, quirks: { responseRate: 0.8 } },
      llm:      { model: replyModel, maxTokens: 400, temperature: 0.8, enabled: true },
      summon:   { keywords: ['osbot', 'blopus'], requireOwnerHandle: false },
      pack:     { knownOsBots: [], tagProbability: 0.1, maxTagsPerReply: 1 },
      memory:   { storePath: './creators/memory-store', maxRecords: 10000, pruneAfterDays: 90 },
      rateLimits: { monthlyPostBudget: 500, safetyBufferPercent: 0.1, minimumPollIntervalMinutes: 3, backoffOnErrorMs: 60000, threadCooldownMinutes: 60 },
      controlChannel: { telegram: { ownerChatId: telegramChatId } },
      replyMode: 'domain', replyEngine: 'rag', replyStrategy: 'growth', avoidTopics: [],
    }
    fs.writeFileSync(configCheckpointPath, JSON.stringify(minCfg, null, 2), 'utf8')
    console.log(`  ✓ Minimal config saved to creators/${creatorName}/config.json`)
  }

  // ── Auto-fetch owner userId from Twitter API ──────────────────
  let ownerUserId = ''
  console.log('\n  Fetching your Twitter user ID...')
  try {
    const { XClient } = await import('../adapters/x/XClient')
    const xc = new XClient('placeholder')
    const fetched = await xc.fetchUserIdByHandle(ownerHandle)
    if (fetched) {
      ownerUserId = fetched
      const cfgPath = path.join(creatorDir, 'config.json')
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      cfg.blopus.userId = ownerUserId
      cfg.owner.userId  = ownerUserId
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
      console.log(`  ✓ Twitter user ID saved: ${ownerUserId}`)
    }
  } catch {
    console.log(`  ⚠ Could not fetch user ID automatically — you can set it later.`)
    console.log(`    Run: npx tsx scripts/fetchBotUserId.ts "@${ownerHandle}"`)
    console.log(`    Then paste the ID into creators/${creatorName}/config.json → blopus.userId`)
  }

  // ── Step 8: Archive + personality (owner/both only) ───────────

  let personalityProfile: any = undefined
  let archiveCopied = false

  if (mode === 'owner' || mode === 'both') {
    section(10, 'Your personality — Twitter archive')
    console.log(`
  For owner mode, Blopus learns YOUR exact voice:
  how you write, your topics, posting hours, reply style, humor.

  It reads your Twitter/X archive to compute this.

  How to get your archive:
  1. Go to x.com → your profile pic → Settings
  2. "Your account" → "Download an archive of your data"
  3. Request it — X emails you a download link (up to 24h wait)
  4. Download the zip → extract it
  5. You will get a folder like: twitter-2026-04-19-.../
     Inside it: assets/, data/, Your archive.html

  Enter the full path to that extracted folder below.
  Blopus automatically finds the data/ inside — paste the main folder path.
  (Press Enter to skip — you can add it later via npm run ingest)
`)

    const archivePath = await askOptional(
      'Full path to your extracted Twitter archive folder',
      'e.g.  C:/Users/you/Downloads/twitter-2025  (the whole extracted folder)'
    )

    const resolvedArchiveDir = (() => {
      if (!archivePath) return null
      if (!fs.existsSync(archivePath)) return null
      if (archivePath.endsWith('.js') && fs.existsSync(archivePath)) {
        return path.dirname(archivePath)  // they gave tweets.js directly
      }
      if (fs.statSync(archivePath).isDirectory()) {
        // check if they gave the main archive folder (contains data/ inside)
        const dataSubdir = path.join(archivePath, 'data')
        if (fs.existsSync(dataSubdir)) return dataSubdir
        // they gave the data/ folder directly
        return archivePath
      }
      return null
    })()

    if (resolvedArchiveDir) {
      console.log('\n  ✓ Archive folder found — processing everything...')
      console.log('  (tweets, DMs, RAG index, biography, relationships — this takes ~1-2 min)\n')

      try {
        const { runFullArchiveIngest } = await import('../core/ingest/FullArchiveIngestor')

        const memoryStoreDir = path.join(creatorDir, 'memory-store')
        fs.mkdirSync(memoryStoreDir, { recursive: true })

        const apiKey = process.env.ANTHROPIC_API_KEY ?? ''
        const ownerUserIdEnv = process.env.OWNER_USER_ID ?? ''

        const result = await runFullArchiveIngest({
          archiveDir:     resolvedArchiveDir,
          creatorDir,
          memoryStoreDir,
          ownerHandle,
          ownerUserId:    ownerUserIdEnv,
          apiKey,
        })

        archiveCopied = true

        // Load the personality profile that was just written
        const profilePath = path.join(creatorDir, 'personality_profile.json')
        if (fs.existsSync(profilePath)) {
          personalityProfile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
        }

        // ── Display summary ──────────────────────────────────────
        console.log('\n' + '═'.repeat(58))
        console.log('  What Blopus learned about you')
        console.log('═'.repeat(58))

        const bp = personalityProfile?.behaviorProfile
        if (bp) {
          console.log(`\n  POSTING BEHAVIOR (computed from your archive):`)
          console.log(`  · Original posts per day:     ${bp.avgPostsPerDay}`)
          console.log(`  · Replies per day:             ${bp.avgRepliesPerDay}`)
          console.log(`  · Quote tweet ratio:           ${Math.round(bp.quoteTweetRatio * 100)}% of your posts`)
          console.log(`  · Avg gap between posts:       ${bp.avgIntervalHours}h`)
          console.log(`  · When you post (UTC hours):   ${bp.typicalPostingHours?.join(', ')}`)
        }

        const ws = personalityProfile?.writingStats
        if (ws) {
          console.log(`\n  YOUR WRITING STYLE (exact counts from archive):`)
          console.log(`  · Reply length:      ${ws.medianReplyLength}`)
          console.log(`  · Case style:        ${ws.caseStyle}`)
          console.log(`  · Apostrophes:       ${ws.apostropheStyle}`)
          console.log(`  · Emoji usage:       ${ws.emojiUsage}`)
          if (ws.uncertaintyPhrases?.length) {
            console.log(`  · Phrases you use:   ${ws.uncertaintyPhrases.join(', ')}`)
          }
          if (ws.characteristicMentions?.length) {
            console.log(`  · Accounts you tag:  ${ws.characteristicMentions.join(', ')}`)
          }
        }

        if (personalityProfile) {
          console.log(`\n  WHAT YOU POST ABOUT (from your original tweets):`)
          ;(personalityProfile.postTopics ?? []).forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`))

          console.log(`\n  WHAT YOU ENGAGE WITH (from your replies):`)
          ;(personalityProfile.replyTopics ?? []).forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`))

          console.log(`\n  YOUR STYLE (Claude's analysis):`)
          console.log(`  Writing:   ${personalityProfile.writingStyle}`)
          console.log(`  Opinions:  ${personalityProfile.opinionStyle}`)
          console.log(`  Humor:     ${personalityProfile.humorStyle}`)
          console.log(`  Replies:   ${personalityProfile.replyStyle}`)

          if (personalityProfile.avoids?.length) {
            console.log(`\n  THINGS YOU AVOID:`)
            personalityProfile.avoids.forEach((a: string) => console.log(`  · ${a}`))
          }

          if (personalityProfile.signaturePatterns?.length) {
            console.log(`\n  YOUR SIGNATURE OPENERS (phrases you actually use):`)
            personalityProfile.signaturePatterns.slice(0, 5).forEach((sp: any) => {
              console.log(`  · "${sp.phrase}"  →  used for: ${sp.usedFor}`)
            })
          }

          if (personalityProfile.examplePhrases?.length) {
            console.log(`\n  EXAMPLE PHRASES FROM YOUR REAL POSTS:`)
            personalityProfile.examplePhrases.slice(0, 4).forEach((p: string) => console.log(`  · "${p}"`))
          }

          if (bp?.burstSampleTweets?.length) {
            console.log(`\n  YOUR HIGH-ENERGY POSTS (from your most active days):`)
            bp.burstSampleTweets.slice(0, 3).forEach((t: string) => console.log(`  · "${t.slice(0, 100)}"${t.length > 100 ? '…' : ''}`))
          }
        }

        console.log(`\n  ✓ RAG index: ${result.rag.examples} reply examples indexed`)
        console.log(`  ✓ People from replies: ${result.persons.fromTweets} contacts`)
        if (result.dms.persons > 0) {
          console.log(`  ✓ DMs: ${result.dms.persons} contacts, ${result.dms.messages} messages`)
        }
        if (result.biography.built) console.log(`  ✓ Owner biography built`)

        // ── Show computed topics ─────────────────────────────────
        if (personalityProfile) {
          // Set dominantTopics from replyTopics by default — step 12 will let user edit them
          personalityProfile.dominantTopics = personalityProfile.replyTopics ?? personalityProfile.dominantTopics

          console.log('\n' + '─'.repeat(58))
          console.log('  Domain topics computed from your archive:')
          console.log()
          ;(personalityProfile.dominantTopics ?? []).forEach((t: string, i: number) => console.log(`    ${i + 1}. ${t}`))
          console.log()
          console.log('  You can edit these in the next step.')

          fs.writeFileSync(
            path.join(creatorDir, 'personality_profile.json'),
            JSON.stringify(personalityProfile, null, 2),
            'utf8'
          )
          console.log(`\n  ✓ Personality profile saved.`)
          await ask('  Press Enter to continue: ')
        }

      } catch (err: any) {
        console.log(`\n  ⚠ Archive processing failed: ${err.message?.slice(0, 100)}`)
        console.log('  Blopus will use a default personality. Run  npm run ingest  later to add yours.')
      }

    } else if (archivePath) {
      console.log(`  ⚠ Path not found or not a folder. Skipping.`)
      console.log(`  Run  npm run ingest  after getting your archive.`)
    } else {
      console.log(`  Skipped. Run  npm run ingest  after getting your archive.`)
    }
  }

  // ── Reply strategy — growth vs engagement ────────────────────

  let replyStrategy: 'growth' | 'engagement' | 'none' = 'growth'

  if (mode === 'owner' || mode === 'both') {
    section(11, 'How do you use replies?')
    console.log(`
  1 · Growth mode     — you reply to OTHER people's viral tweets to get discovered
                        Best for: accounts under ~10k followers trying to grow
                        Blopus hunts viral tweets in your topics and replies as you

  2 · Engagement mode — you reply to YOUR OWN followers and comments on your posts
                        Best for: accounts 10k+ who already have an audience
                        (coming soon — not available yet)

  3 · Neither         — you don't reply, just post original content
                        Blopus will only handle original posts, QTs, RTs, likes
`)
    let stratRaw = ''
    while (!['1', '2', '3'].includes(stratRaw)) {
      stratRaw = await ask('  Enter 1, 2 or 3: ')
    }
    replyStrategy = stratRaw === '1' ? 'growth' : stratRaw === '2' ? 'engagement' : 'none'

    if (replyStrategy === 'engagement') {
      console.log(`\n  Engagement mode — Blopus will reply to your audience. No tweet hunting.\n`)
    } else if (replyStrategy === 'none') {
      console.log(`\n  Got it — no reply hunting. Blopus will only post, QT, RT, and like.\n`)
    } else {
      console.log(`\n  Growth mode — Blopus will hunt viral tweets and reply as you.\n`)
    }
  }

  // ── Part 2: Voice Mode Interview (owner/both only) ───────────

  let voiceProfile: any = undefined
  let quoteTweetBehavior: any = undefined
  let likeBehavior: any = undefined
  let replyEngine: 'voice' | 'rag' = 'rag'

  if (mode === 'owner' || mode === 'both') {
    // ── Domain filter — growth mode only ─────────────────────
    if (replyStrategy === 'growth') {
      section(12, 'Reply targeting')

      const archiveReplyTopics = personalityProfile?.replyTopics ?? personalityProfile?.dominantTopics ?? []

      // Q1 — Mode first
      console.log(`\n  [1] How should Blopus find tweets to reply to?`)
      console.log(`        1 · Domain mode — only tweets matching your topics (recommended)`)
      console.log(`        2 · Viral mode  — anything trending on your home timeline`)
      let replyModeRaw = ''
      while (!['1', '2'].includes(replyModeRaw)) { replyModeRaw = await ask('  > ') }
      const replyModeOwner = replyModeRaw === '1' ? 'domain' : 'viral'
      console.log(`  Got it — ${replyModeOwner} mode\n`)
      ;(personalityProfile as any)._replyMode = replyModeOwner

      let domainTopics = archiveReplyTopics
      let neverTopics: string[] = []

      if (replyModeOwner === 'domain') {
        // Q2 — Topics (domain mode only)
        console.log(`  Your archive shows you engage with these topics:`)
        archiveReplyTopics.forEach((t: string, i: number) => console.log(`    ${i + 1}. ${t}`))
        console.log(`\n  [2] Are these the right topics? Say what to keep, remove, or add.`)
        console.log(`      You can also just name topics you want — or press Enter to use all.`)
        const dtRaw = await ask('  > ')
        if (dtRaw.trim()) {
          const dtJson = await claudeInterpret(setupClient, dtRaw,
            `Current archive topics: ${JSON.stringify(archiveReplyTopics)}. The user may want to keep all, remove some, add new ones (including topics NOT in the archive). Honor whatever they say.`,
            'A JSON array of the final list of topics. If user adds a new topic not in the archive, include it. Return ONLY a valid JSON array of strings.')
          try { const p = JSON.parse(dtJson); if (Array.isArray(p) && p.length) domainTopics = p } catch {}
        }
        console.log(`  Got it — topics:\n${domainTopics.map((t: string, i: number) => `    ${i + 1}. ${t}`).join('\n')}\n`)
        personalityProfile.dominantTopics = domainTopics

        // Q3 — Never (domain mode)
        console.log(`  [3] Any sub-topics to ALWAYS skip — even inside your chosen topics?`)
        console.log(`      Your topics: ${domainTopics.join(', ')}`)
        console.log(`      e.g. a sub-topic, content type, or angle within any of the above you find toxic or draining`)
        console.log(`      Press Enter to skip if nothing comes to mind.`)
        const neverRaw = await ask('  > ')
        if (neverRaw.trim()) {
          const neverJson = await claudeInterpret(setupClient, neverRaw, 'The user is listing topics they never want to reply to. Each word or phrase is a topic.', 'A JSON array of never-reply topics. Return ONLY a valid JSON array of strings.')
          try { neverTopics = JSON.parse(neverJson) } catch { neverTopics = neverRaw.split(',').map((t: string) => t.trim()).filter(Boolean) }
        }
        if (neverTopics.length) {
          console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)
          console.log(`  Expanding into keywords...\n`)
          const expandedNever = await expandNeverKeywords(neverTopics.join(', '), ask)
          if (voiceProfile) voiceProfile.neverTopics = expandedNever
        }

        // Q4 — Per-domain like threshold
        console.log(`  [4] Minimum likes a tweet needs before Blopus replies to it — set per topic.`)
        console.log(`      Higher = only big viral tweets (harder to find). Lower = more tweets, smaller accounts.`)
        console.log(`      Press Enter on any topic to use the default for that type:\n`)
        const domainMinLikes: Record<string, number> = {}
        for (const topic of domainTopics) {
          const suggested = 200
          const raw = await ask(`    ${topic} (suggested: ${suggested}): `)
          const parsed = parseInt(raw.match(/\d+/)?.[0] ?? '')
          domainMinLikes[topic] = isNaN(parsed) ? suggested : parsed
        }
        console.log(`  Got it — thresholds set.\n`)
        if (personalityProfile) (personalityProfile as any).domainMinLikes = domainMinLikes

        // Q4.5 — Max tweet age
        const suggestedAgeHours = 6
        console.log(`  [4.5] How old can a tweet be before Blopus replies to it?`)
        console.log(`        Lower = only very fresh tweets (fewer options). Higher = older tweets too (more options).`)
        console.log(`        Press Enter to use suggested (${suggestedAgeHours}h):\n`)
        const ageRaw = await ask(`    Max tweet age in hours (suggested: ${suggestedAgeHours}h): `)
        const ageParsed = parseInt(ageRaw.match(/\d+/)?.[0] ?? '')
        const maxAgeTweetMinutes = (isNaN(ageParsed) ? suggestedAgeHours : ageParsed) * 60
        console.log(`  Got it — ${maxAgeTweetMinutes / 60}h max age.\n`)
        if (personalityProfile) (personalityProfile as any).maxAgeTweetMinutes = maxAgeTweetMinutes

        // Q5 — Domain search keyword expansion
        console.log(`  [5] Blopus will now expand each topic into 30-50 search keywords`)
        console.log(`      so it can find the right tweets — not just tweets with that exact word.`)
        console.log(`      Review each list and remove anything that looks off.\n`)
        const userContextForExpansion = JSON.stringify({
          dominantTopics: domainTopics,
          writingStats: personalityProfile?.writingStats ?? {},
          archiveSummary: (personalityProfile?.signaturePatterns ?? []).slice(0, 5),
        })
        const domainSearchKeywords: Record<string, string[]> = {}
        for (const topic of domainTopics) {
          try {
            domainSearchKeywords[topic] = await expandDomainKeywords(topic, userContextForExpansion, ask)
          } catch {
            domainSearchKeywords[topic] = [topic]
          }
        }
        console.log(`  Got it — search keywords saved.\n`)
        if (personalityProfile) (personalityProfile as any).domainSearchKeywords = domainSearchKeywords

      } else {
        // Viral mode — only ask never-topics
        console.log(`  [2] Any topics Blopus should NEVER reply to — even if they trend?`)
        console.log(`      e.g. "politics, religion, nsfw" — or press Enter to skip`)
        const neverRaw = await ask('  > ')
        if (neverRaw.trim()) {
          const neverJson = await claudeInterpret(setupClient, neverRaw, 'The user is listing topics they never want to reply to. Each word or phrase is a topic.', 'A JSON array of never-reply topics. Return ONLY a valid JSON array of strings.')
          try { neverTopics = JSON.parse(neverJson) } catch { neverTopics = neverRaw.split(',').map((t: string) => t.trim()).filter(Boolean) }
        }
        if (neverTopics.length) console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)
      }

      if (voiceProfile) voiceProfile.neverTopics = neverTopics

      // Q — Replies per day (from archive reply data only)
      const archiveRpd: number = personalityProfile?.behaviorProfile?.avgRepliesPerDay ?? 0
      const suggestedRpd = archiveRpd > 0 ? Math.round(archiveRpd) : null
      if (suggestedRpd) {
        console.log(`  Your archive shows you replied ~${suggestedRpd} times/day on average.`)
        console.log(`  How many replies per day should Blopus send?`)
        console.log(`      Press Enter to match your archive (${suggestedRpd}/day), or type a number.`)
      } else {
        console.log(`  How many replies per day should Blopus send?`)
        console.log(`      e.g. "10", "20"`)
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
      if (voiceProfile) (voiceProfile as any).repliesPerDay = repliesPerDay

      // Knowledge depth per topic — asked one at a time to avoid parsing mistakes
      if (replyModeOwner === 'domain' && domainTopics.length) {
        console.log('  For each topic, type your knowledge level:')
        console.log('    1 = basic (general takes only)  2 = follow it closely  3 = deep expert\n')
        const depthMap: Record<string, 'basic' | 'intermediate' | 'expert'> = {}
        for (const t of domainTopics) {
          let raw = ''
          while (!['1', '2', '3'].includes(raw.trim())) { raw = await ask(`  ${t}: `) }
          depthMap[t] = raw.trim() === '1' ? 'basic' : raw.trim() === '3' ? 'expert' : 'intermediate'
        }
        const topicProfiles: Record<string, { engagementShare: number; knowledgeDepth: string }> = {}
        domainTopics.forEach((t: string) => {
          topicProfiles[t] = { engagementShare: Math.round(100 / domainTopics.length), knowledgeDepth: depthMap[t] }
        })
        console.log()
        if (personalityProfile) (personalityProfile as any).topicProfiles = topicProfiles
      }
    } // end growth mode domain filter

    // ── Voice vs RAG selection ────────────────────────────────
    section(11, 'How should Blopus sound like you?')
    console.log(`
  1 · Voice mode  — you do a short interview, Blopus learns your exact style
                    banned phrases, golden examples, posting rules
                    Recommended for accounts that care about sounding authentic

  2 · RAG mode    — Blopus reads your tweet archive and copies your style automatically
                    No interview needed — faster setup, slightly less precise
                    Good if your archive already reflects how you write

  3 · Skip        — skip this entirely, Blopus uses archive as-is
`)
    let replyEngineRaw = ''
    while (!['1', '2', '3'].includes(replyEngineRaw)) {
      replyEngineRaw = await ask('  Enter 1, 2 or 3: ')
    }
    if (replyEngineRaw === '3') {
      replyEngine = 'rag'
      console.log('  Skipped — using archive style as-is.\n')
    } else {
      replyEngine = replyEngineRaw === '1' ? 'voice' : 'rag'
      console.log(`  Got it — ${replyEngine} mode\n`)
    }

    let originalPostProfile: any = undefined

    const saveProfile = () => {
      if (personalityProfile) {
        personalityProfile.voiceProfile = voiceProfile
        if (voiceProfile) voiceProfile.originalPostProfile = originalPostProfile
        personalityProfile.quoteTweetBehavior = quoteTweetBehavior
        personalityProfile.likeBehavior = likeBehavior
        fs.writeFileSync(path.join(creatorDir, 'personality_profile.json'), JSON.stringify(personalityProfile, null, 2), 'utf8')
        // Write voice_profile.json separately — agent loads this file directly
        if (voiceProfile) {
          fs.writeFileSync(path.join(creatorDir, 'voice_profile.json'), JSON.stringify(voiceProfile, null, 2), 'utf8')
        }
      }
    }

    if (replyEngine === 'voice') {
      voiceProfile = await runReplyInterview(personalityProfile, ask, setupClient, replyModel)
      saveProfile()
      originalPostProfile = await runOriginalPostInterview(personalityProfile, ask, setupClient)
      saveProfile()
    } else if (replyEngineRaw === '2') {
      // RAG mode — just capture banned phrases + never topics (archive handles the rest)
      console.log('\n' + '─'.repeat(58))
      console.log('  QUICK SETTINGS (RAG mode)\n')
      console.log('  Any words or phrases Blopus should NEVER say?')
      console.log('  e.g. "lol, bro, ngl, tbh" — or press Enter to skip')
      const bannedRaw = await ask('  > ')
      const bannedPhrases = bannedRaw.trim()
        ? bannedRaw.split(',').map((p: string) => p.trim()).filter(Boolean)
        : []
      if (bannedPhrases.length) console.log(`  Got it — never say: ${bannedPhrases.join(', ')}\n`)
      if (!voiceProfile) voiceProfile = {} as any
      voiceProfile.bannedPhrases = bannedPhrases
      if (bannedPhrases.length && personalityProfile) {
        personalityProfile.avoids = [...(personalityProfile.avoids ?? []), ...bannedPhrases]
      }
      console.log('─'.repeat(58))
    }

    if (replyEngine !== 'voice') {
      if (!await askSkip('ORIGINAL POSTS — how Blopus writes your standalone tweets', ask)) {
        originalPostProfile = await runOriginalPostInterview(personalityProfile, ask, setupClient)
        if (originalPostProfile?.topics?.length && personalityProfile) {
          personalityProfile.postTopics = originalPostProfile.topics
        }

        // Topic profiles for posts — engagement share (how often) + knowledge depth (how deep)
        const postTopicList: string[] = (personalityProfile as any)?.postTopics ?? (personalityProfile as any)?.dominantTopics ?? []
        if (postTopicList.length) {
          console.log('\n  ─ How often do you post in each topic, and how deep is your knowledge? ─\n')
          postTopicList.forEach((t: string, i: number) => console.log(`    ${i + 1}. ${t}`))

          console.log('\n  Out of 100 posts, how many are about each topic?')
          console.log('  Describe naturally — e.g. "mostly Indian society, a bit of AI, rarely food"')
          console.log('  or type numbers — e.g. "Indian society 50, AI 15, rest split evenly" — or press Enter to split evenly')
          const shareInput = await ask('  > ')
          let shares: number[] = postTopicList.map(() => Math.round(100 / postTopicList.length))
          if (shareInput.trim()) {
            try {
              const res = await setupClient.messages.create({
                model: 'claude-haiku-4-5-20251001', max_tokens: 200,
                messages: [{ role: 'user', content: `Topics: ${JSON.stringify(postTopicList)}\nUser said: "${shareInput}"\nReturn a JSON array of numbers (one per topic in order) for how often they post about each topic out of 100. Must sum to ~100. Return ONLY a valid JSON array.` }],
              })
              const text = res.content[0].type === 'text' ? res.content[0].text : ''
              const match = text.match(/\[[\s\S]*?\]/)
              if (match) { const p = JSON.parse(match[0]); if (Array.isArray(p) && p.length === postTopicList.length) shares = p }
            } catch {}
          }

          console.log('\n  For each topic, type your knowledge level:')
          console.log('    1 = basic (general takes only)  2 = follow it closely  3 = deep expert\n')
          const depthMap: Record<string, 'basic' | 'intermediate' | 'expert'> = {}
          for (const t of postTopicList) {
            let raw = ''
            while (!['1', '2', '3'].includes(raw.trim())) { raw = await ask(`  ${t}: `) }
            depthMap[t] = raw.trim() === '1' ? 'basic' : raw.trim() === '3' ? 'expert' : 'intermediate'
          }
          const depths = postTopicList.map((t: string) => depthMap[t])

          // Merge into existing topicProfiles (replies already set knowledge depth, posts adds engagementShare)
          const existing = (personalityProfile as any).topicProfiles ?? {}
          postTopicList.forEach((t: string, i: number) => {
            existing[t] = {
              engagementShare: shares[i] ?? Math.round(100 / postTopicList.length),
              knowledgeDepth: depths[i] ?? existing[t]?.knowledgeDepth ?? 'intermediate',
            }
          })
          console.log('\n  Got it —')
          postTopicList.forEach((t: string) => console.log(`    ${t}: ${existing[t].engagementShare}/100 posts, ${existing[t].knowledgeDepth}`))
          console.log()
          if (personalityProfile) (personalityProfile as any).topicProfiles = existing
        }

        saveProfile()
      } else console.log('  Skipped — Blopus will use archive style for posts.\n')
    }

    if (!await askSkip('QUOTE TWEETS — when and how you quote tweet others', ask)) {
      quoteTweetBehavior = await runQuoteTweetInterview(personalityProfile, ask, setupClient)
      saveProfile()
    } else console.log('  Skipped — quote tweeting disabled.\n')

    if (!await askSkip('RETWEETS — when you retweet others', ask)) {
      const rt = await runRetweetInterview(personalityProfile, ask, setupClient)
      if (personalityProfile) (personalityProfile as any).retweetBehavior = rt
      saveProfile()
    } else console.log('  Skipped — retweeting disabled.\n')

    if (!await askSkip('LIKES — what content you like', ask)) {
      likeBehavior = await runLikeInterview(personalityProfile, ask, setupClient)
      saveProfile()
    } else console.log('  Skipped — auto-liking disabled.\n')

    if (!await askSkip('REPLY BACK — who you reply to when people engage with you', ask)) {
      const replyBackRules = await runReplyBackInterview(ask, setupClient)
      if (voiceProfile) voiceProfile.replyBackRules = replyBackRules
      else { if (!personalityProfile?.voiceProfile) (personalityProfile as any).voiceProfile = {}; (personalityProfile as any).voiceProfile.replyBackRules = replyBackRules }
      saveProfile()
    } else console.log('  Skipped — Blopus will reply to everyone.\n')

    // Merge into personalityProfile so it gets saved together
    if (personalityProfile) {
      personalityProfile.voiceProfile      = voiceProfile
      personalityProfile.quoteTweetBehavior = quoteTweetBehavior
      personalityProfile.likeBehavior       = likeBehavior
      if (voiceProfile) voiceProfile.originalPostProfile = originalPostProfile
      // Golden examples override polluted RAG examples
      if (voiceProfile?.goldenExamples?.length) {
        personalityProfile.replyExamples = voiceProfile.goldenExamples
      }
      // Merge user-provided banned phrases into avoids
      if (voiceProfile?.bannedPhrases?.length) {
        personalityProfile.avoids = [...(personalityProfile.avoids ?? []), ...voiceProfile.bannedPhrases]
      }
      // Update personality_profile.json with voice data
      const profilePath = path.join(creatorDir, 'personality_profile.json')
      if (fs.existsSync(profilePath)) {
        fs.writeFileSync(profilePath, JSON.stringify(personalityProfile, null, 2), 'utf8')
        console.log('\n  ✓ Profile saved to personality_profile.json')
      }
      // Write voice_profile.json separately — agent loads this file directly
      if (voiceProfile) {
        fs.writeFileSync(path.join(creatorDir, 'voice_profile.json'), JSON.stringify(voiceProfile, null, 2), 'utf8')
        console.log('  ✓ Voice profile saved to voice_profile.json')
      }
    }
  }

  // ── Step: Reply mode + avoid topics ──────────────────────────
  // For bot mode, ask here. For owner/both, already asked after reply interview above.

  let replyMode: string
  if ((personalityProfile as any)?._replyMode) {
    replyMode = (personalityProfile as any)._replyMode
  } else {
    const replyModeStepN = mode === 'bot' ? 8 : 9
    section(replyModeStepN, 'How should Blopus find tweets to reply to?')
    console.log(`
  1 · Domain mode  — only reply to viral tweets in YOUR topics
                     Uses your personality profile to find relevant content.
                     Feels more like you. Recommended.

  2 · Viral mode   — reply to anything viral on your home timeline
                     More volume, less targeted.
`)
    let replyModeRaw = ''
    while (!['1', '2'].includes(replyModeRaw)) {
      replyModeRaw = await ask('  Enter 1 or 2: ')
    }
    replyMode = replyModeRaw === '1' ? 'domain' : 'viral'
    console.log(`  ✓ Reply mode: ${replyMode}`)
  }

  console.log(`
  Topics Blopus should NEVER post about?
  e.g.  politics, religion, crypto, nsfw
  (comma-separated, or press Enter to skip)
`)
  const avoidRaw = await ask('  Topics to avoid: ')
  const avoidTopics = avoidRaw
    ? avoidRaw.split(',').map((t: string) => t.trim().toLowerCase()).filter(Boolean)
    : []
  if (avoidTopics.length) console.log(`  ✓ Will never post about: ${avoidTopics.join(', ')}`)

  // ── Step: GitHub (optional) ──────────────────────────────────

  const githubStepN = mode === 'bot' ? 9 : 10
  section(githubStepN, 'GitHub control — optional')
  console.log(`
  Skip if you don't need it.
  With it: say "create a repo called X", "push my changes",
  "open a PR", "check CI status" — Blopus does it from Telegram.
  Without it: no GitHub control at all.

  Get a Personal Access Token:
  1. github.com → Settings → Developer settings
  2. Personal access tokens → Tokens (classic)
  3. Generate new token → check all "repo" + "workflow" scopes
  4. Copy and paste below. Press Enter to skip.
`)
  const githubToken = await askOptionalOrEnv('GitHub Personal Access Token (or Enter to skip)', 'GITHUB_TOKEN')

  // ── Step: Railway deploy (optional) ──────────────────────────

  const railwayStepN = mode === 'bot' ? 10 : 11
  section(railwayStepN, 'Railway deploy token — optional')
  console.log(`
  Skip if you don't need it.
  With it: say "deploy this to Railway" — Blopus spins up a
  server, API or database instantly from Telegram. No clicking.
  Without it: no cloud deployment from Telegram.

  Get your token:
  1. railway.app → log in (free account)
  2. Avatar top-right → Account Settings → Tokens → New Token
  3. Name it "Blopus" → Create → copy. Press Enter to skip.
`)
  const railwayToken = await askOptionalOrEnv('Railway token', 'RAILWAY_TOKEN')

  // ── Step: Google Workspace MCP (optional) ────────────────────

  const workspaceStepN = mode === 'bot' ? 9 : 10
  section(workspaceStepN, 'Google Workspace — Gmail, Calendar, YouTube, Drive + more (optional)')
  console.log(`
  Skip if you don't need it.
  With it: "send an email to X", "schedule a meeting tomorrow 3pm",
  "upload this file to Drive", "read my inbox", "create a doc" —
  all from Telegram. Without it: none of those skills work.

  One setup covers ALL of these:
  · Gmail      — read inbox, send emails, search, mark read
  · Calendar   — create events, set reminders, schedule meetings
  · Sheets     — read/write spreadsheets
  · Drive      — upload, share, organise files
  · Docs       — create and edit documents
  · YouTube    — upload videos, manage channel, post comments, analytics
  · Tasks      — create and manage to-do lists
  · Contacts   — read and update your contacts
  · Meet       — create Google Meet links
  · Slides     — create presentations

  Do this right now (takes ~5 mins, one-time only):

  1. Go to https://console.cloud.google.com → create a new project
  2. Library → search and ENABLE each of these APIs:
       · Gmail API
       · Google Calendar API
       · Google Sheets API
       · Google Drive API
       · Google Docs API
       · Google Tasks API
       · Google People API
       · YouTube Data API v3
       · YouTube Analytics API
       · Google Slides API
       · Google Meet API
  3. OAuth consent screen → set to External → add your email as test user
  4. Credentials → Create → OAuth 2.0 Client ID → Desktop App
  5. Download the JSON file → rename it to gmail_credentials.json
  6. Place it in: creators/${creatorName}/gmail_credentials.json

  Press Enter once you have placed the file there (or Enter to skip)
`)

  const googleCredsPath = path.join(creatorDir, 'gmail_credentials.json')
  const googleSkip = await askOptional('Press Enter to continue once file is placed (or type "skip" to skip)')

  let googleClientId     = ''
  let googleClientSecret = ''
  let googleRefreshToken = ''

  if (googleSkip !== 'skip' && fs.existsSync(googleCredsPath)) {
    // Extract CLIENT_ID and CLIENT_SECRET directly from the downloaded JSON
    try {
      const raw = JSON.parse(fs.readFileSync(googleCredsPath, 'utf-8'))
      const creds = raw.installed ?? raw.web ?? {}
      googleClientId     = creds.client_id     ?? ''
      googleClientSecret = creds.client_secret ?? ''
      if (googleClientId) console.log(`  ✓ Extracted CLIENT_ID and CLIENT_SECRET from credentials file`)
    } catch {
      console.log(`  ⚠ Could not parse gmail_credentials.json`)
    }

    console.log(`\n  Running one-time Google sign-in...`)
    console.log(`  A browser will open → sign in with Google → click Allow on all permissions`)
    console.log(`  After you approve, come back here. Token saved forever — auto-refreshes.\n`)
    try {
      const { execSync } = require('child_process')
      execSync(
        `python -c "import sys,os; sys.path.insert(0,'${process.cwd().replace(/\\/g, '/')}'); os.environ['OWNER_HANDLE']='${creatorName}'; from google_auth import get_credentials; get_credentials(); print('Token saved')"`,
        { stdio: 'inherit' }
      )
      // Extract refresh token from saved pickle
      try {
        const refreshRaw = execSync(
          `python -c "import pickle,os; p=open('creators/${creatorName}/gmail_token.pickle','rb'); c=pickle.load(p); p.close(); print(c.refresh_token or '')"`,
          { encoding: 'utf-8' }
        ).trim()
        if (refreshRaw) {
          googleRefreshToken = refreshRaw
          console.log(`  ✓ REFRESH_TOKEN extracted automatically`)
        }
      } catch {}
      console.log(`  ✓ Google Workspace connected — Gmail, Calendar, YouTube, Drive, Docs, Sheets, Meet all ready!`)
    } catch {
      console.log(`  ⚠ Could not auto-authenticate. Run this manually after setup:`)
      console.log(`    $env:OWNER_HANDLE="${creatorName}"; python -c "from google_auth import get_credentials; get_credentials()"`)
    }
  } else if (!fs.existsSync(googleCredsPath)) {
    console.log(`  gmail_credentials.json not found in creators/${creatorName}/ — skipped.`)
    console.log(`  To enable later: place the file there and run:`)
    console.log(`    $env:OWNER_HANDLE="${creatorName}"; python -c "from google_auth import get_credentials; get_credentials()"`)
  } else {
    console.log(`  Skipped. Place gmail_credentials.json in creators/${creatorName}/ and re-run setup to enable.`)
  }

  // ── Step: Surge deploy (optional) ────────────────────────────

  const surgeStepN = mode === 'bot' ? 9 : 10
  section(surgeStepN, 'Website deploy — optional')
  console.log(`
  Skip if you don't need it.
  With it: say "deploy this website" — Blopus publishes it
  instantly to a free .surge.sh URL from Telegram.
  Without it: no website publishing from Telegram.

  Run these 2 commands RIGHT NOW in a NEW terminal tab:

    Step 1 — install surge (one-time):
      npm install -g surge

    Step 2 — create your free account:
      surge output/website blopus-setup.surge.sh

  It will ask for email + password — create them on the spot.
  After that, Blopus can deploy any website with one message.

  Press Enter to skip (you can do this later).
`)

  // Create the dummy folder surge needs so the command doesn't fail
  const surgeDir = path.resolve('output/website')
  fs.mkdirSync(surgeDir, { recursive: true })
  if (!fs.existsSync(path.join(surgeDir, 'index.html'))) {
    fs.writeFileSync(path.join(surgeDir, 'index.html'), '<h1>Blopus</h1>', 'utf8')
  }

  await askOptional('Press Enter when done (or Enter to skip)')

  // Read Surge credentials from ~/.netrc and store for later .env write
  let surgeLogin = ''
  let surgeToken = ''
  try {
    const netrc = fs.readFileSync(path.join(require('os').homedir(), '.netrc'), 'utf8')
    const m = netrc.match(/machine surge\.surge\.sh\s+login (\S+)\s+password (\S+)/)
    if (m) { surgeLogin = m[1]; surgeToken = m[2] }
  } catch {}

  if (surgeLogin) {
    console.log(`  ✓ Surge connected — deploy skill ready!`)
  } else {
    console.log(`  Surge skipped — you can set it up later.`)
  }

  // ── Write config files ────────────────────────────────────────

  const stepN = mode === 'bot' ? 9 : 10
  section(stepN, 'Writing config files')

  const envLines = [
    `# Blopus — ${creatorName}`,
    `OWNER_HANDLE=${creatorName}`,
    `TWITTER_API_KEY=${apiKey}`,
    `TWITTER_API_SECRET=${apiSecret}`,
    `TWITTER_ACCESS_TOKEN=${accessToken}`,
    `TWITTER_ACCESS_TOKEN_SECRET=${accessTokenSecret}`,
    `ANTHROPIC_API_KEY=${anthropicKey}`,
    `X_AUTH_EMAIL=${xEmail}`,
    `X_PASSWORD=${xPassword}`,
    `X_AUTH_TOKEN=${xAuthToken}`,
    `X_CT0=${xCt0}`,
    xDmPasscode ? `X_DM_PASSCODE=${xDmPasscode}` : `# X_DM_PASSCODE=`,
    `TAVILY_API_KEY=${tavilyKey}`,
    geminiKey ? `GEMINI_API_KEY=${geminiKey}` : `# GEMINI_API_KEY=`,
    githubToken ? `GITHUB_TOKEN=${githubToken}` : `# GITHUB_TOKEN=`,
    railwayToken ? `RAILWAY_TOKEN=${railwayToken}` : `# RAILWAY_TOKEN=`,
    surgeLogin ? `SURGE_LOGIN=${surgeLogin}` : `# SURGE_LOGIN=`,
    surgeToken ? `SURGE_TOKEN=${surgeToken}` : `# SURGE_TOKEN=`,
    googleClientId     ? `GOOGLE_CLIENT_ID=${googleClientId}`         : `# GOOGLE_CLIENT_ID=`,
    googleClientSecret ? `GOOGLE_CLIENT_SECRET=${googleClientSecret}` : `# GOOGLE_CLIENT_SECRET=`,
    googleRefreshToken ? `GOOGLE_REFRESH_TOKEN=${googleRefreshToken}` : `# GOOGLE_REFRESH_TOKEN=`,
    `TELEGRAM_BOT_TOKEN=${telegramToken}`,
    `TELEGRAM_OWNER_CHAT_ID=${telegramChatId}`,
    `X_HANDLE=${ownerHandle}`,
    `# BOT_HANDLE=`,
    `OSBOT_CONFIG_PATH=./creators/${creatorName}/config.json`,
    `BLOPUS_DIR=${process.cwd().replace(/\\/g, '/')}`,
    `# OWNER_USER_ID=  (run: npx tsx scripts/fetchBotUserId.ts @${ownerHandle} to get this)`,
    ``,
    `# X GraphQL hashes — if mentions/replies stop working, X changed these. Update them:`,
    `# 1. Open x.com in browser → open DevTools (F12) → Network tab → search for "SearchTimeline"`,
    `# 2. Copy the hash from the request URL and paste below`,
    `X_SEARCH_TIMELINE_HASH=flaR-PUMshxFWZWPNpq4zA`,
    `X_TWEET_DETAIL_HASH=nBS-WpgA6ZG0CyNHD517JQ`,
    `REPLY_MODEL=${replyModel}`,
    `SESSIONBRAIN_MODEL=claude-sonnet-4-6`,
    archiveCopied
      ? `TWITTER_ARCHIVE_PATH=./creators/${creatorName}/tweets.js`
      : `# TWITTER_ARCHIVE_PATH=./creators/${creatorName}/tweets.js`,
  ]
  fs.writeFileSync(path.join(creatorDir, '.env'), envLines.join('\n') + '\n', 'utf8')
  console.log(`  ✓ creators/${creatorName}/.env`)

  // Write CREATOR to root .env so user can run without prefix on all platforms
  const rootEnvPath = path.resolve('.env')
  let rootEnv = fs.existsSync(rootEnvPath) ? fs.readFileSync(rootEnvPath, 'utf8') : ''
  if (/^CREATOR=/m.test(rootEnv)) {
    rootEnv = rootEnv.replace(/^CREATOR=.*/m, `CREATOR=${creatorName}`)
  } else {
    rootEnv = `CREATOR=${creatorName}\n` + rootEnv
  }
  fs.writeFileSync(rootEnvPath, rootEnv, 'utf8')
  console.log(`  ✓ Root .env — CREATOR=${creatorName}`)

  const rpd: number = (voiceProfile as any)?.repliesPerDay ?? 10
  const config = {
    blopus: {
      handle: ownerHandle,
      userId: ownerUserId,
      displayName: ownerHandle,
    },
    owner: {
      handle: ownerHandle,
      userId: ownerUserId,
      displayName: ownerHandle,
    },
    platform: {
      primary: 'x',
      pollIntervalMinutes: 5,
      maxRepliesPerPollCycle: Math.max(1, Math.round(rpd / 24 / 2)),
      maxRepliesPerDay: rpd,
      replyDelayMinutes: { min: 1, max: 5 },
    },
    personality: {
      traits: {
        aggression:  personalityProfile?.traits?.aggression  ?? 0.3,
        warmth:      personalityProfile?.traits?.warmth      ?? 0.6,
        humor:       personalityProfile?.traits?.humor       ?? 0.5,
        formality:   personalityProfile?.traits?.formality   ?? 0.4,
        verbosity:   personalityProfile?.traits?.verbosity   ?? 0.5,
      },
      quirks: { responseRate: 0.8 },
    },
    llm: {
      model: replyModel,
      maxTokens: 400,
      temperature: 0.8,
      enabled: true,
    },
    summon: {
      keywords: ['osbot', 'blopus'],
      requireOwnerHandle: false,
    },
    pack: {
      knownOsBots: [],
      tagProbability: 0.1,
      maxTagsPerReply: 1,
    },
    memory: {
      storePath: `./creators/memory-store`,
      maxRecords: 10000,
      pruneAfterDays: 90,
    },
    rateLimits: {
      monthlyPostBudget: 500,
      safetyBufferPercent: 0.1,
      minimumPollIntervalMinutes: 3,
      backoffOnErrorMs: 60000,
      threadCooldownMinutes: 60,
    },
    controlChannel: {
      telegram: { ownerChatId: telegramChatId },
    },
    replySettings: {
      maxRepliesPerHour: Math.max(1, Math.round(rpd / 16)),
      replyToMentions: true,
      replyToViral: true,
    },
    replyMode,
    replyEngine: (replyEngine as any) ?? 'rag',
    replyStrategy: (replyStrategy as any) ?? 'growth',
    avoidTopics,
    domainMinLikes: (personalityProfile as any)?.domainMinLikes ?? {},
    domainSearchKeywords: (personalityProfile as any)?.domainSearchKeywords ?? {},
    maxAgeTweetMinutes: (personalityProfile as any)?.maxAgeTweetMinutes ?? 720,
  }
  fs.writeFileSync(
    path.join(creatorDir, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  )
  console.log(`  ✓ creators/${creatorName}/config.json`)

  // ── Done ──────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(58))
  console.log('  Setup complete!')
  console.log('═'.repeat(58))

  console.log(`
  Start your agent:

    npm run blopus:owner

  (CREATOR is already saved in .env — no prefix needed on any platform)

  Once it starts, message your Telegram bot to control everything —
  post tweets, search, set timers, manage files, anything.
`)

  console.log('─'.repeat(58))
  console.log('  HOW TELEGRAM WORKS')
  console.log('─'.repeat(58))
  console.log(`
  Your Telegram bot is the control panel for THIS account only.

  If you only run your owner account:
    → One Telegram bot is all you need. You are done.

  If you also want a separate bot account (npm run bot-setup):
    → Create a NEW Telegram bot on @BotFather for it.
    → Do NOT reuse this same token for the bot account.
    → Why: if both agents run simultaneously with the same
      token, Telegram splits your messages randomly between
      them — you lose control of which account you're talking to.
    → Autonomous posting always runs fine regardless.
      Only Telegram control breaks if tokens are shared.
`)

  console.log('─'.repeat(58))
  console.log('  DM replies — coming soon')
  console.log('  When ready, run:  npm run dm-setup')
  console.log('─'.repeat(58))

  if (!personalityProfile) {
    console.log(`
  NOTE: No archive was processed. Blopus will post in a
  generic voice. To add your personality later:
  1. Get your Twitter archive (x.com → Settings → Download archive)
  2. Run:  npm run ingest
`)
  }

  console.log()
  rl.close()
}

main().catch(err => {
  console.error('\nSetup failed:', err.message)
  rl.close()
  process.exit(1)
})
