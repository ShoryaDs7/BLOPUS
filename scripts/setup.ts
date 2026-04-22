#!/usr/bin/env npx tsx
/**
 * Blopus Setup — run once to configure your Blopus instance.
 * Usage: npm run setup
 */

import readline from 'readline'
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'

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
      system: 'You extract structured data from a person\'s natural language answer. CRITICAL: Read the ENTIRE sentence — do not latch onto the first word. If they say "yes but only X now", they mean ONLY X. If they say "yes" with nothing after, they accept the default. Never assume "yes" at the start means full acceptance if the rest of the sentence modifies it. Return ONLY what is asked — no markdown, no fences, no explanations.',
      messages: [{ role: 'user', content: `Context: ${context}\nUser said: "${userSaid}"\nReturn: ${returnFormat}` }],
    })
    const raw = res.content[0].type === 'text' ? res.content[0].text.trim() : ''
    // Strip markdown code fences if Claude wraps JSON
    return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  } catch { return '' }
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
- When you have enough, output exactly: [INTERVIEW_DONE]
  Then on the next lines, output a JSON block (no markdown, just raw JSON) with this shape:
  {"caseStyle":"...","apostropheStyle":"...","replyLength":"...","emojiUsage":"...","characteristicMentions":"...","onNewsWithTake":"...","onFactualClaim":"...","onAgreement":"...","onDisagreement":"...","onFunny":"...","onControversial":"...","bannedPhrases":"...","neverTopics":"..."}

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
      max_tokens: 300,
      system: SYSTEM,
      messages,
    })
    const block = res.content?.[0]
    if (!block || block.type !== 'text') { turnCount++; continue }
    const claudeMsg = block.text.trim()
    messages.push({ role: 'assistant', content: claudeMsg })

    if (claudeMsg.includes('[INTERVIEW_DONE]')) {
      // Extract JSON after the marker
      const jsonStart = claudeMsg.indexOf('{', claudeMsg.indexOf('[INTERVIEW_DONE]'))
      if (jsonStart !== -1) {
        try { structuredAnswers = JSON.parse(claudeMsg.slice(jsonStart)) } catch {}
      }
      break
    }

    // Print Claude's message (question + "Got it —" lines)
    const lines = claudeMsg.split('\n').filter((l: string) => l.trim())
    for (const line of lines) {
      console.log(`  ${line}`)
    }

    // If there's a [Q] in the message, get user input
    if (claudeMsg.includes('[Q]')) {
      const userInput = await askFn('\n  > ')
      console.log()
      messages.push({ role: 'user', content: userInput })
    }

    turnCount++
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
  const topicList = topics.slice(0, 5).map((t, i) => `  ${i + 1}. ${t}`).join('\n')

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 4 — QUOTE TWEETS')
  console.log('═'.repeat(58) + '\n')
  console.log('  Your computed topics from archive:')
  console.log(topicList + '\n')

  console.log('  [1/4] Which of these topics make you want to add your own take?')
  console.log('        (type the topics, or "all", or "none")')
  const q1 = await askFn('  > ')
  const topicsJson = await claudeInterpret(client, q1, `Archive topics: ${JSON.stringify(topics)}`, 'A JSON array of topics the user actually wants to quote tweet about. Read their full answer — if they said "all" return all archive topics, if they said specific ones return only those, if "none" return []. Return ONLY a valid JSON array.')
  let quoteTopics: string[] = []
  try { quoteTopics = JSON.parse(topicsJson) } catch { quoteTopics = [] }
  console.log(`  Got it — quote tweet topics: ${quoteTopics.join(', ') || 'none'}\n`)

  console.log('  [2/4] What would you NEVER quote tweet? (topic, type, or "nothing")')
  const q2 = await askFn('  > ')
  const neverKeywords = await expandNeverKeywords(q2, askFn)
  console.log(`  Got it — ${q2}\n`)

  console.log('  [3/4] When a matching tweet shows up, how likely are you to quote it?')
  console.log('        (always / usually / sometimes / rarely)')
  const q3 = await askFn('  > ')
  const probStr = await claudeInterpret(client, q3, 'Question about likelihood of quoting a matching tweet', 'A decimal number between 0 and 1 representing probability. "always"=1.0, "usually"=0.75, "sometimes"=0.5, "rarely"=0.25. Return ONLY the number.')
  const probability = parseFloat(probStr) || 0.5
  console.log(`  Got it — probability: ${Math.round(probability * 100)}%\n`)

  console.log('  [4/4] How often do you quote tweet? (e.g. "once a day", "2 times a day", "every 4 hours")')
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
  const topicList = topics.slice(0, 5).map((t, i) => `  ${i + 1}. ${t}`).join('\n')

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 5 — RETWEETS')
  console.log('═'.repeat(58) + '\n')
  console.log('  Your computed topics from archive:')
  console.log(topicList + '\n')

  console.log('  [1/4] Which of these topics do you retweet?')
  console.log('        (type the topics, or "all", or "none")')
  const q1 = await askFn('  > ')
  const topicsJson = await claudeInterpret(client, q1, `Archive topics: ${JSON.stringify(topics)}`, 'A JSON array of topics the user actually retweets. Read their full answer — if they said "all" return all archive topics, if they said specific ones return only those, if "none" return []. Return ONLY a valid JSON array.')
  let retweetTopics: string[] = []
  try { retweetTopics = JSON.parse(topicsJson) } catch { retweetTopics = [] }
  console.log(`  Got it — retweet topics: ${retweetTopics.join(', ') || 'none'}\n`)

  console.log('  [2/4] What would you NEVER retweet? (topic, type, or "nothing")')
  const q2 = await askFn('  > ')
  const neverKeywords = await expandNeverKeywords(q2, askFn)
  console.log(`  Got it — ${q2}\n`)

  console.log('  [3/4] When a matching tweet shows up, how likely are you to retweet it?')
  console.log('        (always / usually / sometimes / rarely)')
  const q3 = await askFn('  > ')
  const probStr = await claudeInterpret(client, q3, 'Likelihood of retweeting a matching tweet', 'A decimal 0-1. "always"=1.0, "usually"=0.75, "sometimes"=0.5, "rarely"=0.25. Return ONLY the number.')
  const probability = parseFloat(probStr) || 0.5
  console.log(`  Got it — probability: ${Math.round(probability * 100)}%\n`)

  console.log('  [4/4] How often do you retweet? (e.g. "once a day", "2 times a day", "every 2 hours")')
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
  const topicList = topics.slice(0, 5).map((t, i) => `  ${i + 1}. ${t}`).join('\n')

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 6 — LIKES')
  console.log('═'.repeat(58) + '\n')
  console.log('  Your computed topics from archive:')
  console.log(topicList + '\n')

  console.log('  [1/4] Which of these topics do you like tweets about?')
  console.log('        (type the topics, or "all", or "none")')
  const q1 = await askFn('  > ')
  const topicsJson = await claudeInterpret(client, q1, `Archive topics: ${JSON.stringify(topics)}`, 'A JSON array of topics the user actually likes tweets about. Read their full answer — if they said "all" return all archive topics, if they said specific ones return only those, if "none" return []. Return ONLY a valid JSON array.')
  let likeTopics: string[] = []
  try { likeTopics = JSON.parse(topicsJson) } catch { likeTopics = [] }
  console.log(`  Got it — like topics: ${likeTopics.join(', ') || 'none'}\n`)

  console.log('  [2/4] What would you NEVER like? (topic, type, or "nothing")')
  const q2 = await askFn('  > ')
  const neverKeywords = await expandNeverKeywords(q2, askFn)
  console.log(`  Got it — ${q2}\n`)

  console.log('  [3/4] When a matching tweet shows up, how likely are you to like it?')
  console.log('        (always / usually / sometimes / rarely)')
  const q3 = await askFn('  > ')
  const probStr = await claudeInterpret(client, q3, 'Likelihood of liking a matching tweet', 'A decimal 0-1. "always"=1.0, "usually"=0.75, "sometimes"=0.5, "rarely"=0.25. Return ONLY the number.')
  const probability = parseFloat(probStr) || 0.5
  console.log(`  Got it — probability: ${Math.round(probability * 100)}%\n`)

  console.log('  [4/4] How often do you like tweets? (e.g. "5 times an hour", "few times a day", "once an hour")')
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
async function runReplyInterview(computed: any, askFn: (q: string) => Promise<string>, client: Anthropic): Promise<any> {
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
- If an answer is vague, follow up ONCE
- Cover ALL of these (skip what's already obvious from the archive):
  WRITING STYLE:
  1. Case style — lowercase, mixed, proper? Archive has a reading, confirm it
  2. Apostrophes — "dont" or "don't"? Archive has a reading, confirm it
  3. Emojis — how often, which ones, or never?
  4. Reply length — one-liners vs sentences vs bullet points?
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
- Ask 8-12 questions total. Track count with [x/12] prefix on each [Q].
- When done output exactly: [INTERVIEW_DONE]
  Then ONLY this raw JSON (no markdown, no backticks):
{
  "caseStyle": "...",
  "apostropheStyle": "...",
  "replyLength": "...",
  "emojiUsage": "...",
  "onNewsWithTake": "...",
  "onFactualClaim": "...",
  "onAgreement": "...",
  "onDisagreement": "...",
  "onFunny": "...",
  "onControversial": "...",
  "bannedPhrases": "comma,separated or empty",
  "tagUsagePattern": "if they tag specific accounts: 'You tag @X in [domains] when [tweet type]. Roughly [N] out of 100 replies. Never use @X for [exceptions].' Empty string if no specific accounts mentioned.",
  "replyBehaviorSynthesized": "2-3 sentences on reply-specific behaviors only. Write as instructions TO the bot: 'When you disagree you...', 'You tag @X when...'"
}

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
      if (assistantText.includes('[INTERVIEW_DONE]')) {
        const jsonStart = assistantText.indexOf('{', assistantText.indexOf('[INTERVIEW_DONE]'))
        if (jsonStart !== -1) {
          try { structuredAnswers = JSON.parse(assistantText.slice(jsonStart)) } catch {
            const match = assistantText.slice(jsonStart).match(/\{[\s\S]*\}/)
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
  }

  // ── Golden examples — dynamic per domain (Math.max(2, round(8/domains))) ──
  console.log('\n  ─ Golden examples — reply exactly as you would ─\n')

  const confirmedReplyTopics: string[] = (computed?.voiceProfile?.replyMode === 'domain' && computed?.dominantTopics?.length)
    ? computed.dominantTopics
    : (computed?.replyTopics ?? topics)

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

  const buildReplyPrompt = (tweet: string, correction?: string) => `Reply to this tweet AS this person. Be them exactly.

Tweet: "${tweet}"

Writing style: ${synthesized}
Case: ${structuredAnswers.caseStyle || 'lowercase'}
Length: ${structuredAnswers.replyLength || 'short one-liners, occasionally longer in bullet points'}
${structuredAnswers.tagUsagePattern ? `Tagging rule: ${structuredAnswers.tagUsagePattern}` : ''}
NEVER use: ${splitList(structuredAnswers.bannedPhrases ?? '').join(', ') || 'nothing specified'}
Reply behavior: ${structuredAnswers.replyBehaviorSynthesized ?? ''}

Golden examples — match this exact voice and length:
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}
${correction ? `\nPrevious attempt was wrong — fix this: ${correction}` : ''}

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

      let correction = ''
      let approved = false
      while (!approved) {
        const replyRes = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 120,
          messages: [{ role: 'user', content: buildReplyPrompt(sampleTweet, correction || undefined) }],
        })
        const rc = replyRes.content[0]
        if (!rc || rc.type !== 'text') break
        console.log(`  Reply: "${rc.text.trim()}"`)
        const fb = await askFn('  Correct? (yes / tell me what\'s off): ')
        if (/^yes|^y$|^yep|^yeah/i.test(fb.trim())) {
          approved = true
          console.log()
        } else if (fb.trim()) {
          correction = fb.trim()
          synthesized += ` For ${topic}: ${correction}`
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

    const userAnswer = await askFn('  > ')
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
- If an answer is vague or too short, follow up ONCE before moving on
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

    const userAnswer = await askFn('  > ')
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
  let anthropicKey = ''
  let setupClient!: Anthropic
  while (true) {
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

  // ── Step 2: Mode ─────────────────────────────────────────────

  section(2, 'Choose your mode')
  console.log(`
  1 · Owner mode   — Blopus posts AS YOU on your real X account
                     Learns your exact voice from your tweet archive.

  2 · Bot mode     — Blopus runs its OWN separate X bot account
                     Has its own handle and personality.

  3 · Both         — Runs your real account AND a separate bot.
`)

  let modeRaw = ''
  while (!['1','2','3'].includes(modeRaw)) {
    modeRaw = await ask('  Enter 1, 2, or 3: ')
  }
  const mode = modeRaw === '1' ? 'owner' : modeRaw === '2' ? 'bot' : 'both'
  console.log(`  ✓ Mode: ${mode}`)

  // ── Step 2: Handles ──────────────────────────────────────────

  section(3, 'Your X handles')

  const ownerHandle = await askRequired(
    'Your real X handle (no @)',
    'e.g.  johndoe   — this is YOUR real account'
  )

  const creatorName = ownerHandle.toLowerCase()
  const creatorDir  = path.resolve(`./creators/${creatorName}`)
  fs.mkdirSync(creatorDir, { recursive: true })

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
       Set "App permissions" to "Read and Write" → Save
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
     · Under "Access Token" → click Generate → copy Access Token + Secret
       (if it says "Read" next to the token → you must regenerate it after
        setting Read+Write permissions in step 4, otherwise posting will fail)

  6. Add credits (required to use the API):
     → Left sidebar → Billing → Credits → add at least $5
     (Without credits the API will reject all requests)

  ──────────────────────────────────────────────────────────
`)

  const apiKey            = await askRequired('API Key (Consumer Key)')
  const apiSecret         = await askRequired('API Secret (Consumer Secret)')
  const accessToken       = await askRequired('Access Token')
  const accessTokenSecret = await askRequired('Access Token Secret')

  // ── Step 5: X login for Playwright ───────────────────────────

  section(5, 'X login credentials')
  console.log(`
  Blopus uses a hidden browser to read your X home timeline
  and post as you. It needs your X login to do this.
  Stored locally only — never sent anywhere.
`)

  const xEmail    = await askRequired('X account email')
  const xPassword = await askRequired('X account password')

  // ── Step 5b: X session cookies ────────────────────────────────

  section(6, 'X session cookies — for home timeline reading')
  console.log(`
  Blopus reads your X home timeline using session cookies from your browser.
  Takes 30 seconds to grab.

  How to get them:
  1. Open x.com in Chrome/Edge — make sure you are logged in as yourself
  2. Press F12 → click the "Application" tab in the top menu bar
  3. Left sidebar → Storage → Cookies → click "https://x.com"
  4. Find "auth_token" in the list → click it → copy the entire Value
  5. Find "ct0" in the list → click it → copy the entire Value
`)
  const xAuthToken = await askRequired('auth_token value (long string of letters/numbers)')
  const xCt0       = await askRequired('ct0 value (very long string)')

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
  const xDmPasscode = await askOptional('X DM passcode (Enter to skip if not set)')

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

  const tavilyKey = await askRequired('Tavily API Key')

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

  const geminiKey = await askOptional('Gemini API Key')

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

  const telegramToken  = await askRequired('Telegram bot token')
  const telegramChatId = await askRequired('Your Telegram chat ID')

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
  5. Point Blopus to the extracted "data" folder

  Enter the full path to the extracted data/ folder below.
  (Press Enter to skip — you can add it later via npm run ingest)
`)

    const archivePath = await askOptional(
      'Full path to your archive data/ folder',
      'e.g.  C:/Users/you/Downloads/twitter-2025/data'
    )

    const resolvedArchiveDir = archivePath
      ? (fs.existsSync(archivePath) && fs.statSync(archivePath).isDirectory()
          ? archivePath
          : fs.existsSync(archivePath) && archivePath.endsWith('.js')
            ? path.dirname(archivePath)  // they pasted tweets.js path — use its folder
            : null)
      : null

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

        // ── Ask for topic corrections ────────────────────────────
        if (personalityProfile) {
          console.log('\n' + '─'.repeat(58))
          console.log('  CONFIRM DOMAIN TOPICS FOR REPLY HUNTING')
          console.log('  Blopus will search for viral tweets on these topics to reply to.')
          console.log('  Start from your reply topics — they are more accurate.')
          console.log()
          console.log('  Options:')
          console.log('    Enter               -> use reply topics as-is (recommended)')
          console.log('    use posts           -> use post topics instead')
          console.log('    remove: 2,4         -> remove from reply topics by number')
          console.log('    add: topic name     -> add a topic')
          console.log('    set: t1, t2, t3     -> replace entire list manually')
          console.log()
          console.log('  Reply topics (recommended starting point):')
          ;(personalityProfile.replyTopics ?? []).forEach((t: string, i: number) => console.log(`    ${i + 1}. ${t}`))

          const fix = await ask('\n  Your choice: ')

          if (!fix.trim() || fix.trim().toLowerCase() === 'use replies') {
            personalityProfile.dominantTopics = personalityProfile.replyTopics ?? personalityProfile.dominantTopics
            console.log(`  Using reply topics as domain list.`)
          } else if (fix.trim().toLowerCase() === 'use posts') {
            personalityProfile.dominantTopics = personalityProfile.postTopics ?? personalityProfile.dominantTopics
            console.log(`  Using post topics as domain list.`)
          } else {
            const removeMatch = fix.match(/^remove\s*:\s*([\d,\s]+)/i)
            const addMatch    = fix.match(/^add\s*:\s*(.+)/i)
            const setMatch    = fix.match(/^set\s*:\s*(.+)/i)

            const base = personalityProfile.replyTopics ?? personalityProfile.dominantTopics ?? []

            if (removeMatch) {
              const nums = removeMatch[1].split(',').map(n => parseInt(n.trim()) - 1)
              personalityProfile.dominantTopics = base.filter((_: string, i: number) => !nums.includes(i))
              console.log(`  Topics set to:`)
              personalityProfile.dominantTopics.forEach((t: string) => console.log(`    · ${t}`))
            } else if (addMatch) {
              personalityProfile.dominantTopics = [...base, addMatch[1].trim()]
              console.log(`  Added: ${addMatch[1].trim()}`)
            } else if (setMatch) {
              personalityProfile.dominantTopics = setMatch[1].split(',').map((t: string) => t.trim())
              console.log(`  Topics set to: ${personalityProfile.dominantTopics.join(', ')}`)
            } else {
              personalityProfile.dominantTopics = personalityProfile.replyTopics ?? personalityProfile.dominantTopics
              console.log(`  Using reply topics as domain list.`)
            }
          }

          fs.writeFileSync(
            path.join(creatorDir, 'personality_profile.json'),
            JSON.stringify(personalityProfile, null, 2),
            'utf8'
          )
          console.log(`\n  ✓ Personality profile saved.`)
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
        console.log(`  Got it — topics: ${domainTopics.slice(0, 5).join(', ')}\n`)
        personalityProfile.dominantTopics = domainTopics

        // Q3 — Never (domain mode)
        console.log(`  [3] Any topics Blopus should NEVER reply to — even if they match your topics?`)
        console.log(`      e.g. "politics, religion, nsfw" — or press Enter to skip`)
        const neverRaw = await ask('  > ')
        if (neverRaw.trim()) {
          const neverJson = await claudeInterpret(setupClient, neverRaw, 'The user is listing topics they never want to reply to. Each word or phrase is a topic.', 'A JSON array of never-reply topics. Return ONLY a valid JSON array of strings.')
          try { neverTopics = JSON.parse(neverJson) } catch { neverTopics = neverRaw.split(',').map((t: string) => t.trim()).filter(Boolean) }
        }
        if (neverTopics.length) console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)

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

    if (replyEngine === 'voice') {
      voiceProfile = await runReplyInterview(personalityProfile, ask, setupClient)
      originalPostProfile = await runOriginalPostInterview(personalityProfile, ask, setupClient)
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

    if (!await askSkip('ORIGINAL POSTS — how Blopus writes your standalone tweets', ask))
      originalPostProfile = await runOriginalPostInterview(personalityProfile, ask, setupClient)
    else console.log('  Skipped — Blopus will use archive style for posts.\n')

    if (!await askSkip('QUOTE TWEETS — when and how you quote tweet others', ask))
      quoteTweetBehavior = await runQuoteTweetInterview(personalityProfile, ask, setupClient)
    else console.log('  Skipped — quote tweeting disabled.\n')

    if (!await askSkip('RETWEETS — when you retweet others', ask))
      { const rt = await runRetweetInterview(personalityProfile, ask, setupClient); if (personalityProfile) (personalityProfile as any).retweetBehavior = rt }
    else console.log('  Skipped — retweeting disabled.\n')

    if (!await askSkip('LIKES — what content you like', ask))
      likeBehavior = await runLikeInterview(personalityProfile, ask, setupClient)
    else console.log('  Skipped — auto-liking disabled.\n')

    if (!await askSkip('REPLY BACK — who you reply to when people engage with you', ask))
      { const replyBackRules = await runReplyBackInterview(ask, setupClient)
        if (voiceProfile) voiceProfile.replyBackRules = replyBackRules
        else { if (!personalityProfile?.voiceProfile) (personalityProfile as any).voiceProfile = {}; (personalityProfile as any).voiceProfile.replyBackRules = replyBackRules }
      }
    else console.log('  Skipped — Blopus will reply to everyone.\n')

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
  const githubToken = await askOptional('GitHub Personal Access Token (or Enter to skip)')

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
  const railwayToken = await askOptional('Railway token')

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

  Run this command RIGHT NOW in this terminal to create
  your free Surge account — takes 30 seconds:

    surge output/website blopus-setup.surge.sh

  It will ask for email + password — create them on the spot.
  After that, Blopus can deploy any website with one message.

  Press Enter to skip (you can do this later).
`)
  await askOptional('Press Enter when done (or Enter to skip)')

  // Read Surge credentials from ~/.netrc and store for later .env write
  let surgeLogin = ''
  let surgeToken = ''
  try {
    const netrc = fs.readFileSync(path.join(require('os').homedir(), '.netrc'), 'utf8')
    const m = netrc.match(/machine surge\.surge\.sh\s+login (\S+)\s+password (\S+)/)
    if (m) { surgeLogin = m[1]; surgeToken = m[2] }
  } catch {}

  console.log(`  ✓ Surge setup complete — deploy skill ready!`)

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
    archiveCopied
      ? `TWITTER_ARCHIVE_PATH=./creators/${creatorName}/tweets.js`
      : `# TWITTER_ARCHIVE_PATH=./creators/${creatorName}/tweets.js`,
  ]
  fs.writeFileSync(path.join(creatorDir, '.env'), envLines.join('\n') + '\n', 'utf8')
  console.log(`  ✓ creators/${creatorName}/.env`)

  const config = {
    blopus: {
      handle: ownerHandle,
      displayName: 'Blopus',
    },
    owner: {
      handle: ownerHandle,
      displayName: ownerHandle,
    },
    controlChannel: {
      telegram: { ownerChatId: telegramChatId },
    },
    llm: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
    },
    replySettings: {
      maxRepliesPerHour: 10,
      replyToMentions: true,
      replyToViral: true,
    },
    replyMode,
    replyEngine: (replyEngine as any) ?? 'rag',
    replyStrategy: (replyStrategy as any) ?? 'growth',
    avoidTopics,
  }
  fs.writeFileSync(
    path.join(creatorDir, 'blopus.config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  )
  console.log(`  ✓ creators/${creatorName}/blopus.config.json`)

  // ── Done ──────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(58))
  console.log('  Setup complete!')
  console.log('═'.repeat(58))

  console.log(`
  Start your agent:

    CREATOR=${creatorName} npm run blopus:owner

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
