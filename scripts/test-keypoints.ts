import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config({ path: path.join(process.cwd(), '.env') })
const creatorsDir = path.join(process.cwd(), 'creators')
const creators = fs.readdirSync(creatorsDir).filter(d => fs.statSync(path.join(creatorsDir, d)).isDirectory())
if (!creators.length) { console.error('No creator'); process.exit(1) }
dotenv.config({ path: path.join(creatorsDir, creators[0], '.env') })

import { GoalStore } from '../adapters/control/GoalStore'
import { runGoal } from '../agent/GoalRunner'

async function main() {
  const goal = GoalStore.create({
    goal: 'Research the top 3 JavaScript frameworks in 2026 — compare performance, ecosystem, and job market. Produce a clear recommendation.',
    current_focus: 'Survey React, Vue, and Svelte — find 2026 benchmark data and job posting numbers',
    timeout_minutes: 8,
    runs_per_day: 1,
    last_run_timestamps: [],
    notify_chat_id: process.env.TELEGRAM_OWNER_CHAT_ID ?? '',
  })

  console.log(`[test] Goal: ${goal.id}`)

  for (let day = 1; day <= 3; day++) {
    console.log(`\n── Day ${day} ──`)
    await runGoal(GoalStore.load(goal.id)!)
    const s = GoalStore.load(goal.id)!
    const files = fs.readdirSync(GoalStore.goalDir(goal.id))
    const hasKeypoints = files.some(f => f.startsWith('keypoints_day_'))
    console.log(`Done: ${s.done.at(-1)}`)
    console.log(`Keypoints file written: ${hasKeypoints ? '✅' : '❌'}`)
    console.log(`Files: ${files.join(', ')}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
