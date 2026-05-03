/**
 * XTools — all X actions OsBot can take when commanded via Telegram.
 *
 * These are the "hands" of OsBot. Claude (the brain) decides which
 * tool to call based on what the user says. Each tool does one thing
 * on X and returns a result string.
 *
 * Adding a new capability = add one tool here. Claude handles the rest.
 */

import Anthropic from '@anthropic-ai/sdk'
import { blockLeak, interceptThreat } from '../security/SecurityShield'
import { XAdapter } from '../x/XAdapter'
import { PlaywrightXClient } from '../x/PlaywrightXClient'
import { LLMReplyEngine } from '../../core/personality/LLMReplyEngine'
import { PersonalityProfile } from '../../core/personality/LLMReplyEngine'
import { PlaywrightDomainSearchProvider } from '../x/PlaywrightDomainSearchProvider'
import { ExampleRetriever } from '../../core/rag/ExampleRetriever'
import { BrowserAgent } from './BrowserAgent'
import { MCPBrowserDM } from '../../agent/MCPBrowserDM'
import { TavilyClient } from '../search/TavilyClient'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { TaskRunner } from '../../agent/TaskRunner'
import { ScheduleStore } from './ScheduleStore'

function sanitizeUnicode(s: string): string {
  return s.replace(/[\uD800-\uDFFF]/g, () => '')
}
import { writeRuntimeConfig, readRuntimeConfig } from './RuntimeConfig'
import { execSync } from 'child_process'

const BLOPUS_DIR = path.resolve(process.env.BLOPUS_DIR ?? '.')
const NPX_CMD = (() => {
  try { return execSync('where npx', { encoding: 'utf8' }).trim().split('\n')[0].trim() } catch {}
  try { return execSync('which npx', { encoding: 'utf8' }).trim() } catch {}
  return 'npx'
})()
import { PlaywrightWebScraper } from '../web/PlaywrightWebScraper'
import { appendEvent } from '../../core/memory/GlobalEventLog'

export interface XToolsOptions {
  xAdapter: XAdapter
  playwrightClient: PlaywrightXClient
  profile: PersonalityProfile
  configPath: string
  ragIndexPath?: string    // path to rag_index.json — enables voice-matched replies
  archivePath?: string     // path to tweets.js — used to build RAG if index missing
  mcpDm?: MCPBrowserDM
}

