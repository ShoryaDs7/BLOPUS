/**
 * do_morning_brief.ts
 *
 * Fetches the last 5 posts from @openocta via Twitter API v2,
 * checks likes + replies on each, reads current mood from MemoryEngine,
 * then sends a full morning summary to the owner via Telegram.
 *
 * Usage:
 *   npx ts-node scripts/do_morning_brief.ts
 */

import 'dotenv/config'
import { TwitterApi, TweetV2 } from 'twitter-api-v2'
import { MemoryEngine } from '../core/memory/MemoryEngine'

// ---------------------------------------------------------------------------
// Telegram helper — direct Bot API call, no grammy overhead needed
// ---------------------------------------------------------------------------

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telegram API error ${res.status}: ${body}`)
  }
}

// ---------------------------------------------------------------------------
// Fetch last 5 own posts with public metrics via Twitter API v2
// ---------------------------------------------------------------------------

interface PostMetrics {
  tweetId: string
  text: string
  likes: number
  replies: number
  retweets: number
  createdAt: string
}

async function fetchRecentPosts(botUserId: string): Promise<PostMetrics[]> {
  const client = new TwitterApi({
    appKey:      process.env.TWITTER_API_KEY!,
    appSecret:   process.env.TWITTER_API_SECRET!,
    accessToken: process.env.TWITTER_ACCESS_TOKEN!,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET!,
  })

  console.log('[morning-brief] Fetching @openocta timeline via API...')

  const response = await client.v2.userTimeline(botUserId, {
    max_results: 5,
    exclude: ['retweets', 'replies'],
    'tweet.fields': ['public_metrics', 'created_at', 'text'],
  } as Parameters<typeof client.v2.userTimeline>[1])

  const tweets: TweetV2[] = response.data.data ?? []
  console.log(`[morning-brief] Got ${tweets.length} tweets`)

  return tweets.map(t => {
    const m = t.public_metrics
    return {
      tweetId: t.id,
      text: t.text,
      likes:    m?.like_count     ?? 0,
      replies:  m?.reply_count    ?? 0,
      retweets: m?.retweet_count  ?? 0,
      createdAt: t.created_at ?? '',
    }
  })
}

// ---------------------------------------------------------------------------
// Build message
// ---------------------------------------------------------------------------

function buildMessage(
  mood: string,
  moodSince: Date,
  repliesToday: number,
  monthlyUsage: number,
  posts: PostMetrics[],
): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
  const moodSinceStr = moodSince.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })

  const lines: string[] = [
    `☀️ <b>Morning Brief — ${dateStr}</b>`,
    ``,
    `<b>mood:</b> ${mood}`,
    `<b>mood since:</b> ${moodSinceStr}`,
    `<b>replies today:</b> ${repliesToday}`,
    `<b>monthly usage:</b> ${monthlyUsage}`,
    ``,
    `<b>@openocta — last 5 posts</b>`,
  ]

  if (posts.length === 0) {
    lines.push(`no posts found`)
  } else {
    for (const [i, p] of posts.entries()) {
      const preview = p.text.length > 80 ? p.text.slice(0, 80) + '…' : p.text
      const postedAt = p.createdAt
        ? new Date(p.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        : ''
      lines.push(``)
      lines.push(`${i + 1}. "${preview}"`)
      lines.push(`   ❤️ ${p.likes}  💬 ${p.replies}  🔁 ${p.retweets}${postedAt ? `  · ${postedAt}` : ''}`)
      lines.push(`   x.com/openocta/status/${p.tweetId}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Memory
  const memory = new MemoryEngine('./memory-store/memory.json')
  const mood = memory.getMood()
  const moodSince = memory.getMoodUpdatedAt()
  const { repliesToday, monthlyUsage } = memory.getDailyStats()

  console.log(`[morning-brief] mood=${mood}, repliesToday=${repliesToday}, monthly=${monthlyUsage}`)

  // Fetch posts via Twitter API
  const botUserId = '2026254461946208257' // @openocta userId from config
  const posts = await fetchRecentPosts(botUserId)

  // Build + print preview
  const message = buildMessage(mood, moodSince, repliesToday, monthlyUsage, posts)
  console.log('\n--- MESSAGE PREVIEW ---')
  console.log(message)
  console.log('-----------------------\n')

  // Send to Telegram
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set in .env')

  await sendTelegram(token, chatId, message)
  console.log('✅ Morning brief sent to Telegram.')
}

main().catch(err => {
  console.error('[morning-brief] Fatal error:', err)
  process.exit(1)
})
