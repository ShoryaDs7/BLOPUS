/**
 * BubbleBrain — direct Anthropic tool-use loop for the bubble overlay.
 * No Agent SDK, no MCP servers, no queue. Just fast direct API calls.
 * Two paths:
 *   Vision:   screen described → react in one casual sentence
 *   Friction: deep path — research the gap, return the specific insight, save to memory
 */

import Anthropic from '@anthropic-ai/sdk'
import https from 'https'
import http  from 'http'
import path  from 'path'
import fs    from 'fs'
import { execSync, exec } from 'child_process'
import { TavilyClient } from '../search/TavilyClient'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
const client  = new Anthropic()
const tavily  = new TavilyClient()

const SYSTEM_PROMPT = `You are Blopus — sitting right beside the owner watching their screen like a close friend.

When you receive a [VISION] message:
- If the screen shows an article, blog post, or webpage with content: call web_fetch with the full URL from the APP field, then summarize in 2-3 sentences.
- If the screen shows Gmail or email: call gmail_unread, tell the owner what matters most.
- Otherwise: react in 1 casual sentence relevant to what they are doing.
- Never say "I see" or describe the screen. Speak directly to the owner.
- Never repeat something already said recently.
- If screen is blank or you have absolutely nothing useful: reply NOTHING.`

const FRICTION_SYSTEM = `You are a silent observer beside someone who is stuck. You notice what's missing in their understanding.

Your output: ONE or TWO sentences. 10-20 words total. Hard limit — never exceed this.

Your job: name the specific concept or distinction that is likely missing. Not advice. Not suggestions. Not resources. Just the insight.

Hard rules — never break these:
- Never tell the user what to do
- Never suggest tools, platforms, databases, or resources
- Never say "you should", "try", "use", "check", "look at", "consider"
- Never describe their behavior back to them
- Never say "I", "based on", "according to", "it seems"
- No lists, no headers, no markdown
- ONE or TWO sentences only — if you write more, you failed

Steps:
1. If a file path is given: use read_file first
2. Use read_insights to check if this topic was seen before
3. Use tavily_search only if reading doesn't reveal the cause
4. If you find the missing concept: use save_insight, then write ONE sharp sentence naming it
5. If you genuinely cannot identify anything specific: return NOTHING

Good output examples:
"The attention weights aren't scores — they're a routing mechanism that decides which tokens inform each other."
"Query/key/value is the part where most explanations skip from formula to implementation without bridging the intuition."

Bad output (never do this):
"Your searches are hitting low-quality pages. Use ArXiv or Papers with Code instead."
"You should try academic databases for better resources on this topic."
"It seems you are struggling with the conceptual side of attention mechanisms."

Silence is for when you genuinely cannot diagnose. Not an excuse to avoid the hard work of finding the specific insight.`

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'web_fetch',
    description: 'Fetch and read the text content of any webpage URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'gmail_unread',
    description: 'Get a summary of unread Gmail messages.',
    input_schema: {
      type: 'object' as const,
      properties: {
        max: { type: 'number', description: 'Max messages to return (default 5)' },
      },
    },
  },
  {
    name: 'tavily_search',
    description: 'Search the web for specific information. Returns top result snippets.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Specific search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_insight',
    description: 'Save a useful insight about a topic to Blopus memory for future sessions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic:   { type: 'string', description: 'The topic keyword' },
        insight: { type: 'string', description: 'The specific insight to remember' },
      },
      required: ['topic', 'insight'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a specific file from the codebase. Use when VS Code sends a file path with an error.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute or workspace-relative file path' },
        lines:     { type: 'number', description: 'Max lines to read from start (default 120)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'bash_command',
    description: 'Run a read-only shell command for diagnosis. Allowed: git log/status/diff, ls/dir, cat, npm test output. NO writes, NO deletes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Read-only command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_insights',
    description: 'Load previously saved insights for this topic from Blopus memory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Topic keyword to look up' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'open_url',
    description: 'Open a URL in the user\'s default browser. Use only when a resource directly resolves the gap.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL to open' },
      },
      required: ['url'],
    },
  },
]