// Tool definitions Claude sees — these describe what each tool does
export const X_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'reply_to_tweet',
    description: 'Reply to a specific tweet by URL in the owner\'s exact voice. If you provide text, that text is posted. If you omit text, the reply is auto-generated from the owner\'s voice profile. Use when you have a specific tweet URL to reply to.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet_url: { type: 'string', description: 'Full tweet URL, e.g. https://x.com/user/status/123456789' },
        text: { type: 'string', description: 'Optional reply text. Omit to auto-generate in owner\'s voice.' },
      },
      required: ['tweet_url'],
    },
  },
  {
    name: 'search_and_reply',
    description: 'Search for tweets by keyword/topic and reply to them. Use for "reply to tweets about X", "engage with trending tech posts", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (e.g. "AI agents", "tech startup launch")' },
        count: { type: 'number', description: 'How many tweets to reply to (max 10)' },
        reply_angle: { type: 'string', description: 'What angle/tone to reply with. E.g. "supportive builder perspective", "hint at building a startup", "neutral tech opinion"' },
      },
      required: ['query', 'count', 'reply_angle'],
    },
  },
  {
    name: 'post_tweet',
    description: 'Post a new tweet. Use for "tweet about X", "post something about my startup", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'What to tweet about' },
        angle: { type: 'string', description: 'Specific angle or message. E.g. "hint at building something in AI space"' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'search_trending_and_reply',
    description: 'Find trending tweets in a category and reply to them. Use for "reply to trending tech", "engage with what is trending in AI right now".',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Category to search (e.g. "technology", "AI", "startups")' },
        count: { type: 'number', description: 'How many trending tweets to reply to (max 10)' },
        reply_angle: { type: 'string', description: 'What angle to reply with' },
      },
      required: ['category', 'count', 'reply_angle'],
    },
  },
  {
    name: 'update_autonomous_focus',
    description: 'Change what topics OsBot focuses on for its autonomous activity. Use for "focus more on tech this week", "avoid politics", "hint at my startup in replies".',
    input_schema: {
      type: 'object' as const,
      properties: {
        topics: { type: 'array', items: { type: 'string' }, description: 'Topics to focus on' },
        instruction: { type: 'string', description: 'Special instruction for autonomous behavior. E.g. "subtly hint at building a startup in AI space"' },
        duration_days: { type: 'number', description: 'How many days to keep this focus (default 7)' },
      },
      required: ['topics'],
    },
  },
  {
    name: 'get_status',
    description: 'Get current OsBot activity stats — replies sent, rate limits, what it has been doing.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'browse_x',
    description: 'Navigate X (Twitter) only — view profiles, read tweets, check notifications, summarize feeds. ONLY for x.com tasks. Never use this for scraping other websites — use scrape_website instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Plain English task. E.g. "go to @elonmusk profile and summarize his last 5 tweets today" or "check my notifications and tell me who replied"' },
      },
      required: ['task'],
    },
  },
  {
    name: 'get_user_tweets',
    description: 'Get recent tweets/replies/likes/media from any X profile. Use when asked to browse a profile, find latest tweet, check what someone replied, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'X handle without @, e.g. "elonmusk"' },
        count: { type: 'number', description: 'Number of items to return (default 5, max 10)' },
        type: { type: 'string', enum: ['tweets', 'replies', 'likes', 'media'], description: 'What to fetch: tweets (default), replies, likes, or media' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'get_tweet',
    description: 'Fetch a tweet\'s full text and image description WITHOUT opening a reply box. Use this FIRST when the task requires understanding the tweet content or image before replying/quoting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet_url: { type: 'string', description: 'Full tweet URL, e.g. https://x.com/user/status/123456789' },
      },
      required: ['tweet_url'],
    },
  },
  {
    name: 'quote_tweet',
    description: 'Quote tweet a SPECIFIC tweet you already have the URL for. Use ONLY when user gives you a URL or specific tweet. For random/autonomous QT use quote_tweet_from_feed instead.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet_url: { type: 'string', description: 'Full tweet URL, e.g. https://x.com/user/status/123456789' },
        text: { type: 'string', description: 'Your comment to add on top of the quote tweet' },
      },
      required: ['tweet_url', 'text'],
    },
  },
  {
    name: 'quote_tweet_from_feed',
    description: 'Browse home timeline, pick a good viral tweet, generate a sharp comment in the owner\'s voice, and quote tweet it. Use when user says "post a random quote tweet", "QT something from my feed", "quote tweet randomly", "find something to QT".',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic_hint: { type: 'string', description: 'Optional topic to prefer (e.g. "AI", "startups"). Leave empty to pick freely from feed.' },
      },
      required: [],
    },
  },
  {
    name: 'update_config',
    description: 'Change OsBot runtime settings live — no restart needed. Use for "change daily cap to 20", "set cooldown to 5 minutes", "set min likes to 1000", "change post interval to 6 hours", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        maxRepliesPerDay: { type: 'number', description: 'Max viral replies per day' },
        cooldownMinutes: { type: 'number', description: 'Min minutes between viral replies' },
        minLikes: { type: 'number', description: 'Min likes for a tweet to be considered viral' },
        maxAgeTweetMinutes: { type: 'number', description: 'Max age of tweet in minutes to reply to' },
        consecutiveTopicLimit: { type: 'number', description: 'How many same-topic replies before forcing a topic change' },
        maxAutonomousPostsPerDay: { type: 'number', description: 'Max autonomous posts per day' },
        minPostIntervalHours: { type: 'number', description: 'Min hours between autonomous posts' },
      },
      required: [],
    },
  },
  {
    name: 'read_dm_inbox',
    description: 'Read the DM inbox — returns list of conversations with last message snippet and whether they are unread. Use when user says "check my DMs", "any unread DMs?", "who messaged me?".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'read_dm_thread',
    description: 'Read the full conversation thread with a specific user — returns last N messages (who said what). Use BEFORE send_dm when responding to someone, so you have full context of what was said.',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'X handle of the person whose DM thread to read, e.g. "elonmusk"' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'send_dm',
    description: 'Send a direct message to any X user. Use when asked to "DM @username", "message @someone", "send a DM to @handle saying...".',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'X handle to DM, e.g. "elonmusk" or "@elonmusk"' },
        message: { type: 'string', description: 'The message text to send' },
      },
      required: ['handle', 'message'],
    },
  },
  {
    name: 'find_viral_and_act',
    description: 'Find viral tweets matching conditions and reply/quote them in the owner\'s voice. Use when asked to "reply to 3 AI tweets", "find politics tweets with 1M views and reply", "quote 2 viral tweets", "post 4 AI replies and 2 politics replies", etc. Can handle multiple topic+count combos in one call.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Topic to search (e.g. "AI", "politics", "crypto"). Omit to pick any viral tweets from home feed.' },
        count: { type: 'number', description: 'How many tweets to act on (default 3, max 10)' },
        action: { type: 'string', enum: ['reply', 'quote', 'both'], description: '"reply" to post a reply, "quote" to quote tweet, "both" to do both on each tweet. Default: reply.' },
        min_views: { type: 'number', description: 'Minimum likes the tweet must have. Default 1000. Only set higher if user explicitly asks for "viral" or "trending".' },
        max_age_hours: { type: 'number', description: 'Max age of tweet in hours (default 24)' },
      },
      required: [],
    },
  },
  {
    name: 'control_autonomous',
    description: 'Pause or resume OsBot\'s automatic background posting and replies. Use for "stop posting today", "pause for 6 hours", "pause for 2 days", "resume posting".',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['pause', 'resume'], description: '"pause" to stop all autonomous activity, "resume" to restart it' },
        hours: { type: 'number', description: 'How many hours to pause. Omit to pause indefinitely until you say resume.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'like_tweet',
    description: 'Like one or more specific tweets by URL. Use when asked to "like this tweet", "like @user\'s tweet", "heart this post".',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet_urls: { type: 'array', items: { type: 'string' }, description: 'List of full tweet URLs to like' },
      },
      required: ['tweet_urls'],
    },
  },
  {
    name: 'retweet_tweet',
    description: 'Retweet a specific tweet by URL. Use when asked to "retweet this", "RT this tweet", "share this to my feed".',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet_url: { type: 'string', description: 'Full tweet URL to retweet' },
      },
      required: ['tweet_url'],
    },
  },
  {
    name: 'find_and_like',
    description: 'Find tweets and like them. Pass topic to search any specific subject (e.g. "religion", "civic sense", "AI"). Omit topic to use owner\'s configured like-domains automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'How many tweets to like (default 3, max 5)' },
        topic: { type: 'string', description: 'Optional topic override. E.g. "religion politics", "civic sense", "humor". Omit to use profile default.' },
      },
      required: [],
    },
  },
  {
    name: 'find_and_retweet',
    description: 'Find tweets and retweet one. Pass topic to search any specific subject. Omit topic to use owner\'s configured retweet-domains automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        count: { type: 'number', description: 'How many tweets to retweet (default 1, max 3)' },
        topic: { type: 'string', description: 'Optional topic override. E.g. "politics", "AI", "cricket". Omit to use profile default.' },
      },
      required: [],
    },
  },
  {
    name: 'follow_user',
    description: 'Follow an X user by handle. HIGH RISK — X locks accounts for rapid follows. Only use when user explicitly asks to follow someone. Max 1 follow per 10 minutes enforced automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'Twitter handle to follow, with or without @' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'do',
    description: 'Run any multi-step task given as plain English. Use this for scheduled tasks that need multiple actions in sequence — e.g. "build website, send email, create PDF, deploy". Claude will work through every step and return a full summary.',
    input_schema: {
      type: 'object' as const,
      properties: {
        instruction: { type: 'string', description: 'Full plain English instruction of everything to do, in order.' },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'schedule_task',
    description: 'Schedule a one-time or recurring task. The task calls any other XTool at the scheduled time and sends the result to Telegram. Use for "post every day at 9am", "like tweets at 8pm daily", "do this at 10am tomorrow". Convert natural language time to a cron expression before calling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'Human-readable description of what this task does. E.g. "post tweet about AI every morning"' },
        tool: { type: 'string', description: 'Name of the XTool to call when this task fires. E.g. "post_tweet", "find_and_like", "find_viral_and_act"' },
        tool_input: { type: 'string', description: 'JSON string of the input to pass to the tool. E.g. \'{"topic":"AI","angle":"hot take"}\' for post_tweet.' },
        cron: { type: 'string', description: 'Cron expression for when to run. Examples: "0 9 * * *" = every day 9am, "0 20 * * *" = every day 8pm, "0 9 28 4 *" = once on Apr 28 at 9am. Use 24h UTC unless owner specifies timezone.' },
        one_time: { type: 'boolean', description: 'true = run once then delete. false = repeat on schedule. Default false.' },
      },
      required: ['description', 'tool', 'tool_input', 'cron'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks — shows what is scheduled, when, and whether one-time or recurring. Use for "what tasks are scheduled", "show my scheduled posts".',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task by its ID. Use for "cancel that task", "remove the 9am post", "stop the daily summary".',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'The task ID to cancel (get from list_tasks)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_post_analytics',
    description: 'Get engagement stats (views, likes, replies, reposts) for one or more tweets. Use for "how did my last tweet do?", "which post performed best?", "show analytics for recent posts". Chain with get_user_tweets to analyze recent posts without needing URLs from the user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tweet_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more full tweet URLs to check. Get these from get_user_tweets if you don\'t have them.',
        },
      },
      required: ['tweet_urls'],
    },
  },
  {
    name: 'scrape_website',
    description: 'Go to any website, fill in form fields, submit, click through all tabs/sections and return all extracted data. Use when asked to "scrape this site", "get my kundli", "fill this form", "check this website", etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL of the website to scrape' },
        fields: {
          type: 'array',
          description: 'Form fields to fill. Each item has a label (field name/label on the page) and value.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Field label or name as shown on the page' },
              value: { type: 'string', description: 'Value to fill in' },
            },
            required: ['label', 'value'],
          },
        },
      },
      required: ['url'],
    },
  },
]

