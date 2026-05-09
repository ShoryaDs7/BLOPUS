import http from 'http'
import path from 'path'
import fs   from 'fs'

const BLOPUS_DIR = path.resolve(__dirname, '..')
process.env.BLOPUS_DIR = BLOPUS_DIR

import { config } from 'dotenv'
config({ path: path.join(BLOPUS_DIR, '.env') })

const PORT = 3847

const sseClients = new Set<http.ServerResponse>()

// ── In-session chat history — resets on server restart ────────────────────────
// Keeps last 10 exchanges so "write essay about it" knows what "it" refers to.
const chatHistory: { role: 'user' | 'blopus'; text: string }[] = []
const CHAT_HISTORY_MAX = 10  // exchanges (20 entries total)

function buildChatContext(): string {
  if (chatHistory.length === 0) return ''
  const lines = chatHistory.map(e =>
    `${e.role === 'user' ? 'User' : 'Blopus'}: ${e.text.slice(0, 300)}`
  )
  return `[This session's conversation so far]\n${lines.join('\n')}\n\n---\n\n`
}

function pushToBubble(text: string) {
  const data = `data: ${JSON.stringify({ text })}\n\n`
  for (const res of Array.from(sseClients)) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

function saveMessage(from: 'user' | 'blopus', text: string) {
  try {
    const configPath = process.env.BLOPUS_CONFIG_PATH ?? path.join(BLOPUS_DIR, 'config/blopus.config.json')
    const file = path.join(path.dirname(path.resolve(configPath)), 'bubble_history.json')
    const history: any[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : []
    history.push({ ts: new Date().toISOString(), from, text: text.slice(0, 500) })
    if (history.length > 500) history.splice(0, history.length - 500)
    fs.writeFileSync(file, JSON.stringify(history, null, 2), 'utf-8')
  } catch {}
}


function pushGhost(suggestion: string, context: 'compose' | 'search' = 'compose') {
  const data = `data: ${JSON.stringify({ type: 'ghost', suggestion, context })}\n\n`
  for (const res of Array.from(sseClients)) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

export function pushProposal(label: string, envelope: object, proposalId: string) {
  const data = `data: ${JSON.stringify({ type: 'proposal', label, envelope, proposalId })}\n\n`
  for (const res of Array.from(sseClients)) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

function pushChatProgress(text: string) {
  const data = `data: ${JSON.stringify({ type: 'chat_progress', text })}\n\n`
  for (const res of Array.from(sseClients)) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

function pushTaskResult(proposalId: string, result: string) {
  const data = `data: ${JSON.stringify({ type: 'task_result', proposalId, result })}\n\n`
  for (const res of Array.from(sseClients)) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

function pushProgress(proposalId: string, update: string) {
  const data = `data: ${JSON.stringify({ type: 'task_progress', proposalId, update })}\n\n`
  for (const res of Array.from(sseClients)) {
    try { res.write(data) } catch { sseClients.delete(res) }
  }
}

function pushActivityUpdate() {
  try {
    const file    = getActivityLogPath()
    const entries: ActivityEntry[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : []
    const recent  = entries.slice(-20).reverse()
    const data    = `data: ${JSON.stringify({ type: 'activity_update', entries: recent })}\n\n`
    for (const res of Array.from(sseClients)) {
      try { res.write(data) } catch { sseClients.delete(res) }
    }
  } catch {}
}

// ── Activity log — persists task completions for the feed ─────────────────
interface ActivityEntry {
  ts:      string
  action:  string
  label:   string
  snippet: string
}

function getActivityLogPath(): string {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? path.join(BLOPUS_DIR, 'config/blopus.config.json')
  return path.join(path.dirname(path.resolve(configPath)), 'bubble_activity.json')
}

function saveActivity(action: string, label: string, result: string): void {
  try {
    const file    = getActivityLogPath()
    const entries: ActivityEntry[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : []
    entries.push({
      ts:      new Date().toISOString(),
      action,
      label,
      snippet: result.replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120),
    })
    if (entries.length > 100) entries.splice(0, entries.length - 100)
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8')
  } catch {}
}

// ── Reputation scoring — imported from reputationStore ───────────────────
export { recordDismiss, recordAccept, isSilencedByReputation } from './reputationStore'
import { recordDismiss, recordAccept } from './reputationStore'

// Latest browser context — overwritten on each new page/selection
export interface BrowserContext {
  selectedText:  string
  selectedTopic: string[]   // stemmed keywords from selected text
  pageContent:   string
  pageUrl:       string
}
let browserCtx: BrowserContext = { selectedText: '', selectedTopic: [], pageContent: '', pageUrl: '' }
export function getBrowserContext(): BrowserContext { return browserCtx }

const STOP = new Set(['the','a','an','is','are','was','were','in','on','to','of','and','or','for','with','that','this','it','as','at','by','from','be','has','have','had'])

function stem(w: string): string {
  return w.replace(/ing$|tion$|ers?$|ies$|[sz]$/, '').toLowerCase()
}

function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w))
    .map(stem)
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 12)
}

// Fast vision answer — single Haiku call, no MCP servers, no agent loop.
// Used when the 👁 button is active: take screenshot, answer directly, ~5s not 3min.
async function fastVisionAnswer(message: string, screenBase64: string, contextPrefix: string): Promise<string> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client = new Anthropic()
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are Blopus, an AI assistant. The user has shared a screenshot of their screen and needs direct, actionable help. Be concise and practical. No fluff.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenBase64 } },
        { type: 'text', text: contextPrefix + message },
      ],
    }],
  })
  return resp.content[0]?.type === 'text' ? resp.content[0].text : 'No response.'
}

