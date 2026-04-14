/**
 * AgentBrain — OpenClaw architecture.
 *
 * Compact system prompt + lazy-loaded skill files.
 * Agent reads ${SKILLS_DIR}/<skill>.md when it needs to act.
 * Keeps context lean — no monolithic prompt, no improvisation.
 *
 * ReAct loop via claude-agent-sdk query() — same as OpenClaw's gateway daemon.
 * Daily conversation log: C:/Blopus/logs/YYYY-MM-DD.md
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'fs'
import path from 'path'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
const SKILLS_DIR = path.join(BLOPUS_DIR, 'skills')
const LOGS_DIR   = path.join(BLOPUS_DIR, 'logs')

// Compact skill index — names + one-line descriptions only (same as OpenClaw)
// Agent requests full skill file via Read tool when it needs to act
function buildSkillIndex(): string {
  if (!fs.existsSync(SKILLS_DIR)) return '(no skills installed)'
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'))
  if (!files.length) return '(no skills installed)'

  return files.map(f => {
    try {
      const content = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8')
      const nameMatch = content.match(/^name:\s*(.+)$/m)
      const descMatch = content.match(/^description:\s*(.+)$/m)
      const name = nameMatch?.[1]?.trim() ?? f.replace('.md', '')
      const desc = descMatch?.[1]?.trim() ?? ''
      return `- ${name}: ${desc}  →  Read ${SKILLS_DIR}/${f}`
    } catch { return null }
  }).filter(Boolean).join('\n')
}

function buildSystemPrompt(): string {
  const skillIndex = buildSkillIndex()
  const today = new Date().toDateString()

  // Load owner handle from config if available
  let ownerHandle = process.env.OWNER_HANDLE ?? ''
  let botHandle = process.env.BOT_HANDLE ?? ''
  try {
    const configPath = process.env.BLOPUS_CONFIG_PATH ?? path.join(BLOPUS_DIR, 'config/blopus.config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    ownerHandle = ownerHandle || config.owner?.handle || 'owner'
    botHandle = botHandle || config.blopus?.handle || 'bot'
  } catch {}

  return `You are Claude — Blopus's Telegram control brain.
Today: ${today}

Owner: @${ownerHandle} (personal account), @${botHandle} (bot account). Running Blopus — autonomous X agent running 24/7.
Project: ${BLOPUS_DIR}
Memory: ${path.join(BLOPUS_DIR, 'creators/memory-store/')}

You have full access: Read, Write, Edit, Bash, Glob, Grep.

# How you work (OpenClaw style)
Before acting on a specific task, Read the relevant skill file to know exactly how.
Do not improvise tool usage — load the skill, follow it, execute cleanly.

# Installed skills
${skillIndex}

# Rules
- Short replies — this is Telegram chat
- Owner may type with typos — understand intent, never comment on spelling
- Always show what you're about to do BEFORE doing it (post, edit code, etc.)
- When you don't have a skill for something, reason from the codebase directly`
}

function getTodayLogPath(): string {
  const d = new Date()
  const name = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.md`
  return path.join(LOGS_DIR, name)
}

function appendToLog(role: 'Owner' | 'Blopus', text: string) {
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
    // Last 4000 chars — keep context lean
    return content.length > 4000 ? '...\n' + content.slice(-4000) : content
  } catch { return '' }
}

export class AgentBrain {
  private notifyFn?: (text: string) => Promise<void>

  setNotify(fn: (text: string) => Promise<void>) {
    this.notifyFn = fn
  }

  async process(chatId: string, userMessage: string): Promise<string> {
    const chunks: string[] = []
    let toolsUsed: string[] = []

    appendToLog('Owner', userMessage)

    try {
      await this.notifyFn?.('...')
      console.log('[AgentBrain] query starting for:', userMessage.slice(0, 60))

      // Inject today's conversation log so agent has session context
      const todayLog = loadTodayLog()
      const promptWithContext = todayLog
        ? `[Today's conversation so far]\n${todayLog}\n\n---\n\nOwner: ${userMessage}`
        : userMessage

      for await (const message of query({
        prompt: promptWithContext,
        options: {
          cwd: BLOPUS_DIR,
          systemPrompt: buildSystemPrompt(),
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          permissionMode: 'bypassPermissions',
          maxTurns: 20,
          env: { ...process.env },
        } as any,
      })) {
        if ((message as any).type === 'assistant') {
          const content = (message as any).message?.content ?? []
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) {
              chunks.push(block.text.trim())
            }
            if (block.type === 'tool_use') {
              toolsUsed.push(block.name)
            }
          }
        }

        if ((message as any).type === 'result') {
          const result = (message as any).result
          if (result && typeof result === 'string' && result.trim()) {
            chunks.push(result.trim())
          }
        }
      }

      console.log('[AgentBrain] done. chunks:', chunks.length, 'tools:', toolsUsed)
      const finalChunks = chunks.filter(c => c.length > 0)
      const response = finalChunks[finalChunks.length - 1] ?? 'done.'

      appendToLog('Blopus', response)

      const actionTools = toolsUsed.filter(t => ['Bash', 'Write', 'Edit'].includes(t))
      if (actionTools.length > 0) {
        const unique = [...new Set(actionTools)]
        return `${response}\n\n_(ran: ${unique.join(', ')})_`
      }

      return response
    } catch (err: any) {
      console.error('[AgentBrain] Error:', err)
      return `something went wrong: ${err.message?.slice(0, 100) ?? 'unknown error'}`
    }
  }

}
