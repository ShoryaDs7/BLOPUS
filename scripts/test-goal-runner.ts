/**
 * test-goal-runner.ts — simulates 3 days of GoalRunner on "Prove the Riemann Hypothesis"
 * Run: npx tsx scripts/test-goal-runner.ts
 */

import path from 'path'
import fs from 'fs'
import { config as dotenvConfig } from 'dotenv'

const creatorsBase = path.resolve('./creators')
const creators = fs.existsSync(creatorsBase)
  ? fs.readdirSync(creatorsBase).filter(d => fs.statSync(path.join(creatorsBase, d)).isDirectory())
  : []

if (creators.length) {
  dotenvConfig({ path: path.join(creatorsBase, creators[0], '.env'), override: false })
}
dotenvConfig({ override: false })

process.env.BLOPUS_DIR = path.resolve('.')
process.env.BLOPUS_CONFIG_PATH = creators.length
  ? path.join(creatorsBase, creators[0], 'config.json')
  : path.join('.', 'config.json')

import { GoalStore } from '../adapters/control/GoalStore'
import { runGoal } from '../agent/GoalRunner'

const sep = '─'.repeat(60)

async function main() {
  console.log('\n' + sep)
  console.log('  GoalRunner — 3-day stress test')
  console.log('  Task: Prove the Riemann Hypothesis')
  console.log(sep + '\n')

  const goal = GoalStore.create({
    goal: 'Prove the Riemann Hypothesis. Each day make real mathematical progress — read what was done before, continue from it, produce actual working notes. Do not restate the problem. Do actual work.',
    current_focus: 'Survey current approaches — what has been tried and exactly why each failed',
    deadline: '3 days',
    timeout_minutes: 10,
    notify_chat_id: process.env.TELEGRAM_OWNER_CHAT_ID ?? '',
  })

  console.log(`Goal ID:  ${goal.id}`)
  console.log(`Folder:   goals/${goal.id}/\n`)

  for (let day = 1; day <= 3; day++) {
    const state = GoalStore.load(goal.id)!

    console.log(sep)
    console.log(`  DAY ${day}`)
    console.log(sep)
    console.log(`Focus:   ${state.current_focus}`)
    console.log(`Done:    ${state.done.length === 0 ? 'nothing yet' : state.done.join(' | ')}`)
    console.log(`Files:   ${state.files.length === 0 ? 'none' : state.files.join(', ')}`)
    console.log(`Status:  ${state.status}`)
    console.log('\n▶ Running Claude...\n')

    await runGoal(state)

    const after = GoalStore.load(goal.id)!
    const goalDir = path.join(process.env.BLOPUS_DIR!, 'goals', goal.id)
    const doneTodayPath = path.join(goalDir, 'done_today.txt')

    console.log('\n--- DAY ' + day + ' RESULT ---')
    console.log(`Status:       ${after.status}`)
    console.log(`New focus:    ${after.current_focus}`)
    console.log(`Latest done:  ${after.done.at(-1) ?? 'NOTHING — state not updated'}`)
    console.log(`Blockers:     ${after.blockers.length ? after.blockers.join(', ') : 'none'}`)
    console.log(`Files:        ${after.files.length ? after.files.join(', ') : 'none'}`)

    if (fs.existsSync(doneTodayPath)) {
      console.log('\ndone_today.txt:')
      console.log(fs.readFileSync(doneTodayPath, 'utf-8'))
    } else {
      console.log('\n⚠️  done_today.txt NOT written')
    }

    const allFiles = fs.readdirSync(goalDir)
    console.log(`All files in folder: ${allFiles.join(', ')}\n`)

    if (after.status !== 'active') {
      console.log(`Goal is ${after.status} — stopping test early`)
      break
    }

    if (day < 3) await new Promise(r => setTimeout(r, 2000))
  }

  console.log(sep)
  console.log('  FINAL STATE')
  console.log(sep)
  console.log(JSON.stringify(GoalStore.load(goal.id), null, 2))

  console.log('\n' + sep)
  console.log('  FILES PRODUCED')
  console.log(sep)
  const goalDir = path.join(process.env.BLOPUS_DIR!, 'goals', goal.id)
  for (const f of fs.readdirSync(goalDir)) {
    const size = fs.statSync(path.join(goalDir, f)).size
    console.log(`\n${f} — ${size} bytes`)
    if (f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.tex')) {
      const content = fs.readFileSync(path.join(goalDir, f), 'utf-8')
      console.log(content.split('\n').slice(0, 10).map(l => '  ' + l).join('\n'))
    }
  }

  console.log('\n' + sep)
  console.log('  DONE')
  console.log(sep + '\n')
}

main().catch(err => {
  console.error('\nTest crashed:', err.message)
  process.exit(1)
})
