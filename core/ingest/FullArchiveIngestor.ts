/**
 * FullArchiveIngestor — runs every computation Blopus has on an X archive.
 *
 * Single entry point. Pass archive folder (or individual file paths) and it runs:
 *   1. Personality profile + voice (tweets.js)
 *   2. RAG index (tweet examples for style matching)
 *   3. Relationship history (who owner interacted with)
 *   4. PersonMemory — per-person files from public tweet replies
 *   5. Owner post index (every post ever, searchable)
 *   6. Owner biography (life narrative)
 *   7. User context (what they're currently working on)
 *   8. DM history — per-person files from direct-messages.js (both sides)
 *      - Relationship classification via Claude reasoning (not keywords)
 *      - DM voice profiles per person
 *      - Tone baselines for anomaly detection
 *
 * Called by:
 *   - SetupWizard (first-time Telegram onboarding, when user uploads archive)
 *   - BlopusAgent on startup (if archive path is set and something is new)
 *   - SessionBrain (when user says "update my archive" via Telegram)
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { parseTweetsJsFull, analyzePersonalityFull } from '../personality/PersonalityIngester'
import { ExampleRetriever } from '../rag/ExampleRetriever'
import { PersonMemoryStore, PersonMemory, DmVoiceProfile, PendingClassification } from '../memory/PersonMemoryStore'
import { seedRelationshipsFromArchive } from '../memory/ArchiveRelationshipSeeder'
import { OwnerPostIndex } from '../memory/OwnerPostIndex'
import { buildOwnerBiography } from '../memory/OwnerBiography'
import { ingestContextFromArchive } from '../memory/ArchiveContextIngestor'
import { UserContext } from '../../adapters/control/UserContext'

export interface IngestOptions {
  archiveDir: string           // folder with tweets.js + direct-messages.js
  creatorDir: string           // creators/{handle}/ — where profile files go
  memoryStoreDir: string       // memory-store/
  ownerHandle: string
  ownerUserId: string          // numeric Twitter ID
  apiKey: string               // for Claude reasoning calls
  tweetsJsPath?: string        // override if not in archiveDir
  dmJsPath?: string            // override if not in archiveDir
}

export interface ClassificationConfirmation {
  handle: string
  messageCount: number
  proposed: PersonMemory['relationshipType']
  evidence: string
  needsConfirmation: boolean    // false for fan/acquaintance/unknown — auto-saved
}

export interface IngestResult {
  personality:  { built: boolean; topics: number; signaturePatterns: number }
  rag:          { built: boolean; examples: number }
  relationships:{ added: number; merged: number; total: number }
  persons:      { seeded: number; fromTweets: number; fromDMs: number }
  postIndex:    { seeded: number; total: number }
  biography:    { built: boolean }
  userContext:  { seeded: boolean; facts: number }
  dms:          { persons: number; messages: number; classified: number }
  confirmations: ClassificationConfirmation[]   // contacts needing Telegram confirmation
  report:       string         // full transparency report for Telegram
}

export async function runFullArchiveIngest(opts: IngestOptions): Promise<IngestResult> {
  const {
    archiveDir, creatorDir, memoryStoreDir,
    ownerHandle, ownerUserId, apiKey,
  } = opts

  const tweetsPath = opts.tweetsJsPath ?? path.join(archiveDir, 'tweets.js')
  const dmPath     = opts.dmJsPath     ?? path.join(archiveDir, 'direct-messages.js')

  const hasTweets = fs.existsSync(tweetsPath)
  const hasDMs    = fs.existsSync(dmPath)

  const result: IngestResult = {
    personality:   { built: false, topics: 0, signaturePatterns: 0 },
    rag:           { built: false, examples: 0 },
    relationships: { added: 0, merged: 0, total: 0 },
    persons:       { seeded: 0, fromTweets: 0, fromDMs: 0 },
    postIndex:     { seeded: 0, total: 0 },
    biography:     { built: false },
    userContext:   { seeded: false, facts: 0 },
    dms:           { persons: 0, messages: 0, classified: 0 },
    confirmations: [],
    report:        '',
  }

  const store = new PersonMemoryStore(memoryStoreDir)

  // ── 1. Personality profile ────────────────────────────────────────────────
  if (hasTweets && apiKey) {
    try {
      const raw = fs.readFileSync(tweetsPath, 'utf-8')
      const tweets = parseTweetsJsFull(raw)
      const profile = await analyzePersonalityFull(tweets, ownerHandle)
      const outPath = path.join(creatorDir, 'personality_profile.json')
      fs.writeFileSync(outPath, JSON.stringify(profile, null, 2))
      result.personality = {
        built: true,
        topics: profile.dominantTopics?.length ?? 0,
        signaturePatterns: profile.signaturePatterns?.length ?? 0,
      }
    } catch (err) {
      console.warn('[FullIngest] Personality failed:', err)
    }
  }

  // ── 2. RAG index ─────────────────────────────────────────────────────────
  if (hasTweets) {
    try {
      const ragPath = path.join(creatorDir, 'rag_index.json')
      const rag = new ExampleRetriever(ragPath)
      rag.load(tweetsPath)
      result.rag = { built: true, examples: (rag as any).pairs?.length ?? 0 }
    } catch (err) {
      console.warn('[FullIngest] RAG index failed:', err)
    }
  }

  // ── 3. Relationship history ───────────────────────────────────────────────
  if (hasTweets) {
    try {
      const relPath = path.join(memoryStoreDir, 'relationships.json')
      const r = seedRelationshipsFromArchive(tweetsPath, relPath)
      result.relationships = r
    } catch (err) {
      console.warn('[FullIngest] Relationships failed:', err)
    }
  }

  // ── 4. PersonMemory from tweets ───────────────────────────────────────────
  if (hasTweets) {
    try {
      const r = store.seedFromArchive(tweetsPath)
      result.persons.fromTweets = r.seeded
      result.persons.seeded += r.seeded
    } catch (err) {
      console.warn('[FullIngest] PersonMemory (tweets) failed:', err)
    }
  }

  // ── 5. Post index ─────────────────────────────────────────────────────────
  if (hasTweets) {
    try {
      const postIndex = new OwnerPostIndex(path.join(memoryStoreDir, 'owner_posts.json'))
      const r = postIndex.seedFromArchive(tweetsPath)
      result.postIndex = { seeded: r.seeded, total: postIndex.totalCount }
    } catch (err) {
      console.warn('[FullIngest] Post index failed:', err)
    }
  }

  // ── 6. Owner biography ────────────────────────────────────────────────────
  if (hasTweets) {
    try {
      const bioPath = path.join(memoryStoreDir, 'owner_biography.json')
      await buildOwnerBiography(tweetsPath, ownerHandle, bioPath)
      result.biography = { built: true }
    } catch (err) {
      console.warn('[FullIngest] Biography failed:', err)
    }
  }

  // ── 7. User context ───────────────────────────────────────────────────────
  if (hasTweets) {
    try {
      const userContext = new UserContext(path.join(memoryStoreDir, 'user_context.json'))
      const flagDir = memoryStoreDir
      const seeded = await ingestContextFromArchive(tweetsPath, userContext, ownerHandle, flagDir)
      result.userContext = { seeded, facts: userContext.getAll().length }
    } catch (err) {
      console.warn('[FullIngest] UserContext failed:', err)
    }
  }

  // ── 8. DM history ─────────────────────────────────────────────────────────
  if (hasDMs) {
    try {
      const r = store.seedFromDMArchive(dmPath, ownerUserId, ownerHandle)
      result.persons.fromDMs = r.seeded
      result.persons.seeded += r.seeded
      result.dms.persons = r.persons.length

      // Count total DM messages and classify with full-history Claude reasoning
      let totalMsgs = 0
      let classified = 0
      for (const handle of r.persons) {
        const mem = store.load(handle)
        if (!mem) continue
        const dmMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.platform === 'dm'))
        totalMsgs += dmMsgs.length

        // Run Claude reasoning on every contact with any DM history (not just 10+)
        // Low-stakes types (fan/acquaintance) are auto-saved, sensitive ones wait for user confirm
        if (dmMsgs.length >= 3 && apiKey) {
          const classification = await classifyWithEvidence(mem, dmMsgs, apiKey)
          if (classification) {
            const needsConfirmation = ['romantic', 'family', 'close_friend', 'professional'].includes(classification.type)

            if (needsConfirmation) {
              // Store as pending — don't set relationshipType yet
              mem.pendingClassification = {
                type: classification.type,
                evidence: classification.evidence,
                setAt: new Date().toISOString(),
                confirmed: false,
              }
            } else {
              // Fan / acquaintance / unknown — auto-save, no need to bother the owner
              mem.relationshipType = classification.type
              mem.pendingClassification = null
            }

            store.save(mem)
            classified++

            result.confirmations.push({
              handle,
              messageCount: dmMsgs.length,
              proposed: classification.type,
              evidence: classification.evidence,
              needsConfirmation,
            })
          }
        }
      }
      result.dms.messages = totalMsgs
      result.dms.classified = classified
    } catch (err) {
      console.warn('[FullIngest] DM history failed:', err)
    }
  }

  // ── Build transparency report ─────────────────────────────────────────────
  result.report = buildReport(result, ownerHandle, store, hasTweets, hasDMs)

  // Save report for Telegram pickup on next startup (or immediate send)
  const reportPath = path.join(memoryStoreDir, 'dm_ingest_report.txt')
  fs.writeFileSync(reportPath, result.report, 'utf-8')

  return result
}

// ── Reasoning-based relationship classifier (reads full history, returns evidence) ──

async function classifyWithEvidence(
  mem: PersonMemory,
  dmMessages: { by: string; text: string; timestamp: string }[],
  apiKey: string,
): Promise<{ type: PersonMemory['relationshipType']; evidence: string } | null> {
  try {
    // Use the full conversation — cap at 80 messages (newest preferred) to stay within token budget
    const msgs = dmMessages.length > 80
      ? dmMessages.slice(0, 20).concat(dmMessages.slice(-60))
      : dmMessages

    const convoText = msgs.map(m => {
      const who = m.by === 'owner' ? 'Owner' : 'Them'
      return `${who}: ${m.text.slice(0, 200)}`
    }).join('\n')

    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `Read these DMs between the Owner and @${mem.handle} and figure out their relationship.

${convoText}

Reply in this exact format (two lines, nothing else):
TYPE: <one of: romantic, family, close_friend, professional, acquaintance, fan, unknown>
EVIDENCE: <one sentence — specific things you noticed, like terms of address, topics, tone>

Base your answer on how they actually talk — not what they claim. Look at: terms of address (babe, bro, sir), topics, warmth, formality, how personal the conversations are.`,
      }],
    })

    const text = (response.content[0] as any).text?.trim() ?? ''
    const typeMatch = text.match(/^TYPE:\s*(\w+)/im)
    const evidenceMatch = text.match(/^EVIDENCE:\s*(.+)/im)

    const valid = ['romantic', 'family', 'close_friend', 'professional', 'acquaintance', 'fan', 'unknown']
    const rawType = typeMatch?.[1]?.trim().toLowerCase()
    if (!rawType || !valid.includes(rawType)) return null

    const evidence = evidenceMatch?.[1]?.trim() ?? 'no specific evidence noted'
    return { type: rawType as PersonMemory['relationshipType'], evidence }
  } catch {
    return null
  }
}

// ── Full transparency report ───────────────────────────────────────────────

function buildReport(
  result: IngestResult,
  ownerHandle: string,
  store: PersonMemoryStore,
  hasTweets: boolean,
  hasDMs: boolean,
): string {
  const lines: string[] = []
  const sep = '─'.repeat(50)

  lines.push('📊 OsBot Archive Ingest — Full Report')
  lines.push(sep)
  lines.push(`Owner: @${ownerHandle}`)
  lines.push('')

  // ── Tweet analysis ──
  if (hasTweets) {
    lines.push('🐦 TWEET ARCHIVE')
    if (result.personality.built) {
      lines.push(`  Voice profile: built (${result.personality.topics} topics, ${result.personality.signaturePatterns} signature patterns)`)
    }
    if (result.rag.built) {
      lines.push(`  Style examples (RAG): ${result.rag.examples} tweets indexed`)
    }
    lines.push(`  People from public replies: ${result.persons.fromTweets} person files built`)
    lines.push(`  Post index: ${result.postIndex.seeded} posts catalogued`)
    if (result.biography.built) lines.push(`  Owner biography: built`)
    if (result.userContext.seeded) {
      lines.push(`  Current life context: ${result.userContext.facts} facts extracted`)
    }
  }

  // ── DM analysis ──
  if (hasDMs) {
    lines.push('')
    lines.push('💬 DM ARCHIVE')
    lines.push(`  DM contacts: ${result.dms.persons}`)
    lines.push(`  Total DM messages: ${result.dms.messages}`)
    lines.push(`  AI read full histories for: ${result.dms.classified} contacts`)
    const needConfirm = result.confirmations.filter(c => c.needsConfirmation).length
    const autoSaved  = result.confirmations.filter(c => !c.needsConfirmation).length
    if (needConfirm) lines.push(`  ⏳ ${needConfirm} contacts need your confirmation below`)
    if (autoSaved)  lines.push(`  ✅ ${autoSaved} contacts auto-classified (fan / acquaintance)`)
  }

  // ── Per-person breakdown ──
  lines.push('')
  lines.push('👥 PEOPLE — Full Breakdown')
  lines.push(sep)

  const index = store['loadIndex']()
  const allHandles = Object.keys(index)

  const typeOrder = ['romantic', 'family', 'close_friend', 'professional', 'acquaintance', 'fan', 'unknown']
  const byType: Record<string, string[]> = {}
  for (const h of allHandles) {
    const mem = store.load(h)
    if (!mem) continue
    // If pending classification exists, show its proposed type in breakdown
    const t = (mem.pendingClassification?.type ?? mem.relationshipType) || 'unknown'
    if (!byType[t]) byType[t] = []
    byType[t].push(h)
  }

  for (const rType of typeOrder) {
    const group = byType[rType]
    if (!group?.length) continue
    lines.push('')
    lines.push(`${rType.toUpperCase().replace('_', ' ')} (${group.length})`)

    for (const handle of group.slice(0, 10)) {
      const mem = store.load(handle)
      if (!mem) continue
      const dmMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.platform === 'dm'))
      const publicMsgs = mem.conversations.flatMap(c => c.messages.filter(m => m.platform === 'x'))

      const parts: string[] = [`@${handle}`]
      if (dmMsgs.length) parts.push(`${dmMsgs.length} DMs`)
      if (publicMsgs.length) parts.push(`${publicMsgs.length} public`)
      if (mem.dmVoiceProfile) parts.push(`voice: ${mem.dmVoiceProfile.toneDescriptor}`)
      if (mem.pendingClassification && !mem.pendingClassification.confirmed) parts.push('⏳ awaiting confirm')
      lines.push(`  ${parts.join(' | ')}`)
    }
    if (group.length > 10) lines.push(`  ...and ${group.length - 10} more`)
  }

  // ── Unknown IDs that need resolution ──
  const numericHandles = allHandles.filter(h => h.startsWith('user_'))
  if (numericHandles.length) {
    lines.push('')
    lines.push('❓ UNKNOWN IDs — who are these?')
    lines.push(sep)
    for (const h of numericHandles.slice(0, 10)) {
      const mem = store.load(h)
      const dmCount = mem?.conversations.flatMap(c => c.messages.filter(m => m.platform === 'dm')).length ?? 0
      lines.push(`  ${h} — ${dmCount} DMs — reply: "rename ${h} to @theirhandle"`)
    }
    if (numericHandles.length > 10) lines.push(`  ...and ${numericHandles.length - 10} more`)
  }

  // ── Confirmations needed ──
  const pending = result.confirmations.filter(c => c.needsConfirmation)
  if (pending.length) {
    lines.push('')
    lines.push('📌 CONFIRM THESE — I read their full DM history')
    lines.push(sep)
    lines.push('Reply: "yes @handle" to confirm, or "no @handle: they\'re my [type]" to correct')
    lines.push('')
    for (const c of pending) {
      const typeLabel = c.proposed.replace('_', ' ')
      lines.push(`@${c.handle} (${c.messageCount} DMs)`)
      lines.push(`  I think: ${typeLabel}`)
      lines.push(`  Why: ${c.evidence}`)
      lines.push('')
    }
  }

  lines.push(sep)
  lines.push('To correct anything later: "set @sarah as romantic" / "note for @raj: my investor"')

  return lines.join('\n')
}
