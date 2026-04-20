#!/usr/bin/env npx tsx
/**
 * DM Interview — standalone script.
 *
 * Run: npx tsx scripts/dm-interview.ts
 *
 * Steps:
 *   1. Parse direct-messages.js — show sample messages per userId, owner identifies each person
 *   2. Allow/deny per contact — owner says yes/no
 *   3. Per-person interview — LLM asks questions based on ACTUAL DM history
 *   4. Golden examples — LLM picks real DM lines, owner types reply as they would
 *   5. Validation — LLM plays the contact for 5 back-and-forths, owner judges
 *   6. Save — writes dmVoiceProfile + overallTone + handle to each person's JSON in memory-store
 */

import readline from 'readline'
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { config as dotenvConfig } from 'dotenv'
import { PersonMemoryStore, PersonMemory, DmVoiceProfile, Message } from '../core/memory/PersonMemoryStore'

dotenvConfig({ path: path.join(process.cwd(), '.env') })

// ── Config ────────────────────────────────────────────────────────────────────

const DM_ARCHIVE_PATH = process.env.DM_ARCHIVE_PATH
  ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'Downloads', 'data', 'direct-messages.js')

function findConfigPath(): string {
  if (process.env.OSBOT_CONFIG_PATH && fs.existsSync(process.env.OSBOT_CONFIG_PATH)) return process.env.OSBOT_CONFIG_PATH
  const creatorsDir = path.join(process.cwd(), 'creators')
  const candidates = ['blopus.config.json', 'config.json']
  const dirs = fs.readdirSync(creatorsDir).filter(d =>
    !d.startsWith('.') && d !== 'memory-store' && d !== 'template' &&
    fs.statSync(path.join(creatorsDir, d)).isDirectory()
  )
  for (const dir of dirs) {
    for (const file of candidates) {
      const full = path.join(creatorsDir, dir, file)
      if (fs.existsSync(full)) return full
    }
  }
  throw new Error(`No config found in creators/. Set OSBOT_CONFIG_PATH in .env`)
}
const CONFIG_PATH = findConfigPath()

const configDir = path.dirname(CONFIG_PATH)
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
const OWNER_HANDLE: string = config.ownerHandle ?? config.handle ?? config.owner?.handle ?? 'owner'
const MEMORY_STORE_DIR = path.join(configDir, '..', 'memory-store')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

if (!ANTHROPIC_API_KEY) {
  console.error('\n  ERROR: ANTHROPIC_API_KEY not set in .env\n')
  process.exit(1)
}

// Auto-detect owner userId from archive (they appear in every conversationId)
function detectOwnerUserId(): string {
  if (process.env.OWNER_USER_ID) return process.env.OWNER_USER_ID
  if (config.ownerUserId) return config.ownerUserId
  if (config.userId) return config.userId
  if (!fs.existsSync(DM_ARCHIVE_PATH)) return ''
  try {
    const raw = fs.readFileSync(DM_ARCHIVE_PATH, 'utf-8')
      .replace(/^window\.YTD\.direct_messages\.part0\s*=\s*/, '')
    const convs: any[] = JSON.parse(raw)
    const idCounts: Record<string, number> = {}
    for (const entry of convs) {
      const convId: string = entry.dmConversation?.conversationId ?? ''
      for (const part of convId.split('-')) {
        if (part) idCounts[part] = (idCounts[part] ?? 0) + 1
      }
    }
    const ownerEntry = Object.entries(idCounts).find(([, count]) => count === convs.length)
    return ownerEntry ? ownerEntry[0] : ''
  } catch { return '' }
}
const OWNER_USER_ID: string = detectOwnerUserId()

if (!OWNER_USER_ID) {
  console.error('\n  ERROR: Could not detect OWNER_USER_ID.')
  console.error('  Add ownerUserId to your config.json or set OWNER_USER_ID in .env\n')
  process.exit(1)
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
const store = new PersonMemoryStore(MEMORY_STORE_DIR, ANTHROPIC_API_KEY)

// ── Terminal helpers ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
}
function hr(ch = '─') { console.log(ch.repeat(66)) }
function section(title: string) { console.log(`\n${'═'.repeat(66)}\n  ${title}\n${'═'.repeat(66)}`) }

