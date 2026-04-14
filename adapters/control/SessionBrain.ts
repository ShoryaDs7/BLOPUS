/**
 * SessionBrain — Claude Code agent over Telegram, API-key powered.
 *
 * What makes it feel like Claude Code in the IDE:
 *  1. Streams every tool call to Telegram in real-time — you see the work happening
 *  2. Queues mid-task messages — send "no wrong tweet" while it's running, it handles after
 *  3. Sessions persist to disk — OsBot restart doesn't wipe conversation history
 *  4. Reasoned system prompt — contextual thinking, not literal string search
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import path from 'path'
import fs from 'fs'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
const SESSIONS_FILE = path.join(BLOPUS_DIR, 'memory-store/sessions.json')
const TASK_TIMEOUT_MS = 15 * 60 * 1000
const SESSION_EXPIRY_MS = 2 * 60 * 60 * 1000 // 2 hours — old context adds cost, not value

// Scan skills/ dir and build compact index — name + description only (OpenClaw style)
// Agent requests full skill file via Read tool when it needs to act
function buildSkillIndex(): string {
  const skillsDir = path.join(BLOPUS_DIR, 'skills')
  try {
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).sort()
    const entries: string[] = []
    for (const file of files) {
      const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8').slice(0, 600)
      const nameMatch = content.match(/^name:\s*(.+)$/m)
      const descMatch = content.match(/^description:\s*(.+)$/m)
      const name = nameMatch?.[1]?.trim() ?? file.replace('.md', '')
      const desc = descMatch?.[1]?.trim() ?? ''
      entries.push(`  ${name}: ${desc}  →  Read ${path.join(BLOPUS_DIR, 'skills')}/${file}`)
    }
    return entries.length ? entries.join('\n') : '  (no skills installed)'
  } catch {
    return '  (no skills installed)'
  }
}

// Scan scripts/ dir and extract one-line description from each file's leading comment
function buildScriptIndex(): string {
  const scriptsDir = path.join(BLOPUS_DIR, 'scripts')
  try {
    const files = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.ts')).sort()
    const entries: string[] = []
    for (const file of files) {
      const content = fs.readFileSync(path.join(scriptsDir, file), 'utf-8').slice(0, 400)
      let desc = ''
      const jsdocMatch = content.match(/\/\*\*\s*\n([\s\S]*?)\*\//)
      if (jsdocMatch) {
        const lines = jsdocMatch[1]
          .split('\n')
          .map(l => l.replace(/^\s*\*\s?/, '').trim())
          .filter(l => l && !l.startsWith('@') && !l.startsWith('Run:') && !l.startsWith('Usage') && !l.includes('.ts'))
        desc = lines.slice(0, 2).join(' ').slice(0, 120)
      }
      if (desc) entries.push(`  scripts/${file} — ${desc}`)
    }
    return entries.length ? entries.join('\n') : ''
  } catch {
    return ''
  }
}

// Load creator config — reads BLOPUS_CONFIG_PATH env var (set by run-*.ts scripts)
// Falls back to aiblopus config if not specified
function loadCreatorConfig(): any {
  const configPath = process.env.BLOPUS_CONFIG_PATH
    ? path.resolve(process.env.BLOPUS_CONFIG_PATH)
    : path.resolve('./config/blopus.config.json')
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Compact instruction header injected on every resumed session message.
 * Keeps critical rules in context without replacing full system prompt.
 */
