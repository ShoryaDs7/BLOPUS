#!/usr/bin/env node
/**
 * x-cli — pre-built X action CLI. Zero temp files, zero compilation overhead.
 *
 * Claude calls this directly instead of writing TypeScript every time.
 *
 * Usage (always from C:/Blopus, with correct .env already loaded):
 *   npx tsx tools/x-cli.ts post    <handle> "<tweet text>"
 *   npx tsx tools/x-cli.ts reply   <handle> <tweetId> "<reply text>"
 *   npx tsx tools/x-cli.ts quote   <handle> <tweetId> "<quote text>"
 *   npx tsx tools/x-cli.ts search  <handle> "<query>" [limit]
 *   npx tsx tools/x-cli.ts profile <handle> <targetHandle> [limit]
 *
 * <handle> = the X account to act as (loads cookies from creators/<handle>/.env)
 *
 * Output: prints result JSON to stdout.
 * Errors: prints { error: "..." } to stdout (never throws).
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'
import { PlaywrightXClient } from '../adapters/x/PlaywrightXClient'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')

function loadEnvForHandle(handle: string): void {
  const envPath = path.join(BLOPUS_DIR, 'creators', handle.replace(/^@/, ''), '.env')
  dotenv.config({ path: envPath, override: true })
}

async function main() {
  const [,, action, handle, ...rest] = process.argv

  if (!action || !handle) {
    console.log(JSON.stringify({ error: 'usage: x-cli <action> <handle> [...args]' }))
    process.exit(1)
  }

  loadEnvForHandle(handle)
  const password = process.env.X_PASSWORD ?? ''
  const client = new PlaywrightXClient(handle, password)

  try {
    switch (action) {

      case 'post': {
        const text = rest[0]
        if (!text) { console.log(JSON.stringify({ error: 'post requires <text>' })); break }
        await client.postTweet(text)
        console.log(JSON.stringify({ ok: true, action: 'post', handle, preview: text.slice(0, 60) }))
        break
      }

      case 'reply': {
        const [tweetId, text] = rest
        if (!tweetId || !text) { console.log(JSON.stringify({ error: 'reply requires <tweetId> <text>' })); break }
        await client.postReply(tweetId, text)
        console.log(JSON.stringify({ ok: true, action: 'reply', handle, tweetId, preview: text.slice(0, 60) }))
        break
      }

      case 'quote': {
        const [tweetId, text] = rest
        if (!tweetId || !text) { console.log(JSON.stringify({ error: 'quote requires <tweetId> <text>' })); break }
        await client.quoteTweet(tweetId, text)
        console.log(JSON.stringify({ ok: true, action: 'quote', handle, tweetId, preview: text.slice(0, 60) }))
        break
      }

      case 'search': {
        const [query, limitStr] = rest
        if (!query) { console.log(JSON.stringify({ error: 'search requires <query>' })); break }
        const limit = parseInt(limitStr ?? '5')
        const tweets = await client.searchTweets(query, limit)
        console.log(JSON.stringify({ ok: true, action: 'search', results: tweets }))
        break
      }

      case 'profile': {
        const [targetHandle, limitStr] = rest
        if (!targetHandle) { console.log(JSON.stringify({ error: 'profile requires <targetHandle>' })); break }
        const limit = parseInt(limitStr ?? '5')
        const tweets = await client.searchTweets(`from:${targetHandle}`, limit)
        console.log(JSON.stringify({ ok: true, action: 'profile', targetHandle, results: tweets }))
        break
      }

      default:
        console.log(JSON.stringify({ error: `unknown action: ${action}. valid: post reply quote search profile` }))
    }
  } catch (err: any) {
    console.log(JSON.stringify({ error: err.message ?? String(err) }))
  }

  process.exit(0)
}

main()
