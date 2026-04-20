#!/usr/bin/env npx tsx
/**
 * Blopus Bot Setup — run once to configure a bot account.
 * Usage: npm run bot-setup
 *
 * This sets up a bot account with its OWN personality (no archive needed).
 * For your real owner account, run: npm run setup
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

async function claudeInterpret(client: Anthropic, userSaid: string, context: string, returnFormat: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'You extract structured data from a person\'s natural language answer. CRITICAL: Read the ENTIRE sentence — do not latch onto the first word. If they say "yes but only X now", they mean ONLY X. Return ONLY what is asked — no markdown, no fences, no explanations.',
      messages: [{ role: 'user', content: `Context: ${context}\nUser said: "${userSaid}"\nReturn: ${returnFormat}` }],
    })
    const raw = res.content[0].type === 'text' ? res.content[0].text.trim() : ''
    return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  } catch { return '' }
}

function needsFollowUp(answer: string): boolean {
  return answer.trim().length < 6 || /^(depends|idk|not sure|maybe|dunno|unclear)$/i.test(answer.trim())
}

// ─── Bot Personality Interview ────────────────────────────────
async function runBotPersonalityInterview(
  apiKey: string,
  botHandle: string,
  askFn: (q: string) => Promise<string>
): Promise<any> {
  const client = new Anthropic({ apiKey })

  console.log('\n' + '═'.repeat(58))
  console.log('  BOT PERSONALITY INTERVIEW')
  console.log('  Answer like you\'re texting. No right or wrong answers.')
  console.log('  Claude will ask questions to understand your bot\'s voice.')
  console.log('═'.repeat(58) + '\n')

  const SYSTEM = `You are conducting a personality interview to define how a Twitter/X bot called @${botHandle} should sound and behave.

This bot has NO archive — your job is to ask questions to understand:
- What topics it covers
- How it sounds (tone, style, energy)
- What its personality is
- What it never does
- Golden example tweets that represent its ideal voice

Your job:
- Ask questions ONE AT A TIME
- Each question must be short, conversational, easy to answer fast
- Start broad (what is this bot about?) then get specific (how does it sound?)
- After 8-12 questions, output [INTERVIEW_DONE] followed by a JSON object with this exact structure:

{
  "dominantTopics": ["topic1", "topic2", ...],
  "toneDescriptor": "2-3 word vibe e.g. sharp, contrarian, curious",
  "writingStyle": "1-2 sentences describing how it writes",
  "goldenExamples": ["example tweet 1", "example tweet 2", "example tweet 3"],
  "bannedPhrases": ["phrase1", "phrase2"],
  "bannedTopics": ["topic1"],
  "personality": {
    "aggression": 0.0,
    "warmth": 0.0,
    "humor": 0.0,
    "formality": 0.0,
    "verbosity": 0.0
  },
  "summonKeywords": ["keyword1", "keyword2"],
  "signaturePatterns": ["pattern1", "pattern2"]
}

All personality values are 0.0–1.0. Only output [INTERVIEW_DONE] when you have enough to fill the full JSON.`

  const messages: { role: 'user' | 'assistant', content: string }[] = []
  let botPersonality: any = null

  // Kick off
  const kickoff = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: SYSTEM,
    messages: [{ role: 'user', content: `Start the interview for @${botHandle}. Ask your first question.` }],
  })

  const firstQ = kickoff.content[0].type === 'text' ? kickoff.content[0].text.trim() : ''
  console.log(`\n  ${firstQ}\n`)
  messages.push({ role: 'assistant', content: firstQ })

  for (let i = 0; i < 20; i++) {
    const answer = await askFn('  > ')
    if (!answer) continue

    messages.push({ role: 'user', content: answer })

    const followUp = needsFollowUp(answer)
    const prompt = followUp
      ? `The user said: "${answer}" — that's vague. Ask a short clarifying follow-up before moving on.`
      : `The user said: "${answer}". Ask the next question or output [INTERVIEW_DONE] with the JSON if you have enough.`

    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: SYSTEM,
      messages: [...messages, { role: 'user', content: prompt }],
    })

    const reply = res.content[0].type === 'text' ? res.content[0].text.trim() : ''
    messages.push({ role: 'assistant', content: reply })

    if (reply.includes('[INTERVIEW_DONE]')) {
      const jsonStart = reply.indexOf('{')
      if (jsonStart !== -1) {
        try { botPersonality = JSON.parse(reply.slice(jsonStart)) } catch {}
      }
      console.log('\n  ✓ Interview complete!\n')
      break
    }

    console.log(`\n  ${reply}\n`)
  }

  if (!botPersonality) {
    console.log('  (Using defaults — interview incomplete)\n')
    botPersonality = {
      dominantTopics: [],
      toneDescriptor: 'sharp, direct',
      writingStyle: 'Short punchy posts. No fluff.',
      goldenExamples: [],
      bannedPhrases: [],
      bannedTopics: [],
      personality: { aggression: 0.3, warmth: 0.5, humor: 0.6, formality: 0.1, verbosity: 0.3 },
      summonKeywords: ['thoughts', 'your take', 'weigh in'],
      signaturePatterns: [],
    }
  }

  // ── Preview: show 3 sample tweets in the bot's voice ───────
  console.log('  Generating 3 sample tweets in your bot\'s voice...\n')
  try {
    const previewRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You are @${botHandle}. Write exactly as this bot would post on X.`,
      messages: [{
        role: 'user',
        content: `Bot personality: ${JSON.stringify(botPersonality, null, 2)}\n\nWrite 3 standalone tweets this bot would post. Number them 1. 2. 3. No hashtags unless the bot would naturally use them. Match the tone exactly.`,
      }],
    })
    const preview = previewRes.content[0].type === 'text' ? previewRes.content[0].text.trim() : ''
    console.log('  ── Sample tweets ──────────────────────────────────')
    console.log(preview.split('\n').map((l: string) => `  ${l}`).join('\n'))
    console.log('  ───────────────────────────────────────────────────\n')
  } catch {}

  const looks = await askFn('  Does this sound right? (yes / describe what to change): ')

  if (looks && !/^y(es|ep|eah)?$/i.test(looks.trim())) {
    console.log('\n  Refining personality...\n')
    try {
      const refineRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: 'You adjust a Twitter bot\'s personality JSON based on user feedback. Return ONLY valid JSON, no markdown.',
        messages: [{
          role: 'user',
          content: `Current personality: ${JSON.stringify(botPersonality)}\n\nUser feedback: "${looks}"\n\nReturn the updated personality JSON with the same structure.`,
        }],
      })
      const refined = refineRes.content[0].type === 'text' ? refineRes.content[0].text.trim() : ''
      const clean = refined.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
      try { botPersonality = JSON.parse(clean) } catch {}
    } catch {}
    console.log('  ✓ Personality updated\n')
  }

  return botPersonality
}

// ─── Reply Behavior (Growth mode) ────────────────────────────
async function runReplyBehaviorInterview(
  client: Anthropic,
  botPersonality: any,
  askFn: (q: string) => Promise<string>
): Promise<{ replyMode: string, domainTopics: string[], neverTopics: string[], repliesPerDay: number }> {

  section(8, 'Reply targeting (Growth mode)')
  console.log(`
  Growth mode: Blopus hunts viral tweets in your bot's topics and replies to get discovered.

  [1] How should it find tweets to reply to?
      1 · Domain mode — only tweets matching your bot's topics (recommended)
      2 · Viral mode  — anything trending on its home timeline
`)
  let replyModeRaw = ''
  while (!['1', '2'].includes(replyModeRaw)) {
    replyModeRaw = await askFn('  Enter 1 or 2: ')
  }
  const replyMode = replyModeRaw === '1' ? 'domain' : 'viral'
  console.log(`  Got it — ${replyMode} mode\n`)

  const archiveTopics = botPersonality?.dominantTopics ?? []
  let domainTopics = archiveTopics
  let neverTopics: string[] = []

  if (replyMode === 'domain') {
    if (archiveTopics.length) {
      console.log(`  Your bot's topics from the interview:`)
      archiveTopics.forEach((t: string, i: number) => console.log(`    ${i + 1}. ${t}`))
      console.log(`\n  [2] Are these the right topics? Say what to keep, remove, or add. Enter to use all.`)
      const dtRaw = await askFn('  > ')
      if (dtRaw.trim()) {
        const dtJson = await claudeInterpret(client, dtRaw,
          `Current topics: ${JSON.stringify(archiveTopics)}`,
          'A JSON array of the final topic list. Return ONLY a valid JSON array of strings.')
        try { const p = JSON.parse(dtJson); if (Array.isArray(p) && p.length) domainTopics = p } catch {}
      }
      console.log(`  Got it — topics: ${domainTopics.slice(0, 5).join(', ')}\n`)
    } else {
      console.log(`  [2] What topics should the bot reply to? (comma-separated)`)
      const dtRaw = await askFn('  > ')
      domainTopics = dtRaw.split(',').map((t: string) => t.trim()).filter(Boolean)
      console.log(`  Got it — topics: ${domainTopics.join(', ')}\n`)
    }

    console.log(`  [3] Any topics it should NEVER reply to? (e.g. politics, nsfw — or Enter to skip)`)
    const neverRaw = await askFn('  > ')
    if (neverRaw.trim()) {
      const neverJson = await claudeInterpret(client, neverRaw, 'User listing never-reply topics.', 'A JSON array of never-reply topics.')
      try { neverTopics = JSON.parse(neverJson) } catch { neverTopics = neverRaw.split(',').map((t: string) => t.trim()).filter(Boolean) }
    }
    if (neverTopics.length) console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)

  } else {
    console.log(`  [2] Any topics it should NEVER reply to — even if they trend? (or Enter to skip)`)
    const neverRaw = await askFn('  > ')
    if (neverRaw.trim()) {
      const neverJson = await claudeInterpret(client, neverRaw, 'User listing never-reply topics.', 'A JSON array of never-reply topics.')
      try { neverTopics = JSON.parse(neverJson) } catch { neverTopics = neverRaw.split(',').map((t: string) => t.trim()).filter(Boolean) }
    }
    if (neverTopics.length) console.log(`  Got it — never reply to: ${neverTopics.join(', ')}\n`)
  }

  console.log(`  How many replies per day should the bot send? (e.g. 10, 20 — default 10)`)
  const qRpd = await askFn('  > ')
  let repliesPerDay = 10
  if (qRpd.trim()) {
    const match = qRpd.match(/\d+/)
    if (match) repliesPerDay = parseInt(match[0])
  }
  console.log(`  Got it — ${repliesPerDay} replies/day\n`)

  return { replyMode, domainTopics, neverTopics, repliesPerDay }
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(58))
  console.log('  BLOPUS BOT SETUP')
  console.log('  Sets up a standalone bot account with its own personality.')
  console.log('  For your real account, run: npm run setup')
  console.log('═'.repeat(58))

  // ── Step 1: Anthropic key (needed for interview) ──────────
  section(1, 'Anthropic API key')
  console.log(`
  Required to run the bot and conduct the personality interview.
  Get it from: https://console.anthropic.com → API Keys
`)
  const anthropicKey = await askRequired('Anthropic API Key')
  const setupClient = new Anthropic({ apiKey: anthropicKey })
  console.log('  ✓ API key saved\n')

  // ── Step 2: Bot handle ────────────────────────────────────
  section(2, 'Bot X handle')
  console.log(`
  The X handle of your bot account (no @).
  e.g.  johndoe_ai  — must already exist on X
`)
  const botHandle = await askRequired('Bot X handle (no @)', '')
  const creatorName = botHandle.toLowerCase()
  const creatorDir = path.resolve(`./creators/${creatorName}`)
  fs.mkdirSync(creatorDir, { recursive: true })
  console.log(`  ✓ Will save to: creators/${creatorName}/\n`)

  // ── Step 3: Twitter API keys ──────────────────────────────
  section(3, 'Twitter / X API keys')
  console.log(`
  These must be from the bot's X developer account — NOT your personal account.

  How to get them:
  1. Go to: https://developer.twitter.com/en/portal/dashboard
  2. Sign in with the BOT'S X account
  3. Create Project → create app → set permissions to "Read and Write"
  4. Keys and Tokens tab → copy all 4 values below
`)
  const apiKey            = await askRequired('API Key (Consumer Key)')
  const apiSecret         = await askRequired('API Secret (Consumer Secret)')
  const accessToken       = await askRequired('Access Token')
  const accessTokenSecret = await askRequired('Access Token Secret')

  // ── Step 4: X login credentials ──────────────────────────
  section(4, 'X login credentials  (for the bot account)')
  console.log(`
  Blopus uses a hidden browser to read the home timeline and post.
  Use the bot account's login — stored locally only, never sent anywhere.
`)
  const xEmail    = await askRequired('Bot X account email')
  const xPassword = await askRequired('Bot X account password')

  // ── Step 5: X session cookies ─────────────────────────────
  section(5, 'X session cookies  (for home timeline reading)')
  console.log(`
  Log into the BOT's X account in Chrome/Edge, then:

  1. Press F12 → Application tab → Storage → Cookies → https://x.com
  2. Find "auth_token" → copy the Value
  3. Find "ct0" → copy the Value
`)
  const xAuthToken = await askRequired('auth_token value')
  const xCt0       = await askRequired('ct0 value')

  console.log(`
  ⚠  These cookies expire periodically (every few weeks).
  When they expire, home timeline and search silently return 0 results —
  the bot will stop finding tweets to reply to with no error message.

  When that happens: repeat this step — grab fresh auth_token + ct0
  from x.com → F12 → Application → Cookies → update your .env file.
`)

  console.log(`
  X DM passcode — only needed if the bot has "Additional password protection" on X.
  Settings → Security → Additional password protection. Press Enter to skip if not set.
`)
  const xDmPasscode = await askOptional('X DM passcode (Enter to skip)')

  // ── Step 6: Tavily ─────────────────────────────────────────
  section(6, 'Tavily API key')
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

  section(7, 'Gemini API key  (optional)')
  console.log(`
  Skip if you don't need it.
  With it: send any YouTube link to Telegram, ask anything about
  the video — bot watches it and answers accurately.
  Without it: still works but less accurate (transcript only).

  Free at: https://aistudio.google.com → Get API Key
  Free tier: 1,500 requests/day — more than enough.
`)
  const geminiKey = await askOptional('Gemini API Key')

  // ── Step 8: Telegram ─────────────────────────────────────
  section(8, 'Telegram control bot')
  console.log(`
  HOW THIS TELEGRAM BOT WORKS:
  When your agent runs, this bot becomes its control panel.
  Message it to post, search — anything.

  Running bot account only → one Telegram bot is all you need.

  Also running an owner account (npm run setup)?
  → Run one at a time: same token is fine
  → Run both simultaneously: create a SEPARATE bot on @BotFather
    Same token + both running = Telegram splits your messages
    randomly between accounts. Autonomous posting still works fine,
    only your manual control gets confused.

  ─────────────────────────────────────────────────────
  Create a new bot:
  1. Open Telegram → search @BotFather
  2. Send:  /newbot
  3. Follow prompts → copy the token
  4. Username must end in _bot  (e.g. mybot_ctrl_bot)

  Get your chat ID:
  1. Open Telegram → search @userinfobot → it shows your numeric ID
`)

  const telegramToken  = await askRequired('Telegram bot token')
  const telegramChatId = await askRequired('Your Telegram chat ID (numeric)')

  // ── Step 8: Bot personality interview ────────────────────
  const botPersonality = await runBotPersonalityInterview(anthropicKey, botHandle, ask)

  // ── Step 9: Reply behavior (growth mode) ─────────────────
  const { replyMode, domainTopics, neverTopics, repliesPerDay } =
    await runReplyBehaviorInterview(setupClient, botPersonality, ask)

  // ── Step 10: Quote tweets ─────────────────────────────────
  let quoteTweetEnabled = false
  if (!await askSkip('QUOTE TWEETS — should the bot quote tweet others?', ask)) {
    console.log(`
  Should the bot quote tweet viral posts it finds?
  1 · Yes — quote tweet with the bot's take added
  2 · No  — replies only, no quote tweets
`)
    const qtRaw = await ask('  Enter 1 or 2: ')
    quoteTweetEnabled = qtRaw.trim() === '1'
    console.log(`  Got it — quote tweets ${quoteTweetEnabled ? 'enabled' : 'disabled'}\n`)
  } else {
    console.log('  Skipped — quote tweeting disabled.\n')
  }

  // ── Step 11: Optional extras ──────────────────────────────
  section(11, 'GitHub  (optional)')
  console.log(`
  Skip if you don't need it.
  With it: say "create a repo called X", "push my changes",
  "open a PR", "check CI status" — bot does it from Telegram.
  Without it: no GitHub control at all.

  Get a Personal Access Token:
  github.com → Settings → Developer settings → Tokens (classic)
  Generate new token → check all "repo" + "workflow" scopes → copy.
`)
  const githubToken = await askOptional('GitHub Personal Access Token')

  section(11, 'Railway deploy token  (optional)')
  console.log(`
  Skip if you don't need it.
  With it: say "deploy this to Railway" — bot spins up a server,
  API or database instantly from Telegram. No clicking.
  Without it: no cloud deployment from Telegram.

  railway.app → Account Settings → Tokens → New Token → copy.
`)
  const railwayToken = await askOptional('Railway token')

  // ── Step 12: Google Workspace (optional) ──────────────────
  section(12, 'Google Workspace — Gmail, Calendar, Drive + more  (optional)')
  console.log(`
  Skip if you don't need it.
  With it: "send an email to X", "schedule a meeting tomorrow 3pm",
  "upload this file to Drive", "read my inbox", "create a doc" —
  all from Telegram. Without it: none of those skills work.

  Gives the bot full Google account control.

  One-time setup (~5 mins):
  1. Go to https://console.cloud.google.com → create a new project
  2. Library → enable: Gmail API, Google Calendar API, Google Sheets API,
     Google Drive API, Google Docs API, Google Tasks API, Google People API,
     YouTube Data API v3, YouTube Analytics API, Google Slides API
  3. OAuth consent screen → External → add your email as test user
  4. Credentials → Create → OAuth 2.0 Client ID → Desktop App
  5. Download JSON → rename to gmail_credentials.json
  6. Place it in: creators/${creatorName}/gmail_credentials.json

  Press Enter once file is placed, or type "skip".
`)

  const googleCredsPath  = path.join(creatorDir, 'gmail_credentials.json')
  const googleSkip       = await askOptional('Press Enter to continue (or type "skip")')
  let googleClientId     = ''
  let googleClientSecret = ''
  let googleRefreshToken = ''

  if (googleSkip !== 'skip' && fs.existsSync(googleCredsPath)) {
    try {
      const raw   = JSON.parse(fs.readFileSync(googleCredsPath, 'utf-8'))
      const creds = raw.installed ?? raw.web ?? {}
      googleClientId     = creds.client_id     ?? ''
      googleClientSecret = creds.client_secret ?? ''
      if (googleClientId) console.log('  ✓ Extracted CLIENT_ID and CLIENT_SECRET')
    } catch { console.log('  ⚠ Could not parse credentials file — add GOOGLE_CLIENT_ID/SECRET manually later') }

    if (googleClientId) {
      console.log(`
  Now run this to authorise Google access (opens your browser):

    OWNER_HANDLE="${creatorName}" python -c "from google_auth import get_credentials; get_credentials()"

  Press Enter once you have completed the browser login.
`)
      await ask('  Press Enter when done: ')

      const tokenPath = path.join(creatorDir, 'token.json')
      if (fs.existsSync(tokenPath)) {
        try {
          const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
          googleRefreshToken = tok.refresh_token ?? ''
          if (googleRefreshToken) console.log('  ✓ Google refresh token extracted')
        } catch {}
      }
    }
  } else if (googleSkip !== 'skip') {
    console.log('  gmail_credentials.json not found — skipping Google setup.')
  }

  // ── Step 13: Surge (optional) ─────────────────────────────
  section(13, 'Surge  (optional — for static site deploys)')
  console.log(`
  Skip if you don't need it.
  With it: say "deploy this website" — bot publishes it instantly
  to a free .surge.sh URL from Telegram.
  Without it: no website publishing from Telegram.

  Install + login (run this in your terminal now):
    npm install --global surge
    surge login

  Press Enter once done, or type "skip".
`)
  await askOptional('Press Enter when done (or skip)')

  let surgeLogin = ''
  let surgeToken = ''
  try {
    const netrc = fs.readFileSync(path.join(require('os').homedir(), '.netrc'), 'utf8')
    const m = netrc.match(/machine surge\.surge\.sh\s+login (\S+)\s+password (\S+)/)
    if (m) { surgeLogin = m[1]; surgeToken = m[2] }
  } catch {}
  if (surgeLogin) console.log('  ✓ Surge credentials found')

  // ── Write .env ────────────────────────────────────────────
  section(14, 'Writing config files')

  const envLines = [
    `# Blopus Bot — ${creatorName}`,
    `BOT_HANDLE=${botHandle}`,
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
    xDmPasscode  ? `X_DM_PASSCODE=${xDmPasscode}`   : `# X_DM_PASSCODE=`,
    `TAVILY_API_KEY=${tavilyKey}`,
    geminiKey    ? `GEMINI_API_KEY=${geminiKey}`     : `# GEMINI_API_KEY=`,
    githubToken  ? `GITHUB_TOKEN=${githubToken}`     : `# GITHUB_TOKEN=`,
    railwayToken ? `RAILWAY_TOKEN=${railwayToken}`   : `# RAILWAY_TOKEN=`,
    surgeLogin   ? `SURGE_LOGIN=${surgeLogin}`       : `# SURGE_LOGIN=`,
    surgeToken   ? `SURGE_TOKEN=${surgeToken}`       : `# SURGE_TOKEN=`,
    googleClientId     ? `GOOGLE_CLIENT_ID=${googleClientId}`         : `# GOOGLE_CLIENT_ID=`,
    googleClientSecret ? `GOOGLE_CLIENT_SECRET=${googleClientSecret}` : `# GOOGLE_CLIENT_SECRET=`,
    googleRefreshToken ? `GOOGLE_REFRESH_TOKEN=${googleRefreshToken}` : `# GOOGLE_REFRESH_TOKEN=`,
    `TELEGRAM_BOT_TOKEN=${telegramToken}`,
    `TELEGRAM_OWNER_CHAT_ID=${telegramChatId}`,
    `X_HANDLE=${botHandle}`,
    `OSBOT_CONFIG_PATH=./creators/${creatorName}/config.json`,
    `BLOPUS_DIR=${process.cwd().replace(/\\/g, '/')}`,
    ``,
    `# X GraphQL hashes — if mentions/replies stop working, X changed these. Update them:`,
    `# 1. Open x.com in browser → open DevTools (F12) → Network tab → search for "SearchTimeline"`,
    `# 2. Copy the hash from the request URL and paste below`,
    `X_SEARCH_TIMELINE_HASH=flaR-PUMshxFWZWPNpq4zA`,
    `X_TWEET_DETAIL_HASH=nBS-WpgA6ZG0CyNHD517JQ`,
  ]

  fs.writeFileSync(path.join(creatorDir, '.env'), envLines.join('\n') + '\n', 'utf8')
  console.log(`  ✓ creators/${creatorName}/.env`)

  // ── Write config.json ─────────────────────────────────────
  const config = {
    blopus: {
      handle: botHandle,
      displayName: 'Blopus',
    },
    owner: {
      handle: botHandle,
      displayName: botHandle,
    },
    controlChannel: {
      telegram: { ownerChatId: telegramChatId },
    },
    llm: {
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 400,
    },
    replySettings: {
      maxRepliesPerHour: Math.ceil(repliesPerDay / 16),
      maxRepliesPerDay: repliesPerDay,
      replyToMentions: true,
      replyToViral: true,
    },
    replyMode,
    replyStrategy: 'growth',
    avoidTopics: neverTopics,
    quoteTweetEnabled,
  }

  fs.writeFileSync(
    path.join(creatorDir, 'blopus.config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  )
  console.log(`  ✓ creators/${creatorName}/blopus.config.json`)

  // ── Write personality_profile.json ────────────────────────
  const personalityProfile = {
    ...botPersonality,
    dominantTopics: domainTopics.length ? domainTopics : botPersonality.dominantTopics,
    replyTopics: domainTopics,
    neverTopics,
    replyMode,
    replyStrategy: 'growth',
    repliesPerDay,
    isBot: true,
  }

  fs.writeFileSync(
    path.join(creatorDir, 'personality_profile.json'),
    JSON.stringify(personalityProfile, null, 2),
    'utf8'
  )
  console.log(`  ✓ creators/${creatorName}/personality_profile.json`)

  // ── Done ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(58))
  console.log('  Bot setup complete!')
  console.log('═'.repeat(58))
  console.log(`
  Start your bot:

    CREATOR=${creatorName} npm run blopus:bot

  Once it starts, message your Telegram bot to control it —
  post tweets, search, set timers, manage files, anything.
`)
  console.log('─'.repeat(58))
  console.log('  HOW TELEGRAM WORKS WITH MULTIPLE ACCOUNTS')
  console.log('─'.repeat(58))
  console.log(`
  Each agent (owner or bot) uses whatever Telegram token is
  in its creator .env. Here is what that means in practice:

  Running one at a time (owner in morning, bot at night):
    → Same Telegram token is fine. One agent active = full control.

  Running both simultaneously (two terminals at once):
    → Separate tokens required.
    → Autonomous posting (scheduled tweets, viral replies) runs
      perfectly fine on both accounts regardless.
    → Only Telegram control breaks if tokens are shared — your
      messages get split randomly between both agents.

  Want to also run your real owner account?
    → Run:  npm run setup
    → Each creator folder is fully independent — no conflicts.
`)
  hr()
  console.log()

  rl.close()
}

main().catch(err => {
  console.error('\n  Setup failed:', err.message)
  rl.close()
  process.exit(1)
})
