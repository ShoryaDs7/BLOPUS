/**
 * ingestDMs.ts
 *
 * Parses your X DM archive (direct-messages.js) and seeds PersonMemoryStore
 * with full both-sides DM history. Merges into existing person files —
 * same handle = same file, so DMs and public comments are unified automatically.
 *
 * After ingestion, prints a full transparency report of everything computed —
 * relationship types, tone baselines, voice profiles — so you can verify
 * or correct anything before OsBot starts replying.
 *
 * Usage:
 *   npx ts-node scripts/ingestDMs.ts --dms path/to/direct-messages.js --owner-id YOUR_NUMERIC_USER_ID --owner-handle yourHandle
 *
 * How to get direct-messages.js:
 *   X → Settings → Your Account → Download an archive → extract → data/direct-messages.js
 *
 * How to find your numeric user ID:
 *   It's in account.js from the same archive: { "account": { "accountId": "..." } }
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { PersonMemoryStore, PersonMemory } from '../core/memory/PersonMemoryStore'

function humanTime(isoString: string): string {
  const d = new Date(isoString)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function buildTransparencyReport(store: PersonMemoryStore, persons: string[]): string {
  const lines: string[] = []
  lines.push('═'.repeat(60))
  lines.push('  OsBot DM Archive — Full Transparency Report')
  lines.push('═'.repeat(60))
  lines.push(`  Persons processed: ${persons.length}`)
  lines.push('')

  // Group by relationship type
  const byType: Record<string, PersonMemory[]> = {}
  for (const handle of persons) {
    const mem = store.load(handle)
    if (!mem) continue
    const rType = mem.relationshipType
    if (!byType[rType]) byType[rType] = []
    byType[rType].push(mem)
  }

  const typeOrder = ['romantic', 'family', 'close_friend', 'professional', 'acquaintance', 'fan', 'unknown']

  for (const rType of typeOrder) {
    const group = byType[rType]
    if (!group?.length) continue

    lines.push(`── ${rType.toUpperCase().replace('_', ' ')} (${group.length}) ──`)

    for (const mem of group) {
      const dmMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.platform === 'dm'))
      const theirDmMsgs = dmMsgs.filter(m => m.by === 'them')
      const ownerDmMsgs = dmMsgs.filter(m => m.by === 'owner')
      const dmSessions = mem.conversations.filter(c => c.messages.some(m => m.platform === 'dm'))
      const publicConvs = mem.conversations.filter(c => c.messages.some(m => m.platform === 'x'))

      lines.push(``)
      lines.push(`  @${mem.handle}`)
      lines.push(`    First contact:    ${humanTime(mem.firstSeenAt)}`)
      lines.push(`    Last contact:     ${humanTime(mem.lastSeenAt)}`)
      lines.push(`    DM messages:      ${dmMsgs.length} total (${ownerDmMsgs.length} yours, ${theirDmMsgs.length} theirs)`)
      lines.push(`    DM sessions:      ${dmSessions.length}`)
      if (publicConvs.length > 0) {
        lines.push(`    Public convos:    ${publicConvs.length} (merged from comment history)`)
      }
      lines.push(`    Topics:           ${mem.dominantTopics.join(', ') || 'none detected'}`)

      if (mem.dmVoiceProfile) {
        const v = mem.dmVoiceProfile
        lines.push(`    Your DM voice:    ${v.toneDescriptor} | ${v.formalityLevel} | replies: ${v.typicalReplyLength}`)
        if (v.endearments.length) lines.push(`    You call them:    ${v.endearments.join(', ')}`)
        lines.push(`    Source:           ${v.derivedFrom}`)
      } else {
        lines.push(`    Your DM voice:    not enough data (< 2 messages from you)`)
      }

      if (mem.toneBaseline) {
        const b = mem.toneBaseline
        lines.push(`    Their baseline:   avg ${b.avgMessageLengthChars} chars/msg | ${b.emojiFrequency} emoji/msg | warmth: ${b.warmthScore}`)
      }

      if (mem.theirPersonality !== 'unknown') {
        lines.push(`    Their personality: ${mem.theirPersonality}`)
      }
    }
    lines.push('')
  }

  lines.push('═'.repeat(60))
  lines.push('  Flags to review:')
  lines.push('═'.repeat(60))

  let flagCount = 0
  for (const handle of persons) {
    const mem = store.load(handle)
    if (!mem) continue

    // Flag romantic/family classifications for confirmation
    if (mem.relationshipType === 'romantic' || mem.relationshipType === 'family') {
      lines.push(`  ⚠️  @${mem.handle} classified as "${mem.relationshipType}" — is this correct?`)
      flagCount++
    }

    // Flag unknown handles (userId only, no real handle resolved yet)
    if (handle.startsWith('user_')) {
      lines.push(`  ⚠️  ${handle} — numeric ID only, handle not resolved. Who is this?`)
      flagCount++
    }
  }

  if (flagCount === 0) lines.push('  None — everything looks clean.')
  lines.push('')
  lines.push('  To correct anything: tell OsBot via Telegram.')
  lines.push('  Example: "set @sarah as romantic" or "add note for @alex: my investor, keep formal"')
  lines.push('═'.repeat(60))

  return lines.join('\n')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dmsFlag     = args.indexOf('--dms')
  const ownerIdFlag = args.indexOf('--owner-id')
  const ownerHFlag  = args.indexOf('--owner-handle')

  if (dmsFlag === -1 || ownerIdFlag === -1 || ownerHFlag === -1) {
    console.error('Usage: npx ts-node scripts/ingestDMs.ts --dms path/to/direct-messages.js --owner-id NUMERIC_ID --owner-handle yourHandle')
    process.exit(1)
  }

  const dmsPath     = args[dmsFlag + 1]
  const ownerUserId = args[ownerIdFlag + 1]
  const ownerHandle = args[ownerHFlag + 1]

  if (!fs.existsSync(dmsPath)) {
    console.error(`File not found: ${dmsPath}`)
    process.exit(1)
  }

  const store = new PersonMemoryStore(path.resolve('./memory-store'))

  console.log(`\nParsing DMs from: ${dmsPath}`)
  console.log(`Owner: @${ownerHandle} (ID: ${ownerUserId})\n`)

  const { seeded, skipped, persons } = store.seedFromDMArchive(dmsPath, ownerUserId, ownerHandle)

  console.log(`\nSeeded: ${seeded} | Skipped: ${skipped}\n`)

  if (persons.length > 0) {
    const report = buildTransparencyReport(store, persons)
    console.log(report)

    // Save report to file so SessionBrain can send it to Telegram on next startup
    const reportPath = path.resolve('./memory-store/dm_ingest_report.txt')
    fs.writeFileSync(reportPath, report, 'utf-8')
    console.log(`\nReport saved to: ${reportPath}`)
    console.log('OsBot will send this to Telegram next time it starts.')
  }
}

main().catch(console.error)
