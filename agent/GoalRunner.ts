import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'fs'
import path from 'path'
import { GoalStore, GoalState } from '../adapters/control/GoalStore'
import { buildSystemPrompt } from '../adapters/control/SessionBrain'

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
  const dayNumber = goal.done.length + 1

  const doneBlock = goal.done.length
    ? goal.done.slice(-7).map((d, i) => `${i + 1}. ${d}`).join('\n')
    : 'Nothing done yet. This is day 1.'

  const blockerBlock = goal.blockers.length
    ? `Blockers: ${goal.blockers.join(', ')}`
    : 'No blockers.'

  // Read all keypoints — from current folder AND any prior goal folders (file handover case)
  const priorDirs = [...new Set(goal.files.map(f => path.dirname(f)))].filter(d => d !== dir)
  const allKeypointDirs = [dir, ...priorDirs]
  const allKeypoints: string[] = []
  for (const kdir of allKeypointDirs) {
    try {
      fs.readdirSync(kdir)
        .filter(f => f.startsWith('keypoints_day_'))
        .sort()
        .forEach(f => {
          const content = fs.readFileSync(path.join(kdir, f), 'utf-8').trim()
          allKeypoints.push(`--- ${f} ---\n${content}`)
        })
    } catch {}
  }
  const keypointsBlock = allKeypoints.join('\n\n')

  // Only show last 2 work files — not all files
  const workFiles = goal.files
    .filter(f => !f.includes('keypoints_day_') && !f.includes('done_today') && !f.includes('state.json') && !f.includes('README'))
    .slice(-2)
  const filesBlock = workFiles.length
    ? `Most recent work files (read these for context): ${workFiles.join(', ')}`
    : 'No work files yet.'

  const conditionBlock = goal.completion_condition
    ? `\nCompletion condition: "${goal.completion_condition}" — check this at the START of every session. If it is met, write "Completed — [condition] is met" as line 1 of done_today.txt and stop working.`
    : ''

  return `Goal: ${goal.goal}
${goal.deadline ? `Deadline: ${goal.deadline}` : ''}${conditionBlock}
Today is Day ${dayNumber}.

Current focus: ${goal.current_focus}

Recent sessions:
${doneBlock}

${blockerBlock}
${filesBlock}
${keypointsBlock ? `\nKey points from all prior sessions (critical — read carefully):\n${keypointsBlock}` : ''}

Working directory for this goal: ${dir}
Today: ${today}

Never call ToolSearch — all your tools are already listed in the system prompt above. Act immediately.

FIRST — before any other work — write ${dir}/done_today.txt with your plan for today:
Line 1: what you intend to do today (one sentence)
Line 2: what you expect tomorrow's focus to be (one sentence)
Line 3: none
Line 4: none

Then do the actual work. When finished:

1. Overwrite ${dir}/done_today.txt with the real summary:
Line 1: what you actually did today (one sentence)
Line 2: what to focus on tomorrow (one sentence)
Line 3: ONLY write a blocker if you genuinely cannot proceed without the owner's input — missing credentials, a decision only they can make, access you cannot get yourself. If you can try a different approach, just try it — write "none" here and keep going. Do NOT write a blocker just because one thing failed.
Line 4: any new files created, comma separated (or write: none)

2. Write ${dir}/keypoints_day_${dayNumber}.md — bullets only, no prose, 5-10 lines max:
## Permanently ruled out
- [anything tried and definitively failed — so future sessions never retry it]
## Must not forget
- [critical decisions, facts, or findings that aren't obvious from the summary]
## Best open thread
- [the most promising direction to pursue next]`
}