function buildInstructionHeader(): string {
  const cfg = loadCreatorConfig()
  const botHandle   = cfg?.osbot?.handle ?? 'the bot account'
  const ownerHandle = cfg?.owner?.handle ?? 'the owner'
  const projectDir  = BLOPUS_DIR.replace(/\\/g, '/')
  const skillIndex  = buildSkillIndex()

  return `[INSTRUCTIONS — always follow these]
Past conversations: [PAST CONVERSATIONS] and [TODAY] sections above contain the real history. Answer questions about past work FROM THOSE SECTIONS FIRST — do not run git log or find commands to reconstruct what you already know.
X actions: use mcp__xtools__ tools. reply_to_tweet(tweet_url, text), post_tweet(topic), quote_tweet(tweet_url, text), search_trending_and_reply(category). Browser MCP ok for profiles/timelines, not for tweet URLs you're replying to.
Scheduling: any recurring request → CronCreate immediately, no confirmation needed. Natural language → cron expression. CronList = show tasks. CronDelete = remove.
Browser: non-X sites only. navigate→screenshot→snapshot→click→repeat.
Memory: @handle → Read ${projectDir}/creators/memory-store/persons/<handle>.json directly. Never glob first.
Stuck? Tell owner what's blocking — never run random commands.
Skills: when task matches a skill below — READ the full skill file first, follow its code exactly. Do NOT write code from memory.
${skillIndex}`
}

