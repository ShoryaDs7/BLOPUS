/**
 * Bubble brain server — wraps SessionBrain over HTTP.
 * Spawned by bubble/main.js on startup.
 * Listens on 127.0.0.1:3847.
 */

import http from 'http'
import path from 'path'
import fs   from 'fs'

// Set BLOPUS_DIR BEFORE any other imports that read it
const BLOPUS_DIR = path.resolve(__dirname, '..')
process.env.BLOPUS_DIR = BLOPUS_DIR

// Load .env from Blopus root
import { config } from 'dotenv'
config({ path: path.join(BLOPUS_DIR, '.env') })

const PORT = 3847

async function main() {
  // Dynamic import so SessionBrain sees BLOPUS_DIR + env already set
  const { SessionBrain } = await import('../adapters/control/SessionBrain')
  const brain = new SessionBrain()
  const CHAT_ID = 'bubble'

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method !== 'POST' || req.url !== '/message') {
      res.writeHead(404); res.end(); return
    }

    let body = ''
    req.on('data', d => body += d)
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body)
        console.log(`[BubbleServer] message: ${message.slice(0, 60)}`)
        const response = await brain.process(CHAT_ID, message)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ response }))
      } catch (e: any) {
        console.error(`[BubbleServer] error:`, e)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e?.message ?? 'unknown error' }))
      }
    })
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[BubbleServer] ready on 127.0.0.1:${PORT}`)
  })
}

main().catch(e => {
  console.error('[BubbleServer] failed to start:', e)
  process.exit(1)
})
