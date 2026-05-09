import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import fs   from 'fs'

export interface IntentEvent {
  event: 'typing_pause' | 'compose_focus' | 'send_hover' | 'send_out' | 'scroll_pause' | 'send_click' | string
  duration?: number
  url: string
  platform: string
  text_sample?: string
}

export interface IntentResult {
  action: 'ignore' | 'show_ghost' | 'hide_ghost' | 'inject' | 'screenshot'
  suggestion?: string
}

interface SuggestionCache {
  originalText: string
  suggestion:   string
  cachedAt:     number
}

const HIGH_STAKES = [
  'mail.google.com', 'gmail.com',
  'x.com', 'twitter.com',
  'linkedin.com',
  'reddit.com',
  'outlook.live.com', 'outlook.office.com',
  'notion.so',
  'slack.com',
]

const EVENT_SCORES: Record<string, number> = {
  typing_pause:  3,
  compose_focus: 1,
  send_hover:    5,
  scroll_pause:  1,
}

const client = new Anthropic()
let cache: SuggestionCache | null = null
let precomputing = false

let onSuggestionReady: ((suggestion: string, context: 'compose') => void) | null = null
export function setOnSuggestionReady(fn: (suggestion: string, context: 'compose') => void) {
  onSuggestionReady = fn
}

// ── Context — loaded once at startup ─────────────────────────────────────────
function buildContext(): string {
  try {
    const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
    const creator    = process.env.CREATOR?.trim()
    const configDir  = creator
      ? path.join(BLOPUS_DIR, 'creators', creator)
      : process.env.BLOPUS_CONFIG_PATH
        ? path.dirname(path.resolve(process.env.BLOPUS_CONFIG_PATH))
        : path.join(BLOPUS_DIR, 'config')

    let biography = ''
    let facts     = ''
    try {
      const bio = JSON.parse(fs.readFileSync(path.join(configDir, 'memory-store/owner_biography.json'), 'utf-8'))
      biography = bio.evolution?.slice(0, 400) ?? ''
    } catch {}
    try {
      const ctx = JSON.parse(fs.readFileSync(path.join(configDir, 'memory-store/user_context.json'), 'utf-8'))
      facts = (ctx as any[]).slice(0, 6).map((c: any) => `- ${c.text}`).join('\n')
    } catch {}

    if (!biography && !facts) return ''
    return `Context about the person writing this:\n${biography}\n\nWhat they are working on:\n${facts}`
  } catch {
    return ''
  }
}

const USER_CONTEXT = buildContext()
console.log('[IntentEngine] context loaded:', USER_CONTEXT ? 'yes' : 'none (fallback)')

const SYSTEM_PROMPT = `You rewrite messages so they land better — clearer, sharper, more human.
${USER_CONTEXT ? `\n${USER_CONTEXT}\n` : ''}
Rules:
- Keep the same intent and tone the person is going for — don't change their voice
- Fix grammar, clarity, and awkward phrasing — but keep it feeling natural, not corporate
- If the message is already good, reply NONE
- Reply ONLY with the rewritten message. No quotes, no preamble, no explanation.`

// ── Helpers ───────────────────────────────────────────────────────────────────
function isHighStakes(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return HIGH_STAKES.some(h => host.endsWith(h))
  } catch { return false }
}

function scoreEvent(ev: IntentEvent): number {
  let s = EVENT_SCORES[ev.event] ?? 0
  if (isHighStakes(ev.url)) s += 3
  return s
}

function cacheValid(currentText: string): boolean {
  if (!cache) return false
  if (Date.now() - cache.cachedAt > 60_000) return false
  const orig = cache.originalText.trim()
  const curr = currentText.trim()
  const checkLen = Math.min(orig.length, 60)
  if (checkLen > 0 && !curr.startsWith(orig.slice(0, checkLen))) return false
  return true
}

const SHORT_REPLIES = /^(ok|okay|sure|yes|no|thanks|thank you|got it|will do|sounds good|lol|haha|nice|cool|great|done|noted|agreed|👍|🙏|❤️)[\s!.]*$/i

function worthImproving(text: string): boolean {
  if (text.trim().length < 15) return false
  if (SHORT_REPLIES.test(text.trim())) return false
  if (text.trim().split(/\s+/).length < 3) return false
  return true
}

// ── Precompute ────────────────────────────────────────────────────────────────
async function precompute(text: string): Promise<void> {
  if (precomputing) return
  if (cache && cache.originalText.trim() === text.trim()) {
    console.log('[IntentEngine] precompute skipped — text unchanged')
    if (cache.suggestion && onSuggestionReady) onSuggestionReady(cache.suggestion, 'compose')
    return
  }

  precomputing = true
  const t0 = Date.now()
  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:     SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Message:\n"${text}"\n\nImprove it or reply NONE.` }],
    })
    const result = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    const ms = Date.now() - t0
    if (result && !/^none$/i.test(result)) {
      cache = { originalText: text, suggestion: result, cachedAt: Date.now() }
      console.log(`[IntentEngine] CACHE store — ${ms}ms — "${text.slice(0, 40)}"`)
      if (onSuggestionReady) onSuggestionReady(result, 'compose')
    } else {
      console.log(`[IntentEngine] CACHE miss (NONE) — ${ms}ms`)
    }
  } catch (e) {
    console.error('[IntentEngine] precompute error:', e)
  } finally {
    precomputing = false
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function processIntent(ev: IntentEvent): Promise<IntentResult> {
  const s    = scoreEvent(ev)
  const text = ev.text_sample ?? ''

  console.log(`[IntentEngine] event=${ev.event} score=${s} url=${ev.url.slice(0, 60)}`)

  if (ev.event === 'send_hover') {
    if (cacheValid(text)) {
      console.log('[IntentEngine] CACHE hit → show_ghost')
      return { action: 'show_ghost', suggestion: cache!.suggestion }
    }
    const reason = !cache ? 'no cache' : Date.now() - cache.cachedAt > 60_000 ? 'ttl expired' : 'prefix mismatch'
    console.log(`[IntentEngine] CACHE miss (${reason}) → ignore`)
    return { action: 'ignore' }
  }

  if (ev.event === 'send_out') {
    return { action: 'hide_ghost' }
  }

  if (ev.event === 'send_click') {
    if (cacheValid(text)) {
      const suggestion = cache!.suggestion
      cache = null
      console.log('[IntentEngine] CACHE hit → inject')
      return { action: 'inject', suggestion }
    }
    return { action: 'ignore' }
  }

  if (s < 6) return { action: 'ignore' }

  if (ev.event === 'typing_pause') {
    if (!worthImproving(text)) {
      console.log('[IntentEngine] sanity check failed — not worth improving')
      return { action: 'ignore' }
    }
    if (cache) {
      const orig = cache.originalText.trim()
      const checkLen = Math.min(orig.length, 60)
      if (checkLen > 0 && !text.trim().startsWith(orig.slice(0, checkLen))) {
        console.log('[IntentEngine] cache invalidated — text rewritten')
        cache = null
      }
    }
    precompute(text).catch(() => {})
    return { action: 'ignore' }
  }

  if (s >= 8 && isHighStakes(ev.url)) {
    console.log('[IntentEngine] → screenshot (high-stakes other event)')
    return { action: 'screenshot' }
  }

  return { action: 'ignore' }
}
