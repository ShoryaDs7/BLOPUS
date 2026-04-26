#!/usr/bin/env npx tsx
/**
 * Standalone script to run ONLY the Original Post interview (Part 7).
 * Claude-led dynamic interview — reads archive, asks what it needs, outputs structured JSON.
 * Saves to voiceProfile.originalPostProfile in personality_profile.json.
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
    const edit = await ask('  > ')

    if (edit.trim()) {
      const removed = edit.toLowerCase().split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      keywords = keywords.filter(k => !removed.some(r => k.toLowerCase().includes(r)))
      console.log(`  Got it.\n`)
    }

    allKeywords.push(...keywords)
  }

  return [...new Set(allKeywords)] // dedupe across topics
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

  const bp = profile.behaviorProfile ?? {}
  const ws = profile.writingStats ?? {}
  const postTopics: string[] = profile.postTopics ?? profile.dominantTopics ?? []

  console.log('\n' + '═'.repeat(58))
  console.log('  ORIGINAL POSTS')
  console.log('  Answer like you\'re texting. Claude will ask what it needs.')
  console.log('═'.repeat(58) + '\n')

  // Show computed post topics from archive before interview starts
  console.log('  Your archive shows these topics in your original posts:')
  postTopics.forEach((t, i) => console.log(`    ${i + 1}. ${t}`))
  console.log()

  const archiveContext = JSON.stringify({
    postTopics,
    avgPostsPerDay:      bp.avgPostsPerDay ?? 2,
    typicalPostingHours: bp.typicalPostingHours ?? [],
    sampleOriginals:     (bp.sampleOriginals ?? []).slice(0, 8),
    writingStyle: {
      caseStyle:       ws.caseStyle,
      apostropheStyle: ws.apostropheStyle,
      emojiUsage:      ws.emojiUsage,
    },
  }, null, 2)

  const SYSTEM = `You are interviewing a Twitter user about their ORIGINAL posts (not replies, not retweets).

You have their archive analysis:
${archiveContext}

Your job:
- Ask questions ONE AT A TIME based on what you see in their archive
- Prefix each question with [Q] — nothing else before the question
- After each answer, output one line starting with "Got it —" summarizing what you learned, then ask the next
- Cover ALL of these areas:
  1. Topics — confirm the archive list is still accurate or if focus has shifted. Show them the list.
  2. Post source — ask THREE separate questions, one at a time, wait for each answer:
     a. "Out of 100 posts, how many are purely your own thought — something that came from your head with no external trigger?"
     b. "Out of 100 posts, how many are reactions to a tweet you just saw — you read something and wanted to respond with your own post?"
     c. "Out of 100 posts, how many are triggered by news or current events you read somewhere?"
     - After all three answers, check they add up to roughly 100. If not, ask them to adjust.
     - Push for numbers. If vague, use the conversion table below.
     - Save as postSourceSplit with three keys: personalThought, tweetReaction, newsDriven.
  3. What they NEVER post about — topics or content types they avoid entirely
  4. Posts per day — ask: "Your archive shows you post about X times a day on average. Does that still feel right, or has it changed?" IMPORTANT: this is asking how many posts per day total, NOT how often (not interval/frequency). If they give an interval like "every 3 hours" or "every few minutes", convert it to a daily count using 16 active hours: e.g. "every 3 hours" = ~5/day, "every 30 mins" = ~32/day. Then confirm: "So roughly [N] posts per day — does that sound right?" Never save an interval as the posts-per-day value.
  5. Mixed language in posts — if the archive shows non-English words, ask: "Out of 100 posts, how many would include a word in [language from archive]? Give me a number." Skip and save 0 if archive is English-only.

  6. Case style in posts — ask: "When you write a post, do you write in all lowercase, sentence case (first word capitalised), title case, or something else?" Do NOT assume it matches their reply style — posts can differ.

  7. Post length — ask: "What's your default post length — one-liner, 2-3 sentences, or longer threads? Does it change based on topic?" Push until you get a concrete rule like "one-liners for hot takes, 2-3 sentences when explaining something."
     - If vague, ask: "Give me an example — what would a short post look like vs a long one for you?"
     - Keep asking until you have a clear length rule per scenario.

  8. Emoji — this is a multi-part question. Ask each part separately, wait for the answer, then ask the next:
     a. First ask: "Out of 100 original posts, how many would include any emoji at all? Give me a number."
     b. Then ask: "Which specific emojis do you actually use?" Wait for their list.
     c. Then for EACH emoji they mention, ask: "For [emoji] — which of your topics do you use it on, and under what condition? Like, is it only when something is funny? Only celebrating? Only when you're being sarcastic?"
        - If they say "whenever" or "idk" — ask: "Out of the posts where you use [emoji], what % are about [topic A] vs [topic B]?"
        - Keep asking until you have: emoji → topic/domain → condition/trigger → rough % of posts
     d. Finally ask: "Any topics where you'd NEVER use an emoji no matter what?"
     - Do NOT move to the next question until you have specific conditions for each emoji they use.

- Ask 8-12 questions total (emoji question counts as multiple — one per emoji follow-up). Skip anything already obvious from the archive.

QUANTITATIVE RULES — apply to every frequency/style question:
- Always push for a NUMBER. Frame as: "out of 100 posts, how many would [X]?"
- If user says anything vague ("idk", "sometimes", "a little", "not much", "depends", "occasionally"): ask ONCE — "give me your best guess as a number out of 100"
- If they still won't give a number, convert: never→0, rarely/barely→5, sometimes/a little/occasionally→15, often/usually→60, mostly/almost always→80, always→95
- NEVER output vague words for frequency fields — always a number 0-100

FOLLOW-UP RULES — apply to style/context questions (case, emoji, length):
- If the answer is vague or general, ALWAYS ask at least one follow-up before moving on
- For emoji: do NOT accept "depends" or "when it fits" — ask which topic, which condition, which %
- For length: do NOT accept "it varies" — ask what makes it vary, get a concrete rule
- For case: do NOT accept "normal" — ask if that means capitalised first word or all lowercase

- When done, output exactly: [INTERVIEW_DONE]
  Then on the next lines output ONLY this raw JSON (no markdown, no backticks):
{
  "topics": ["topic1", "topic2"],
  "postSourceSplit": { "personalThought": NUMBER, "tweetReaction": NUMBER, "newsDriven": NUMBER },
  "caseStyle": "exact rule: e.g. 'Always sentence case' or 'All lowercase' or 'Title case for hot takes, lowercase otherwise'",
  "postLength": "concrete rule: e.g. 'One-liners for hot takes and reactions. 2-3 sentences when explaining. Threads only for breakdowns.'",
  "emojiContext": "per-emoji mapping: e.g. '😭 on humor/meme posts (20% of posts). 🔥 on AI/tech when excited (5%). Never on geopolitics or serious takes.'",
  "emojiFrequency": NUMBER_0_to_100,
  "mixedLanguageFrequency": NUMBER_0_to_100,
  "neverAbout": ["topic1"],
  "confirmedPostsPerDay": 2.0
}`

  const messages: Anthropic.MessageParam[] = []

  const kickoff = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Start the interview.' }],
  })

  let assistantText = kickoff.content[0].type === 'text' ? kickoff.content[0].text.trim() : ''
  messages.push({ role: 'user', content: 'Start the interview.' })
  messages.push({ role: 'assistant', content: assistantText })

  // Robust JSON extractor — counts balanced braces so trailing LLM text never breaks parse
  const extractInterviewJSON = (text: string): any | null => {
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

  let result: any = null

  while (true) {
    if (assistantText.includes('[INTERVIEW_DONE]')) {
      result = extractInterviewJSON(assistantText)
      if (!result) console.warn('[Setup] Original posts interview JSON missing — LLM may have output malformed JSON')
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

  if (!result) {
    console.log('\n  Could not parse interview result. Try running again.')
    rl.close()
    process.exit(1)
  }

  // Expand neverAbout into full keyword list
  const neverRaw: string[] = result.neverAbout ?? []
  const neverKeywords = neverRaw.length ? await expandNeverKeywords(client, neverRaw) : []
  result.neverAbout = neverKeywords

  // ── Golden examples — post exactly as you would ──────────────
  console.log('\n  ─ Golden examples — write exactly how you\'d post this ─\n')

  // Use topics user CONFIRMED in interview, not archive defaults
  const confirmedTopics: string[] = result.topics?.length ? result.topics : postTopics
  const postSourceType: string = result.postSourceType ?? 'mixed'

  // Build scenario types based on what user said triggers their posts
  const scenarioInstructions: Record<string, string> = {
    'news-driven':        'Each scenario: a specific news event or development just happened in that topic. Write it as "X just happened — [brief realistic detail]". User will write what they would post reacting to it.',
    'personal-thoughts':  'Each scenario: user is sitting, something crossed their mind about that topic. Write it as "You\'re thinking about [specific aspect of topic]". No news. User will write the post that comes from their head.',
    'opinions-hot-takes': 'Each scenario: there is a common take or belief in that topic that the user might agree or disagree with. Write it as "Common take: [the take]". User will write their actual position.',
    'questions-polls':    'Each scenario: user wants to ask their audience something about that topic. Write it as "You want to ask your followers about [specific question topic]".',
    'life-updates':       'Each scenario: something happened in the user\'s life related to that topic. Write it as "You just [did something related to topic]".',
    'mixed':              'Mix scenario types across topics — some news events ("X just happened in [topic]"), some personal thoughts ("You\'re thinking about [aspect of topic]"), some observations ("You noticed something about [topic] this week").',
  }
  const scenarioInstruction = scenarioInstructions[postSourceType] ?? scenarioInstructions['mixed']

  let prompts: string[] = []
  try {
    const promptRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Generate one posting trigger per topic for a Twitter user. Topics: ${confirmedTopics.join(', ')}

Their archive posts for style reference (DO NOT copy, just understand what they react to):
${(bp.sampleOriginals ?? []).slice(0, 6).map((s: string, i: number) => `${i + 1}. ${s}`).join('\n')}

${scenarioInstruction}

RULES:
- Output ONLY the scenario text, nothing else — no topic labels, no headers, no numbering, no markdown
- One scenario per line
- Each under 15 words
- Must sound like something that actually happened or a real thought, not a writing prompt`
      }]
    })
    const c = promptRes.content[0]
    if (c.type === 'text') prompts = c.text.trim().split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 10 && !l.startsWith('#') && !l.startsWith('*') && !/^\d+\./.test(l))
  } catch {}

  if (!prompts.length) prompts = confirmedTopics.map(t => `Your take on something happening in ${t}`)

  const goldenExamples: string[] = []
  const topicExamples: { scenario: string; post: string }[] = []
  for (let i = 0; i < prompts.length; i++) {
    console.log(`  [${i + 1}/${prompts.length}] "${prompts[i]}"`)
    const post = await ask('  Your post > ')
    if (post && !/^skip$/i.test(post)) {
      goldenExamples.push(post)
      topicExamples.push({ scenario: prompts[i], post })
      console.log('  Got it.\n')
    } else console.log('  Skipped.\n')
  }

  // ── Synthesize post style ─────────────────────────────────────
  let synthesized = ''
  if (goldenExamples.length) {
    console.log('  Synthesizing your post style...\n')
    try {
      const synthRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{
          role: 'user',
          content: `You are setting up an autonomous X bot that posts AS this exact person.

Confirmed post style from interview:
- Format: ${result.formatStyle}
- Source type: ${postSourceType}
- Topics: ${confirmedTopics.join(', ')}

Their actual posts (golden examples — bot must match these exactly):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

Write 2-3 sentences describing ONLY how this person writes original posts (structure, tone, length, style). Not replies. This gets injected into every post-generation prompt.`
        }]
      })
      const c = synthRes.content[0]
      if (c.type === 'text') synthesized = c.text.trim()
    } catch {}
  }

  // ── LLM validation — one sample post per confirmed topic, retry until approved ──
  if (synthesized && goldenExamples.length) {
    console.log('\n─'.repeat(29))
    console.log('  Here\'s how I\'d post on each of your topics.\n  Tell me if any don\'t sound like you.\n')
    try {
      for (const topic of confirmedTopics) {
        let approved = false
        let correction: string | undefined
        while (!approved) {
          const sampleRes = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [{
              role: 'user',
              content: `Write one original post AS this person about "${topic}".${correction ? `\n\nPREVIOUS ATTEMPT WAS WRONG. Correction: ${correction}` : ''}

Their post style: ${synthesized}
Their golden examples:
${goldenExamples.slice(0, 4).map((e, i) => `${i + 1}. "${e}"`).join('\n')}

Match their exact voice, length, format. Return ONLY the post text, nothing else.`
            }]
          })
          const c = sampleRes.content[0]
          if (c.type !== 'text') break
          const sample = c.text.trim()
          console.log(`  [${topic}]`)
          console.log(`  "${sample}"`)
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
      }
    } catch {}
  }

  result.goldenExamples = goldenExamples
  result.topicExamples = topicExamples
  if (synthesized) result.synthesized = synthesized

  if (!profile.voiceProfile) profile.voiceProfile = {}
  profile.voiceProfile.originalPostProfile = result
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  // voice_profile.json is merged over personality_profile in voice mode — must stay in sync
  const vpPath = path.join(path.dirname(profilePath), 'voice_profile.json')
  if (fs.existsSync(vpPath)) {
    const vp = JSON.parse(fs.readFileSync(vpPath, 'utf8'))
    vp.originalPostProfile = result
    fs.writeFileSync(vpPath, JSON.stringify(vp, null, 2), 'utf8')
  }

  console.log('\n' + '═'.repeat(58))
  console.log('  Saved to personality_profile.json')
  console.log(`  · Topics:     ${(result.topics ?? []).slice(0, 4).join(', ')}`)
  console.log(`  · Post type:  ${result.postSourceType ?? '—'}`)
  console.log(`  · Case:       ${result.caseStyle ?? '—'}`)
  console.log(`  · Length:     ${result.postLength ?? '—'}`)
  console.log(`  · Emoji:      ${result.emojiContext ?? '—'}`)
  console.log(`  · Never:      ${neverKeywords.slice(0, 6).join(', ') || 'nothing'}${neverKeywords.length > 6 ? ` (+${neverKeywords.length - 6} more)` : ''}`)
  console.log(`  · Per day:    ${result.confirmedPostsPerDay ?? '—'}`)
  console.log(`  · Examples:   ${goldenExamples.length} posts captured`)
  console.log('═'.repeat(58) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
