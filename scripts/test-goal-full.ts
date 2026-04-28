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
  const email = process.env.OWNER_EMAIL ?? 'shawrya.ds7@gmail.com'

  const goal = GoalStore.create({
    goal: `Research the most interesting AI agent breakthrough from the past week. Day 1: find it and post one tweet about it in the owner's voice (use post_tweet tool). Day 2: dig deeper — find implications and post a follow-up tweet. Day 3: send a summary email to ${email} with what was found across all 3 days, then post a final concluding tweet.`,
    current_focus: 'Find the most interesting AI agent news from the past 7 days and post about it',
    timeout_minutes: 20,
    runs_per_day: 1,
    last_run_timestamps: [],
    notify_chat_id: process.env.TELEGRAM_OWNER_CHAT_ID ?? '',
  })

  console.log(`[test] Goal: ${goal.id}`)

  for (let day = 1; day <= 3; day++) {
    console.log(`\n── Day ${day} ──`)
    await runGoal(GoalStore.load(goal.id)!)
    const s = GoalStore.load(goal.id)!
    console.log(`Done: ${s.done.at(-1)}`)
    console.log(`Files: ${fs.readdirSync(GoalStore.goalDir(goal.id)).join(', ')}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
