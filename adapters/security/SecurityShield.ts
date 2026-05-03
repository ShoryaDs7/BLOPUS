/**
 * SecurityShield — three-layer pre-launch protection:
 * 1. interceptThreat() — blocks prompt injection in incoming tweet content before it hits Claude
 * 2. blockLeak()        — blocks credential leaks in generated text before it's posted/sent
 * 3. flagIntruder()     — alerts owner when a stranger contacts the Telegram control bot
 */

async function notifyOwner(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) return
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {})
}

// ─── Prompt injection patterns ───────────────────────────────────────────────
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /forget\s+(everything|all|your\s+instructions)/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /\[system\]/i,
  /<\|im_start\|>/i,
  /override\s*:/i,
  /your\s+new\s+(goal|task|role|purpose)\s+is/i,
  /act\s+as\s+(a\s+)?(new|different|another)/i,
  /disregard\s+(all\s+)?(previous|prior)/i,
  /from\s+now\s+on\s+(you\s+are|ignore)/i,
  /do\s+not\s+follow\s+(your|the|these)\s+instructions/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /roleplay\s+as/i,
  /jailbreak\s+(?:(?:this|the|your|a)\s+)?(?:bot|ai|assistant|model|system|prompt)/i,
  /prompt\s+injection/i,
  /system\s+prompt\s*:/i,
  // Subtle style-guide injections — feeding examples back as instructions
  /here['']?s\s+(a\s+)?(detailed\s+)?(guide|manual|instructions?)\s+(to|for|on)\s+how/i,
  /your\s+writing\s+style\s+is/i,
  /the\s+examples\s+show\s+a\s+(consistent\s+)?pattern/i,
  /this\s+is\s+how\s+you\s+(write|respond|reply|talk)/i,
  /based\s+on\s+your\s+(examples?|replies|posts|writing)/i,
]

// ─── Character break patterns — scan OUTPUT before posting ───────────────────
const CHARACTER_BREAK_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'AI refusal',         pattern: /I['']m\s+not\s+going\s+to\s+(roleplay|write|mimic|pretend)/i },
  { name: 'AI identity leak',   pattern: /as\s+an\s+AI\b/i },
  { name: 'AI identity leak',   pattern: /I['']m\s+an\s+AI\b/i },
  { name: 'Claude identity',    pattern: /\bClaude\b.*\b(cannot|will not|won't|refuse)/i },
  { name: 'persona refusal',    pattern: /not\s+going\s+to\s+(roleplay|adopt|mimic)\s+(this|that|a)\s+persona/i },
  { name: 'I cannot comply',    pattern: /I\s+cannot\s+(comply|do\s+that|help\s+with\s+that|assist\s+with)/i },
  { name: 'against guidelines', pattern: /against\s+my\s+(guidelines|values|principles|training)/i },
]

// ─── Credential leak patterns ─────────────────────────────────────────────────
const CREDENTIAL_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'Anthropic API key',     pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/ },
  { name: 'OpenAI API key',        pattern: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'AWS access key',        pattern: /AKIA[A-Z0-9]{16}/ },
  { name: 'GitHub token',          pattern: /ghp_[a-zA-Z0-9]{30,}/ },
  { name: 'Twitter bearer token',  pattern: /AAAAAAAAAAAAAAAAAAA[a-zA-Z0-9%]{10,}/ },
  { name: 'Railway token',         pattern: /(?:railway|token|secret|key)\s*[:=]\s*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i },
  { name: 'Generic secret in text',pattern: /(?:api[_\s-]?key|secret|token|password)\s*[:=]\s*["']?[a-zA-Z0-9\-_]{20,}["']?/i },
]

export interface ScanResult {
  safe: boolean
  threat: string | null
}

export function scanForInjection(content: string): ScanResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return { safe: false, threat: `injection pattern matched: ${pattern.source}` }
    }
  }
  return { safe: true, threat: null }
}

export function scanOutput(content: string): ScanResult {
  for (const { name, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      return { safe: false, threat: name }
    }
  }
  for (const { name, pattern } of CHARACTER_BREAK_PATTERNS) {
    if (pattern.test(content)) {
      return { safe: false, threat: `character break detected: ${name}` }
    }
  }
  return { safe: true, threat: null }
}

/** Scan incoming tweet/content for prompt injection before passing to Claude. */
export async function interceptThreat(content: string, source: string): Promise<boolean> {
  const result = scanForInjection(content)
  if (!result.safe) {
    console.warn(`[SecurityShield] BLOCKED injection from ${source}: ${result.threat}`)
    await notifyOwner(
      `🛡️ Injection attempt blocked\n\nSource: ${source}\nThreat: ${result.threat}\n\nContent: "${content.slice(0, 200)}"`,
    )
    return false
  }
  return true
}

/** Haiku checks if the text sounds like the owner's own thought or Claude explaining/refusing */
async function isOwnerVoice(content: string): Promise<boolean> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return true // no key = skip check, don't block
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: `Read this text and answer with one word only — OWNER or AI.

OWNER = this is something a real person would post as their own thought, opinion, or reaction.
AI = this sounds like an AI model explaining why it can't reply, refusing a request, adding a disclaimer, or commenting on its own behavior.

Text: "${content.slice(0, 400)}"

Answer (OWNER or AI):`,
        }],
      }),
    })
    const data = await res.json() as any
    const answer = data?.content?.[0]?.text?.trim().toUpperCase() ?? 'OWNER'
    return !answer.startsWith('AI')
  } catch {
    return true // on error, don't block
  }
}

/** Scan generated text for credential leaks + AI voice before posting to X, email, etc. */
export async function blockLeak(content: string, action: string): Promise<boolean> {
  const result = scanOutput(content)
  if (!result.safe) {
    console.warn(`[SecurityShield] BLOCKED output for ${action}: ${result.threat}`)
    await notifyOwner(
      `🚨 Credential leak blocked\n\nAction: ${action}\nThreat: ${result.threat}\n\nContent preview: "${content.slice(0, 200)}"`,
    )
    return false
  }

  const ownerVoice = await isOwnerVoice(content)
  if (!ownerVoice) {
    console.warn(`[SecurityShield] BLOCKED AI voice leak for ${action}: "${content.slice(0, 80)}"`)
    await notifyOwner(
      `🛡️ AI voice blocked before posting\n\nAction: ${action}\nContent: "${content.slice(0, 200)}"`,
    )
    return false
  }

  return true
}

// ─── Telegram rate limiter ────────────────────────────────────────────────────
class RateLimiter {
  private timestamps: number[] = []
  constructor(private maxPerWindow: number, private windowMs: number) {}

  isAllowed(): boolean {
    const now = Date.now()
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs)
    if (this.timestamps.length >= this.maxPerWindow) return false
    this.timestamps.push(now)
    return true
  }
}

export const telegramRateLimiter = new RateLimiter(20, 60_000) // 20 messages per minute

/** Alert owner when a stranger contacts the Telegram control bot. */
export async function flagIntruder(chatId: number | string, text: string): Promise<void> {
  console.warn(`[SecurityShield] Unknown sender ${chatId} attempted contact`)
  await notifyOwner(
    `⚠️ Unknown sender tried to reach BLOPUS\n\nChat ID: ${chatId}\nMessage: "${String(text).slice(0, 100)}"`,
  )
}