function buildSystemPrompt(): string {
  const cfg = loadCreatorConfig()

  const botHandle   = cfg?.osbot?.handle      ?? 'the bot account'
  const ownerHandle = cfg?.owner?.handle       ?? 'the owner'
  const ownerName   = cfg?.owner?.displayName  ?? 'the owner'
  const projectDir  = BLOPUS_DIR.replace(/\\/g, '/')
  const skillIndex  = buildSkillIndex()
  const scriptIndex = buildScriptIndex()

  return `You are Claude — Blopus's Telegram brain. You have full file access + browser + platform action system.

Owner: ${ownerName} (@${ownerHandle}). Bot account: @${botHandle}. Project: ${projectDir}

# X / Twitter actions — use mcp__xtools__ tools directly
You have these X tools available. Use them immediately when asked — no JSON, no Bash, no x-cli:
- mcp__xtools__get_tweet — read a tweet's text + image (use FIRST when you need to see content before replying)
- mcp__xtools__get_user_tweets — get recent tweets from any profile (handle, count)
- mcp__xtools__post_tweet — post a new tweet (topic, optional angle)
- mcp__xtools__reply_to_tweet — reply to a tweet URL (tweet_url, text)
- mcp__xtools__quote_tweet — quote tweet a URL (tweet_url, text)
- mcp__xtools__quote_tweet_from_feed — pick viral tweet from feed and quote it
- mcp__xtools__search_trending_and_reply — ONLY use when no conditions specified and no view/age requirements
- mcp__xtools__search_and_reply — ONLY use when user gives a specific keyword/hashtag to search, no view/age conditions
- mcp__xtools__control_autonomous — pause/resume autonomous posting
- mcp__xtools__find_viral_and_act — find viral tweets by conditions and reply/quote. Params: topic (optional), count, action (reply/quote/both), min_views, max_age_hours. Use for "reply to 3 AI tweets", "find 500k+ politics tweets and quote", "post 2 AI and 2 politics replies" (call twice).
- mcp__xtools__read_dm_inbox — read DM inbox, see all conversations + unread status
- mcp__xtools__read_dm_thread — read full conversation thread with a specific user (handle)
- mcp__xtools__send_dm — send a DM to any X user (handle, message)

Rules:
- Tweet URL + reply text is obvious → call reply_to_tweet directly
- Tweet URL + need to see image/content first → call get_tweet, then reply_to_tweet
- NEVER use browser MCP to open the same tweet URL you're about to reply_to_tweet or quote_tweet — use get_tweet instead. Browser MCP is fine for profiles, timelines, search.
- "post a tweet about X" → use post_tweet
- NEVER use Bash or x-cli for X actions.

# DM flow — always follow this order
When asked to respond to DMs or "I have unread":
1. read_dm_inbox → find who is unread
2. For each unread person → read_dm_thread(@handle) → get full conversation context
3. Check person history file: ${projectDir}/creators/memory-store/persons/<handle>.json (if exists, read it — tells you who they are and how owner talks to them)
4. Generate a reply in owner's voice based on conversation + person history
5. send_dm(@handle, reply)

When asked to "DM @username [message]" directly → skip steps 1-3, just send_dm immediately.

# Browser — for reading websites, news, non-X browsing only
Pattern: browser_navigate → browser_take_screenshot → browser_snapshot → browser_click(ref) → repeat.
NEVER open browser for x.com or twitter.com.

# Memory — person history, conversations, relationship data
When ANY @handle is mentioned — immediately Read the file directly:
  ${projectDir}/creators/memory-store/persons/<handle>.json
Example: "@tamaki_senpai02" → Read ${projectDir}/creators/memory-store/persons/tamaki_senpai02.json
Two people mentioned? Read BOTH files. File not found? Then say no records.
NEVER glob or search memory-store first.

# Google API — CRITICAL RULE — NO EXCEPTIONS
A ready-made auth helper exists at: ${projectDir}/google_auth.py
ALWAYS use it for ALL Google tasks — Gmail, Calendar, Sheets, Drive, Docs, YouTube, Meet.

Always use it like this:
  import sys; sys.path.insert(0, '${projectDir}')
  from google_auth import get_service
  gmail    = get_service('gmail', 'v1')
  calendar = get_service('calendar', 'v3')
  sheets   = get_service('sheets', 'v4')
  drive    = get_service('drive', 'v3')
  docs     = get_service('docs', 'v1')

First time use: browser opens once for owner to sign in — this is expected and correct. Token saves automatically and never expires after that.
If gmail_credentials.json missing — tell owner to place it in creators/${ownerHandle}/ folder.

# When stuck — stop and tell the owner
If you cannot complete a step (missing tool, unclear instruction, blocked): say exactly what is blocking you. NEVER try random commands hoping something works.

# API keys — if missing, guide owner to get it and offer to save it
If a task needs an API key that's not in .env:
1. Tell the owner exactly where to get it (URL + steps, max 3 lines)
2. Say "paste the key here and I'll add it to your .env automatically"
3. When owner pastes the key — append it to ${projectDir}/creators/${ownerHandle}/.env and confirm
Example for Resend: "Email needs a free API key. Go to resend.com → sign up → API Keys → Create → paste it here and I'll save it."

# Rules
- Short replies — Telegram chat
- ${ownerName} types with typos — understand intent, never comment
- Never say you can't do something — read the codebase/memory first
- NotebookLM: NEVER check login, NEVER run \`python -m notebooklm list\`, NEVER ask owner to login. Session is saved. Just run the generate script and report errors if any.
- Financial tasks: if the task involves ANY financial calculations (burn rate, ARR, valuations, multiples, FX conversion, runway, revenue) — you MUST verify every calculation by running it in Python via Bash before including it in your response. Never report a financial number you haven't verified with code.

# Persistent memory
Long-term memory file: ${projectDir}/memory-store/MEMORY.md
This file is injected at the start of EVERY session — even after restarts or weeks away.
Write to it when: owner says "remember this", a task is ongoing, or important context needs to survive.
Format: short bullet points. Overwrite stale entries. Keep it under 100 lines.

# Skills — ALWAYS read the skill file before writing any code
When a task matches a skill below — READ the full skill file first, then follow its code exactly.
Do NOT write code from memory. The skill file has tested working code.

${skillIndex}`
}

