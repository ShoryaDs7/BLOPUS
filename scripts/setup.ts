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

// ─────────────────────────────────────────────────────────────
// Helper: follow-up if answer is too vague
function needsFollowUp(answer: string): boolean {
  return answer.trim().length < 6 || /^(depends|idk|not sure|maybe|dunno|unclear)$/i.test(answer.trim())
}

// ─── Part 2: Voice Mode Interview ────────────────────────────
async function runVoiceInterview(
  apiKey: string,
  computed: any,
  askFn: (q: string) => Promise<string>
): Promise<any> {
  const answers: Record<string, string> = {}
  const goldenExamples: string[] = []
  const stats = computed?.writingStats ?? {}

  console.log('\n' + '═'.repeat(58))
  console.log('  PART 2 — VOICE MODE')
  console.log('  Lock in exactly how you write. Answer like you\'re texting.')
  console.log('═'.repeat(58))

  // ── Section 1: Confirm computed stats ──────────────────────
  console.log('\n  ─ Section 1: Confirm what we computed from your archive ─\n')
  console.log('  Just say yes/correct or give the fix.\n')

  // Case style
  const casePrompt = stats.caseStyle
    ? `  Archive says: ${stats.caseStyle}. Correct? `
    : `  How do you write — lowercase, sentence case, or mixed? `
  const caseA = await askFn(casePrompt)
  if (stats.caseStyle && !/yes|correct|yep|yup|yeah|y$/i.test(caseA)) {
    answers.caseStyle = caseA.trim() || stats.caseStyle
  } else {
    answers.caseStyle = stats.caseStyle || caseA
  }

  // Apostrophe style
  if (stats.apostropheStyle) {
    const a = await askFn(`\n  Archive says: ${stats.apostropheStyle}. Correct? `)
    answers.apostropheStyle = /yes|correct|yep|yup|yeah|y$/i.test(a) ? stats.apostropheStyle : a || stats.apostropheStyle
  } else {
    const a = await askFn('\n  Do you use apostrophes in contractions (don\'t / dont)? ')
    answers.apostropheStyle = a
  }

  // Reply length
  if (stats.medianReplyLength) {
    const a = await askFn(`\n  Archive says your replies are typically ${stats.medianReplyLength}. Correct? `)
    answers.replyLength = /yes|correct|yep|yup|yeah|y$/i.test(a) ? stats.medianReplyLength : a || stats.medianReplyLength
  } else {
    const a = await askFn('\n  How long are your replies usually? (one line / two sentences / depends) ')
    answers.replyLength = a
  }

  // Emoji usage
  if (stats.emojiUsage) {
    const a = await askFn(`\n  Emoji usage: ${stats.emojiUsage}. Correct? `)
    answers.emojiUsage = /yes|correct|yep|yup|yeah|y$/i.test(a) ? stats.emojiUsage : a || stats.emojiUsage
  } else {
    const a = await askFn('\n  How much do you use emojis? (never / rare / sometimes / a lot) ')
    answers.emojiUsage = a
  }

  // Characteristic mentions
  const mentions = stats.characteristicMentions ?? []
  if (mentions.length > 0) {
    const a = await askFn(`\n  You frequently tag ${mentions.join(', ')} in replies. Correct? `)
    if (/yes|correct|yep|yup|yeah|y$/i.test(a)) {
      answers.characteristicMentions = mentions.join(', ')
    } else {
      const fix = await askFn('  Which accounts do you tag, if any? (or "none") ')
      answers.characteristicMentions = fix
    }
  } else {
    const a = await askFn('\n  Do you tag any accounts in replies often? (e.g. @grok, or "none") ')
    answers.characteristicMentions = a
  }

  // ── Section 2: Tweet type → behavior ───────────────────────
  console.log('\n\n  ─ Section 2: How you respond to different tweet types ─\n')
  console.log('  Pick a letter or describe freely.\n')

  // Q1: News with a take
  console.log('  Q1. News tweet in your topics — you have a take on it.')
  console.log('      a) reply with my take directly')
  console.log('      b) tag @grok or another tool')
  console.log('      c) short reaction (lol / damn / wild)')
  console.log('      d) just like it, no reply')
  console.log('      e) skip')
  const q1 = await askFn('\n  Your move: ')
  answers.onNewsWithTake = q1
  if (/^a\b|reply|take|directly/i.test(q1)) {
    const fu = await askFn('  How long — one line or two sentences? ')
    answers.onNewsWithTake += ` (${fu})`
  } else if (/depends/i.test(q1)) {
    const fu = await askFn('  Depends on what? Give me an example: ')
    answers.onNewsWithTake += ` — specifically: ${fu}`
  }

  // Q2: Factual claim unsure about
  console.log('\n  Q2. Someone makes a factual claim you\'re not 100% sure about.')
  console.log('      a) tag @grok to verify')
  console.log('      b) react anyway with my take')
  console.log('      c) skip / ignore')
  console.log('      d) depends on the claim')
  const q2 = await askFn('\n  Your move: ')
  answers.onFactualClaim = q2
  if (/^d\b|depends/i.test(q2)) {
    const fu = await askFn('  Depends on what? ')
    answers.onFactualClaim += ` — specifically: ${fu}`
  } else if (/^a\b|grok/i.test(q2)) {
    const fu = await askFn('  Always @grok or only for certain things? ')
    answers.onFactualClaim += ` — ${fu}`
  }

  // Q3: Tweet you agree with
  console.log('\n  Q3. Tweet you fully agree with — you would\'ve posted it yourself.')
  console.log('      a) one line agreement')
  console.log('      b) add my own angle to it')
  console.log('      c) just like it, don\'t reply')
  console.log('      d) retweet it')
  const q3 = await askFn('\n  Your move: ')
  answers.onAgreement = q3
  if (/^a\b|^b\b|one line|angle|agree/i.test(q3)) {
    const fu = await askFn('  Write me what that reply actually looks like: ')
    answers.onAgreement += ` — example: "${fu}"`
  } else if (/depends/i.test(q3)) {
    const fu = await askFn('  Depends on what? ')
    answers.onAgreement += ` — ${fu}`
  }

  // Q4: Someone wrong or delusional
  console.log('\n  Q4. Someone says something you think is wrong or delusional.')
  console.log('      a) push back with a reason')
  console.log('      b) one-liner / sarcasm')
  console.log('      c) just like and keep scrolling')
  console.log('      d) depends how wrong they are')
  const q4 = await askFn('\n  Your move: ')
  answers.onDisagreement = q4
  if (/^a\b|push|reason/i.test(q4)) {
    const fu = await askFn('  Write me an example pushback reply: ')
    answers.onDisagreement += ` — example: "${fu}"`
  } else if (/^b\b|sarcasm|one.liner/i.test(q4)) {
    const fu = await askFn('  Write me an example sarcastic reply: ')
    answers.onDisagreement += ` — example: "${fu}"`
  } else if (/^d\b|depends/i.test(q4)) {
    const fu = await askFn('  When would you push back vs ignore? ')
    answers.onDisagreement += ` — specifically: ${fu}`
  }

  // Q5: Funny tweet
  console.log('\n  Q5. Funny or absurd tweet in your feed.')
  console.log('      a) react and add to the joke')
  console.log('      b) just like it')
  console.log('      c) tag @grok')
  console.log('      d) usually skip')
  const q5 = await askFn('\n  Your move: ')
  answers.onFunny = q5
  if (/^a\b|react|joke/i.test(q5)) {
    const fu = await askFn('  What does that look like? Write an example: ')
    answers.onFunny += ` — example: "${fu}"`
  }

  // Q6: Hot take / controversial tweet
  console.log('\n  Q6. Hot take or controversial opinion — not your topic but it\'s spicy.')
  console.log('      a) jump in with my own take')
  console.log('      b) retweet without comment')
  console.log('      c) like only')
  console.log('      d) scroll past')
  const q6 = await askFn('\n  Your move: ')
  answers.onControversial = q6
  if (/^a\b|jump|take/i.test(q6)) {
    const fu = await askFn('  What\'s your style when you jump in? ')
    answers.onControversial += ` — ${fu}`
  }

  // ── Section 3: Golden examples ──────────────────────────────
  console.log('\n\n  ─ Section 3: Your golden examples ─\n')
  console.log('  Write 3-5 replies you\'d actually post. Real tweets, real energy.')
  console.log('  These become your style bible — the bot matches these exactly.')
  console.log('  Type "done" when finished.\n')

  for (let i = 1; i <= 5; i++) {
    const ex = await askFn(`  Example ${i}: `)
    if (!ex.trim() || ex.toLowerCase() === 'done') {
      if (goldenExamples.length < 2) {
        console.log('  Need at least 2 examples.')
        const ex2 = await askFn(`  Example ${i}: `)
        if (ex2.trim() && ex2.toLowerCase() !== 'done') goldenExamples.push(ex2)
      }
      break
    }
    goldenExamples.push(ex.trim())
    if (i >= 3) {
      const more = await askFn('  Add another? (Enter to skip): ')
      if (!more.trim() || more.toLowerCase() === 'done') break
      goldenExamples.push(more.trim())
      break
    }
  }

  // ── Section 4: Hard rules ────────────────────────────────────
  console.log('\n\n  ─ Section 4: Hard rules ─\n')

  const bannedA = await askFn('  Phrases you NEVER want the bot to use? (comma-separated or Enter to skip): ')
  answers.bannedPhrases = bannedA

  const neverA = await askFn('\n  Topics/content you never engage with? (comma-separated or Enter to skip): ')
  answers.neverTopics = neverA

  // ── Synthesize with Claude ───────────────────────────────────
  console.log('\n  Synthesizing your voice profile...')

  let synthesized = ''
  try {
    const client = new Anthropic({ apiKey })
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 350,
      messages: [{
        role: 'user',
        content: `You are setting up an autonomous X bot that posts AS this person.

Their confirmed writing style:
- Case style: ${answers.caseStyle}
- Apostrophes: ${answers.apostropheStyle}
- Reply length: ${answers.replyLength}
- Emoji usage: ${answers.emojiUsage}
- Accounts they tag: ${answers.characteristicMentions || 'none'}

Their behavior patterns:
- On news with a take: ${answers.onNewsWithTake}
- On uncertain facts: ${answers.onFactualClaim}
- When agreeing: ${answers.onAgreement}
- When disagreeing: ${answers.onDisagreement}
- On funny content: ${answers.onFunny}
- On controversial: ${answers.onControversial}

Their golden example replies (write EXACTLY like these):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

Write a 3-4 sentence voice profile that captures exactly how this person writes. Be specific and concrete — refer to their actual examples and behaviors. This gets injected into an LLM prompt.`
      }]
    })
    const c = res.content[0]
    if (c.type === 'text') synthesized = c.text
  } catch (e: any) {
    synthesized = `Writes ${answers.replyLength || 'short'} replies in ${answers.caseStyle || 'lowercase'}. ${answers.onDisagreement ? 'When someone is wrong: ' + answers.onDisagreement + '.' : ''}`
  }

  // Show and confirm
  console.log('\n' + '─'.repeat(58))
  console.log('  VOICE PROFILE SYNTHESIZED:\n')
  console.log('  ' + synthesized.split('\n').join('\n  '))
  console.log('\n' + '─'.repeat(58))

  const confirm = await askFn('\n  Does this match how you write? (yes / no — tell me what\'s wrong): ')
  let corrections = ''
  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(confirm)) {
    corrections = confirm
    console.log('  Got it — noted. Updating voice profile.\n')
    if (corrections) synthesized += ` CORRECTION: ${corrections}`
  }

  return {
    mode: 'interview' as const,
    caseStyle: answers.caseStyle,
    apostropheStyle: answers.apostropheStyle,
    replyLength: answers.replyLength,
    emojiUsage: answers.emojiUsage,
    characteristicMentions: (answers.characteristicMentions || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    behaviorPatterns: {
      onNewsWithTake: answers.onNewsWithTake,
      onFactualClaim: answers.onFactualClaim,
      onAgreement: answers.onAgreement,
      onDisagreement: answers.onDisagreement,
      onFunny: answers.onFunny,
      onControversial: answers.onControversial,
    },
    goldenExamples,
    bannedPhrases: (answers.bannedPhrases || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    neverTopics: (answers.neverTopics || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    synthesized,
    confirmedAt: new Date().toISOString(),
  }
}

// ─── Part 4: Quote Tweet Interview ───────────────────────────
async function runQuoteTweetInterview(askFn: (q: string) => Promise<string>): Promise<any> {
  console.log('\n' + '═'.repeat(58))
  console.log('  PART 4 — QUOTE TWEET BEHAVIOR')
  console.log('═'.repeat(58))
  console.log('\n  When do you quote tweet vs just reply?\n')

  const answers: Record<string, string> = {}

  // Q1: When to quote
  console.log('  Q1. When do you quote tweet instead of just replying?')
  console.log('      a) when I want my followers to see it + my take')
  console.log('      b) when I disagree but want to keep full context')
  console.log('      c) when something is so good I want to amplify it')
  console.log('      d) rarely — I almost always just reply')
  const q1 = await askFn('\n  Your answer: ')
  answers.whenToQuote = q1
  if (/^a\b|^b\b|take|disagree/i.test(q1)) {
    const fu = await askFn('  Write me an example quote tweet you\'d post: ')
    answers.whenToQuote += ` — example: "${fu}"`
  } else if (/depends/i.test(q1)) {
    const fu = await askFn('  Depends on what? Give an example: ')
    answers.whenToQuote += ` — ${fu}`
  }

  // Q2: Style
  console.log('\n  Q2. When you do quote tweet — what\'s your style?')
  console.log('      a) add context or explain my take')
  console.log('      b) one sharp line / sarcasm')
  console.log('      c) agree and hype it up')
  console.log('      d) short reaction (one word, emoji, etc)')
  const q2 = await askFn('\n  Your style: ')
  answers.quoteTweetStyle = q2
  if (needsFollowUp(q2)) {
    const fu = await askFn('  Can you be more specific? Write an example: ')
    answers.quoteTweetStyle += ` — ${fu}`
  }

  // Q3: Never quote
  const q3 = await askFn('\n  Q3. What would you NEVER quote tweet? ')
  answers.neverQuote = q3
  if (needsFollowUp(q3)) {
    const fu = await askFn('  Give me an example of something you\'d never quote: ')
    answers.neverQuote += ` — e.g. ${fu}`
  }

  console.log('\n  ✓ Quote tweet behavior saved.')

  return {
    whenToQuote: answers.whenToQuote,
    quoteTweetStyle: answers.quoteTweetStyle,
    neverQuote: answers.neverQuote.split(',').map((s: string) => s.trim()).filter(Boolean),
  }
}

// ─── Part 5: Like Behavior Interview ─────────────────────────
async function runLikeInterview(askFn: (q: string) => Promise<string>): Promise<any> {
  console.log('\n' + '═'.repeat(58))
  console.log('  PART 5 — LIKE BEHAVIOR')
  console.log('═'.repeat(58))
  console.log('\n  When do you like a tweet without replying?\n')

  const answers: Record<string, string> = {}

  // Q1: What you like
  const q1 = await askFn('  Q1. What kind of tweets do you like without replying? ')
  answers.likesWhat = q1
  if (needsFollowUp(q1)) {
    const fu = await askFn('  Give me an example of one you\'d like: ')
    answers.likesWhat += ` — example: "${fu}"`
  } else if (/depends/i.test(q1)) {
    const fu = await askFn('  Depends on what? ')
    answers.likesWhat += ` — ${fu}`
  }

  // Q2: Accounts you always like
  const q2 = await askFn('\n  Q2. Any accounts you almost always like when they post? (handles or Enter to skip) ')
  answers.alwaysLike = q2

  // Q3: Never like
  const q3 = await askFn('\n  Q3. What would you NEVER like? Accounts or content types: ')
  answers.neverLike = q3
  if (needsFollowUp(q3)) {
    const fu = await askFn('  Give me an example: ')
    answers.neverLike += ` — e.g. ${fu}`
  }

  // Q4: Like + reply at same time?
  console.log('\n  Q4. When you reply to something, do you also like it?')
  console.log('      a) always')
  console.log('      b) only if I agree')
  console.log('      c) never')
  const q4 = await askFn('\n  Your habit: ')
  answers.likeOnReply = q4

  console.log('\n  ✓ Like behavior saved.')

  return {
    likesWhat: answers.likesWhat,
    alwaysLike: (answers.alwaysLike || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    neverLike: (answers.neverLike || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    likeOnReply: answers.likeOnReply,
  }
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

  // ── Step 1: Mode ─────────────────────────────────────────────

  section(1, 'Choose your mode')
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

  section(2, 'Your X handles')

  const ownerHandle = await askRequired(
    'Your real X handle (no @)',
    'e.g.  johndoe   — this is YOUR real account'
  )

  let botHandle = ownerHandle
  if (mode === 'bot' || mode === 'both') {
    botHandle = await askRequired(
      'Bot X handle (no @)',
      'e.g.  johndoe_ai  — the separate bot account you made on X'
    )
  }

  const creatorName = ownerHandle.toLowerCase()
  const creatorDir  = path.resolve(`./creators/${creatorName}`)
  fs.mkdirSync(creatorDir, { recursive: true })

  // ── Step 3: Twitter API keys ──────────────────────────────────

  section(3, 'Twitter / X API keys')
  console.log(`
  How to get these:
  1. Go to:  https://developer.twitter.com/en/portal/dashboard
  2. Sign in with your X account → "Create Project" → create an app
  3. Set app permissions to "Read and Write"
  4. Go to app → "Keys and Tokens" tab
  5. Copy: API Key, API Secret, Access Token, Access Token Secret
`)

  const apiKey            = await askRequired('API Key (Consumer Key)')
  const apiSecret         = await askRequired('API Secret (Consumer Secret)')
  const accessToken       = await askRequired('Access Token')
  const accessTokenSecret = await askRequired('Access Token Secret')

  // ── Step 4: Anthropic API key ─────────────────────────────────

  section(4, 'Anthropic API key')
  console.log(`
  How to get this:
  1. Go to:  https://console.anthropic.com
  2. Sign in → "API Keys" in left sidebar → "Create Key"
  3. Copy the key (starts with  sk-ant-...)
`)

  const anthropicKey = await askRequired('Anthropic API Key')
  process.env.ANTHROPIC_API_KEY = anthropicKey

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
  X DM passcode — only needed if you have "Additional password protection" enabled on X.
  To check: x.com → Settings → Security and account access → Security
            → look for "Additional password protection" — if it is ON enter the code below.
  If it is OFF or you are unsure, just press Enter to skip.
`)
  const xDmPasscode = await askOptional('X DM passcode (Enter to skip if not set)')

  // ── Step 7: Tavily (optional) ─────────────────────────────────

  section(6, 'Tavily API key  (optional)')
  console.log(`
  Gives Blopus real-time web search so replies reference
  current news and events. Free tier at: https://tavily.com
  Sign up → copy API key from dashboard.
`)

  const tavilyKey = await askOptional('Tavily API Key')

  // ── Step 7: Gemini (optional) ─────────────────────────────────

  section(7, 'Gemini API key  (optional)')
  console.log(`
  Lets Blopus understand YouTube videos — user sends a link,
  Blopus watches it and answers any question about it.
  Works without this key too (uses transcript + Claude as fallback).

  Get it free at: https://aistudio.google.com → Get API Key
  Free tier: 1,500 requests/day — more than enough.
`)

  const geminiKey = await askOptional('Gemini API Key')

  // ── Step 8: Telegram ──────────────────────────────────────────

  section(8, 'Telegram control bot')
  console.log(`
  Blopus is controlled via Telegram — you send commands,
  it replies, shows you what it's doing, asks for approvals.

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
    section(8, 'Your personality — Twitter archive')
    console.log(`
  For owner mode, Blopus learns YOUR exact voice:
  how you write, your topics, posting hours, reply style, humor.

  It reads your Twitter/X archive to compute this.

  How to get your archive:
  1. Go to x.com → your profile pic → Settings
  2. "Your account" → "Download an archive of your data"
  3. Request it — X emails you a download link (up to 24h wait)
  4. Download the zip → extract it
  5. Inside: data/tweets.js — that's the file you need

  Enter the full path to tweets.js below.
  (Press Enter to skip — you can add it later via npm run ingest)
`)

    const archivePath = await askOptional(
      'Full path to your tweets.js',
      'e.g.  C:/Users/you/Downloads/twitter-2025/data/tweets.js'
    )

    if (archivePath && fs.existsSync(archivePath)) {
      console.log('\n  ✓ Archive found — processing...')

      try {
        const destPath = path.join(creatorDir, 'tweets.js')
        fs.copyFileSync(archivePath, destPath)
        archiveCopied = true

        const { parseTweetsJsFull, analyzePersonalityFull } = await import('../core/personality/PersonalityIngester')
        const content = fs.readFileSync(archivePath, 'utf8')
        const parsed  = parseTweetsJsFull(content)

        console.log(`\n  Found ${parsed.originals.length} original tweets + ${parsed.replies.length} replies.`)
        console.log('  Running personality analysis via Claude... (~30 seconds)\n')

        personalityProfile = await analyzePersonalityFull(parsed, ownerHandle)

        // ── Display everything computed ──────────────────────────

        console.log('\n' + '═'.repeat(58))
        console.log('  What Blopus learned about you')
        console.log('═'.repeat(58))

        const bp = personalityProfile.behaviorProfile
        if (bp) {
          console.log(`\n  POSTING BEHAVIOR (computed from your archive):`)
          console.log(`  · Original posts per day:     ${bp.avgPostsPerDay}`)
          console.log(`  · Replies per day:             ${bp.avgRepliesPerDay}`)
          console.log(`  · Quote tweet ratio:           ${Math.round(bp.quoteTweetRatio * 100)}% of your posts`)
          console.log(`  · Avg gap between posts:       ${bp.avgIntervalHours}h`)
          console.log(`  · When you post (UTC hours):   ${bp.typicalPostingHours?.join(', ')}`)
        }

        const ws = personalityProfile.writingStats
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

        // ── Show post topics vs reply topics separately ──────────
        console.log(`\n  WHAT YOU POST ABOUT (from your original tweets):`)
        ;(personalityProfile.postTopics ?? []).forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`))

        console.log(`\n  WHAT YOU ENGAGE WITH (from your replies):`)
        ;(personalityProfile.replyTopics ?? []).forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`))

        console.log(`\n  NOTE: Domain mode uses topics to find tweets to reply to.`)
        console.log(`  Reply topics are more accurate for this — post topics may cause wrong matches.`)

        const topicBreakdown: Array<{ topic: string; postPct: number; replyPct: number }> = []

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

        // ── Ask for corrections ──────────────────────────────────

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
          // Default: use reply topics
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

        // ── Build RAG index ──────────────────────────────────────
        console.log('  Building reply example index (RAG)...')
        try {
          const { ExampleRetriever } = await import('../core/rag/ExampleRetriever')
          const ragPath = path.join(creatorDir, 'rag_index.json')
          const retriever = new ExampleRetriever(ragPath)
          retriever.load(destPath)
          console.log('  ✓ Reply example index built.')
        } catch (e: any) {
          console.log(`  ⚠ RAG index failed: ${e.message} — Blopus will build it on first run.`)
        }

      } catch (err: any) {
        console.log(`\n  ⚠ Archive processing failed: ${err.message?.slice(0, 100)}`)
        console.log('  Blopus will use a default personality. Run  npm run ingest  later to add yours.')
      }

    } else if (archivePath) {
      console.log(`  ⚠ File not found at that path. Skipping.`)
      console.log(`  Run  npm run ingest  after getting your archive.`)
    } else {
      console.log(`  Skipped. Run  npm run ingest  after getting your archive.`)
    }
  }

  // ── Part 2: Voice Mode Interview (owner/both only) ───────────

  let voiceProfile: any = undefined
  let quoteTweetBehavior: any = undefined
  let likeBehavior: any = undefined

  if (mode === 'owner' || mode === 'both') {
    voiceProfile      = await runVoiceInterview(anthropicKey, personalityProfile, ownerHandle, ask)
    quoteTweetBehavior = await runQuoteTweetInterview(ask)
    likeBehavior       = await runLikeInterview(ask)

    // Merge into personalityProfile so it gets saved together
    if (personalityProfile) {
      personalityProfile.voiceProfile       = voiceProfile
      personalityProfile.quoteTweetBehavior  = quoteTweetBehavior
      personalityProfile.likeBehavior        = likeBehavior
      // Golden examples override polluted RAG examples
      if (voiceProfile.goldenExamples?.length) {
        personalityProfile.replyExamples = voiceProfile.goldenExamples
      }
      // Merge user-provided banned phrases into avoids
      if (voiceProfile.bannedPhrases?.length) {
        personalityProfile.avoids = [...(personalityProfile.avoids ?? []), ...voiceProfile.bannedPhrases]
      }
      // Update personality_profile.json with voice data
      const profilePath = path.join(creatorDir, 'personality_profile.json')
      if (fs.existsSync(profilePath)) {
        fs.writeFileSync(profilePath, JSON.stringify(personalityProfile, null, 2), 'utf8')
        console.log('\n  ✓ Voice profile saved to personality_profile.json')
      }
    }
  }

  // ── Step: Reply mode + avoid topics ──────────────────────────

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
  const replyMode = replyModeRaw === '1' ? 'domain' : 'viral'
  console.log(`  ✓ Reply mode: ${replyMode}`)

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
  Want Blopus to manage your GitHub — create repos, push code,
  open PRs, manage issues, check CI, and more?

  Requires a GitHub Personal Access Token:
  1. Go to github.com → Settings → Developer settings
  2. Personal access tokens → Tokens (classic)
  3. Generate new token → check all "repo" + "workflow" scopes
  4. Copy the token and paste it below

  You can do this now or later. Press Enter to skip.
`)
  const githubToken = await askOptional('GitHub Personal Access Token (or Enter to skip)')

  // ── Step: Railway deploy (optional) ──────────────────────────

  const railwayStepN = mode === 'bot' ? 10 : 11
  section(railwayStepN, 'Railway deploy token — optional')
  console.log(`
  Lets Blopus deploy your projects to Railway from Telegram.
  (spin up servers, APIs, databases with one Telegram message)

  How to get your token:
  1. Go to railway.app → log in (free account)
  2. Click your avatar top-right → Account Settings
  3. Left sidebar: Tokens → New Token
  4. Give it a name (e.g. "Blopus") → Create → copy the token

  Press Enter to skip.
`)
  const railwayToken = await askOptional('Railway token')

  // ── Step: Google Workspace MCP (optional) ────────────────────

  const workspaceStepN = mode === 'bot' ? 9 : 10
  section(workspaceStepN, 'Google Workspace — Gmail, Calendar, YouTube, Drive + more (optional)')
  console.log(`
  Gives Blopus full control of your Google account — one setup covers ALL of these:
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

  // ── Step: NotebookLM skill ────────────────────────────────────

  const notebookStepN = mode === 'bot' ? 11 : 12
  section(notebookStepN, 'NotebookLM — AI content generation (optional)')
  console.log(`
  Gives Blopus the ability to generate podcasts, video overviews,
  flashcards, quizzes, infographics and slide decks from your content.

  This installs the NotebookLM Python library and connects it to Claude Code.
  Press Enter to skip.
`)
  const notebookSkip = await askOptional('Press Enter to set up NotebookLM (type "skip" to skip)')

  if (notebookSkip !== 'skip') {
    const { execSync } = require('child_process')

    // 1. Install the Python package
    console.log('\n  Installing notebooklm-py...')
    try {
      execSync('pip install "notebooklm-py[browser]" -q', { stdio: 'inherit' })
      console.log('  ✓ notebooklm-py installed')
    } catch {
      console.log('  ⚠ pip install failed — make sure Python is installed and try again.')
    }

    // 2. Install Playwright Chromium for the browser login
    // NOTE: Python Playwright may remove Node.js Playwright's Chromium versions.
    // We reinstall Node Playwright Chromium afterward to keep Blopus's X scraping intact.
    console.log('\n  Installing Chromium browser for NotebookLM...')
    try {
      execSync('python -m playwright install chromium', { stdio: 'inherit' })
      console.log('  ✓ Chromium ready for NotebookLM')
    } catch {
      console.log('  ⚠ Chromium install failed — run: python -m playwright install chromium')
    }
    console.log('\n  Restoring Blopus Chromium (X timeline + autonomous posting)...')
    try {
      execSync('npx playwright install chromium', { stdio: 'inherit' })
      console.log('  ✓ Blopus Chromium restored — X scraping and posting intact')
    } catch {
      console.log('  ⚠ Could not restore Node Playwright Chromium — run: npx playwright install chromium')
    }

    // 3. Google login — runs our fixed login script (bypasses bug in notebooklm-py)
    console.log(`
  ─────────────────────────────────────────────────────
  ONE MANUAL STEP — NotebookLM Google login:

  Open a NEW terminal window and run this command:

    python scripts/notebooklm_login.py

  Steps in that terminal:
  1. A browser window will open automatically
  2. Sign in with your Google account
  3. Wait until you can see your NotebookLM notebooks page
     (you should see "Create notebook" button)
  4. Press Enter in THAT terminal — session saves and browser closes

  Note: Google sessions expire every few weeks.
  When Blopus says "session expired", just run this again.

  Once done, come back here and press Enter below.
  ─────────────────────────────────────────────────────
`)
    await ask('  Press Enter here once you have completed the login in the other terminal: ')

    // 4. Verify login worked — check storage_state.json written by our login script
    const { existsSync, statSync } = require('fs')
    const storageFile = require('os').homedir() + '/.notebooklm/storage_state.json'
    if (existsSync(storageFile) && statSync(storageFile).size > 1000) {
      console.log('  ✓ NotebookLM login confirmed — session saved successfully')
    } else {
      console.log('  ⚠ Session file not found or empty. Run the login again:')
      console.log('    python scripts/notebooklm_login.py')
    }
  } else {
    console.log('  Skipped. To add later: pip install "notebooklm-py[browser]" && python scripts/notebooklm_login.py')
  }

  // ── Step: Surge deploy (optional) ────────────────────────────

  const surgeStepN = mode === 'bot' ? 9 : 10
  section(surgeStepN, 'Website deploy — optional')
  console.log(`
  Want to deploy websites to the internet from Telegram?
  (free, no credit card, instant .surge.sh URL)

  Run this command RIGHT NOW in this terminal to create
  your free Surge account — takes 30 seconds:

    surge output/website blopus-setup.surge.sh

  It will ask for email + password — create them on the spot.
  After that, Blopus can deploy any website with one message.

  Press Enter to skip (you can do this later).
`)
  await askOptional('Press Enter when done (or Enter to skip)')
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
    tavilyKey ? `TAVILY_API_KEY=${tavilyKey}` : `# TAVILY_API_KEY=`,
    geminiKey ? `GEMINI_API_KEY=${geminiKey}` : `# GEMINI_API_KEY=`,
    githubToken ? `GITHUB_TOKEN=${githubToken}` : `# GITHUB_TOKEN=`,
    railwayToken ? `RAILWAY_TOKEN=${railwayToken}` : `# RAILWAY_TOKEN=`,
    googleClientId     ? `GOOGLE_CLIENT_ID=${googleClientId}`         : `# GOOGLE_CLIENT_ID=`,
    googleClientSecret ? `GOOGLE_CLIENT_SECRET=${googleClientSecret}` : `# GOOGLE_CLIENT_SECRET=`,
    googleRefreshToken ? `GOOGLE_REFRESH_TOKEN=${googleRefreshToken}` : `# GOOGLE_REFRESH_TOKEN=`,
    `TELEGRAM_BOT_TOKEN=${telegramToken}`,
    `TELEGRAM_OWNER_CHAT_ID=${telegramChatId}`,
    archiveCopied
      ? `TWITTER_ARCHIVE_PATH=./creators/${creatorName}/tweets.js`
      : `# TWITTER_ARCHIVE_PATH=./creators/${creatorName}/tweets.js`,
  ]
  fs.writeFileSync(path.join(creatorDir, '.env'), envLines.join('\n') + '\n', 'utf8')
  console.log(`  ✓ creators/${creatorName}/.env`)

  const config = {
    blopus: {
      handle: mode === 'owner' ? ownerHandle : botHandle,
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
  console.log('\n  Start your agent:\n')

  if (mode === 'owner' || mode === 'both') {
    console.log(`    CREATOR=${creatorName} npm run blopus:owner\n`)
  }
  if (mode === 'bot' || mode === 'both') {
    console.log(`    CREATOR=${creatorName} npm run blopus:bot\n`)
  }

  console.log(`  Once it starts, message your Telegram bot to control everything.`)

  if (!personalityProfile && (mode === 'owner' || mode === 'both')) {
    console.log(`
  IMPORTANT: No archive was processed. Blopus will post in a
  generic voice. To add your personality:
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