// ── Types ─────────────────────────────────────────────────────────────────────

interface DmContact {
  userId: string
  handle: string | null          // set after owner identifies
  name: string | null            // set after owner identifies
  relationship: string | null    // e.g. "girlfriend", "best friend"
  messages: { by: 'owner' | 'them'; text: string; timestamp: string }[]
  allowed: boolean | null        // set after allow/deny step
  voiceProfile: DmVoiceProfile | null
  overallTone: string | null
}

// ── Step 1: Parse archive ─────────────────────────────────────────────────────

function parseDmArchive(): DmContact[] {
  if (!fs.existsSync(DM_ARCHIVE_PATH)) {
    console.error(`\n  ERROR: DM archive not found at:\n  ${DM_ARCHIVE_PATH}\n`)
    console.error('  Set DM_ARCHIVE_PATH in .env to point to your direct-messages.js')
    process.exit(1)
  }

  const raw = fs.readFileSync(DM_ARCHIVE_PATH, 'utf-8')
    .replace(/^window\.YTD\.direct_messages\.part0\s*=\s*/, '')
    .replace(/^window\.YTD\.direct_messages_group\.part0\s*=\s*/, '')

  const conversations: any[] = JSON.parse(raw)
  const contacts: DmContact[] = []

  for (const entry of conversations) {
    const conv = entry.dmConversation
    if (!conv?.messages?.length) continue

    const convId: string = conv.conversationId ?? ''
    const parts = convId.split('-')
    if (parts.length !== 2) continue  // group DM — skip

    const otherUserId = parts.find((p: string) => p !== OWNER_USER_ID)
    if (!otherUserId) continue

    const rawMessages: any[] = conv.messages
      .map((m: any) => m.messageCreate)
      .filter(Boolean)
      .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    const messages = rawMessages
      .map(m => ({
        by: (m.senderId === OWNER_USER_ID ? 'owner' : 'them') as 'owner' | 'them',
        text: (m.text ?? '').trim(),
        timestamp: new Date(m.createdAt).toISOString(),
      }))
      .filter(m => m.text.length > 0)

    if (messages.length === 0) continue

    contacts.push({
      userId: otherUserId,
      handle: null,
      name: null,
      relationship: null,
      messages,
      allowed: null,
      voiceProfile: null,
      overallTone: null,
    })
  }

  return contacts
}

async function identifyContacts(contacts: DmContact[]): Promise<void> {
  section('STEP 1 — Identify your DM contacts')
  console.log('  Your DM archive has no names — only numeric user IDs.')
  console.log('  Read the messages below and tell us who each person is.\n')

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]
    hr()
    console.log(`\n  Contact ${i + 1} of ${contacts.length}  (userId: ${c.userId})`)
    console.log(`  ${c.messages.length} messages total\n`)

    // Most recent 8 — owner remembers recent convos, not ones from years ago
    const samples = c.messages.slice(-8)

    console.log('  Sample messages:')
    for (const m of samples) {
      const who = m.by === 'owner' ? '  [YOU]  ' : '  [THEM] '
      console.log(`${who} "${m.text.slice(0, 90)}"`)
    }

    console.log()
    const name = await ask('  Who is this? (first name or nickname, e.g. "Priya"): ')
    const rel  = await ask('  What is your relationship? (e.g. "girlfriend", "best friend", "dad", "investor"): ')
    const handle = await ask('  Their @handle on X (Enter to skip if you don\'t know): ')

    c.name = name || `Unknown_${c.userId.slice(-4)}`
    c.relationship = rel || 'unknown'
    c.handle = handle || `user_${c.userId}`
    console.log(`  ✓ Identified as ${c.name} (${c.relationship})`)
  }
}