/** Reads done_today.txt and applies the result to GoalStore. Exported for testing. */
export async function applyGoalResult(goal: GoalState): Promise<'completed' | 'paused' | 'active'> {
  const dir = GoalStore.goalDir(goal.id)
  const doneTodayPath = path.join(dir, 'done_today.txt')

  let doneToday = 'Session ran but no summary written.'
  let nextFocus = goal.current_focus
  let newBlockers: string[] = []
  let newFiles: string[] = []

  if (fs.existsSync(doneTodayPath)) {
    const lines = fs.readFileSync(doneTodayPath, 'utf-8')
      .split('\n').map(l => l.trim()).filter(Boolean)
    doneToday   = lines[0] ?? doneToday
    nextFocus   = lines[1] ?? nextFocus
    newBlockers = lines[2] && lines[2].toLowerCase() !== 'none' ? [lines[2]] : []
    newFiles    = lines[3] && lines[3].toLowerCase() !== 'none'
      ? lines[3].split(',').map(f => f.trim()).filter(Boolean)
      : []
  }

  const allInFolder = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => f !== 'state.json' && f !== 'done_today.txt').map(f => path.join(dir, f))
    : []
  const knownFiles = new Set(goal.files)
  const discoveredFiles = allInFolder.filter(f => !knownFiles.has(f))
  const updatedFiles = [...goal.files, ...discoveredFiles, ...newFiles.filter(f => !knownFiles.has(f))]
  const today = new Date().toISOString().split('T')[0]
  const d = doneToday.toLowerCase()
  const goalDone = d.startsWith('completed') || d.startsWith('goal completed') ||
    d.startsWith('done —') || d.startsWith('done:') || d.startsWith('finished') ||
    d.startsWith('task complete') || d.startsWith('goal complete') || d.startsWith('all done') ||
    d.includes('goal is complete') || d.includes('task is complete') || d.includes('work is complete')

  if (goalDone) {
    GoalStore.update(goal.id, { done: [...goal.done, `${today}: ${doneToday}`], current_focus: nextFocus, blockers: [], files: updatedFiles, status: 'completed' })
    await notify(goal.notify_chat_id, `🎉 Goal complete!\n\n"${goal.goal.slice(0, 80)}"\n\n${doneToday}`)
    return 'completed'
  } else if (newBlockers.length > 0) {
    GoalStore.update(goal.id, { done: [...goal.done, `${today}: ${doneToday}`], current_focus: nextFocus, blockers: newBlockers, files: updatedFiles })
    await notify(goal.notify_chat_id, `⚠️ "${goal.goal.slice(0, 60)}"\n\nDone: ${doneToday}\nNext: ${nextFocus}\n\nFlagged: ${newBlockers.join(', ')}\n\nStill running tomorrow — reply if you want to redirect.`)
    return 'active'
  } else {
    GoalStore.update(goal.id, { done: [...goal.done, `${today}: ${doneToday}`], current_focus: nextFocus, blockers: [], files: updatedFiles })
    await notify(goal.notify_chat_id, `✅ Done: ${doneToday}\n\nNext: ${nextFocus}`)
    return 'active'
  }
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
    systemPrompt: buildSystemPrompt(),
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
      'WebSearch', 'WebFetch', 'Agent', 'TodoWrite',
      'mcp__xtools__*',
    ],
    env: {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY,
      USERPROFILE: path.join(BLOPUS_DIR, '.claude-api-home'),
      HOME: path.join(BLOPUS_DIR, '.claude-api-home'),
    },
  }

  try {
    await Promise.race([
      (async () => {
        for await (const msg of query({ prompt: buildPrompt(goal), options })) {
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

  await applyGoalResult(goal)
}

function shouldRunNow(goal: GoalState): boolean {
  const now = new Date()
  const todayStr = now.toISOString().split('T')[0]
  const runsPerDay = goal.runs_per_day ?? 1
  const timestamps = goal.last_run_timestamps ?? []

  // Count how many times it already ran today
  const ranToday = timestamps.filter(t => t.startsWith(todayStr)).length
  if (ranToday >= runsPerDay) return false

  // Enforce minimum gap between runs = (24h / runs_per_day) * 0.8
  if (timestamps.length > 0) {
    const lastRun = new Date(timestamps[timestamps.length - 1])
    const minGapMs = (24 / runsPerDay) * 60 * 60 * 1000 * 0.8
    if (now.getTime() - lastRun.getTime() < minGapMs) return false
  }

  return true
}

export class GoalRunner {
  private timer: NodeJS.Timeout | null = null

  start(): void {
    console.log('[GoalRunner] started — checking goals every 30 min')
    this.tick()
    this.timer = setInterval(() => this.tick(), 30 * 60 * 1000)
  }

  private async tick(): Promise<void> {
    const goals = GoalStore.listActive()
    const due = goals.filter(shouldRunNow)
    if (!due.length) return
    console.log(`[GoalRunner] ${due.length} goal(s) due — running`)
    for (const goal of due) {
      // Record run timestamp before starting
      const ts = new Date().toISOString()
      const timestamps = [...(goal.last_run_timestamps ?? []), ts].slice(-28)
      GoalStore.update(goal.id, { last_run_timestamps: timestamps })

      await runGoal(GoalStore.load(goal.id)!)

      // Check if deadline passed — auto-complete
      const fresh = GoalStore.load(goal.id)!
      if (fresh.deadline) {
        const today = new Date().toISOString().split('T')[0]
        if (today >= fresh.deadline && fresh.status === 'active') {
          GoalStore.update(goal.id, { status: 'completed' })
          await notify(fresh.notify_chat_id,
            `✅ Goal "${fresh.goal.slice(0, 60)}" reached its deadline. Marking complete.`)
        }
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