// Tool call → short human-readable Telegram notification
function toolSummary(name: string, input: any): string {
  const EMOJI: Record<string, string> = {
    bash:      '⚡',
    read:      '📄',
    write:     '✏️',
    edit:      '✏️',
    glob:      '🔍',
    grep:      '🔍',
    webfetch:  '🌐',
    websearch: '🌐',
  }
  const n = name.toLowerCase()
  const emoji = EMOJI[n] ?? '🔧'

  if (n === 'bash') {
    const cmd = (input.command ?? '').replace(/\s+/g, ' ').slice(0, 80)
    return `${emoji} ${cmd}`
  }
  if (n === 'read') {
    const fp = (input.file_path ?? '').replace(/\\/g, '/')
    const short = fp.split('/').slice(-2).join('/')
    return `${emoji} reading ${short}`
  }
  if (n === 'write' || n === 'edit') {
    const fp = (input.file_path ?? '').replace(/\\/g, '/')
    return `${emoji} ${n}: ${fp.split('/').pop()}`
  }
  if (n === 'glob' || n === 'grep') {
    return `${emoji} searching: ${(input.pattern ?? input.query ?? '').slice(0, 60)}`
  }
  if (n === 'agent') {
    return `🤖 spawning agent: ${(input.description ?? '').slice(0, 60)}`
  }
  if (n === 'toolsearch') {
    return `🔍 tool lookup: ${(input.query ?? '').slice(0, 60)}`
  }
  // Browser MCP tools
  if (n === 'mcp__browser__browser_navigate') {
    return `🌐 navigating to ${(input.url ?? '').slice(0, 80)}`
  }
  if (n === 'mcp__browser__browser_snapshot') {
    return `👁 reading page...`
  }
  if (n === 'mcp__browser__browser_click') {
    return `🖱 clicking: ${input.element ?? input.ref ?? ''}`
  }
  if (n === 'mcp__browser__browser_type' || n === 'mcp__browser__browser_fill') {
    const text = (input.text ?? input.value ?? '').slice(0, 60)
    return `⌨️ typing: "${text}"`
  }
  if (n === 'mcp__browser__browser_screenshot' || n === 'mcp__browser__browser_take_screenshot') {
    return `📸 screenshot`
  }
  if (n === 'mcp__browser__browser_scroll') {
    return `↕️ scrolling page`
  }
  if (n === 'mcp__browser__browser_wait_for') {
    return `⏳ waiting for page...`
  }
  if (n.startsWith('mcp__browser__')) {
    return `🌐 browser: ${n.replace('mcp__browser__browser_', '')}`
  }
  return `${emoji} ${n}: ${JSON.stringify(input).slice(0, 60)}`
}

const LOGS_DIR = path.join(BLOPUS_DIR, 'logs')

// MCP browser gets its own copy of the authenticated profile so it doesn't conflict
// with the autonomous Playwright session using the same userDataDir simultaneously.
// Only the Cookies + Local Storage files are copied — not the full profile (too large).
function getMcpProfileDir(handle: string): string {
  const src = path.join(BLOPUS_DIR, 'memory-store/chrome-profiles', handle)
  const dst = path.join(BLOPUS_DIR, 'memory-store/chrome-profiles', `${handle}-mcp`)
  if (!fs.existsSync(dst)) {
    try {
      fs.mkdirSync(dst, { recursive: true })
      // Copy Default profile dir which has cookies/session
      const defaultSrc = path.join(src, 'Default')
      const defaultDst = path.join(dst, 'Default')
      if (fs.existsSync(defaultSrc)) {
        fs.cpSync(defaultSrc, defaultDst, { recursive: true })
        console.log(`[SessionBrain] MCP profile copied from ${handle} → ${handle}-mcp`)
      }
    } catch (e) {
      console.warn(`[SessionBrain] Could not copy profile, using mcp-browser fallback:`, e)
      return path.join(BLOPUS_DIR, 'memory-store/chrome-profiles/mcp-browser')
    }
  }
  return dst
}

function getTodayLogPath(): string {
  const d = new Date()
  const name = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.md`
  return path.join(LOGS_DIR, name)
}

function appendToLog(role: 'Owner' | 'Blopus', text: string): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    const line = `\n## ${role} [${new Date().toLocaleTimeString()}]\n${text}\n`
    fs.appendFileSync(getTodayLogPath(), line, 'utf8')
  } catch {}
}

function loadTodayLog(): string {
  try {
    const p = getTodayLogPath()
    if (!fs.existsSync(p)) return ''
    const content = fs.readFileSync(p, 'utf8')
    // Last 10000 chars — enough for a full day of context
    return content.length > 10000 ? '…\n' + content.slice(-10000) : content
  } catch { return '' }
}

