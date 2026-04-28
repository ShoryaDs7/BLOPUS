import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'fs'
import path from 'path'
import { GoalStore, GoalState } from '../adapters/control/GoalStore'

import { execSync } from 'child_process'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')

const NPX_CMD = (() => {
  try { return execSync('where npx', { encoding: 'utf8' }).trim().split('\n')[0].trim() } catch {}
  try { return execSync('which npx', { encoding: 'utf8' }).trim() } catch {}
  return 'npx'
})()

async function notify(chatId: string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {})
}

function isLooping(done: string[]): boolean {
  if (done.length < 3) return false
  const last3 = done.slice(-3).map(s => s.slice(0, 30).toLowerCase())
  return last3[0] === last3[1] && last3[1] === last3[2]
}

function buildPrompt(goal: GoalState): string {
  const dir = GoalStore.goalDir(goal.id)
  const today = new Date().toISOString().split('T')[0]

  const doneBlock = goal.done.length
    ? goal.done.map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'Nothing done yet. This is day 1.'

  const blockerBlock = goal.blockers.length
    ? `Blockers: ${goal.blockers.join(', ')}`
    : 'No blockers.'

  const filesBlock = goal.files.length
    ? `Files so far: ${goal.files.join(', ')}`
    : 'No files created yet.'

  return `Goal: ${goal.goal}
${goal.deadline ? `Deadline: ${goal.deadline}` : ''}

Current focus: ${goal.current_focus}

What's been done:
${doneBlock}

${blockerBlock}
${filesBlock}

Working directory for this goal: ${dir}
Today: ${today}

FIRST — before any other work — write ${dir}/done_today.txt with your plan for today:
Line 1: what you intend to do today (one sentence)
Line 2: what you expect tomorrow's focus to be (one sentence)
Line 3: none
Line 4: none

Then do the actual work. When finished, overwrite ${dir}/done_today.txt with the real summary:
Line 1: what you actually did today (one sentence)
Line 2: what to focus on tomorrow (one sentence)
Line 3: any blockers (or write: none)
Line 4: any new files created, comma separated (or write: none)`
}

export async function runGoal(goal: GoalState): Promise<void> {
  const dir = GoalStore.goalDir(goal.id)
  const doneTodayPath = path.join(dir, 'done_today.txt')

  if (fs.existsSync(doneTodayPath)) fs.unlinkSync(doneTodayPath)

  if (isLooping(goal.done)) {
    await notify(goal.notify_chat_id,
      `⚠️ Goal "${goal.goal.slice(0, 60)}" looks like it's looping — last 3 days were similar. Paused. Tell me what to do next.`)
    GoalStore.update(goal.id, { status: 'paused' })
    return
  }

  await notify(goal.notify_chat_id, `🔄 Working on: "${goal.goal.slice(0, 60)}"`)

  const timeoutMs = (goal.timeout_minutes ?? 15) * 60 * 1000

  const options: any = {
    cwd: BLOPUS_DIR,
    permissionMode: 'bypassPermissions',
    maxTurns: 80,
    model: process.env.SESSIONBRAIN_MODEL ?? 'claude-sonnet-4-6',
    systemPrompt: buildPrompt(goal),
    mcpServers: {
      xtools: {
        type: 'stdio' as const,
        command: NPX_CMD,
        args: ['tsx', path.join(BLOPUS_DIR, 'adapters/control/XToolsMcpServer.ts')],
        env: { ...process.env },
      },
    },
    allowedTools: [
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'ToolSearch',
      'mcp__xtools__*',
    ],
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  }

  try {
    await Promise.race([
      (async () => {
        for await (const msg of query({ prompt: 'Start working on the goal now.', options })) {
          const m = msg as any
          if (m.type === 'assistant' && m.message?.content) {
            for (const block of m.message.content) {
              if (block.type === 'tool_use') {
                console.log(`[GoalRunner] tool: ${block.name} ${JSON.stringify(block.input).slice(0, 80)}`)
              }
              if (block.type === 'text' && block.text?.trim()) {
                console.log(`[GoalRunner] claude: ${block.text.slice(0, 120)}`)
              }
            }
          }
        }
      })(),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ])
  } catch (err: any) {
    await notify(goal.notify_chat_id, `❌ Goal run failed: ${err.message?.slice(0, 100)}`)
    return
  }

  let doneToday = 'Session ran but no summary written.'
  let nextFocus = goal.current_focus
  let newBlockers: string[] = []
  let newFiles: string[] = []

  if (fs.existsSync(doneTodayPath)) {
    const lines = fs.readFileSync(doneTodayPath, 'utf-8')
      .split('\n').map(l => l.trim()).filter(Boolean)
    doneToday  = lines[0] ?? doneToday
    nextFocus  = lines[1] ?? nextFocus
    newBlockers = lines[2] && lines[2].toLowerCase() !== 'none' ? [lines[2]] : []
    newFiles    = lines[3] && lines[3].toLowerCase() !== 'none'
      ? lines[3].split(',').map(f => f.trim()).filter(Boolean)
      : []
  }

  // Auto-scan folder — register all files Claude created regardless of what it reported
  const allInFolder = fs.readdirSync(dir)
    .filter(f => f !== 'state.json' && f !== 'done_today.txt')
    .map(f => path.join(dir, f))
  const knownFiles = new Set(goal.files)
  const discoveredFiles = allInFolder.filter(f => !knownFiles.has(f))

  const today = new Date().toISOString().split('T')[0]
  GoalStore.update(goal.id, {
    done: [...goal.done, `${today}: ${doneToday}`],
    current_focus: nextFocus,
    blockers: newBlockers,
    files: [...goal.files, ...discoveredFiles, ...newFiles.filter(f => !knownFiles.has(f))],
  })

  const blockerLine = newBlockers.length ? `\n⚠️ Blocked: ${newBlockers.join(', ')}` : ''
  await notify(goal.notify_chat_id,
    `✅ Done: ${doneToday}\n\nTomorrow: ${nextFocus}${blockerLine}`)
}

export class GoalRunner {
  private timer: NodeJS.Timeout | null = null

  start(): void {
    console.log('[GoalRunner] started — checking active goals every 24h')
    this.tick()
    this.timer = setInterval(() => this.tick(), 24 * 60 * 60 * 1000)
  }

  private async tick(): Promise<void> {
    const goals = GoalStore.listActive()
    if (!goals.length) return
    console.log(`[GoalRunner] ${goals.length} active goal(s) — running`)
    for (const goal of goals) {
      await runGoal(goal)
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
