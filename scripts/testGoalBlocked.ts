/**
 * testGoalBlocked.ts — tests blocked status + auto-pause logic. No LLM calls.
 * Writes done_today.txt directly, calls applyGoalResult, checks state.
 * Run: npx tsx scripts/testGoalBlocked.ts
 */

import path from 'path'
import fs from 'fs'

process.env.BLOPUS_DIR = path.resolve('.')

import { GoalStore } from '../adapters/control/GoalStore'
import { applyGoalResult } from '../agent/GoalRunner'

let passed = 0
let failed = 0

function check(label: string, actual: any, expected: any) {
  const ok = actual === expected
  console.log(`  ${ok ? '✅' : '❌'} ${label}: got "${actual}" ${ok ? '' : `— expected "${expected}"`}`)
  ok ? passed++ : failed++
}

function writeResult(goalId: string, line1: string, line2: string, line3: string, line4 = 'none') {
  const dir = GoalStore.goalDir(goalId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'done_today.txt'), [line1, line2, line3, line4].join('\n'))
}

const sep = '─'.repeat(60)

async function main() {
  console.log('\n' + sep)
  console.log('  GoalRunner — blocked status unit tests (no LLM)')
  console.log(sep + '\n')

  // ── Case 1: blocker written → goal pauses ───────────────────────────────────
  console.log('Case 1: Claude writes a blocker → goal must pause\n')
  const g1 = GoalStore.create({ goal: 'Test goal A', current_focus: 'start', notify_chat_id: '' })
  writeResult(g1.id, 'Tried to get Stripe revenue but no API key found', 'Get Stripe key from owner', 'Need STRIPE_SECRET_KEY — not in .env, cannot proceed without it')
  const r1 = await applyGoalResult(GoalStore.load(g1.id)!)
  const s1 = GoalStore.load(g1.id)!
  check('status=active',    s1.status,           'active')
  check('return=active',    r1,                  'active')
  check('blocker recorded', s1.blockers.length > 0 ? 'yes' : 'no', 'yes')
  check('done entry added', s1.done.length,       1)

  // ── Case 2: no blocker → goal stays active ──────────────────────────────────
  console.log('\nCase 2: Claude solves it → goal stays active\n')
  const g2 = GoalStore.create({ goal: 'Test goal B', current_focus: 'research', notify_chat_id: '' })
  writeResult(g2.id, 'Researched top 3 AI tools and wrote comparison file', 'Write tweet about findings', 'none')
  const r2 = await applyGoalResult(GoalStore.load(g2.id)!)
  const s2 = GoalStore.load(g2.id)!
  check('status=active',    s2.status,           'active')
  check('return=active',    r2,                  'active')
  check('no blocker',       s2.blockers.length,   0)
  check('done entry added', s2.done.length,        1)

  // ── Case 3: completed → goal marks done ─────────────────────────────────────
  console.log('\nCase 3: Claude writes "Completed" → goal marks complete\n')
  const g3 = GoalStore.create({ goal: 'Test goal C', current_focus: 'finish', notify_chat_id: '' })
  writeResult(g3.id, 'Completed — all 10 leads researched and outreach drafted', 'none', 'none')
  const r3 = await applyGoalResult(GoalStore.load(g3.id)!)
  const s3 = GoalStore.load(g3.id)!
  check('status=completed', s3.status,           'completed')
  check('return=completed', r3,                  'completed')

  // ── Case 4: paused goal does not fire in GoalRunner tick ────────────────────
  console.log('\nCase 4: paused goal excluded from active list\n')
  const active = GoalStore.listActive()
  const blockedGoal = active.find(g => g.id === g1.id)
  check('blocked goal still active', blockedGoal ? 'found' : 'not found', 'found')

  // ── Case 5: "none" on line 3 is not treated as a blocker ───────────────────
  console.log('\nCase 5: line 3 = "none" → no false blocker\n')
  const g5 = GoalStore.create({ goal: 'Test goal E', current_focus: 'work', notify_chat_id: '' })
  writeResult(g5.id, 'Did some research and made progress', 'Continue tomorrow', 'none')
  await applyGoalResult(GoalStore.load(g5.id)!)
  const s5 = GoalStore.load(g5.id)!
  check('none not a blocker', s5.blockers.length, 0)
  check('status=active',      s5.status,          'active')

  // ── Cleanup — delete all goal folders created by this test ──────────────────
  for (const g of [g1, g2, g3, g5]) {
    try { fs.rmSync(GoalStore.goalDir(g.id), { recursive: true, force: true }) } catch {}
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + sep)
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)
  if (failed === 0) {
    console.log('✅ Blocked status logic is correct.')
  } else {
    console.error('❌ Fix GoalRunner before launch.')
    process.exit(1)
  }
  console.log(sep + '\n')
}

main().catch(err => {
  console.error('Test crashed:', err.message)
  process.exit(1)
})
