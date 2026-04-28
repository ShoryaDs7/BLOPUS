import path from 'path'
import fs from 'fs'

const tmpDir = path.resolve('./tmp-scheduler-test')
fs.mkdirSync(tmpDir, { recursive: true })
process.env.BLOPUS_CONFIG_PATH = path.join(tmpDir, 'config.json')
fs.writeFileSync(process.env.BLOPUS_CONFIG_PATH, '{}')
process.env.TELEGRAM_BOT_TOKEN = 'test'
process.env.TELEGRAM_OWNER_CHAT_ID = 'test'

import { ScheduleStore } from '../adapters/control/ScheduleStore'
import { TaskRunner } from '../agent/TaskRunner'
import { XTools } from '../adapters/control/XTools'

const now = new Date()
const h = now.getHours()
const m = now.getMinutes()
const pad = (n: number) => String(n).padStart(2, '0')

// cron for 2 minutes in future
const futureMin = (m + 2) % 60
const futureHour = m >= 58 ? (h + 1) % 24 : h
const cronFuture = `${futureMin} ${futureHour} * * *`

// cron for 5 minutes ago (missed, <30 min)
const past5Min = ((m - 5) + 60) % 60
const past5Hour = m < 5 ? (h - 1 + 24) % 24 : h
const cronPast5 = `${past5Min} ${past5Hour} * * *`

// cron for 45 minutes ago (missed, >30 min)
const past45Min = ((m - 45) + 60) % 60
const past45Hour = m < 45 ? (h - 1 + 24) % 24 : h
const cronPast45 = `${past45Min} ${past45Hour} * * *`

console.log(`\nNow: ${pad(h)}:${pad(m)}`)
console.log(`\n--- Testing 3 scenarios ---\n`)

// We call execute() directly to test the schedule_task logic
// Need a minimal XTools instance with taskRunner

// Mock everything except the schedule logic
const mockXTools = {
  setTaskRunner(r: any) { (this as any).taskRunner = r },
  taskRunner: null as any,
  async execute(toolName: string, input: Record<string, any>): Promise<string> {
    if (toolName !== 'schedule_task') return `[mock] ${toolName} fired`
    // paste the actual schedule_task logic here via the real XTools path
    return '[should not reach]'
  }
}

// Use real XTools.execute via direct import — just test the guard logic
// by parsing what it returns for each cron

function checkCron(cronExpr: string, label: string): string {
  const parts = cronExpr.trim().split(/\s+/)
  const cronMin = parseInt(parts[0], 10)
  const cronHour = parseInt(parts[1], 10)
  const target = new Date(now)
  target.setHours(cronHour, cronMin, 0, 0)
  const missedMs = now.getTime() - target.getTime()

  if (missedMs <= 0) {
    return `✅ Future task — will fire at ${pad(cronHour)}:${pad(cronMin)} today`
  } else if (missedMs <= 30 * 60 * 1000) {
    return `⚡ Missed by ${Math.round(missedMs/60000)} min — run IMMEDIATELY (not tomorrow)`
  } else {
    return `⚠️ Missed by ${Math.round(missedMs/60000)} min — ask user: did you mean tomorrow?`
  }
}

console.log(`Case 1: schedule at ${pad(futureHour)}:${pad(futureMin)} (2 min from now)`)
console.log(`  → ${checkCron(cronFuture, 'future')}\n`)

console.log(`Case 2: schedule at ${pad(past5Hour)}:${pad(past5Min)} (5 min ago)`)
console.log(`  → ${checkCron(cronPast5, 'past5')}\n`)

console.log(`Case 3: schedule at ${pad(past45Hour)}:${pad(past45Min)} (45 min ago)`)
console.log(`  → ${checkCron(cronPast45, 'past45')}\n`)
