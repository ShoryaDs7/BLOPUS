/**
 * Test: user hands over the Riemann Hypothesis research Claude already produced
 * and says "continue my work for 3 more days."
 */

import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config({ path: path.join(process.cwd(), '.env') })

const creatorsDir = path.join(process.cwd(), 'creators')
const creators = fs.readdirSync(creatorsDir).filter(d =>
  fs.statSync(path.join(creatorsDir, d)).isDirectory()
)
if (!creators.length) { console.error('No creator found in creators/'); process.exit(1) }
dotenv.config({ path: path.join(creatorsDir, creators[0], '.env') })

import { GoalStore } from '../adapters/control/GoalStore'
import { runGoal } from '../agent/GoalRunner'

const RIEMANN_GOAL_DIR = path.join(process.cwd(), 'goals', 'goal_1777396609611')

async function main() {
  // Grab the files Claude produced during the Riemann research
  const existingFiles = fs.readdirSync(RIEMANN_GOAL_DIR)
    .filter(f => f !== 'state.json' && f !== 'done_today.txt')
    .map(f => ({ name: f, content: fs.readFileSync(path.join(RIEMANN_GOAL_DIR, f), 'utf-8') }))

  console.log(`[test] Handing over ${existingFiles.length} research files from previous Riemann session:`)
  existingFiles.forEach(f => console.log(`  - ${f.name} (${f.content.length} chars)`))

  // Create a new goal — continuing from exactly where the old one left off
  const goal = GoalStore.create({
    goal: 'Prove the Riemann Hypothesis. Each day make real mathematical progress — read what was done before, continue from it, produce actual working notes. Do not restate the problem. Do actual work.',
    current_focus: 'Pursue the Connes L^2(A_Q/Q*) adelic route — examine whether Frobenius action can be shown to have real spectrum via operator-theoretic methods, and attempt Lichtenbaum Weil-etale cohomology for Spec(Z).',
    timeout_minutes: 15,
    notify_chat_id: process.env.TELEGRAM_OWNER_CHAT_ID ?? '',
  })

  const dir = GoalStore.goalDir(goal.id)

  // Copy all prior research files into the new goal folder
  for (const f of existingFiles) {
    fs.writeFileSync(path.join(dir, f.name), f.content)
  }

  // Set state to reflect the prior work already done
  GoalStore.update(goal.id, {
    done: [
      '2026-04-28: Produced a comprehensive technical survey of all major RH approaches — spectral/Hilbert-Pólya, Berry-Keating H=xp, Connes NCG, Weil/Deligne, zero-density estimates, De Bruijn-Newman, Li criterion.',
      '2026-04-28: Attempted spectral construction and scattering approach — see day2_spectral_construction.txt and day2_scattering_attempt.txt.',
      '2026-04-28: Constructed Lax-Phillips extended Hilbert space, tested explicit-formula contradiction route — see day3_lax_phillips_krein.txt.',
      '2026-04-28: Wrote Weil distribution as quadratic form, analyzed positivity conditions — see day3_weil_quadratic_form.txt.',
      '2026-04-28: Proved Fredholm det of B cannot equal 1/zeta directly, closed GCD positivity route, identified Connes L^2(A_Q/Q*) as only viable adelic route — see day4_arakelov_deninger.txt.',
      '2026-04-28: Deep GCD matrix spectral theory and Weil-etale cohomology for Spec(Z) — see day5_gcd_matrix_weil_etale.txt.',
      '2026-04-28: GCD Fredholm adelic approach — Fredholm det regularization fails, self-referential Gram matrix found — see day6_fredholm_adelic.txt.',
    ],
    files: existingFiles.map(f => path.join(dir, f.name)),
  })

  console.log(`\n[test] Goal: ${goal.id}`)
  console.log(`[test] Folder: ${dir}`)

  for (let day = 1; day <= 3; day++) {
    console.log(`\n── Day ${day} ──`)
    await runGoal(GoalStore.load(goal.id)!)
    const s = GoalStore.load(goal.id)!
    console.log(`Done:  ${s.done.at(-1)}`)
    console.log(`Next:  ${s.current_focus}`)
  }

  console.log(`\nFolder: ${fs.readdirSync(dir).join(', ')}`)
}

main().catch(err => { console.error(err); process.exit(1) })
