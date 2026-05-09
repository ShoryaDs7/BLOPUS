import Anthropic from '@anthropic-ai/sdk'
import path from 'path'
import fs   from 'fs'

export type PushFn = (text: string) => void

export interface VisionSurfaceState {
  surface:        'gmail' | 'notion' | 'slack' | 'figma' | 'zoom' | 'docs' | 'calendar' | 'linear' | 'browser' | 'vscode' | 'terminal' | 'other'
  activity:       'composing_email' | 'reading_email' | 'writing_doc' | 'editing_doc' | 'in_meeting' | 'coding' | 'reading' | 'browsing' | 'other'
  intent:         string   // short phrase: "investor outreach", "planning", "debugging"
  friction:       'stalled' | 'switching' | 'focused' | 'none'
  confidence:     number   // 0.0–1.0
  contextSnippet: string   // key text visible on screen, max 100 chars
}

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
const client     = new Anthropic()
let   busy       = false
let   currentTitle = ''

function buildSystemPrompt(): string {
  try {
    const configPath = process.env.BLOPUS_CONFIG_PATH ?? path.join(BLOPUS_DIR, 'config/blopus.config.json')
    const cfg  = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    const ppPath = path.join(path.dirname(path.resolve(configPath)), 'personality_profile.json')
    const pp   = JSON.parse(fs.readFileSync(ppPath, 'utf-8'))

    const ownerName = cfg?.owner?.displayName ?? 'the owner'
    const topics    = (pp?.dominantTopics ?? []).join(', ')
    const style     = pp?.writingStyle ?? ''
    const examples  = (pp?.examplePhrases ?? []).slice(0, 3).join(' / ')

    return `You are Blopus — an AI companion watching ${ownerName}'s screen.

About ${ownerName}: works on ${topics}. Vibe: ${style}. How they talk: ${examples}.

React in ONE casual sentence relevant to what's on screen. No describing what you see. No "I see" or "I notice". Speak to them directly. If nothing useful: reply NOTHING.`
  } catch {
    return "You are Blopus — an AI companion watching the owner's screen. React in one casual sentence or reply NOTHING."
  }
}

const SYSTEM_PROMPT = buildSystemPrompt()

export function startVisionLoop(push: PushFn): {
  updateContext:     (title: string) => void
  triggerScreenshot: () => Promise<void>
  stop:              () => void
} {
  let running = true

  async function fireScreenshot() {
    if (busy || !running) return
    busy = true
    try {
      const sd = await import('screenshot-desktop')
      const screenshot = (sd as any).default ?? sd
      const imgBuf: Buffer = await screenshot({ format: 'png' })
      const base64 = imgBuf.toString('base64')

      const resp = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system:     SYSTEM_PROMPT,
        messages: [{
          role:    'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            { type: 'text',  text: `Window: "${currentTitle}"\nReact in one sentence or reply NOTHING.` },
          ],
        }],
      })

      const text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
      console.log('[Vision] Haiku:', text.slice(0, 100))
      if (text && !/^nothing$/i.test(text)) push(text)
    } catch (e) {
      console.error('[Vision] error:', e)
    } finally {
      busy = false
    }
  }

  return {
    updateContext:     (title) => { currentTitle = title },
    triggerScreenshot: fireScreenshot,
    stop:              () => { running = false },
  }
}

// ── Structured scan — vision gate for unknown surfaces ────────────────────────
// Called by suspicion gate in awarenessLayer. Returns structured surface state
// so ActionRouter can decide whether to propose. Never pushes text directly.
const STRUCTURED_SCAN_SYSTEM = `Analyze the screenshot and return ONLY valid JSON, nothing else.

JSON schema:
{
  "surface": "gmail|notion|slack|figma|zoom|docs|calendar|linear|browser|vscode|terminal|other",
  "activity": "composing_email|reading_email|writing_doc|editing_doc|in_meeting|coding|reading|browsing|other",
  "intent": "short phrase describing likely goal, max 6 words",
  "friction": "stalled|switching|focused|none",
  "confidence": 0.0-1.0,
  "contextSnippet": "most informative text visible, max 80 chars"
}`

export async function structuredScan(windowTitle: string): Promise<VisionSurfaceState | null> {
  if (busy) return null
  busy = true
  try {
    const sd = await import('screenshot-desktop')
    const screenshot = (sd as any).default ?? sd
    const imgBuf: Buffer = await screenshot({ format: 'png' })
    const base64 = imgBuf.toString('base64')

    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system:     STRUCTURED_SCAN_SYSTEM,
      messages: [{
        role:    'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text',  text: `Window: "${windowTitle}"\nReturn JSON only.` },
        ],
      }],
    })

    const raw  = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    const match = raw.match(/\{[\s\S]+\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as VisionSurfaceState
    if (!parsed.surface || !parsed.activity) return null
    if (parsed.confidence < 0.60) return null
    console.log(`[Vision] structuredScan surface=${parsed.surface} activity=${parsed.activity} conf=${parsed.confidence.toFixed(2)}`)
    return parsed
  } catch (e) {
    console.error('[Vision] structuredScan error:', (e as Error).message?.slice(0, 60))
    return null
  } finally {
    busy = false
  }
}
