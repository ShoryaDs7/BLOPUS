/**
 * backfillParentTweets.ts
 *
 * For every person in PersonMemoryStore where all conversations are one-sided
 * (only "owner" messages, no "them" replies), fetch the original tweet text
 * using Playwright and prepend it as the "them" message in each conversation.
 *
 * This fills in the missing context: instead of just seeing "you replied: X",
 * you see "their tweet: Y → you replied: X"
 *
 * Run: npx ts-node scripts/backfillParentTweets.ts
 * Safe to re-run — skips conversations that already have a "them" message.
 */

import * as dotenv from 'dotenv'
dotenv.config({ path: './creators/openocta/.env' })
dotenv.config({ path: './.env', override: false })

import fs from 'fs'
import path from 'path'
import { chromium, BrowserContext } from 'playwright'

const PERSONS_DIR = path.resolve('./creators/memory-store/persons')
const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile')
const DELAY_MS = 2000         // delay between fetches — be gentle
const MAX_PER_RUN = 200       // cap per run so it doesn't take forever

interface Message {
  by: 'owner' | 'them'
  text: string
  timestamp: string
  tweetId?: string
  platform: string
}

interface Conversation {
  id: string
  startedAt: string
  lastMessageAt: string
  topic: string
  messages: Message[]
}

interface PersonFile {
  handle: string
  conversations: Conversation[]
  [key: string]: any
}

async function fetchTweetText(context: BrowserContext, tweetId: string): Promise<string | null> {
  const page = await context.newPage()
  try {
    await page.goto(`https://x.com/i/web/status/${tweetId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    })
    await page.waitForTimeout(3000)

    // Get the first tweet article on the page (the main tweet, not replies)
    const text = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]')
      for (const article of articles) {
        // Skip if it says "Replying to" — that's a reply, not the main tweet
        const textEl = article.querySelector('[data-testid="tweetText"]')
        if (textEl) {
          return (textEl as HTMLElement).innerText || textEl.textContent || ''
        }
      }
      return null
    }) as string | null

    if (text && text.length > 5) {
      return text.trim()
    }
    return null
  } catch (e) {
    console.warn(`  [skip] Failed to fetch tweet ${tweetId}: ${(e as Error).message.slice(0, 60)}`)
    return null
  } finally {
    await page.close()
  }
}

async function main() {
  // Inject @openocta cookies
  const authToken = process.env.X_AUTH_TOKEN
  const ct0 = process.env.X_CT0
  if (!authToken || !ct0) {
    console.error('Missing X_AUTH_TOKEN or X_CT0 in .env')
    process.exit(1)
  }

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: ['--no-sandbox'],
  })

  // Inject cookies
  await context.addCookies([
    { name: 'auth_token', value: authToken, domain: '.x.com', path: '/' },
    { name: 'ct0', value: ct0, domain: '.x.com', path: '/' },
  ])

  const files = fs.readdirSync(PERSONS_DIR).filter(f => f.endsWith('.json') && f !== '_index.json')
  console.log(`Found ${files.length} person files`)

  let processed = 0
  let skipped = 0
  let fetched = 0
  let failed = 0

  for (const file of files) {
    if (processed >= MAX_PER_RUN) {
      console.log(`\nReached cap of ${MAX_PER_RUN}. Re-run to continue.`)
      break
    }

    const filePath = path.join(PERSONS_DIR, file)
    const data: PersonFile = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const handle = data.handle

    let fileChanged = false

    for (const conv of data.conversations) {
      // Skip if already has a "them" message
      const hasTheirMessage = conv.messages.some(m => m.by === 'them')
      if (hasTheirMessage) { skipped++; continue }

      // The conversation id is the tweet ID of the tweet being replied to
      const parentTweetId = conv.id
      if (!parentTweetId || parentTweetId.length < 5) { skipped++; continue }

      console.log(`@${handle} conv ${parentTweetId} — fetching parent tweet...`)
      const tweetText = await fetchTweetText(context, parentTweetId)

      if (tweetText) {
        // Prepend their tweet as the first message in the conversation
        const theirMessage: Message = {
          by: 'them',
          text: tweetText,
          timestamp: conv.startedAt,
          tweetId: parentTweetId,
          platform: 'x',
        }
        conv.messages.unshift(theirMessage)
        fileChanged = true
        fetched++
        console.log(`  ✓ Got: "${tweetText.slice(0, 80)}..."`)
      } else {
        failed++
        console.log(`  ✗ Could not fetch`)
      }

      processed++
      await new Promise(r => setTimeout(r, DELAY_MS))

      if (processed >= MAX_PER_RUN) break
    }

    if (fileChanged) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
      console.log(`  Saved ${file}`)
    }
  }

  await context.close()

  console.log(`\n=== Done ===`)
  console.log(`Fetched: ${fetched} parent tweets`)
  console.log(`Failed:  ${failed}`)
  console.log(`Skipped (already had their message): ${skipped}`)
  console.log(`Processed: ${processed}/${MAX_PER_RUN} cap`)
}

main().catch(e => { console.error(e); process.exit(1) })
