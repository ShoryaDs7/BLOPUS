/**
 * XToolsServer — tiny local HTTP server exposing XTools to SessionBrain.
 * Runs inside the main Blopus process so it shares the same PlaywrightXClient.
 * SessionBrain calls it via Bash: curl http://localhost:7821/tool -d '{"name":"...","input":{...}}'
 */

import http from 'http'
import { XTools } from './XTools'

let server: http.Server | null = null

export function startXToolsServer(xtools: XTools, port = 7821): void {
  server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/tool') {
      res.writeHead(404)
      res.end('not found')
      return
    }

    let body = ''
    for await (const chunk of req) body += chunk

    try {
      const { name, input } = JSON.parse(body)
      const result = await xtools.execute(name, input)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ result }))
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`[XToolsServer] listening on http://127.0.0.1:${port}`)
  })
}