async function main() {
  const { SessionBrain } = await import('../adapters/control/SessionBrain')
  const { appendEvent }  = await import('../core/memory/GlobalEventLog')
  const { startWindowWatcher } = await import('./windowWatcher')
  const { startVisionLoop }    = await import('./visionLoop')
  const { processIntent, setOnSuggestionReady } = await import('./intentEngine')
  const { startAwarenessLayer } = await import('./awarenessLayer')
  setOnSuggestionReady((suggestion, context) => pushGhost(suggestion, context))

  const sessionBrain = new SessionBrain()
  sessionBrain.setNotify(async () => {})

  // Separate instance for bubble tasks — same full power (reads same disk files: voice profile,
  // personality, skills, memory, MCP servers). Isolated so Telegram/GoalRunner are never affected.
  const bubbleSessionBrain = new SessionBrain()
  bubbleSessionBrain.setNotify(async () => {})


  const vision    = startVisionLoop((text) => {
    pushToBubble(text)
    appendEvent({ platform: 'bubble', type: 'vision_flag', text })
  })
  const awareness = startAwarenessLayer((msg) => pushToBubble(msg))
  const { onVSCodeSignal } = awareness

  startWindowWatcher((ctx) => {
    vision.updateContext(ctx.label)
    awareness.onContext(ctx)
  })
  console.log('[BubbleServer] started')

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    if (req.method === 'POST' && req.url === '/message') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        try {
          const { message, imageBase64, imageMime, visionMode } = JSON.parse(body)
          console.log(`[BubbleServer] user: ${message.slice(0, 60)} vision=${!!visionMode || !!imageBase64}`)
          saveMessage('user', message)
          const contextPrefix = buildChatContext()
          chatHistory.push({ role: 'user', text: message })

          let response: string
          sessionBrain.setNotify(async (text) => pushChatProgress(text))
          try {
          if (imageBase64 && imageMime) {
            // User attached a file explicitly
            response = await sessionBrain.processWithImage('bubble', contextPrefix + message, imageBase64, imageMime)
          } else if (visionMode) {
            // Vision button — fast path: screenshot + single Haiku call, no agent loop
            let screenBase64: string | null = null
            try {
              const sd = await import('screenshot-desktop')
              const screenshotFn = (sd as any).default ?? sd
              const buf: Buffer = await screenshotFn({ format: 'png' })
              screenBase64 = buf.toString('base64')
              console.log('[BubbleServer] vision screenshot taken (fast path)')
            } catch { console.warn('[BubbleServer] screenshot failed') }

            response = screenBase64
              ? await fastVisionAnswer(message, screenBase64, contextPrefix)
              : await sessionBrain.process('bubble', contextPrefix + message)
          } else {
            response = await sessionBrain.process('bubble', contextPrefix + message)
          }
          } finally {
            sessionBrain.setNotify(async () => {})
          }
          chatHistory.push({ role: 'blopus', text: response })
          if (chatHistory.length > CHAT_HISTORY_MAX * 2) {
            chatHistory.splice(0, chatHistory.length - CHAT_HISTORY_MAX * 2)
          }
          saveMessage('blopus', response)
          appendEvent({ platform: 'bubble', type: 'chat', text: `user: ${message.slice(0,60)} → ${response.slice(0,60)}` })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ response }))
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message ?? 'unknown' }))
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/intent') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        try {
          const ev = JSON.parse(body)
          if (ev.url) browserCtx.pageUrl = ev.url   // keep surface detection current
          const result = await processIntent(ev)
          if (result.action === 'show_ghost' && result.suggestion) {
            pushGhost(result.suggestion, ev.context ?? 'compose')
          }
          if (result.action === 'hide_ghost') {
            const data = `data: ${JSON.stringify({ type: 'hide_ghost' })}\n\n`
            for (const res2 of Array.from(sseClients)) {
              try { res2.write(data) } catch { sseClients.delete(res2) }
            }
          }
          if (result.action === 'screenshot') {
            vision.triggerScreenshot().catch(e => console.error('[Intent] screenshot error:', e))
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ action: result.action }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message ?? 'bad request' }))
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/vscode') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        try {
          const signal = JSON.parse(body)
          console.log(`[BubbleServer] vscode event=${signal.event} file=${(signal.file ?? '').split(/[\\/]/).slice(-1)[0]}`)
          onVSCodeSignal(signal)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/browser') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        try {
          const ev = JSON.parse(body)
          if (ev.event === 'selection' && ev.text) {
            browserCtx.selectedText = ev.text
            browserCtx.pageUrl      = ev.url ?? browserCtx.pageUrl
            // Store selection with metadata — friction path decides when to use it
            browserCtx.selectedText  = ev.text
            browserCtx.selectedTopic = extractKeywords(ev.text)
            browserCtx.pageUrl       = ev.url ?? browserCtx.pageUrl
            console.log(`[BubbleServer] selection stored (${browserCtx.selectedTopic.join(',').slice(0,40)}): "${ev.text.slice(0, 60)}"`)
            // NOTE: no BubbleBrain fire here — friction owns execution
          } else if (ev.event === 'page_load' && ev.summary) {
            // Don't store YouTube home / generic feed pages as context — they're noise
            const isGenericFeed = /youtube\.com\/?$|youtube\.com\/\?|reddit\.com\/?$|twitter\.com\/?$|x\.com\/?$/i.test(ev.url ?? '')
            if (!isGenericFeed) {
              browserCtx.pageContent = ev.summary
              browserCtx.pageUrl     = ev.url ?? browserCtx.pageUrl
            }
            browserCtx.selectedText = ''   // clear selection on new page
            console.log(`[BubbleServer] browser page_load: ${ev.summary.length} chars from ${(ev.url ?? '').slice(0, 60)}`)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message }))
        }
      })
      return
    }

    if (req.method === 'POST' && req.url === '/task') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', async () => {
        try {
          const { proposalId, envelope } = JSON.parse(body)
          if (!envelope || !proposalId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'missing proposalId or envelope' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))

          if (envelope.runner === 'session_brain') {
            // Isolated brain — completely separate from Telegram/GoalRunner SessionBrain
            const maxMs = envelope.maxRuntimeMs ?? 5 * 60 * 1000
            console.log(`[BubbleServer] session_brain task start proposalId=${proposalId} maxMs=${maxMs}`)
            bubbleSessionBrain.setNotify(async (text) => pushProgress(proposalId, text))
            const taskPromise   = bubbleSessionBrain.process('bubble_task', envelope.goal)
            const timeoutPromise = new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('timeout')), maxMs)
            )
            const label = (envelope as any).context?.topic ?? 'task'
            recordAccept(label)
            Promise.race([taskPromise, timeoutPromise])
              .then(result => {
                console.log(`[BubbleServer] session_brain task done proposalId=${proposalId} len=${result.length}`)
                const final = result || 'no result found'
                pushTaskResult(proposalId, final)
                pushToBubble(`✓ done — ${label}`)
                saveActivity((envelope as any).runner ?? 'session_brain', label, final)
                pushActivityUpdate()
              })
              .catch(e => {
                const msg = e?.message === 'timeout' ? 'took too long — try a more focused question' : 'task failed — try again'
                console.error(`[BubbleServer] session_brain task error:`, e?.message?.slice(0, 80))
                pushTaskResult(proposalId, msg)
              })
              .finally(() => bubbleSessionBrain.setNotify(async () => {}))
          } else {
            // task_executor — fast isolated search path
            const { executeTask } = await import('./TaskExecutor')
            console.log(`[BubbleServer] task_executor start proposalId=${proposalId}`)
            const label = (envelope as any).context?.topic ?? 'task'
            recordAccept(label)
            executeTask(envelope)
              .then(result => {
                console.log(`[BubbleServer] task_executor done proposalId=${proposalId} len=${result.length}`)
                const final = result || 'no result found'
                pushTaskResult(proposalId, final)
                pushToBubble(`✓ done — ${label}`)
                saveActivity((envelope as any).actionType ?? 'find', label, final)
                pushActivityUpdate()
              })
              .catch(e => {
                console.error(`[BubbleServer] task_executor error:`, e)
                pushTaskResult(proposalId, 'task failed — try again')
              })
          }
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e?.message }))
        }
      })
      return
    }

    if (req.method === 'GET' && req.url === '/activity') {
      try {
        const file    = getActivityLogPath()
        const entries: ActivityEntry[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : []
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(entries.slice(-20).reverse()))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify([]))
      }
      return
    }

    if (req.method === 'POST' && req.url === '/proposal/dismiss') {
      let body = ''
      req.on('data', d => { body += d })
      req.on('end', () => {
        try { const { topic } = JSON.parse(body); if (topic) recordDismiss(topic) } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (req.method === 'POST' && req.url === '/task/cancel') {
      bubbleSessionBrain.cancelTask('bubble_task')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && req.url === '/chat/cancel') {
      sessionBrain.cancelTask('bubble')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // ── Test endpoint — fire a screenshot manually to verify vision pipeline ──
    if (req.method === 'POST' && req.url === '/test-vision') {
      vision.triggerScreenshot()
        .then(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })) })
        .catch((e: any) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e?.message })) })
      return
    }

    res.writeHead(404); res.end()
  })

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') setTimeout(() => server.listen(PORT, '127.0.0.1'), 2000)
    else console.error('[BubbleServer] error:', err)
  })

  server.listen(PORT, '127.0.0.1', () => console.log(`[BubbleServer] ready on 127.0.0.1:${PORT}`))
}

main().catch(e => { console.error('[BubbleServer] failed:', e); process.exit(1) })
