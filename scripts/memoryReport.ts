/**
 * memoryReport.ts
 *
 * Prints a summary of the current memory store: mood, monthly usage,
 * pending replies, recent interactions.
 *
 * Usage:
 *   npx ts-node scripts/memoryReport.ts
 */

import 'dotenv/config'
import path from 'path'
import { MemoryEngine } from '../core/memory/MemoryEngine'

function main(): void {
  const memPath = process.env.BLOPUS_MEMORY_PATH ?? './memory-store/memory.json'
  const memory = new MemoryEngine(path.resolve(memPath))

  const mood = memory.getMood()
  const monthly = memory.getMonthlyUsage()
  const daily = memory.getDailyUsage()
  const pending = memory.getPendingReplies()
  const sinceId = memory.getLastSinceId()

  console.log('\n=== OsBot Memory Report ===')
  console.log(`Mood:          ${mood}`)
  console.log(`Monthly usage: ${monthly}`)
  console.log(`Daily usage:   ${daily}`)
  console.log(`sinceId:       ${sinceId ?? 'none (first run)'}`)
  console.log(`Pending replies (unsent): ${pending.length}`)
  if (pending.length > 0) {
    pending.forEach(p => {
      console.log(`  - ${p.id}: due at ${p.fireAt} → "${p.replyText.slice(0, 60)}..."`)
    })
  }
  console.log('===========================\n')
}

main()
