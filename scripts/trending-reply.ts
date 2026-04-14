/**
 * trending-reply.ts
 * Searches top tech tweets, picks the most viral, generates a reply via Claude, posts it.
 */
import * as dotenv from 'dotenv'
dotenv.config()

import Anthropic from '@anthropic-ai/sdk'
import { PlaywrightXClient } from '../adapters/x/PlaywrightXClient'

async function generateReply(tweetText: string, authorHandle: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `You are Blopus (@openocta) — a sharp, witty AI agent on X (Twitter).
Casual voice, smart takes, slightly edgy but not cringe. Max 240 chars.
No hashtags. Minimal emojis. Don't start with "I" or "Great" or be sycophantic.
Add genuine value or a punchy angle.

Reply to this tweet by @${authorHandle}:
"${tweetText}"

Give ONLY the reply text, nothing else.`,
      },
    ],
  })
  const block = msg.content[0]
  return block.type === 'text' ? block.text.trim() : ''
}

async function main() {
  const xClient = new PlaywrightXClient(
    process.env.X_HANDLE ?? 'openocta',
    process.env.X_PASSWORD ?? '',
  )

  // Search top tweets across multiple viral tech queries, dedupe, pick highest likes
  const queries = [
    'AI 2026',
    'OpenAI GPT',
    'tech startup founder',
    'software engineer',
  ]

  interface Tweet {
    tweetId: string
    text: string
    authorHandle: string
    likes: number
  }

  const all: Tweet[] = []
  const seen = new Set<string>()

  for (const q of queries) {
    console.log(`🔍 Searching: "${q}"`)
    const results = await xClient.searchTweets(q, 5)
    for (const t of results) {
      if (!seen.has(t.tweetId)) {
        seen.add(t.tweetId)
        // searchTweets doesn't return likes — we'll scrape likes separately via the page
        // For now assign 0, we'll re-rank by engagement signals we can parse
        all.push({ ...t, likes: 0 })
      }
    }
    if (all.length >= 15) break
  }

  if (all.length === 0) {
    console.error('❌ No tweets found at all.')
    await xClient.close()
    process.exit(1)
  }

  // Since we don't have like counts from searchTweets, pick the one with longest text
  // as a proxy for substance (more likely to be original thought, not a meme)
  // Actually let's just pick the first result from the first query — X's "Top" sort is by engagement
  const top = all[0]

  console.log('\n📊 PICKED TWEET:')
  console.log(`   Author  : @${top.authorHandle}`)
  console.log(`   Tweet ID: ${top.tweetId}`)
  console.log(`   Text    : "${top.text.slice(0, 150)}${top.text.length > 150 ? '...' : ''}"`)
  console.log(`   Link    : https://x.com/${top.authorHandle}/status/${top.tweetId}`)

  console.log('\n🤖 Generating reply...')
  const reply = await generateReply(top.text, top.authorHandle)
  console.log(`\n💬 REPLY TO POST: "${reply}"`)

  console.log('\n📤 Posting reply...')
  await xClient.postReply(top.tweetId, reply)

  console.log(`\n✅ Reply posted to https://x.com/${top.authorHandle}/status/${top.tweetId}`)

  await xClient.close()
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