export class XTools {
  private xAdapter: XAdapter
  private playwrightClient: PlaywrightXClient
  private profile: PersonalityProfile
  private configPath: string
  private llmEngine: LLMReplyEngine
  private mcpDm?: MCPBrowserDM
  private lastFollowAt = 0  // timestamp of last follow — enforce min gap
  private taskRunner?: TaskRunner

  setTaskRunner(runner: TaskRunner): void {
    this.taskRunner = runner
  }


  constructor(options: XToolsOptions) {
    this.xAdapter = options.xAdapter
    this.playwrightClient = options.playwrightClient
    this.profile = options.profile
    this.configPath = options.configPath
    this.mcpDm = options.mcpDm

    // Build RAG retriever if index path provided — enables voice-matched replies
    let ragRetriever: ExampleRetriever | undefined
    if (options.ragIndexPath) {
      ragRetriever = new ExampleRetriever(options.ragIndexPath)
      ragRetriever.load(options.archivePath)
      if (options.profile.signaturePatterns) {
        ragRetriever.setSignaturePatterns(options.profile.signaturePatterns)
      }
    }

    this.llmEngine = new LLMReplyEngine(
      process.env.OWNER_HANDLE ?? 'owner',
      'chill' as any,
      { defense: [], generic: [] },
      { model: 'claude-sonnet-4-6', maxTokens: 280, temperature: 1.0, enabled: true },
      options.profile,
      true,
      ragRetriever,
    )
  }

  async execute(toolName: string, input: Record<string, any>): Promise<string> {
    console.log(`[XTools] Executing: ${toolName}`, input)

    try {
      switch (toolName) {
        case 'get_user_tweets':
          return await this.getUserTweets(input.handle, input.count ?? 5, input.type ?? 'tweets')

        case 'reply_to_tweet': {
          const m = (input.tweet_url ?? '').match(/\/status\/(\d+)/)
          if (!m) return 'invalid tweet URL'
          let replyText: string = input.text ?? ''
          // If no text provided, fetch tweet and generate in owner's voice via RAG
          if (!replyText) {
            const tweetContent = await this.getTweet(input.tweet_url).catch(() => '')
            const tweetText = tweetContent.replace(/^Tweet text:\s*/i, '').split('\nImage:')[0].trim()
            if (tweetText) {
              const generated = await this.llmEngine.generateViralReply(
                { text: tweetText, authorHandle: 'user' },
                'chill' as any,
                false,
              )
              replyText = generated || ''
            }
            if (!replyText) return '❌ Could not generate reply — tweet not found or voice generation failed'
          }
          if (!await blockLeak(replyText, 'reply_to_tweet')) return '❌ Blocked by output firewall — potential credential leak detected'
          await this.playwrightClient.postReply(m[1], replyText)
          appendEvent({ platform: 'x', type: 'reply', text: replyText })
          return `✅ Replied to ${input.tweet_url}: "${replyText.slice(0, 80)}"`
        }

        case 'search_and_reply':
          return await this.searchAndReply(input.query, input.count ?? 3, input.reply_angle)

        case 'post_tweet':
          return await this.postTweet(input.topic, input.angle ?? '')

        case 'search_trending_and_reply':
          return await this.searchTrendingAndReply(input.category, input.count ?? 3, input.reply_angle)

        case 'update_autonomous_focus':
          return await this.updateAutonomousFocus(input.topics, input.instruction ?? '', input.duration_days ?? 7)

        case 'get_status':
          return this.getStatus()

        case 'get_tweet':
          return await this.getTweet(input.tweet_url)

        case 'browse_x':
          return await this.browseX(input.task)

        case 'quote_tweet':
          return await this.quoteTweet(input.tweet_url, input.text)

        case 'quote_tweet_from_feed':
          return await this.quoteTweetFromFeed(input.topic_hint ?? '')

        case 'update_config':
          return this.updateConfig(input)

        case 'read_dm_inbox': {
          if (!this.mcpDm) return 'DM inbox not available'
          const convos = await this.mcpDm.readInbox()
          if (!convos.length) return 'No conversations found in DM inbox'
          return convos.map(c =>
            `@${c.handle}${c.isUnread ? ' [UNREAD]' : ''}: "${c.lastMessage}"`
          ).join('\n')
        }

        case 'read_dm_thread': {
          if (!this.mcpDm) return 'DM reader not available'
          const { thread } = await this.mcpDm.readInboxAndThread(input.handle)
          if (!thread.length) return `No messages found in thread with @${input.handle.replace(/^@/, '')}`
          return thread.map(m => `${m.by === 'me' ? 'You' : `@${input.handle.replace(/^@/, '')}`}: ${m.text}`).join('\n')
        }

        case 'send_dm': {
          const ok = await this.playwrightClient.sendDm(input.handle, input.message)
          return ok ? `DM sent to @${input.handle.replace(/^@/, '')}` : `failed to send DM to @${input.handle.replace(/^@/, '')} — check if DMs are open`
        }

        case 'find_viral_and_act':
          return await this.findViralAndAct(
            input.topic ?? '',
            input.count ?? 3,
            String(input.action ?? 'reply'),
            input.min_views ?? 1000,
            input.max_age_hours ?? 24,
          )

        case 'control_autonomous':
          return await this.controlAutonomous(input.action, input.hours)

        case 'like_tweet': {
          const ids = (input.tweet_urls as string[]).map(u => {
            const m = u.match(/\/status\/(\d+)/)
            return m ? m[1] : null
          }).filter(Boolean) as string[]
          if (!ids.length) return 'no valid tweet URLs provided'
          const capped = ids.slice(0, 5) // hard cap — liking too many at once gets accounts flagged
          const liked = await this.playwrightClient.likeTweets(capped)
          return `liked ${liked}/${capped.length} tweets${ids.length > 5 ? ` (capped at 5 — X flags mass liking)` : ''}`
        }

        case 'retweet_tweet': {
          const m = (input.tweet_url as string).match(/\/status\/(\d+)/)
          if (!m) return `invalid tweet URL`
          await this.xAdapter.retweetTweet(m[1])
          return `retweeted`
        }

        case 'find_and_like':
          return await this.findAndLike(input.count ?? 3, input.topic)

        case 'find_and_retweet':
          return await this.findAndRetweet(input.count ?? 1, input.topic)

        case 'follow_user': {
          const handle = (input.handle as string).replace(/^@/, '')
          // Rate limit: minimum 10 minutes between follows — X flags rapid programmatic follows
          const minGapMs = 10 * 60 * 1000
          const msSinceLast = Date.now() - this.lastFollowAt
          if (this.lastFollowAt > 0 && msSinceLast < minGapMs) {
            const waitMins = Math.ceil((minGapMs - msSinceLast) / 60000)
            return `⚠️ follow rate limit — wait ${waitMins} more minute${waitMins > 1 ? 's' : ''} before following again (X flags rapid follows and locks accounts)`
          }
          const result = await this.xAdapter.followUser(handle)
          if (result === 'already_following') return `already following @${handle}`
          if (result === 'not_found') return `couldn't find @${handle} — check the handle`
          this.lastFollowAt = Date.now()
          return `followed @${handle}`
        }

        case 'do': {
          const instruction = String(input.instruction ?? '').trim()
          if (!instruction) return 'no instruction provided'

          // Spawn a full agent session — same as SessionBrain but self-contained.
          // Uses XToolsMcpServer so it has access to all X + scheduling tools.
          const { query } = await import('@anthropic-ai/claude-agent-sdk')

          const chunks: string[] = []
          const opts: any = {
            model: process.env.SESSIONBRAIN_MODEL ?? 'claude-sonnet-4-6',
            maxTurns: 30,
            permissionMode: 'bypassPermissions',
            cwd: BLOPUS_DIR,
            mcpServers: {
              xtools: {
                type: 'stdio' as const,
                command: NPX_CMD,
                args: ['tsx', path.join(BLOPUS_DIR, 'adapters/control/XToolsMcpServer.ts')],
                env: { ...process.env },
              },
            },
            allowedTools: [
              'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
              'WebSearch', 'WebFetch', 'Agent', 'TodoWrite',
              'mcp__xtools__*',
            ],
            env: {
              ...process.env,
              ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_API_KEY,
              USERPROFILE: path.join(BLOPUS_DIR, '.claude-api-home'),
              HOME: path.join(BLOPUS_DIR, '.claude-api-home'),
            },
            systemPrompt: `You are OsBot's task executor. Complete every step in the instruction fully and in order. Use mcp__xtools__* tools for X actions. Report what you did after each step.`,
          }

          for await (const msg of query({ prompt: instruction, options: opts })) {
            const m = msg as any
            if (m.type === 'assistant' && m.message?.content) {
              for (const block of m.message.content) {
                if (block.type === 'text' && block.text?.trim()) chunks.push(block.text.trim())
              }
            }
            if (m.type === 'result' && m.result?.trim()) chunks.push(m.result.trim())
          }

          return chunks.length ? chunks[chunks.length - 1] : 'task completed'
        }

        case 'schedule_task': {
          if (!this.taskRunner) return '⚠️ Scheduler not ready — try again in a moment'
          const { description, tool, cron: cronExpr, one_time = false } = input
          if (!tool || !cronExpr) return 'missing required fields: tool, cron'
          let tool_input: Record<string, any> = {}
          try { tool_input = typeof input.tool_input === 'string' ? JSON.parse(input.tool_input) : (input.tool_input ?? {}) } catch { return '⚠️ tool_input must be valid JSON string' }

          // Check if a one-time task's time has already passed today.
          // Cron "M H * * *" — if that H:M is in the past, node-cron silently queues for tomorrow.
          // If missed by ≤30 min: run immediately. If missed by more: warn and ask.
          if (one_time) {
            const parts = String(cronExpr).trim().split(/\s+/)
            if (parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
              const cronMin = parseInt(parts[0], 10)
              const cronHour = parseInt(parts[1], 10)
              if (!isNaN(cronMin) && !isNaN(cronHour)) {
                const now = new Date()
                const target = new Date(now)
                target.setHours(cronHour, cronMin, 0, 0)
                const missedMs = now.getTime() - target.getTime()
                if (missedMs > 0) {
                  // Time passed today
                  if (missedMs <= 30 * 60 * 1000) {
                    // Missed by ≤30 min — run immediately, don't schedule
                    const task = {
                      id: uuidv4().slice(0, 8),
                      description: description ?? tool,
                      tool, tool_input: tool_input ?? {},
                      cron: cronExpr, one_time: true,
                      created_at: new Date().toISOString(),
                    }
                    // Fire right now without waiting for cron
                    setImmediate(async () => {
                      try {
                        const result = await this.execute(tool, tool_input ?? {})
                        const token = process.env.TELEGRAM_BOT_TOKEN
                        const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
                        if (token && chatId) {
                          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ chat_id: chatId, text: `✅ Ran immediately (${Math.round(missedMs/60000)}min late): ${task.description}\n\n${result.slice(0,300)}` }),
                          }).catch(() => {})
                        }
                      } catch {}
                    })
                    return `⚡ Time already passed (${Math.round(missedMs/60000)} min ago) — running immediately now instead of waiting until tomorrow.`
                  } else {
                    // Missed by >30 min — warn, don't schedule for tomorrow silently
                    const pad = (n: number) => String(n).padStart(2, '0')
                    return `⚠️ ${pad(cronHour)}:${pad(cronMin)} already passed today (${Math.round(missedMs/60000)} min ago). Did you mean tomorrow? Reply "yes schedule for tomorrow" or give me a new time.`
                  }
                }
              }
            }
          }

