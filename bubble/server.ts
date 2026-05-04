/**
 * Bubble brain server — wraps SessionBrain over HTTP.
 * Spawned by bubble/main.js on startup.
 * Listens on 127.0.0.1:3847.
 */

import 'dotenv/config'
import http from 'http'
import path from 'path'

process.env.BLOPUS_DIR = path.resolve(__dirname, '..')

import { SessionBrain } from '../adapters/control/SessionBrain'

const brain = new SessionBrain()
const CHAT_ID = 'bubble'
const PORT    = 3847

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
      const response = await brain.process(CHAT_ID, message)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response }))
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e?.message ?? 'unknown error' }))
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[BubbleServer] ready on 127.0.0.1:${PORT}`)
})