const SESSION_LOG_FILE = path.join(BLOPUS_DIR, 'memory-store/session_log.jsonl')
const TASK_LOG_FILE = path.join(BLOPUS_DIR, 'memory-store/task_log.jsonl')

// Compressed task summary — saved after each task, token-efficient structured format
function appendTaskSummary(q: string, a: string): void {
  try {
    // Derive a compact task type from the question
    const qLow = q.toLowerCase()
    let type = 'task'
    if (qLow.includes('email')) type = 'email'
    else if (qLow.includes('tweet') || qLow.includes('post') || qLow.includes('reply')) type = 'x'
    else if (qLow.includes('scrape') || qLow.includes('web') || qLow.includes('news')) type = 'web'
    else if (qLow.includes('pdf') || qLow.includes('doc') || qLow.includes('pptx') || qLow.includes('xlsx') || qLow.includes('pitch')) type = 'doc'
    else if (qLow.includes('image') || qLow.includes('photo') || qLow.includes('picture')) type = 'image'
    else if (qLow.includes('code') || qLow.includes('fix') || qLow.includes('build')) type = 'code'
    else if (qLow.includes('remember') || qLow.includes('memory')) type = 'memory'
    else if (qLow.includes('cron') || qLow.includes('schedule')) type = 'schedule'

    const status = a.toLowerCase().includes('error') || a.toLowerCase().includes('failed') ? 'fail' : 'ok'
    const summary = a.replace(/\*\*/g, '').replace(/\n+/g, ' ').slice(0, 120)
    const entry = { t: new Date().toTimeString().slice(0,5), type, q: q.slice(0, 80), s: status, r: summary }
    fs.mkdirSync(path.join(BLOPUS_DIR, 'memory-store'), { recursive: true })
    fs.appendFileSync(TASK_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {}
}

// Keep old session log writer for backwards compat
function appendSessionEntry(q: string, a: string): void {
  appendTaskSummary(q, a)
}

function loadSessionLog(): string {
  try {
    // Try new task log first, fall back to old session log
    const logFile = fs.existsSync(TASK_LOG_FILE) ? TASK_LOG_FILE : SESSION_LOG_FILE
    if (!fs.existsSync(logFile)) return ''
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
    const recent = lines.slice(-50) // last 50 tasks — cheap because entries are tiny
    const entries = recent.map(l => {
      try {
        const parsed = JSON.parse(l)
        // New compact format
        if (parsed.type && parsed.t) {
          return `{t:${parsed.t},type:${parsed.type},q:"${parsed.q}",s:${parsed.s},r:"${parsed.r}"}`
        }
        // Old format fallback
        const { at, q, a } = parsed
        const time = new Date(at).toLocaleTimeString()
        return `[${time}] Q:${q.slice(0,80)} A:${a.slice(0,80)}`
      } catch { return null }
    }).filter(Boolean)
    return entries.join('\n')
  } catch { return '' }
}

function buildMemoryContext(): string {
  const parts: string[] = []

  // Long-term memory — persists across restarts, weeks, months
  try {
    const memPath = path.join(BLOPUS_DIR, 'memory-store/MEMORY.md')
    if (fs.existsSync(memPath)) {
      const content = fs.readFileSync(memPath, 'utf8').trim()
      if (content) {
        const capped = content.length > 2000 ? '…\n' + content.slice(-2000) : content
        parts.push(`[LONG-TERM MEMORY]\n${capped}`)
      }
    }
  } catch {}

  // Session log — every past exchange, auto-saved, no LLM needed
  const sessionLog = loadSessionLog()
  if (sessionLog) {
    parts.push(`[PAST CONVERSATIONS — most recent last]\n${sessionLog}`)
  }

  // Today's log (raw full text for current day context)
  const todayLog = loadTodayLog()
  if (todayLog.trim()) {
    const d = new Date()
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    parts.push(`[TODAY - ${dateStr}]\n${todayLog}`)
  }

  return parts.join('\n\n')
}

// Execute X action using the shared PlaywrightXClient instance — avoids spawning a second browser
async function executeXAction(action: any, xClient?: any): Promise<string> {
  const text: string = action.text ?? ''
  const tweetId: string = action.tweetId ?? ''

  if (!xClient) return `❌ X client not available`

  try {
    if (action.xaction === 'post') {
      await xClient.postTweet(text)
      return `✅ Posted: "${text.slice(0, 80)}"`
    } else if (action.xaction === 'reply') {
      await xClient.postReply(tweetId, text)
      return `✅ Replied: "${text.slice(0, 80)}"`
    } else if (action.xaction === 'quote') {
      await xClient.postQuoteTweet(text, tweetId)
      return `✅ Quoted: "${text.slice(0, 80)}"`
    } else {
      return `❌ Unknown xaction: ${action.xaction}`
    }
  } catch (e: any) {
    return `❌ X action failed: ${e.message?.slice(0, 100)}`
  }
}

export class SessionBrain {
  // streamFn: sends text to Telegram (tool updates + final replies)
  private streamFn?: (text: string) => Promise<void>
  // Per-chat session IDs — persisted to disk with last-used timestamp
  private sessions = new Map<string, { id: string; lastUsed: number }>()
  // Per-chat processing lock
  private processing = new Set<string>()
  // Queue for messages that arrive while processing
  private messageQueue = new Map<string, string[]>()
  // Shared X client — avoids spawning second Playwright instance
  private xClient?: any

  constructor() {
    this.loadSessions()
  }

  // ── Disk persistence ──────────────────────────────────────────────────────

  private loadSessions(): void {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'))
        for (const [k, v] of Object.entries(data)) {
          // Support both old format (string) and new format ({ id, lastUsed })
          if (typeof v === 'string') {
            this.sessions.set(k, { id: v, lastUsed: Date.now() })
          } else {
            this.sessions.set(k, v as { id: string; lastUsed: number })
          }
        }
        console.log(`[SessionBrain] Loaded ${this.sessions.size} session(s) from disk`)
      }
    } catch {
      // fresh start
    }
  }

  private saveSessions(): void {
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true })
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(this.sessions), null, 2))
    } catch {}
  }

  // ── Public API ────────────────────────────────────────────────────────────

  setNotify(fn: (text: string) => Promise<void>): void {
    this.streamFn = fn
  }

  setXClient(client: any): void {
    this.xClient = client
  }

  private async emit(text: string): Promise<void> {
    await this.streamFn?.(text).catch(() => {})
  }

