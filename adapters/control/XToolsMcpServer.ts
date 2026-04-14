/**
 * XToolsMcpServer — MCP stdio proxy for XTools.
 * SessionBrain spawns this as a child process and connects via MCP protocol.
 *
 * This process has NO PlaywrightXClient of its own.
 * All tool calls are forwarded to XToolsServer (HTTP, port 7821) which runs
 * inside the main BlopusAgent process and shares its PlaywrightXClient.
 * This means: always authenticated, no profile conflicts, no duplicate browsers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const XTOOLS_URL = 'http://127.0.0.1:7821/tool'

async function call(name: string, input: Record<string, any>): Promise<string> {
  try {
    const resp = await fetch(XTOOLS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, input }),
    })
    const data = await resp.json() as any
    return data.result ?? data.error ?? 'no response'
  } catch (e: any) {
    return `❌ XToolsServer unreachable: ${e.message?.slice(0, 80)}`
  }
}

const server = new McpServer({ name: 'xtools', version: '1.0.0' })

server.tool('post_tweet',
  'Post a new tweet in the owner\'s voice. topic = what to tweet about, angle = optional tone/angle.',
  { topic: z.string(), angle: z.string().optional() },
  async ({ topic, angle }) => ({
    content: [{ type: 'text' as const, text: await call('post_tweet', { topic, angle: angle ?? '' }) }]
  })
)

server.tool('reply_to_tweet',
  'Reply to a specific tweet by URL. Give the full tweet URL and your reply text.',
  { tweet_url: z.string(), text: z.string() },
  async ({ tweet_url, text }) => ({
    content: [{ type: 'text' as const, text: await call('reply_to_tweet', { tweet_url, text }) }]
  })
)

server.tool('get_user_tweets',
  'Get recent tweets/replies/likes/media from any X profile.',
  { handle: z.string(), count: z.number().optional(), type: z.enum(['tweets', 'replies', 'likes', 'media']).optional() },
  async ({ handle, count, type }) => ({
    content: [{ type: 'text' as const, text: await call('get_user_tweets', { handle, count: count ?? 5, type: type ?? 'tweets' }) }]
  })
)

server.tool('get_tweet',
  'Fetch a tweet\'s full text and image description without opening a reply box. Use when you need to understand tweet content or analyze an image before replying.',
  { tweet_url: z.string() },
  async ({ tweet_url }) => ({
    content: [{ type: 'text' as const, text: await call('get_tweet', { tweet_url }) }]
  })
)

server.tool('quote_tweet',
  'Quote tweet a specific tweet. Give the full tweet URL and your comment.',
  { tweet_url: z.string(), text: z.string() },
  async ({ tweet_url, text }) => ({
    content: [{ type: 'text' as const, text: await call('quote_tweet', { tweet_url, text }) }]
  })
)

server.tool('quote_tweet_from_feed',
  'Browse home timeline, pick a viral tweet, and quote tweet it in the owner\'s voice.',
  { topic_hint: z.string().optional() },
  async ({ topic_hint }) => ({
    content: [{ type: 'text' as const, text: await call('quote_tweet_from_feed', { topic_hint: topic_hint ?? '' }) }]
  })
)

server.tool('search_trending_and_reply',
  'Find trending viral tweets in a category and reply to them. category = topic like "AI", "tech", "Hollywood".',
  { category: z.string(), count: z.number().optional(), reply_angle: z.string().optional() },
  async ({ category, count, reply_angle }) => ({
    content: [{ type: 'text' as const, text: await call('search_trending_and_reply', { category, count: count ?? 1, reply_angle: reply_angle ?? 'sharp take, builder perspective' }) }]
  })
)

server.tool('search_and_reply',
  'Search tweets by keyword and reply to them.',
  { query: z.string(), count: z.number().optional(), reply_angle: z.string().optional() },
  async ({ query, count, reply_angle }) => ({
    content: [{ type: 'text' as const, text: await call('search_and_reply', { query, count: count ?? 1, reply_angle: reply_angle ?? 'sharp take' }) }]
  })
)

server.tool('find_viral_and_act',
  'Find viral tweets by conditions and reply/quote in owner\'s voice. Use for "reply to 3 AI tweets", "find politics 1M+ views and quote", "2 AI replies and 2 politics replies" (call twice). topic is optional — omit for any viral tweet.',
  { topic: z.string().optional(), count: z.number().optional(), action: z.enum(['reply', 'quote', 'both']).optional(), min_views: z.number().optional(), max_age_hours: z.number().optional() },
  async ({ topic, count, action, min_views, max_age_hours }) => ({
    content: [{ type: 'text' as const, text: await call('find_viral_and_act', { topic: topic ?? '', count: count ?? 3, action: action ?? 'reply', min_views: min_views ?? 500000, max_age_hours: max_age_hours ?? 12 }) }]
  })
)

server.tool('send_dm',
  'Send a direct message to any X user.',
  { handle: z.string(), message: z.string() },
  async ({ handle, message }) => ({
    content: [{ type: 'text' as const, text: await call('send_dm', { handle, message }) }]
  })
)

server.tool('read_dm_inbox',
  'Read DM inbox — returns all conversations with last message and unread status.',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: await call('read_dm_inbox', {}) }]
  })
)

server.tool('read_dm_thread',
  'Read the full DM conversation thread with a specific user. Use before send_dm to get context.',
  { handle: z.string() },
  async ({ handle }) => ({
    content: [{ type: 'text' as const, text: await call('read_dm_thread', { handle }) }]
  })
)

server.tool('control_autonomous',
  'Pause or resume autonomous posting. action = "pause" or "resume", hours = optional duration.',
  { action: z.enum(['pause', 'resume']), hours: z.number().optional() },
  async ({ action, hours }) => ({
    content: [{ type: 'text' as const, text: await call('control_autonomous', { action, hours }) }]
  })
)

server.tool('get_status',
  'Get current OsBot status — what it has been doing, daily counts, config.',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: await call('get_status', {}) }]
  })
)

server.tool('like_tweet',
  'Like one or more tweets by URL.',
  { tweet_urls: z.array(z.string()) },
  async ({ tweet_urls }) => ({
    content: [{ type: 'text' as const, text: await call('like_tweet', { tweet_urls }) }]
  })
)

const transport = new StdioServerTransport()
server.connect(transport)
console.error('[XToolsMcpServer] ready — proxying to XToolsServer :7821')