// ── Step 2: Allow/deny ────────────────────────────────────────────────────────

async function allowDenyContacts(contacts: DmContact[]): Promise<void> {
  section('STEP 2 — Allow Blopus to reply in DMs')
  console.log('  For each contact, choose how Blopus should handle their DMs:\n')
  console.log('    auto    — Blopus replies automatically (good for casual friends)')
  console.log('    review  — Blopus drafts a reply, you approve before sending')
  console.log('    skip    — Blopus never touches this person\'s DMs\n')

  for (const c of contacts) {
    // No handle = no X account to DM — skip the question entirely
    if (!c.handle || c.handle.startsWith('user_')) {
      c.allowed = false
      console.log(`  ${c.name} (${c.relationship}) — skipped (no handle provided)`)
      continue
    }
    const ans = await ask(`  ${c.name} (${c.relationship}) — auto / review / skip? `)
    const normalized = ans.toLowerCase().trim()
    if (normalized === 'skip' || normalized === 's') {
      c.allowed = false
    } else {
      c.allowed = true
      // store permission in a note for now — will be wired into dmReplyPermission
      ;(c as any).dmReplyPermission = normalized === 'review' || normalized === 'r' ? 'review' : 'auto'
    }
    console.log(`  ✓ ${c.name}: ${c.allowed ? (c as any).dmReplyPermission : 'blocked'}`)
  }
}

// ── Step 3: Per-person interview ──────────────────────────────────────────────

