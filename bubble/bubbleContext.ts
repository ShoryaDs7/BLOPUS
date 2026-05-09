import path from 'path'
import fs   from 'fs'

interface BubbleSession {
  ts:          string    // ISO
  topics:      string[]
  durationMin: number
}

interface BubbleContextFile {
  sessions: BubbleSession[]
}

const MAX_SESSIONS     = 30
const FLUSH_INACTIVITY = 20 * 60 * 1000   // flush session after 20 min quiet

function getFilePath(): string {
  const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
  const creator    = process.env.CREATOR?.trim()
  const configDir  = creator
    ? path.join(BLOPUS_DIR, 'creators', creator)
    : process.env.BLOPUS_CONFIG_PATH
      ? path.dirname(path.resolve(process.env.BLOPUS_CONFIG_PATH))
      : path.join(BLOPUS_DIR, 'config')
  return path.join(configDir, 'bubble_context.json')
}

function load(): BubbleContextFile {
  try {
    const file = getFilePath()
    if (!fs.existsSync(file)) return { sessions: [] }
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch { return { sessions: [] } }
}

function save(ctx: BubbleContextFile): void {
  try {
    if (ctx.sessions.length > MAX_SESSIONS) {
      ctx.sessions = ctx.sessions.slice(-MAX_SESSIONS)
    }
    fs.writeFileSync(getFilePath(), JSON.stringify(ctx, null, 2), 'utf-8')
  } catch {}
}

// ── In-memory current session accumulator ────────────────────────────────────
let sessionTopics    = new Set<string>()
let sessionStartedAt = Date.now()
let flushTimer:        ReturnType<typeof setTimeout> | null = null

function flushSession() {
  if (sessionTopics.size === 0) return
  const ctx = load()
  ctx.sessions.push({
    ts:          new Date().toISOString(),
    topics:      Array.from(sessionTopics),
    durationMin: Math.round((Date.now() - sessionStartedAt) / 60_000),
  })
  save(ctx)
  console.log(`[BubbleContext] flushed — ${Array.from(sessionTopics).join(', ')}`)
  sessionTopics    = new Set()
  sessionStartedAt = Date.now()
}

export function recordTopic(topic: string): void {
  if (!topic || topic.length < 4) return
  sessionTopics.add(topic)
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushSession, FLUSH_INACTIVITY)
}

// Returns topics seen in sessions within the past lookbackMs
export function getRecentTopics(lookbackMs: number): string[] {
  const cutoff = Date.now() - lookbackMs
  const ctx    = load()
  const out    = new Set<string>()
  for (const s of ctx.sessions) {
    if (new Date(s.ts).getTime() > cutoff) {
      for (const t of s.topics) out.add(t)
    }
  }
  // Also include what's accumulated in the current in-memory session
  for (const t of sessionTopics) out.add(t)
  return Array.from(out)
}