          const task = {
            id: uuidv4().slice(0, 8),
            description: description ?? tool,
            tool,
            tool_input: tool_input ?? {},
            cron: cronExpr,
            one_time: !!one_time,
            created_at: new Date().toISOString(),
          }
          this.taskRunner.add(task)
          const freq = one_time ? 'one-time' : 'recurring'
          const parts2 = String(cronExpr).trim().split(/\s+/)
          const timeStr = parts2.length === 5 && !isNaN(parseInt(parts2[0])) && !isNaN(parseInt(parts2[1]))
            ? `${String(parseInt(parts2[1])).padStart(2,'0')}:${String(parseInt(parts2[0])).padStart(2,'0')}`
            : cronExpr
          return `✅ Scheduled (${freq}) — ID: ${task.id}\nTask: ${task.description}\nFires at: ${timeStr}\nTool: ${tool}`
        }

        case 'list_tasks': {
          const tasks = ScheduleStore.load()
          if (!tasks.length) return 'No scheduled tasks.'
          return tasks.map(t =>
            `[${t.id}] ${t.description}\n  cron: ${t.cron} | ${t.one_time ? 'one-time' : 'recurring'} | tool: ${t.tool}\n  created: ${t.created_at.slice(0, 16)}`
          ).join('\n\n')
        }

        case 'cancel_task': {
          if (!this.taskRunner) return '⚠️ Scheduler not ready'
          const removed = this.taskRunner.cancel(input.task_id)
          return removed ? `✅ Task ${input.task_id} cancelled` : `Task ${input.task_id} not found`
        }

        case 'get_post_analytics': {
          const urls = (input.tweet_urls as string[]) ?? []
          if (!urls.length) return 'no tweet URLs provided — use get_user_tweets first to get URLs'
          const results: string[] = []
          for (const url of urls.slice(0, 10)) {
            const stats = await this.getPostAnalytics(url)
            results.push(stats)
          }
          return results.join('\n\n')
        }

        case 'scrape_website': {
          const url = input.url as string
          const fields = (input.fields as Array<{ label: string; value: string }>) ?? []
          const scraper = new PlaywrightWebScraper()
          try {
            console.log(`[XTools:scrape] ${url} with ${fields.length} fields`)
            const result = await scraper.scrape(url, fields)
            if (result.error) return `scrape failed: ${result.error}`
            if (!result.rawText.trim()) return `scraped ${url} but got no data — page may require login or JS not supported`
            // Telegram has 4096 char limit — trim if needed
            const out = result.rawText.length > 3800
              ? result.rawText.slice(0, 3800) + `\n\n... (${result.rawText.length - 3800} more chars)`
              : result.rawText
            return out
          } finally {
            await scraper.close()
          }
        }

        default:
          return `unknown tool: ${toolName}`
      }
    } catch (err) {
      console.error(`[XTools] Tool ${toolName} failed:`, err)
      return `failed to execute ${toolName}: ${String(err).slice(0, 100)}`
    }
  }

  private async searchAndReply(query: string, count: number, angle: string): Promise<string> {
    const cap = Math.min(count, 10)
    const tweets = await this.playwrightClient.searchTweets(query, cap * 2)
    if (!tweets.length) return `no tweets found for "${query}"`

    const targets = tweets.slice(0, cap)
    const log: string[] = []

    for (const tweet of targets) {
      try {
        const replyText = await this.llmEngine.generateReply({
          mentionText: `${tweet.text}\n\n[Special instruction for this reply: ${angle}]`,
          authorHandle: tweet.authorHandle,
          authorId: '',
          mentionType: 'viral_reply' as any,
          previousInteractions: 0,
          mood: 'chill' as any,
          traits: { aggression: 0.3, warmth: 0.6, humor: 0.7, formality: 0.1, verbosity: 0.4 } as any,
        })
        await this.xAdapter.postAutonomousReply(tweet.tweetId, replyText)
        log.push(`@${tweet.authorHandle}: "${tweet.text.slice(0, 80)}" → your reply: "${replyText}"`)
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000))
      } catch (err) {
        console.warn(`[XTools] Reply failed for ${tweet.tweetId}:`, err)
      }
    }

    return `replied to ${log.length}/${cap} tweets about "${query}":\n${log.join('\n')}`
  }

  private async postTweet(topic: string, angle: string): Promise<string> {
    const trigger = angle ? `${topic} — ${angle}` : topic
    let text: string | null = null
    try {
      text = await this.llmEngine.generateAutonomousPost({
        mentionsToday: 0, repliesToday: 0, hoursSinceLastMention: 99,
        recentTopics: [topic], mood: 'chill' as any,
        currentEvents: [trigger], targetPlatform: 'x', accountType: 'owner-own',
        ownerHandle: process.env.OWNER_HANDLE ?? '',
      })
    } catch (err: any) {
      console.error('[XTools] post_tweet generateAutonomousPost error:', err?.message ?? err)
      return `❌ post_tweet failed: ${err?.message?.slice(0, 100) ?? 'unknown error'}`
    }
    if (!text) return '❌ Could not generate post — voice profile may be missing'
    if (!await blockLeak(text, 'post_tweet')) return '❌ Blocked by output firewall — potential credential leak detected'
    await this.xAdapter.postTweet(text)
    appendEvent({ platform: 'x', type: 'post', text, topic })
    return `posted tweet: "${text}"`
  }

  private async findViralAndAct(
    topic: string,
    count: number,
    action: string,
    minViews: number,
    maxAgeHours: number,
  ): Promise<string> {
    // Normalize — accept prefix matches so "repl" → "reply", "quot" → "quote"
    if (!['reply', 'quote', 'both'].includes(action)) {
      action = action.startsWith('quot') ? 'quote' : action.startsWith('both') ? 'both' : 'reply'
    }
    const cap = Math.min(count, 10)

    let candidates = await this.playwrightClient.getHomeTweets(50)

    // Filter by topic if specified — split into keywords, match any
    if (topic) {
      const keywords = topic.toLowerCase().replace(/[()]/g, '').split(/[\s,]+/).filter(w => w.length >= 3)
      const filtered = candidates.filter(c => {
        const text = c.text.toLowerCase()
        return keywords.some(k => text.includes(k))
      })
      if (filtered.length > 0) candidates = filtered
    }

    // Fallback: if home feed has no matches, search X directly for the topic
    if (!candidates.length && topic) {
      console.log(`[XTools] find_viral_and_act: no home feed matches for "${topic}" — falling back to X search`)
      const searched = await this.playwrightClient.searchTweets(topic, cap * 3)
      if (searched.length) {
        candidates = searched.map(t => ({
          tweetId: t.tweetId,
          text: t.text,
          authorHandle: t.authorHandle,
          likeCount: 0,
          ageMinutes: 0,
          mediaUrls: [],
          viewCount: 0,
          viewsPerMinute: 0,
        } as any))
      }
    }

    if (!candidates.length) return `no viral tweets found${topic ? ` on "${topic}"` : ''} with ${(minViews / 1000).toFixed(0)}k+ views in last ${maxAgeHours}h`

    candidates.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    const targets = candidates.slice(0, cap)
    const log: string[] = []

    for (const tweet of targets) {
      try {
        let replyText = ''
        let qtText = ''

        if (action === 'reply' || action === 'both') {
          if (!await interceptThreat(tweet.text, `tweet @${tweet.authorHandle}`)) {
            log.push(`✗ @${tweet.authorHandle}: blocked — injection attempt in tweet`)
            continue
          }
          replyText = await this.llmEngine.generateReply({
            mentionText: tweet.text,
            authorHandle: tweet.authorHandle,
            authorId: '',
            mentionType: 'viral_reply' as any,
            previousInteractions: 0,
            mood: 'chill' as any,
            traits: { aggression: 0.3, warmth: 0.6, humor: 0.7, formality: 0.1, verbosity: 0.4 } as any,
          })
          // Retry once on failure — X sometimes rejects the first attempt
          if (!await blockLeak(replyText, 'findViralAndAct reply')) {
            log.push(`✗ @${tweet.authorHandle}: blocked by output firewall`)
            continue
          }
          let posted = false
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await this.xAdapter.postAutonomousReply(tweet.tweetId, replyText)
              posted = true
              break
            } catch {
              if (attempt === 0) await new Promise(r => setTimeout(r, 4000))
            }
          }
          if (!posted) { log.push(`✗ @${tweet.authorHandle}: reply failed after retry`); continue }
        }
        if (action === 'quote' || action === 'both') {
          qtText = await this.generateQTComment(tweet.text)
          if (qtText) await this.playwrightClient.quoteTweet(tweet.tweetId, qtText)
        }

        const shown = replyText || qtText
        log.push(`✓ @${tweet.authorHandle}: "${shown.slice(0, 80)}"`)
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000))
      } catch (err: any) {
        log.push(`✗ @${tweet.authorHandle}: ${String(err?.message ?? err).slice(0, 60)}`)
      }
    }

    return `${action} on ${log.length}/${cap} viral${topic ? ` "${topic}"` : ''} tweets:\n${log.join('\n')}`
  }

  private async searchTrendingAndReply(category: string, count: number, angle: string): Promise<string> {
    const cap = Math.min(count, 10)

    let candidates = await this.playwrightClient.getHomeTweets(30)

    // Filter by category keyword if possible
    const cat = category.toLowerCase()
    const topicMatch = candidates.filter(c => c.text.toLowerCase().includes(cat))
    if (topicMatch.length > 0) candidates = topicMatch

    if (!candidates.length) {
      const searched = await this.playwrightClient.searchTweets(category, cap * 3)
      candidates = searched
    }

    if (!candidates.length) return `no tweets found for "${category}" right now`

    // Sort by likes, take top ones
    candidates.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    const targets = candidates.slice(0, cap)
    const log: string[] = []

    for (const tweet of targets) {
      try {
        const replyText = await this.llmEngine.generateReply({
          mentionText: `${tweet.text}\n\n[Special instruction for this reply: ${angle}]`,
          authorHandle: tweet.authorHandle,
          authorId: '',
          mentionType: 'viral_reply' as any,
          previousInteractions: 0,
          mood: 'chill' as any,
          traits: { aggression: 0.3, warmth: 0.6, humor: 0.7, formality: 0.1, verbosity: 0.4 } as any,
        })
        await this.xAdapter.postAutonomousReply(tweet.tweetId, replyText)
        log.push(`@${tweet.authorHandle} (${tweet.likeCount.toLocaleString()} likes): "${tweet.text.slice(0, 80)}" → your reply: "${replyText}"`)
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 4000))
      } catch (err) {
        console.warn(`[XTools] Reply failed for ${tweet.tweetId}:`, err)
      }
    }

    return `replied to ${log.length}/${cap} viral "${category}" tweets from your home feed:\n${log.join('\n')}`
  }

  private async updateAutonomousFocus(topics: string[], instruction: string, days: number): Promise<string> {
    // Write a focus override file that autonomous OsBot reads
    const focusFile = path.join(path.dirname(this.configPath), 'focus_override.json')
    const override = {
      topics,
      instruction,
      expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
      setAt: new Date().toISOString(),
    }
    fs.writeFileSync(focusFile, JSON.stringify(override, null, 2))
    return `updated focus: topics=[${topics.join(', ')}], instruction="${instruction}", active for ${days} days`
  }

  private getStatus(): string {
    try {
      const memPath = path.join(path.dirname(this.configPath), 'memory.json')
      if (!fs.existsSync(memPath)) return 'OsBot status: running — no memory.json yet (no activity logged)'
      const mem = JSON.parse(fs.readFileSync(memPath, 'utf8'))
      const today = new Date().toISOString().slice(0, 10)
      const events: any[] = mem.events ?? []
      const todayEvents = events.filter((e: any) => (e.timestamp ?? '').startsWith(today))
      const repliedIds: string[] = mem.repliedTweetIds ?? []
      const recentEvents = todayEvents.slice(-5).reverse()
      const lines: string[] = [
        `OsBot status — ${today}`,
        `Total replies sent today: ${todayEvents.filter((e:any) => e.type === 'reply').length}`,
        `Total replies ever: ${repliedIds.length}`,
        `Autonomous posts today: ${todayEvents.filter((e:any) => e.type === 'post').length}`,
      ]
      if (recentEvents.length) {
        lines.push(`\nLast ${recentEvents.length} actions today:`)
        for (const e of recentEvents) {
          const time = (e.timestamp ?? '').slice(11, 16)
          lines.push(`  ${time} — ${e.type ?? 'action'}: ${String(e.summary ?? e.text ?? '').slice(0, 80)}`)
        }
      }
      // Also show focus override if active
      const focusFile = path.join(path.dirname(this.configPath), 'focus_override.json')
      if (fs.existsSync(focusFile)) {
        const fo = JSON.parse(fs.readFileSync(focusFile, 'utf8'))
        if (fo.paused) lines.push(`\n⏸ Autonomous posting PAUSED${fo.pausedUntil ? ` until ${fo.pausedUntil.slice(0,16)}` : ' (indefinitely)'}`)
        if (fo.topics?.length) lines.push(`Focus topics: ${fo.topics.join(', ')}`)
      }
      return lines.join('\n')
    } catch {
      return 'OsBot status: running (could not read memory.json)'
    }
  }

  private async getUserTweets(handle: string, count: number, type: 'tweets' | 'replies' | 'likes' | 'media' = 'tweets'): Promise<string> {
    const cap = Math.min(count, 10)
    const { page, close } = await this.playwrightClient.createPage()
    try {
      const cleanHandle = handle.replace(/^@/, '')
      const tabPath = type === 'replies' ? 'with_replies' : type === 'likes' ? 'likes' : type === 'media' ? 'media' : ''
      const url = tabPath ? `https://x.com/${cleanHandle}/${tabPath}` : `https://x.com/${cleanHandle}`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })

      // Wait for first article — up to 12s
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12000 }).catch(() => {})
      await page.evaluate('window.scrollBy(0, 500)')
      await page.waitForTimeout(1500)

      const includeReplies = type === 'replies'
      const tweets = await page.evaluate(({ maxCount, incReplies }: { maxCount: number; incReplies: boolean }) => {
        const results: { url: string; text: string }[] = []
        const articles = document.querySelectorAll('article[data-testid="tweet"]')
        for (const article of Array.from(articles)) {
          if (results.length >= maxCount) break
          const isReply = (article.textContent || '').includes('Replying to')
          if (isReply && !incReplies) continue
          const textEl = article.querySelector('[data-testid="tweetText"]')
          const text = textEl ? (textEl as HTMLElement).innerText?.trim() || textEl.textContent?.trim() || '' : ''
          // Use status link — same approach as scrapeTweetArticles
          let tweetUrl = ''
          const links = article.querySelectorAll('a[href*="/status/"]')
          for (const link of Array.from(links)) {
            const m = (link as HTMLAnchorElement).href.match(/\/status\/(\d+)/)
            if (m) { tweetUrl = (link as HTMLAnchorElement).href; break }
          }
          if (tweetUrl && text) results.push({ url: tweetUrl, text })
        }
        return results
      }, { maxCount: cap, incReplies: includeReplies })

      if (!tweets.length) return `no tweets found for @${cleanHandle} — profile may be private or page didn't load`

      return tweets.map((t, i) =>
        `${i + 1}. ${t.url}\n   ${t.text.slice(0, 200)}`
      ).join('\n\n')
    } finally {
      await close()
    }
  }

  private async getTweet(tweetUrl: string): Promise<string> {
    const m = tweetUrl.match(/\/status\/(\d+)/)
    if (!m) return `invalid tweet URL — paste the full URL like https://x.com/user/status/123456`

    const { page, close } = await this.playwrightClient.createPage()
    try {
      await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      // Wait for tweet text element — up to 10s, then proceed anyway
      await page.waitForSelector('[data-testid="tweetText"]', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(500)

      // Extract tweet text via DOM
      const tweetText = await page.evaluate(() => {
        const el = (document as any).querySelector('[data-testid="tweetText"]')
        return el ? (el as any).innerText : ''
      }).catch(() => '')

      // Check if tweet has an attached image — skip vision API if text-only (saves cost)
      const hasImage = await page.evaluate(() => {
        return !!(document as any).querySelector('[data-testid="tweetPhoto"], [data-testid="card.layoutLarge.media"] img, article img[src*="pbs.twimg.com/media"]')
      }).catch(() => false)

      let imageDescription = ''
      if (hasImage) {
        const screenshotBuf = await page.screenshot({ fullPage: false })
        const base64 = screenshotBuf.toString('base64')
        // Haiku — cheap, fast, good enough for image description
        const client = new Anthropic()
        const vision = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
              { type: 'text', text: 'Describe the image attached to this tweet in detail. Be specific about objects, food, text, numbers visible.' }
            ]
          }]
        })
        imageDescription = vision.content[0].type === 'text' ? vision.content[0].text : ''
      }

      return [
        tweetText ? `Tweet text: ${tweetText}` : '',
        imageDescription ? `Image: ${imageDescription}` : '',
      ].filter(Boolean).join('\n')
    } finally {
      await close()
    }
  }

  private async browseX(task: string): Promise<string> {
    const { page, close } = await this.playwrightClient.createPage()
    try {
      await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2000)
      const agent = new BrowserAgent()
      return await agent.execute(task, page)
    } finally {
      await close()
    }
  }

  private async quoteTweet(tweetUrl: string, text: string): Promise<string> {
    const m = tweetUrl.match(/\/status\/(\d+)/)
    if (!m) return `invalid tweet URL — paste the full URL like https://x.com/user/status/123456`
    const tweetId = m[1]
    await this.playwrightClient.quoteTweet(tweetId, text)
    appendEvent({ platform: 'x', type: 'quote', text })
    return `quote tweeted ${tweetUrl} with: "${text}"`
  }

  private async generateQTComment(tweetText: string): Promise<string> {
    const creatorDir = path.dirname(path.resolve(this.configPath))
    const ppPath = path.join(creatorDir, 'personality_profile.json')
    if (!fs.existsSync(ppPath)) return ''
    const pp = JSON.parse(fs.readFileSync(ppPath, 'utf8'))
    const opp = pp?.voiceProfile?.originalPostProfile
    if (!opp?.goldenExamples?.length) return ''

    const goldenExamples: string[] = opp.goldenExamples ?? []
    const topicExamples: { scenario: string; post: string }[] = opp.topicExamples ?? []
    const synthesized: string = opp.synthesized ?? ''
    const caseStyle: string = opp.caseStyle ?? ''
    const postLength: string = opp.postLength ?? opp.formatStyle ?? ''
    const emojiContext: string = opp.emojiContext ?? ''
    const emojiFrequency: number = opp.emojiFrequency ?? 0
    const emojiRule = emojiContext ? `emoji: ${emojiContext}` : emojiFrequency > 0 ? `emoji in ${emojiFrequency}% of posts` : 'no emojis'

    const examplesBlock = goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')
    const topicBlock = topicExamples.length
      ? '\nFor these specific situations you posted like this (most important — shows your exact stance):\n' +
        topicExamples.map(e => `Situation: "${e.scenario}"\nYour post: "${e.post}"`).join('\n\n')
      : ''

    const cleanTweetText = sanitizeUnicode(tweetText)
    const prompt = `These are your real posts on X. Study them — this is your entire guide:

${examplesBlock}
${topicBlock}

How you write posts: ${synthesized}

Rules: ${caseStyle || 'sentence case'}. ${postLength || 'short, 1-2 lines max'}. ${emojiRule}. No hashtags.

Now write your quote tweet comment on this exactly like the examples above:
"${cleanTweetText}"

Comment only. Nothing else.`

    const client = new Anthropic()
    const resp = await client.messages.create({
      model: process.env.REPLY_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }],
    })
    let comment = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    comment = comment.replace(/^["']|["']$/g, '').replace(/—/g, ' ').trim()
    if (comment.length > 280) comment = comment.slice(0, 280).replace(/\s\S*$/, '')
    return comment
  }

  private async quoteTweetFromFeed(topicHint: string): Promise<string> {
    let candidates = await this.playwrightClient.getHomeTweets(30)

    // Fallback: home feed empty → search by topic hint or profile topic
    if (!candidates.length) {
      const pp = this.profile as any
      const searchTerm = topicHint || (pp?.dominantTopics?.[0]) || 'India'
      const keyword = searchTerm.replace(/\([^)]*\)/g, '').split(/[\s/,]+/).find((w: string) => w.length >= 4) ?? searchTerm.split(' ')[0]
      console.log(`[XTools:quote_tweet_from_feed] Home empty — searching: ${keyword}`)
      candidates = await this.playwrightClient.searchTweets(keyword, 20)
    }

    if (!candidates.length) return 'no tweets found — try again in a few minutes'

    // Filter by topic hint if given
    let pool = candidates.filter((c: any) => c.authorHandle !== (process.env.OWNER_HANDLE ?? ''))
    if (topicHint) {
      const hint = topicHint.toLowerCase()
      const topicMatch = pool.filter(c => c.text.toLowerCase().includes(hint))
      if (topicMatch.length > 0) pool = topicMatch
    }

    // Pick the most liked from top 5
    pool.sort((a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0))
    const pick = pool[0]
    if (!pick) return 'no suitable tweets found'

    const comment = await this.generateQTComment(pick.text)
    if (!comment) return 'failed to generate comment — personality_profile.json may be missing or incomplete'

    await this.playwrightClient.quoteTweet(pick.tweetId, comment)
    return `quote tweeted @${pick.authorHandle} (${pick.likeCount} likes):\ntheir tweet: "${pick.text.slice(0, 80)}"\nyour comment: "${comment}"`
  }

  private async findAndLike(count: number, topicOverride?: string): Promise<string> {
    const cap = Math.min(count, 5)
    const pp = this.profile as any

    // Use override topic if provided, else pick random from profile
    let topic: string
    if (topicOverride) {
      topic = topicOverride
    } else {
      const topics: string[] = pp?.likeBehavior?.topics?.length
        ? pp.likeBehavior.topics
        : pp?.dominantTopics ?? []
      if (!topics.length) return 'no like topics configured — run npm run setup to set like behavior'
      topic = topics[Math.floor(Math.random() * topics.length)]
    }

    const keyword = topic.replace(/\([^)]*\)/g, '').split(/[\s/,]+/).find(w => w.length >= 4) ?? topic.split(' ')[0]
    console.log(`[XTools:find_and_like] searching topic: "${topic}" → keyword: "${keyword}"`)

    let tweetIds: string[] = []

    // Level 1: X search
    const searched = await this.playwrightClient.searchTweets(keyword, cap * 5)
    tweetIds = searched.map(r => r.tweetId)

    // Level 2: home timeline via same authenticated client (no profile conflict)
    if (!tweetIds.length) {
      console.log(`[XTools:find_and_like] X search empty — trying home timeline`)
      const homeTweets = await this.playwrightClient.getHomeTweets(20)
      tweetIds = homeTweets.map(t => t.tweetId)
    }

    // Level 3: Tavily web search (if API key configured)
    if (!tweetIds.length) {
      console.log(`[XTools:find_and_like] Home timeline empty — trying Tavily for: ${keyword}`)
      tweetIds = await new TavilyClient().searchTweetIds(keyword, cap * 5)
    }

    if (!tweetIds.length) return `no tweets found for topic: ${topic} — X search, home feed, and web search all dry`

    // Shuffle for randomness — don't always like the same top tweets
    const shuffled = tweetIds.sort(() => Math.random() - 0.5).slice(0, cap)
    let liked = 0
    for (const r of shuffled) {
      try {
        const n = await this.playwrightClient.likeTweets([r])
        if (n > 0) liked++
        // Random delay 4–12s between likes — human scrolls, doesn't rapid-fire
        const delay = 4000 + Math.floor(Math.random() * 8000)
        await new Promise(res => setTimeout(res, delay))
      } catch {}
    }
    return `liked ${liked}/${shuffled.length} tweets in "${topic}"`
  }

  private async findAndRetweet(count: number, topicOverride?: string): Promise<string> {
    const cap = Math.min(count, 3)
    const pp = this.profile as any

    let topic: string
    if (topicOverride) {
      topic = topicOverride
    } else {
      const topics: string[] = pp?.retweetBehavior?.topics?.length
        ? pp.retweetBehavior.topics
        : pp?.dominantTopics ?? []
      if (!topics.length) return 'no retweet topics configured — run npm run setup to set retweet behavior'
      topic = topics[Math.floor(Math.random() * topics.length)]
    }

    const keyword = topic.replace(/\([^)]*\)/g, '').split(/[\s/,]+/).find(w => w.length >= 4) ?? topic.split(' ')[0]
    console.log(`[XTools:find_and_retweet] searching topic: "${topic}" → keyword: "${keyword}"`)

    let tweetIds: string[] = []

    const searched = await this.playwrightClient.searchTweets(keyword, cap * 5)
    tweetIds = searched.map(r => r.tweetId)

    if (!tweetIds.length) {
      console.log(`[XTools:find_and_retweet] X search empty — trying home timeline`)
      const homeTweets = await this.playwrightClient.getHomeTweets(20)
      tweetIds = homeTweets.map(t => t.tweetId)
    }

    if (!tweetIds.length) {
      console.log(`[XTools:find_and_retweet] Home timeline empty — trying Tavily for: ${keyword}`)
      tweetIds = await new TavilyClient().searchTweetIds(keyword, cap * 5)
    }

    if (!tweetIds.length) return `no tweets found for topic: ${topic} — X search, home feed, and web search all dry`

    const shuffled = tweetIds.sort(() => Math.random() - 0.5).slice(0, cap)
    const log: string[] = []
    for (const id of shuffled) {
      try {
        await this.xAdapter.retweetTweet(id)
        log.push(id)
        await new Promise(res => setTimeout(res, 3000 + Math.random() * 4000))
      } catch {}
    }
    return log.length
      ? `retweeted ${log.length} tweets in "${topic}"`
      : `failed to retweet any tweets in "${topic}"`
  }

  private async getPostAnalytics(tweetUrl: string): Promise<string> {
    const m = tweetUrl.match(/\/status\/(\d+)/)
    if (!m) return `${tweetUrl} — invalid URL`

    const { page, close } = await this.playwrightClient.createPage()
    try {
      await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12000 }).catch(() => {})
      await page.waitForTimeout(1500)

      // Pull raw text of the whole tweet article — parse numbers from aria-labels
      const tweetText = await page.locator('[data-testid="tweetText"]').first().innerText().catch(() => '')

      // Aria-labels on action buttons contain counts: "1,234 Likes", "56 Replies", "89 Reposts"
      function extractCount(label: string): string {
        const n = label.match(/^([\d,]+(?:\.\d+)?[KMB]?)/i)
        return n ? n[1] : '0'
      }

      const likeLabel    = await page.locator('[data-testid="like"]').first().getAttribute('aria-label').catch(() => '')
      const replyLabel   = await page.locator('[data-testid="reply"]').first().getAttribute('aria-label').catch(() => '')
      const retweetLabel = await page.locator('[data-testid="retweet"]').first().getAttribute('aria-label').catch(() => '')

      const likes    = extractCount(likeLabel ?? '')
      const replies  = extractCount(replyLabel ?? '')
      const reposts  = extractCount(retweetLabel ?? '')

      // Views — shown as plain text near the analytics link at the bottom of the tweet
      let views = '—'
      const analyticsLink = await page.locator('a[href$="/analytics"]').first().innerText().catch(() => '')
      if (analyticsLink) {
        const v = analyticsLink.match(/([\d,.]+\s*[KMB]?)\s*Views?/i)
        views = v ? v[1].trim() : analyticsLink.trim()
      }

      const preview = tweetText ? `"${tweetText.slice(0, 80)}${tweetText.length > 80 ? '…' : ''}"` : tweetUrl
      return `${preview}\n  👁 ${views} views  ❤️ ${likes} likes  💬 ${replies} replies  🔁 ${reposts} reposts\n  ${tweetUrl}`
    } finally {
      await close()
    }
  }

  private updateConfig(updates: Record<string, any>): string {
    const allowed = ['maxRepliesPerDay','cooldownMinutes','minLikes','maxAgeTweetMinutes','consecutiveTopicLimit','maxAutonomousPostsPerDay','minPostIntervalHours']
    const filtered = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)))
    if (Object.keys(filtered).length === 0) return 'no valid config keys provided'
    const result = writeRuntimeConfig(filtered)
    const current = readRuntimeConfig()
    return `config updated:\n${Object.entries(current).filter(([k]) => k !== 'updatedAt').map(([k,v]) => `- ${k}: ${v}`).join('\n')}`
  }

  private async controlAutonomous(action: 'pause' | 'resume', hours?: number): Promise<string> {
    const focusFile = path.join(path.dirname(this.configPath), 'focus_override.json')
    const existing = fs.existsSync(focusFile)
      ? JSON.parse(fs.readFileSync(focusFile, 'utf-8'))
      : {}

    if (action === 'resume') {
      delete existing.paused
      delete existing.pausedUntil
      fs.writeFileSync(focusFile, JSON.stringify(existing, null, 2))
      return 'autonomous posting resumed — OsBot will continue normal activity'
    }

    existing.paused = true
    existing.setAt = new Date().toISOString()
    if (hours) {
      existing.pausedUntil = new Date(Date.now() + hours * 3600000).toISOString()
    } else {
      delete existing.pausedUntil
    }
    fs.writeFileSync(focusFile, JSON.stringify(existing, null, 2))

    return hours
      ? `autonomous posting paused for ${hours} hours — will auto-resume after that`
      : `autonomous posting paused — say "resume posting" when you want it back`
  }
}