async function runInterview(c: DmContact): Promise<Record<string, string>> {
  console.log(`\n  Interviewing for: ${c.name} (${c.relationship})`)
  console.log('  Haiku will ask you a few questions based on your actual DM history.\n')

  // Build message sample for Haiku — all messages from them, recent first
  const theirTexts = c.messages.filter(m => m.by === 'them').slice(-30).map(m => `"${m.text.replace(/"/g, "'")}"`)
  const ownerTexts = c.messages.filter(m => m.by === 'owner').slice(-30).map(m => `"${m.text.replace(/"/g, "'")}"`)

  // Ask Haiku to generate interview questions based on this specific history
  const qRes = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are building a DM voice profile for a social AI bot. The bot needs to reply to DMs AS the owner.

The owner's relationship with this person: ${c.relationship}
Their name: ${c.name}

Messages from THEM to the owner (what they send):
${theirTexts.join('\n')}

Messages from the OWNER to them (what you need to replicate):
${ownerTexts.join('\n')}

Generate between 2 and 6 interview questions to ask the owner directly (use "you", not "the owner") — fewer if the message history is short and patterns are clear, more if the history is long and complex. Focused ONLY on HOW they communicate with this person — not what they talk about.

You need to understand:
- How long or short are their replies typically? Do they match energy or stay brief?
- Do they use humor, sarcasm, nicknames, or terms of endearment with this person?
- How does the owner's writing style shift when they're busy, upset, or excited with this person specifically?
- What would feel WRONG if the bot said it — things the owner would never say to THIS person?

Do NOT ask about the specific topics or events in the messages — those are just examples, not the pattern.
Do NOT ask what they talk about. Ask HOW they talk.
Reference the messages only to ground your question in their actual style — not to ask about the content.
Format: numbered list only. No intro text. No explanations. Just the 4 questions.`
    }]
  })

  const questionsText = qRes.content[0].type === 'text' ? qRes.content[0].text.trim() : ''
  const questions = questionsText.split('\n').filter(l => /^\d+\./.test(l.trim())).slice(0, 6)

  // Fixed vulnerability questions — always asked for every user/relationship
  const fixedQuestions = [
    `What do you call people who get mentioned in conversation with ${c.name}? (e.g. do you say "didi" or "sister", "mummy" or "mom", "yaar" or "friend" — use the exact words you actually use)`,
    `How do you typically end a conversation with ${c.name}? Give the exact words or phrase — or do you just stop replying without saying anything?`,
    `When ${c.name} sends a long message with 4-5 different things, do you address everything or just 1-2 things and ignore the rest?`,
    `What phrases or words would sound completely WRONG coming from you to ${c.name}? (things that feel too formal, too casual, or just not you)`,
    `Do you use "aap", "tum", or "tu" with ${c.name}? And does that ever change?`,
    `Do you use emojis with ${c.name}? If yes, which ones and how often — if no, never?`,
  ]

  const answers: Record<string, string> = {}

  for (const q of questions) {
    console.log(`\n  ${q}`)
    let fullAnswer = await ask('  You: ')
    const thread = [{ q, a: fullAnswer }]

    // Haiku-driven follow-up loop — max 2 follow-ups per question to avoid rabbit holes
    let followUpCount = 0
    while (followUpCount < 2) {
      const judgeRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{
          role: 'user',
          content: `You are building a DM voice profile. You asked the owner this question:
"${q}"

Conversation so far:
${thread.map(t => `Q: ${t.q}\nA: ${t.a}`).join('\n')}

Relationship: ${c.relationship}, Name: ${c.name}
DM language: ${c.messages.slice(-3).map(m => m.text).join(' ')}

Is the answer clear enough to understand HOW the owner talks to this person?
- If YES or if we already have enough detail on this specific point: reply with just "clear"
- If NO and a follow-up on a DIFFERENT aspect would genuinely help: reply with ONE short follow-up question in the SAME LANGUAGE as the DMs above. Under 20 words. No preamble.
- Do NOT drill further into the same specific word or detail already answered.`
        }]
      })

      const judgment = judgeRes.content[0].type === 'text' ? judgeRes.content[0].text.trim() : 'clear'
      if (/^clear$/i.test(judgment)) break

      console.log(`\n  ${judgment}`)
      const followUp = await ask('  You: ')
      if (!followUp.trim() || /^(skip|done|enough|next)$/i.test(followUp.trim())) break

      thread.push({ q: judgment, a: followUp })
      fullAnswer = thread.map(t => t.a).join(' | ')
      followUpCount++
    }

    answers[q] = fullAnswer
  }

  // Run fixed vulnerability questions — no follow-up loop, just direct answers
  console.log('\n  A few more specific questions to avoid common mistakes:\n')
  for (const q of fixedQuestions) {
    console.log(`  ${q}`)
    const ans = await ask('  You: ')
    answers[`[fixed] ${q}`] = ans.trim() || '(skipped)'
    console.log()
  }

  return answers
}

// ── Step 4: Golden examples ───────────────────────────────────────────────────

async function collectGoldenExamples(c: DmContact): Promise<string[]> {
  console.log('\n  Now I\'ll pick 5 real messages from their side.')
  console.log('  You type back exactly how you\'d reply — in your real voice.\n')

  // Haiku picks 3 representative messages from them
  const theirTexts = c.messages.filter(m => m.by === 'them').map(m => m.text)
  const pickRes = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `From these messages sent to the owner by ${c.name} (${c.relationship}), pick 5 that are maximally diverse — mix of: long message, short message, emotional/warm message, practical/question message, casual message. No two should feel similar. Return ONLY the 5 messages as a JSON array of strings. No explanation.

Messages:
${theirTexts.map((t, i) => `${i + 1}. "${t.replace(/"/g, "'")}" `).join('\n')}

Return: ["message1", "message2", "message3", "message4", "message5"]`
    }]
  })

  let picked: string[] = []
  try {
    const raw = pickRes.content[0].type === 'text' ? pickRes.content[0].text.trim() : '[]'
    picked = JSON.parse(raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''))
  } catch {
    picked = theirTexts.slice(0, 5)
  }

  const goldenPairs: string[] = []

  for (let i = 0; i < Math.min(picked.length, 5); i++) {
    const msg = picked[i]
    console.log(`\n  [${c.name}]: "${msg}"`)
    const reply = await ask('  Your reply: ')
    if (reply.trim()) {
      goldenPairs.push(`[${c.name}]: "${msg}"\n[You]: "${reply.trim()}"`)
    }
  }

  return goldenPairs
}

// ── Step 5: Validation simulation ────────────────────────────────────────────

async function runValidation(
  c: DmContact,
  interviewAnswers: Record<string, string>,
  goldenExamples: string[],
): Promise<boolean> {
  console.log(`\n  Validation: Haiku will play ${c.name} AND generate your replies.`)
  console.log('  Just read each exchange and judge if YOUR side sounds like you.\n')

  const theirSample = c.messages.filter(m => m.by === 'them').slice(-10).map(m => `"${m.text}"`).join('\n')
  const ownerSample = c.messages.filter(m => m.by === 'owner').slice(-10).map(m => `"${m.text}"`).join('\n')
  const interviewSummary = Object.entries(interviewAnswers).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n')
  const goldenBlock = goldenExamples.join('\n\n')

  const contactPrompt = `You are ${c.name}. Relationship with owner: ${c.relationship}.
Real messages you send them (tone/style reference ONLY):
${theirSample}

CRITICAL: Invent a completely NEW topic that does NOT appear in the samples above. If samples mention study/padhai/exams/health — talk about something else entirely (e.g. family event, money, travel, news, random life update). The topic must be fresh. Match their tone and style, but different subject.
One short message. No asterisks or roleplay markers.`

  // Extract fixed vulnerability answers as hard rules
  const fixedRules = Object.entries(interviewAnswers)
    .filter(([k]) => k.startsWith('[fixed]'))
    .map(([k, v]) => `- ${k.replace('[fixed] ', '').split('?')[0].trim()}: ${v}`)
    .join('\n')

  const ownerPrompt = `You are replying to ${c.name} (${c.relationship}) in a DM.

How you actually talk to them — from interview:
${interviewSummary}

Real examples of how you reply to them:
${ownerSample}

${goldenBlock ? `Golden reply examples:\n${goldenBlock}` : ''}

${fixedRules ? `HARD RULES — never violate these, they come directly from the owner:\n${fixedRules}` : ''}

Reply as the owner would — same language, same length, same tone. One message only. No explanation.
IMPORTANT: Do NOT copy or paraphrase anything from the real examples above. Write a fresh reply to whatever the contact just said.`

  let currentOwnerPrompt = ownerPrompt

  async function runSim() {
    const convoHistory: { contact: string; owner: string }[] = []
    for (let i = 0; i < 5; i++) {
      const contactMsgs: { role: 'user' | 'assistant'; content: string }[] = convoHistory.flatMap(h => [
        { role: 'user' as const, content: `Generate your next message to the owner.` },
        { role: 'assistant' as const, content: h.contact },
        { role: 'user' as const, content: `Owner replied: "${h.owner}". Now send your next message.` },
      ])
      const contactRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 100, system: contactPrompt,
        messages: [...contactMsgs, { role: 'user', content: i === 0 ? 'Start the conversation.' : 'Continue.' }]
      })
      const contactMsg = contactRes.content[0].type === 'text' ? contactRes.content[0].text.trim() : ''

      const ownerMsgs: { role: 'user' | 'assistant'; content: string }[] = convoHistory.flatMap(h => [
        { role: 'user' as const, content: h.contact },
        { role: 'assistant' as const, content: h.owner },
      ])
      const ownerRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 100, system: currentOwnerPrompt,
        messages: [...ownerMsgs, { role: 'user', content: contactMsg }]
      })
      const ownerReply = ownerRes.content[0].type === 'text' ? ownerRes.content[0].text.trim() : ''

      console.log(`\n  [${c.name}]: ${contactMsg}`)
      console.log(`  [You — bot]:  ${ownerReply}`)
      convoHistory.push({ contact: contactMsg, owner: ownerReply })
    }
  }

  // Run → judge → fix → repeat until satisfied
  while (true) {
    await runSim()
    console.log()
    const judgment = await ask('  Did YOUR side (bot replies) sound like you? (yes / no / mostly): ')
    if (/^(yes|y)$/i.test(judgment.trim())) return true

    const feedback = await ask('  What was off? Be specific (e.g. "too formal", "said love you which i never say", "wrong language"): ')
    console.log('\n  Got it — regenerating with your feedback...\n')
    currentOwnerPrompt = ownerPrompt + `\n\nFEEDBACK FROM LAST RUN — strictly fix these:\n${feedback}`
  }
}

// ── Step 6: Save to memory-store ──────────────────────────────────────────────

async function saveContact(
  c: DmContact,
  interviewAnswers: Record<string, string>,
  goldenExamples: string[],
): Promise<void> {
  console.log(`\n  Computing voice profile for ${c.name}...`)

  // Build DM voice profile from actual message history
  const ownerDmMessages: Message[] = c.messages
    .filter(m => m.by === 'owner')
    .map(m => ({
      by: 'owner' as const,
      text: m.text,
      timestamp: m.timestamp,
      platform: 'dm' as const,
    }))

  const computedVoice = PersonMemoryStore.buildDmVoiceProfile(ownerDmMessages)

  // Compute overallTone via Haiku
  const theirSample = c.messages.filter(m => m.by === 'them').slice(-60).map(m => `"${m.text.replace(/"/g, "'")}"`)
  let overallTone = ''
  try {
    const toneRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 40,
      messages: [{
        role: 'user',
        content: `These are messages sent to you by ${c.name} (${c.relationship}) across your DM history:
${theirSample.join('\n')}

Write ONE line (under 15 words) describing how they engage overall.
Examples:
"warm and caring, emotionally open, checks in on you often"
"casual and playful, lots of banter, occasionally serious"
"brief and professional, focused on updates, rarely personal"
No preamble. Just the line.`
      }]
    })
    overallTone = toneRes.content[0].type === 'text' ? toneRes.content[0].text.trim() : ''
  } catch {}

  // Load or create the person's memory file
  const handle = c.handle ?? `user_${c.userId}`
  const mem: PersonMemory = store.load(handle) ?? ({
    handle,
    userId: c.userId,
    platform: 'dm' as const,
    score: 0,
    firstSeenAt: c.messages[0]?.timestamp ?? new Date().toISOString(),
    lastSeenAt: c.messages[c.messages.length - 1]?.timestamp ?? new Date().toISOString(),
    totalInteractions: c.messages.length,
    conversationCount: 0,
    relationshipType: 'unknown' as const,
    pendingClassification: null,
    dmReplyPermission: null,
    toneBaseline: null,
    theirPersonality: 'unknown',
    ownerToneWithThem: 'unknown',
    dominantTopics: [],
    notableEvents: [],
    dmVoiceProfile: null,
    ownerNote: null,
    conversations: [],
  } as PersonMemory)

  // Set fields from interview
  mem.userId = c.userId
  mem.dmReplyPermission = ((c as any).dmReplyPermission ?? 'review') as any
  if (overallTone) mem.overallTone = overallTone
  if (computedVoice) {
    // Enhance with golden examples as toneDescriptor supplement
    const goldenNote = goldenExamples.length
      ? ` | golden examples collected: ${goldenExamples.length}`
      : ''
    mem.dmVoiceProfile = {
      ...computedVoice,
      toneDescriptor: computedVoice.toneDescriptor + goldenNote,
    }
  }

  // Store interview Q&A as ownerNote for now (searchable later)
  const interviewSummary = Object.entries(interviewAnswers)
    .map(([q, a]) => `Q: ${q.replace(/^\d+\.\s*/, '')}\nA: ${a}`)
    .join('\n\n')
  mem.ownerNote = `Relationship: ${c.relationship}. Name: ${c.name}.\n\n${interviewSummary}`

  // Infer relationship type
  const allDmMessages: Message[] = c.messages.map(m => ({
    by: m.by,
    text: m.text,
    timestamp: m.timestamp,
    platform: 'dm' as const,
  }))
  mem.relationshipType = PersonMemoryStore.inferRelationshipType(mem, allDmMessages)

  // Seed actual DM conversations if not already done
  const existingDmIds = new Set(mem.conversations.map(conv => conv.id))
  const SESSION_GAP_MS = 2 * 60 * 60 * 1000
  const newConversations: import('../core/memory/PersonMemoryStore').Conversation[] = []
  let currentSession: import('../core/memory/PersonMemoryStore').Conversation | null = null

  for (const msg of allDmMessages) {
    const msgTime = new Date(msg.timestamp).getTime()
    const sessionId = `dm-${c.userId}-${msg.timestamp}`
    const isNew = !currentSession ||
      (msgTime - new Date(currentSession.lastMessageAt).getTime()) > SESSION_GAP_MS

    if (isNew) {
      currentSession = {
        id: sessionId,
        startedAt: msg.timestamp,
        lastMessageAt: msg.timestamp,
        topic: 'general',
        messages: [],
      }
      if (!existingDmIds.has(sessionId)) {
        newConversations.push(currentSession)
      }
    }
    currentSession!.messages.push(msg)
    currentSession!.lastMessageAt = msg.timestamp
  }

  mem.conversations = [...mem.conversations, ...newConversations].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  )
  mem.conversationCount = mem.conversations.length

  // Tone baseline
  const theirDmMessages: Message[] = allDmMessages.filter(m => m.by === 'them')
  const baseline = PersonMemoryStore.computeToneBaseline(theirDmMessages)
  if (baseline) mem.toneBaseline = baseline

  mem.notableEvents = [
    `DM interview completed`,
    `${c.messages.length} DM messages seeded from archive`,
    `relationship: ${c.relationship}`,
  ]

  store.save(mem)
  store.updateIndex(mem)

  console.log(`  ✓ Saved to memory-store: ${handle}.json`)
  console.log(`    relationship: ${mem.relationshipType}`)
  console.log(`    dm permission: ${mem.dmReplyPermission}`)
  if (overallTone) console.log(`    overall tone: ${overallTone}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(66))
  console.log('  BLOPUS — DM Interview')
  console.log('  Builds your DM voice profile per contact from archive history')
  console.log('═'.repeat(66))

  if (!fs.existsSync(DM_ARCHIVE_PATH)) {
    console.error(`\n  DM archive not found at:\n  ${DM_ARCHIVE_PATH}`)
    console.error('\n  Point DM_ARCHIVE_PATH in .env to your direct-messages.js file.\n')
    process.exit(1)
  }

  // ── Step 1: Parse + identify ───────────────────────────────
  const contacts = parseDmArchive()
  if (contacts.length === 0) {
    console.log('\n  No DM conversations found in archive. Nothing to do.\n')
    rl.close()
    return
  }

  console.log(`\n  Found ${contacts.length} DM conversation(s) in your archive.`)

  // Check if any contacts are already saved in memory-store
  const alreadySaved = contacts.map(c => {
    const existing = store.findByUserId(c.userId)
    return existing ? { ...c, handle: existing.handle, name: existing.handle, relationship: existing.relationshipType, allowed: existing.dmReplyPermission !== 'blocked' } : c
  })
  const hasSaved = alreadySaved.some(c => c.handle && !c.handle.startsWith('user_'))

  if (hasSaved) {
    console.log('\n  Existing interviews found. What do you want to do?')
    console.log('    1 — Edit a specific contact (skip re-identification)')
    console.log('    2 — Run full interview from scratch\n')
    const choice = await ask('  Enter 1 or 2: ')

    if (!/^2$/.test(choice.trim())) {
      // Show saved contacts and let user pick one
      const saved = alreadySaved.filter(c => c.handle && !c.handle.startsWith('user_'))
      console.log('\n  Saved contacts:')
      saved.forEach((c, i) => console.log(`    ${i + 1} — ${c.handle} (${c.relationship})`))
      const pick = await ask('\n  Which contact to edit? (number): ')
      const idx = parseInt(pick.trim()) - 1
      const target = saved[idx]
      if (!target) { console.log('  Invalid choice.'); rl.close(); return }

      target.allowed = true
      ;(target as any).dmReplyPermission = 'auto'

      section(`${target.handle?.toUpperCase()} (${target.relationship})`)
      console.log('  Jump to a specific step:')
      console.log('    1 — Interview  2 — Golden examples  3 — Validation  4 — Save only\n')
      const jump = await ask('  Jump to step (1/2/3/4 or Enter for all): ')
      const startStep = parseInt(jump.trim()) || 1

      let interviewAnswers: Record<string, string> = {}
      let goldenExamples: string[] = []

      if (startStep > 1) {
        const existing = store.load(target.handle!)
        if (existing?.ownerNote) interviewAnswers = { '_loaded': existing.ownerNote }
      }

      if (startStep <= 1) interviewAnswers = await runInterview(target as DmContact)
      if (startStep <= 2) goldenExamples = await collectGoldenExamples(target as DmContact)
      if (startStep <= 3) {
        hr()
        console.log('\n  STEP 5 — Validation simulation')
        await runValidation(target as DmContact, interviewAnswers, goldenExamples)
      }
      hr()
      console.log('\n  STEP 6 — Saving to memory-store')
      await saveContact(target as DmContact, interviewAnswers, goldenExamples)

      console.log('\n' + '═'.repeat(66))
      console.log('  Done!')
      console.log('═'.repeat(66) + '\n')
      rl.close()
      return
    }
  }

  await identifyContacts(contacts)

  // ── Step 2: Allow/deny ─────────────────────────────────────
  await allowDenyContacts(contacts)

  const allowed = contacts.filter(c => c.allowed === true)
  if (allowed.length === 0) {
    console.log('\n  No contacts allowed. Nothing to build.\n')
    rl.close()
    return
  }

  // ── Steps 3–6 per contact ──────────────────────────────────
  for (const c of allowed) {
    section(`${c.name?.toUpperCase()} (${c.relationship})`)

    console.log('  Jump to a specific step (or press Enter to run all from the start):')
    console.log('    1 — Interview (questions about how you talk to them)')
    console.log('    2 — Golden examples (real messages, you reply)')
    console.log('    3 — Validation (bot generates your replies, you judge)')
    console.log('    4 — Save only (re-save with existing data)')
    console.log('    Enter — run all steps\n')
    const jump = await ask('  Jump to step (1/2/3/4 or Enter): ')
    const startStep = parseInt(jump.trim()) || 1

    let interviewAnswers: Record<string, string> = {}
    let goldenExamples: string[] = []

    // Load existing data from JSON if skipping early steps
    if (startStep > 1) {
      const handle = c.handle ?? `user_${c.userId}`
      const existing = store.load(handle)
      if (existing?.ownerNote) {
        // Re-parse interview answers from saved ownerNote
        interviewAnswers = { '_loaded': existing.ownerNote }
        console.log('  (Loaded existing interview data from memory-store)')
      }
    }

    if (startStep <= 1) interviewAnswers = await runInterview(c)
    if (startStep <= 2) goldenExamples = await collectGoldenExamples(c)

    if (startStep <= 3) {
      hr()
      console.log('\n  STEP 5 — Validation simulation')
      await runValidation(c, interviewAnswers, goldenExamples)
    }

    hr()
    console.log('\n  STEP 6 — Saving to memory-store')
    await saveContact(c, interviewAnswers, goldenExamples)
  }

  console.log('\n' + '═'.repeat(66))
  console.log(`  Done! ${allowed.length} contact(s) saved to memory-store.`)
  console.log('  The bot will use these voice profiles automatically in DMs.')
  console.log('═'.repeat(66) + '\n')

  rl.close()
}

main().catch(e => {
  console.error(e)
  rl.close()
  process.exit(1)
})