function fetchUrl(url: string): Promise<string> {
  return new Promise(resolve => {
    try {
      const mod = url.startsWith('https') ? https : http
      const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        // Follow one redirect
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchUrl(res.headers.location))
          return
        }
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          const text = data
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 6000)
          resolve(text || 'page was empty')
        })
      })
      req.on('error', () => resolve('failed to fetch URL'))
      req.setTimeout(12000, () => { req.destroy(); resolve('fetch timed out') })
    } catch {
      resolve('failed to fetch URL')
    }
  })
}

function gmailUnread(max: number): string {
  try {
    const script = path.join(BLOPUS_DIR, 'google_auth.py')
    const result = execSync(
      `python "${script}" gmail_unread ${max}`,
      { timeout: 15000, encoding: 'utf-8' }
    )
    return result.trim() || 'no unread messages'
  } catch (e: any) {
    return `gmail error: ${e.message?.slice(0, 100)}`
  }
}

// Whitelist: only safe read patterns allowed
const BASH_BLOCKED = /rm\s|del\s|move\s|rename\s|mkdir|rmdir|format|drop\s|truncate|write-file|set-content|out-file|>\s*\S|&\s*rm|&&\s*del/i

function bashCommand(cmd: string): string {
  if (BASH_BLOCKED.test(cmd)) return 'blocked: command contains write/delete operations'
  try {
    const out = execSync(cmd, { timeout: 8000, encoding: 'utf-8', cwd: BLOPUS_DIR })
    return out.trim().slice(0, 3000) || '(no output)'
  } catch (e: any) {
    return `error: ${e.message?.slice(0, 200)}`
  }
}

function readFile(filePath: string, lines = 120): string {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(BLOPUS_DIR, filePath)
    const content = fs.readFileSync(abs, 'utf-8')
    return content.split('\n').slice(0, lines).join('\n').slice(0, 8000)
  } catch {
    return 'file not found or unreadable'
  }
}

function readInsights(topic: string): string {
  try {
    const file = path.join(BLOPUS_DIR, 'memory-store', 'bubble_insights.jsonl')
    if (!fs.existsSync(file)) return 'no insights saved yet'
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    const matches = lines
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(e => e && e.topic?.toLowerCase().includes(topic.toLowerCase()))
      .slice(-5)
    if (matches.length === 0) return 'no past insights for this topic'
    return matches.map((e: any) => `[${new Date(e.ts).toLocaleDateString()}] ${e.insight}`).join('\n')
  } catch {
    return 'could not read insights'
  }
}