async processWithImage(chatId: string, userMessage: string, imageBase64: string, mimeType: string): Promise<string> {
    // Use Anthropic API directly to analyze the image first, then pass description to agent
    try {
      const Anthropic = require('@anthropic-ai/sdk')
      const client = new Anthropic.default()
      const visionResp = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: `Describe this image in detail. Include all relevant information visible.` }
          ]
        }]
      })
      const imageDescription = visionResp.content[0].type === 'text' ? visionResp.content[0].text : 'image attached'
      const fullMessage = `${userMessage}\n\n[IMAGE DESCRIPTION: ${imageDescription}]`
      return this._run(chatId, fullMessage)
    } catch (e: any) {
      return this._run(chatId, userMessage)
    }
  }

  async process(chatId: string, userMessage: string): Promise<string> {
    if (this.processing.has(chatId)) {
      const queue = this.messageQueue.get(chatId) ?? []
      queue.push(userMessage)
      this.messageQueue.set(chatId, queue)
      console.log(`[SessionBrain] chat=${chatId} — queued mid-task message`)
      return 'finishing current task first — then handling this.'
    }
    return this._run(chatId, userMessage)
  }

  // ── Core agent loop ───────────────────────────────────────────────────────

  private async _run(chatId: string, userMessage: string): Promise<string> {
    this.processing.add(chatId)
    appendToLog('Owner', userMessage)
    await this.emit('...')

    // Always start fresh — no session resume. Memory is handled by task_log + today's log + MEMORY.md.
    // Session resume was replaying 80k-150k tokens of internal history on every message = massive cost.
    const existingSession = undefined
    console.log(`[SessionBrain] chat=${chatId} session=NEW msg="${userMessage.slice(0, 60)}"`)

    const chunks: string[] = []
    let newSessionId: string | undefined
    let lastEmitAt = 0

    const abort = new AbortController()
    const timeoutHandle = setTimeout(() => {
      console.warn(`[SessionBrain] chat=${chatId} TIMEOUT after ${TASK_TIMEOUT_MS / 1000}s`)
      abort.abort()
    }, TASK_TIMEOUT_MS)

    try {
      const options: any = {
        cwd: BLOPUS_DIR,
        permissionMode: 'bypassPermissions',
        maxTurns: 25,
        model: process.env.SESSIONBRAIN_MODEL ?? 'claude-haiku-4-5-20251001',
        abortController: abort,
        // MCP browser — passed directly so SDK always starts it regardless of settings.json discovery.
        // Works for any website: X, trading platforms, news, anything a human can browse.
        // Uses direct node path (not npx) to avoid PATH resolution issues in agent environment.
        mcpServers: {
          xtools: {
            type: 'stdio' as const,
            command: 'C:\\Program Files\\nodejs\\npx.cmd',
            args: ['tsx', path.join(BLOPUS_DIR, 'adapters/control/XToolsMcpServer.ts')],
            env: { ...process.env },
          },
          browser: {
            type: 'stdio' as const,
            command: 'node',
            args: [
              path.join(BLOPUS_DIR, 'node_modules/@playwright/mcp/cli.js'),
              '--browser', 'chromium',
              '--user-data-dir', getMcpProfileDir(loadCreatorConfig()?.blopus?.handle ?? 'blopus'),
              '--viewport-size', '1280,900',
              '--headless',
            ],
          },
        },
        // Allow all standard Claude Code tools + browser MCP tools.
        // Without listing mcp__browser__* the SDK blocks browser tool calls even with bypassPermissions.
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
          'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'ToolSearch',
          'mcp__browser__*',
          'mcp__xtools__*',
        ],
        env: {
          ...process.env,
          // ANTHROPIC_AUTH_TOKEN is read directly by the CLI before any OAuth check.
          // ANTHROPIC_API_KEY requires "API mode" to be explicitly configured — avoid it.
          ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY,
          // Clean home dir — no .credentials.json so OAuth is never loaded
          USERPROFILE: path.join(BLOPUS_DIR, '.claude-api-home'),
          HOME: path.join(BLOPUS_DIR, '.claude-api-home'),
        },
      }

      // Always fresh session — system prompt injected every time, memory via task_log + today's log
      options.systemPrompt = buildSystemPrompt()

      const memoryContext = buildMemoryContext()
      const memoryPrefix = memoryContext ? memoryContext + '\n\n---\n\n' : ''
      const effectivePrompt = memoryPrefix + userMessage

      for await (const message of query({ prompt: effectivePrompt, options })) {
        const msg = message as any

        // Capture session ID
        if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
          newSessionId = msg.session_id
          console.log(`[SessionBrain] session captured: ${newSessionId}`)
          // Log MCP server connection status
          if (msg.mcp_servers?.length) {
            for (const s of msg.mcp_servers) {
              console.log(`[MCP] ${s.name}: ${s.status}`)
            }
          }
        }

        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {

            // Stream tool use to Telegram — rate limited to 1 per 400ms so it doesn't flood
            if (block.type === 'tool_use') {
              const now = Date.now()
              if (now - lastEmitAt >= 400) {
                await this.emit(toolSummary(block.name, block.input))
                lastEmitAt = now
              }
            }

            // Collect text for final response
            if (block.type === 'text' && block.text?.trim()) {
              chunks.push(block.text.trim())
            }
          }
        }

        // Detect context window exhaustion — stopReason 'length' with no content
        if (msg.type === 'result' && msg.subtype === 'error_during_execution') {
          const errText = msg.error?.message ?? msg.error ?? ''
          if (String(errText).toLowerCase().includes('context') || String(errText).toLowerCase().includes('length')) {
            console.warn(`[SessionBrain] chat=${chatId} — context window hit, clearing session`)
            this.sessions.delete(chatId)
            this.saveSessions()
            return 'conversation got too long — cleared session and starting fresh. resend your last message.'
          }
        }

        if (msg.type === 'result' && msg.result?.trim()) {
          chunks.push(msg.result.trim())
        }

      }

      if (newSessionId) {
        this.sessions.set(chatId, { id: newSessionId, lastUsed: Date.now() })
        this.saveSessions()
      }

      const finalChunks = chunks.filter(c => c.length > 0)

      // Intercept special JSON action blocks across all chunks
      const allText = finalChunks.join('\n')
      // Strip markdown code fences before searching
      const strippedText = allText.replace(/```(?:json)?\s*/g, '').replace(/```/g, '')

      // xaction — X post/reply/quote
      const xactionMatch = strippedText.match(/\{[^{}]*"xaction"\s*:[^{}]*\}/)
      if (xactionMatch) {
        try {
          const action = JSON.parse(xactionMatch[0])
          await this.emit('⚡ executing X action...')
          const result = await executeXAction(action, this.xClient)
          appendToLog('Blopus', result)
          return result
        } catch {}
      }

      // telegramFile — file to deliver back (e.g. from NotebookLM skill)
      const fileMatch = strippedText.match(/\{[^{}]*"telegramFile"\s*:[^{}]*\}/)
      if (fileMatch) {
        // Return the raw JSON so TelegramAdapter can handle file sending
        return fileMatch[0]
      }

      if (finalChunks.length > 0) {
        appendToLog('Blopus', finalChunks[finalChunks.length - 1])
        appendSessionEntry(userMessage, finalChunks[finalChunks.length - 1])
      }

      // Cost tracking — log and emit after every real message
      // Empty response = silent context window exhaustion (stopReason 'length' with no text)
      if (finalChunks.length === 0) {
        console.warn(`[SessionBrain] chat=${chatId} — empty response, likely context limit hit`)
        if (existingSession) {
          this.sessions.delete(chatId)
          this.saveSessions()
          return 'conversation got too long — cleared session and starting fresh. resend your last message.'
        }
        return 'no response — try rephrasing or breaking the task into smaller steps.'
      }

      return finalChunks[finalChunks.length - 1]

    } catch (err: any) {
      console.error('[SessionBrain] Error:', err)
      if (existingSession) {
        this.sessions.delete(chatId)
        this.saveSessions()
      }
      if (abort.signal.aborted) {
        return 'took too long (>15 min) — cancelled. try breaking it into smaller steps.'
      }
      return `error: ${err.message?.slice(0, 150) ?? 'unknown'}`
    } finally {
      clearTimeout(timeoutHandle)
      this.processing.delete(chatId)
      // Process any messages that arrived while we were busy
      setImmediate(() => this._drainQueue(chatId))
    }
  }

  // ── Queue drain ───────────────────────────────────────────────────────────

  private async _drainQueue(chatId: string): Promise<void> {
    const queue = this.messageQueue.get(chatId)
    if (!queue || queue.length === 0) return
    const next = queue.shift()!
    this.messageQueue.set(chatId, queue)
    console.log(`[SessionBrain] chat=${chatId} — processing queued message: "${next.slice(0, 60)}"`)
    const result = await this._run(chatId, next)
    // Send result directly via stream (Telegram adapter won't see this return value)
    const chunks = result.match(/[\s\S]{1,4000}/g) ?? ['done.']
    for (const chunk of chunks) {
      await this.emit(chunk)
    }
  }
}
