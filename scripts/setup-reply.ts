#!/usr/bin/env npx tsx
/**
 * Standalone script — How You Reply interview.
 * Covers writing style + reply-specific behaviors in one dynamic interview.
 * Saves to voiceProfile (synthesized + replyBehavior).
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
  const ws = profile.writingStats ?? {}
  const archiveContext = JSON.stringify({
    writingStats:           ws,
    dominantTopics:         profile.dominantTopics ?? [],
    replyTopics:            profile.replyTopics ?? [],
    signaturePatterns:      (profile.signaturePatterns ?? []).slice(0, 8).map((p: any) =>
      typeof p === 'string' ? p : { phrase: p.phrase, usedFor: p.usedFor, neverUsedFor: p.neverUsedFor }
    ),
    characteristicMentions: ws.characteristicMentions ?? [],
    replyExamples:          (profile.replyExamples ?? []).slice(0, 10),
  }, null, 2)

  console.log('\n' + '═'.repeat(58))
  console.log('  HOW YOU REPLY')
  console.log('  Writing style + reply patterns in one interview.')
  console.log('═'.repeat(58) + '\n')

  // ── Skip option — jump to section using saved profile data ──────────────
  const existingVP = profile.voiceProfile
  let skipTo = ''
  if (existingVP?.synthesized) {
    console.log('  Saved profile found. Jump to:')
    console.log('  [1] Full interview (start over)')
    console.log('  [2] Golden examples only (keep saved interview answers)')
    console.log('  [3] Sample replies only (keep everything, just redo validation)')
    const pick = await ask('\n  > ')
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
- Cover ALL of these (skip what's already obvious from the archive):
  WRITING STYLE:
  1. Case style — lowercase, mixed, proper? Archive has a reading, confirm it
  2. Apostrophes — do they write "dont" or "don't"? Archive has a reading, confirm it
  3. Emojis — ask: "Out of 100 replies, how many would include an emoji?" Archive has a %, confirm the number.
  4. Mixed language — if the archive shows any non-English words or phrases, ask: "Out of 100 replies, how many would include a word or phrase in [language detected from archive]? Give me a number." If archive is English-only or no non-English patterns visible, skip this question and save 0.
  5. Reply length — one-liners vs sentences vs bullet points, when does length change?
  6. Opening phrases — do they have any signature starters, or no fixed pattern?

  REPLY BEHAVIOR:
  7. Tagging patterns — who do they tag and when? Archive has characteristicMentions, confirm/clarify
     CRITICAL: If they mention ANY specific account (e.g. @grok, @elonmusk, @sama), immediately ask 3 follow-up questions before moving on (each counts toward question limit):
       a. Which topics/domains do you use @[account] in? (e.g. only AI, or also crypto, sports?)
       b. What type of tweet makes you tag them? (factual claim? wrong take? just for engagement? always?)
       c. Out of 100 replies, roughly how many would have @[account]?
  8. Wrong takes — what do they do when someone is wrong?
  9. Agreement — how do they reply when they agree with something?
  10. Hot takes / breaking news — do they jump in or stay out?
  11. What they NEVER do in replies
- Ask 8-12 questions total. Track count with [x/12] prefix on each [Q].

QUANTITATIVE RULES — apply to every frequency/style question:
- Always push for a NUMBER. Frame as: "out of 100 replies, how many would [X]?"
- If user says anything vague ("idk", "sometimes", "a little", "not much", "depends", "occasionally"): ask ONCE — "give me your best guess as a number out of 100"
- If they still won't give a number, convert using this table: never→0, rarely/barely/almost never→5, sometimes/a little/not much/occasionally→15, often/usually→60, mostly/almost always→80, always/every time→95
- NEVER output vague words for frequency fields in the JSON — always a number 0-100

- When done output exactly: [INTERVIEW_DONE]
  Then ONLY this raw JSON (no markdown, no backticks):
{
  "caseStyle": "...",
  "apostropheStyle": "...",
  "replyLength": "...",
  "emojiUsage": "NUMBER 0-100: how many out of 100 replies include an emoji",
  "mixedLanguageFrequency": "NUMBER 0-100: how many out of 100 replies include non-English words (0 if English-only)",
  "onNewsWithTake": "...",
  "onFactualClaim": "...",
  "onAgreement": "...",
  "onDisagreement": "...",
  "onFunny": "...",
  "onControversial": "...",
  "bannedPhrases": "comma,separated or empty",
  "neverTopics": "comma,separated or empty",
  "tagUsagePattern": "if they tag specific accounts: 'You tag @X in [domains] when [tweet type]. Roughly [N] out of 100 replies. Never use @X for [exceptions].' Empty string if no specific accounts mentioned.",
  "replyBehaviorSynthesized": "2-3 sentences on reply-specific behaviors only (tagging, reactions, tone). Write as instructions TO the bot: 'When you disagree you...', 'You tag @X when...'"
}

Never say you're an AI. No "Great answer!" Keep it direct.`

  // Load from saved profile if skipping interview
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
  if (skipTo === 'golden' || skipTo === 'samples') {
    const vp = existingVP!
    structuredAnswers = {
      caseStyle:               vp.caseStyle ?? '',
      apostropheStyle:         vp.apostropheStyle ?? '',
      replyLength:             vp.replyLength ?? '',
      emojiUsage:              vp.emojiUsage ?? '',
      onNewsWithTake:          vp.behaviorPatterns?.onNewsWithTake ?? '',
      onFactualClaim:          vp.behaviorPatterns?.onFactualClaim ?? '',
      onAgreement:             vp.behaviorPatterns?.onAgreement ?? '',
      onDisagreement:          vp.behaviorPatterns?.onDisagreement ?? '',
      onFunny:                 vp.behaviorPatterns?.onFunny ?? '',
      onControversial:         vp.behaviorPatterns?.onControversial ?? '',
      bannedPhrases:           (vp.bannedPhrases ?? []).join(','),
      neverTopics:             (vp.neverTopics ?? []).join(','),
      tagUsagePattern:         vp.tagUsagePattern ?? '',
      replyBehaviorSynthesized: vp.replyBehavior?.synthesized ?? '',
    }
    console.log('  Using saved interview answers.\n')
  }

  if (!skipTo) {
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
      structuredAnswers = extractInterviewJSON(assistantText) ?? {}
      if (!structuredAnswers.caseStyle) console.warn('[Setup] Interview JSON missing fields — LLM may have output malformed JSON')
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
  } // end if (!skipTo)

  // ── Golden examples — 2 per domain (1 wrong-take + 1 agree/news) ──────────
  console.log('\n  ─ Golden examples — reply exactly as you would ─\n')

  // Use confirmed domain topics if domain filter already ran, else fall back to archive
  const confirmedReplyTopics: string[] = (profile.voiceProfile?.replyMode === 'domain' && profile.dominantTopics?.length)
    ? profile.dominantTopics
    : (profile.replyTopics ?? topics)

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
  } catch {}

  if (!tweetPairs.length) {
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
    while (!userInput.trim()) { userInput = await ask('\n  > ') }
    console.log()
    if (/^na$/i.test(userInput)) { neverReplyTypes.push(tweet); console.log('  Got it — skipping this type.\n') }
    else if (/^skip$/i.test(userInput)) { console.log('  Skipped.\n') }
    else { goldenExamples.push(userInput); console.log('  Got it.\n') }
  }
  } // end if (skipTo !== 'samples')

  // ── Synthesize writing style ─────────────────────────────────
  let synthesized = (existingVP?.synthesized ?? '').split('\n').filter((l: string) => !l.startsWith('#')).join('\n').trim()
  if (skipTo === 'samples' && synthesized) {
    console.log('  Using saved synthesized style.\n')
  } else {
  console.log('  Synthesizing...\n')
  synthesized = ''
  try {
    const synthRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: `You are setting up an autonomous X bot that posts AS this exact person.

Confirmed writing style:
${JSON.stringify(structuredAnswers, null, 2)}

Their actual replies (golden examples — bot must match these exactly):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}
${neverReplyTypes.length ? `\nTweet types they do NOT reply to (they said "na" to these):\n${neverReplyTypes.map((t, i) => `${i + 1}. "${t}"`).join('\n')}` : ''}

Write 2-3 sentences describing ONLY how this person writes (style, tone, structure, length). No reply behaviors. This gets injected into every LLM prompt.` }],
    })
    const c = synthRes.content[0]
    if (c.type === 'text') synthesized = c.text.trim().split('\n').filter((l: string) => !l.startsWith('#')).join('\n').trim()
  } catch {
    synthesized = `Writes in ${structuredAnswers.caseStyle || 'mixed case'}. Replies are ${structuredAnswers.replyLength || 'short'}.`
  }
  } // end if (skipTo === 'samples' && synthesized) else

  const splitList = (s: string) => (s || '').split(',').map((x: string) => x.trim()).filter(Boolean)

  console.log('─'.repeat(58))
  console.log('  WRITING STYLE:\n')
  console.log('  ' + synthesized.split('\n').join('\n  '))
  console.log('─'.repeat(58))

  const confirm = await ask('\n  Does this sound like you? (yes / tell me what\'s off): ')
  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(confirm)) {
    synthesized += ` CORRECTION: ${confirm}`
    console.log('  Got it — noted.\n')
  }

  // ── LLM validation — one sample reply per confirmed reply topic, retry until approved ──
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
        const fb = await ask('  Correct? (yes / tell me what\'s off): ')
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

  const voiceProfile = {
    mode: 'interview' as const,
    caseStyle:              structuredAnswers.caseStyle ?? '',
    apostropheStyle:        structuredAnswers.apostropheStyle ?? '',
    replyLength:            structuredAnswers.replyLength ?? '',
    emojiUsage:             structuredAnswers.emojiUsage ?? '',
    mixedLanguageFrequency: structuredAnswers.mixedLanguageFrequency ?? '',
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
    neverTopics:     splitList(structuredAnswers.neverTopics ?? ''),
    synthesized,
    confirmedAt:     new Date().toISOString(),
    replyBehavior:   structuredAnswers.replyBehaviorSynthesized
      ? { synthesized: structuredAnswers.replyBehaviorSynthesized }
      : profile.voiceProfile?.replyBehavior,
    originalPostProfile: profile.voiceProfile?.originalPostProfile,
  }

  if (!profile.voiceProfile) profile.voiceProfile = {}
  Object.assign(profile.voiceProfile, voiceProfile)
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  console.log('\n' + '═'.repeat(58))
  console.log('  Saved → voiceProfile.synthesized + voiceProfile.replyBehavior')
  console.log('═'.repeat(58) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