function openUrl(url: string): string {
  try {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`
    exec(cmd)
    return 'opened'
  } catch {
    return 'could not open URL'
  }
}

function saveInsight(topic: string, insight: string): string {
  try {
    const file = path.join(BLOPUS_DIR, 'memory-store', 'bubble_insights.jsonl')
    const entry = JSON.stringify({ ts: Date.now(), topic, insight }) + '\n'
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, entry, 'utf-8')
    return 'saved'
  } catch {
    return 'save failed'
  }
}

async function runTool(name: string, input: any): Promise<string> {
  if (name === 'web_fetch')    return fetchUrl(input.url)
  if (name === 'gmail_unread') return gmailUnread(input.max ?? 5)
  if (name === 'tavily_search') {
    const results = await tavily.search(input.query, 3, 'basic')
    return results.length > 0 ? results.join('\n') : 'no results'
  }
  if (name === 'save_insight')  return saveInsight(input.topic, input.insight)
  if (name === 'read_file')     return readFile(input.file_path, input.lines)
  if (name === 'bash_command')  return bashCommand(input.command)
  if (name === 'read_insights') return readInsights(input.topic)
  if (name === 'open_url')      return openUrl(input.url)
  return 'unknown tool'
}

export interface FrictionContext {
  topic:        string
  pageTitle:    string
  gap:          string
  frictionState: string
  recentTopics: string[]
  filePath?:    string   // VS Code: actual file to read
  line?:        number   // VS Code: error line number
  selectedText?: string  // browser: text user highlighted
  pageContent?:  string  // browser: visible page text
}

export class BubbleBrain {
  private processing = false

  async process(_chatId: string, msg: string): Promise<string> {
    if (this.processing) return ''
    this.processing = true
    try {
      return await this._run(msg)
    } finally {
      this.processing = false
    }
  }

  async resolveDeep(ctx: FrictionContext): Promise<string> {
    // No actionable context — stay silent rather than asking questions
    if (!ctx.topic && !ctx.filePath) return ''

    const userMsg = [
      `Topic: "${ctx.topic}"`,
      `Page/context: "${ctx.pageTitle}"`,
      `Gap type: ${ctx.gap}`,
      `Friction: ${ctx.frictionState}`,
      ctx.filePath ? `File to read: ${ctx.filePath}${ctx.line ? ` (error at line ${ctx.line})` : ''}` : '',
      ctx.recentTopics.length > 1
        ? `Recent trajectory: ${ctx.recentTopics.slice(0, 4).join(' → ')}`
        : '',
      ctx.selectedText ? `Selected text (what user highlighted): "${ctx.selectedText.slice(0, 800)}"` : '',
      ctx.pageContent  ? `Page content (visible text): "${ctx.pageContent.slice(0, 1200)}"` : '',
    ].filter(Boolean).join('\n')

    return this._runFriction(userMsg)
  }

  private async _runFriction(msg: string): Promise<string> {
    console.log('[BubbleBrain] _runFriction start')
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: msg }]
    let lastSavedInsight = ''

    for (let turn = 0; turn < 5; turn++) {
      const resp = await client.messages.create({
        model:      process.env.BUBBLEBRAIN_MODEL ?? 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system:     FRICTION_SYSTEM,
        tools:      TOOLS,
        messages,
      })

      console.log(`[BubbleBrain] turn=${turn} stop_reason=${resp.stop_reason}`)

      if (resp.stop_reason === 'end_turn') {
        const block = resp.content.find(b => b.type === 'text')
        const text  = (block as any)?.text?.trim() ?? ''
        console.log(`[BubbleBrain] final text="${text.slice(0, 80)}"`)
        // Haiku often ends with no text after tool calls — fall back to last saved insight
        if (!text || /^nothing$/i.test(text)) {
          if (lastSavedInsight) {
            console.log(`[BubbleBrain] using saved insight as answer`)
            return lastSavedInsight
          }
          return ''
        }
        return text
      }

      if (resp.stop_reason === 'tool_use') {
        const toolBlocks = resp.content.filter(b => b.type === 'tool_use')
        messages.push({ role: 'assistant', content: resp.content })
        const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
          toolBlocks.map(async (b: any) => {
            console.log(`[BubbleBrain] tool=${b.name} input=${JSON.stringify(b.input).slice(0, 80)}`)
            const content = await runTool(b.name, b.input)
            console.log(`[BubbleBrain] tool=${b.name} result=${content.slice(0, 80)}`)
            if (b.name === 'save_insight' && b.input?.insight) {
              lastSavedInsight = b.input.insight
            }
            return { type: 'tool_result' as const, tool_use_id: b.id, content }
          })
        )
        messages.push({ role: 'user', content: results })
        continue
      }
      break
    }
    console.log('[BubbleBrain] _runFriction exhausted turns — returning empty')
    return ''
  }

  private async _run(msg: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: msg }]

    for (let turn = 0; turn < 5; turn++) {
      const resp = await client.messages.create({
        model:      process.env.BUBBLEBRAIN_MODEL ?? 'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        tools:      TOOLS,
        messages,
      })

      if (resp.stop_reason === 'end_turn') {
        const block = resp.content.find(b => b.type === 'text')
        return (block as any)?.text?.trim() ?? ''
      }

      if (resp.stop_reason === 'tool_use') {
        const toolBlocks = resp.content.filter(b => b.type === 'tool_use')
        messages.push({ role: 'assistant', content: resp.content })

        const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
          toolBlocks.map(async (b: any) => ({
            type:        'tool_result' as const,
            tool_use_id: b.id,
            content:     await runTool(b.name, b.input),
          }))
        )
        messages.push({ role: 'user', content: results })
        continue
      }

      break
    }

    return ''
  }
}
