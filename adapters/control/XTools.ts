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
import { XAdapter } from '../x/XAdapter'
import { PlaywrightXClient } from '../x/PlaywrightXClient'
import { LLMReplyEngine } from '../../core/personality/LLMReplyEngine'
import { PersonalityProfile } from '../../core/personality/LLMReplyEngine'
import { PlaywrightHomeTimelineProvider } from '../x/PlaywrightHomeTimelineProvider'
import { ExampleRetriever } from '../../core/rag/ExampleRetriever'
import { BrowserAgent } from './BrowserAgent'
import { MCPBrowserDM } from '../../agent/MCPBrowserDM'
import fs from 'fs'
import path from 'path'
import { writeRuntimeConfig, readRuntimeConfig } from './RuntimeConfig'
import { PlaywrightWebScraper } from '../web/PlaywrightWebScraper'

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
        min_views: { type: 'number', description: 'Minimum likes/views the tweet must have (default 500000)' },
        max_age_hours: { type: 'number', description: 'Max age of tweet in hours (default 12)' },
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
    description: 'Like one or more tweets by URL. Max 5 at a time — X flags mass liking as bot activity. Use when asked to "like this tweet", "like @user\'s tweet", "heart this post".',
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
    name: 'follow_user',
    description: 'Follow an X user by handle. Use when asked to "follow @someone", "follow this person".',
    input_schema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'Twitter handle to follow, with or without @' },
      },
      required: ['handle'],
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
          await this.playwrightClient.postReply(m[1], replyText)
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
            input.action ?? 'reply',
            input.min_views ?? 500000,
            input.max_age_hours ?? 12,
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

        case 'follow_user': {
          const handle = (input.handle as string).replace(/^@/, '')
          const result = await this.xAdapter.followUser(handle)
          if (result === 'already_following') return `already following @${handle}`
          if (result === 'not_found') return `couldn't find @${handle} — check the handle`
          return `followed @${handle}`
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
        await new Promise(r => setTimeout(r, 3000))
      } catch (err) {
        console.warn(`[XTools] Reply failed for ${tweet.tweetId}:`, err)
      }
    }

    return `replied to ${log.length}/${cap} tweets about "${query}":\n${log.join('\n')}`
  }

  private async postTweet(topic: string, angle: string): Promise<string> {
    const pp = this.profile
    const ws = pp?.writingStats ?? {}
    const system = [
      `You are @${process.env.OWNER_HANDLE ?? 'owner'} posting on X. Real human, NOT a bot.`,
      pp?.writingStyle ? `Your writing style: ${pp.writingStyle}` : '',
      ws.caseStyle ? `Case style: ${ws.caseStyle}` : '',
      ws.apostropheStyle ? `Apostrophe style: ${ws.apostropheStyle}` : '',
      ws.emojiUsage ? `Emoji usage: ${ws.emojiUsage}` : '',
      pp?.dominantTopics?.length ? `Your usual topics: ${pp.dominantTopics.join(', ')}` : '',
      `Write ONE tweet specifically about: ${topic}`,
      angle ? `Angle/tone: ${angle}` : '',
      `No hashtags unless natural. Under 240 chars. Sound like a real person, not a bot summarizing.`,
    ].filter(Boolean).join('\n')

    const client = new Anthropic()
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      temperature: 1.0,
      system,
      messages: [{ role: 'user', content: 'Post:' }],
    })
    const text = resp.content[0].type === 'text' ? resp.content[0].text.trim().slice(0, 240) : topic
    await this.xAdapter.postTweet(text)
    return `posted tweet: "${text}"`
  }

  private async findViralAndAct(
    topic: string,
    count: number,
    action: 'reply' | 'quote' | 'both',
    minViews: number,
    maxAgeHours: number,
  ): Promise<string> {
    const cap = Math.min(count, 10)
    const homeTimeline = new PlaywrightHomeTimelineProvider()
    if (!homeTimeline.enabled) return 'home timeline not available — X auth tokens not set'

    let candidates = await homeTimeline.getViralFromHome(minViews, maxAgeHours * 60)

    // Filter by topic if specified
    if (topic) {
      const t = topic.toLowerCase()
      const filtered = candidates.filter(c => c.text.toLowerCase().includes(t))
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

    candidates.sort((a, b) => b.likeCount - a.likeCount)
    const targets = candidates.slice(0, cap)
    const log: string[] = []

    for (const tweet of targets) {
      try {
        const replyText = await this.llmEngine.generateReply({
          mentionText: tweet.text,
          authorHandle: tweet.authorHandle,
          authorId: '',
          mentionType: 'viral_reply' as any,
          previousInteractions: 0,
          mood: 'chill' as any,
          traits: { aggression: 0.3, warmth: 0.6, humor: 0.7, formality: 0.1, verbosity: 0.4 } as any,
        })

        if (action === 'reply' || action === 'both') {
          await this.xAdapter.postAutonomousReply(tweet.tweetId, replyText)
        }
        if (action === 'quote' || action === 'both') {
          await this.playwrightClient.quoteTweet(tweet.tweetId, replyText)
        }

        log.push(`✓ @${tweet.authorHandle} (${tweet.likeCount.toLocaleString()} likes): "${replyText}"`)
        await new Promise(r => setTimeout(r, 3000))
      } catch (err) {
        log.push(`✗ @${tweet.authorHandle}: failed`)
      }
    }

    return `${action} on ${log.length}/${cap} viral${topic ? ` "${topic}"` : ''} tweets:\n${log.join('\n')}`
  }

  private async searchTrendingAndReply(category: string, count: number, angle: string): Promise<string> {
    const cap = Math.min(count, 10)

    // Use home timeline (same as autonomous viral hunter) — filters by likes, returns real viral tweets
    const homeTimeline = new PlaywrightHomeTimelineProvider()
    let candidates = await homeTimeline.getViralFromHome(1000, 1440) // 1000+ likes, last 24h

    // Filter by category keyword if possible
    const cat = category.toLowerCase()
    const topicMatch = candidates.filter(c => c.text.toLowerCase().includes(cat))
    if (topicMatch.length > 0) candidates = topicMatch

    if (!candidates.length) {
      // Fallback: lower the bar and try without topic filter
      candidates = await homeTimeline.getViralFromHome(500, 1440)
    }

    if (!candidates.length) return `no viral tweets found in home feed for "${category}" right now`

    // Sort by likes, take top ones
    candidates.sort((a, b) => b.likeCount - a.likeCount)
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
        await new Promise(r => setTimeout(r, 3000))
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
    return `status: X tools ready. use search_and_reply, post_tweet, or search_trending_and_reply to act.`
  }

  private async getUserTweets(handle: string, count: number, type: 'tweets' | 'replies' | 'likes' | 'media' = 'tweets'): Promise<string> {
    const cap = Math.min(count, 10)
    const { page, close } = await this.playwrightClient.createPage()
    try {
      const cleanHandle = handle.replace(/^@/, '')
      const tabPath = type === 'replies' ? 'with_replies' : type === 'likes' ? 'likes' : type === 'media' ? 'media' : ''
      const url = tabPath ? `https://x.com/${cleanHandle}/${tabPath}` : `https://x.com/${cleanHandle}`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(4000)

      const tweets = await page.evaluate((maxCount: number) => {
        const results: { url: string; text: string }[] = []
        const articles = (document as any).querySelectorAll('article[data-testid="tweet"]')
        for (const article of Array.from(articles) as any[]) {
          if (results.length >= maxCount) break
          const textEl = article.querySelector('[data-testid="tweetText"]')
          const text = textEl ? (textEl as any).innerText.trim() : ''
          const timeEl = article.querySelector('time')
          const timeLink = timeEl ? timeEl.closest('a') : null
          const url = timeLink ? `https://x.com${(timeLink as any).getAttribute('href')}` : ''
          if (url) results.push({ url, text })
        }
        return results
      }, cap)

      if (!tweets.length) return `no tweets found for @${cleanHandle}`

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
      await page.waitForTimeout(4000)

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
    return `quote tweeted ${tweetUrl} with: "${text}"`
  }

  private async quoteTweetFromFeed(topicHint: string): Promise<string> {
    // Browse home timeline for viral tweets
    const homeTimeline = new PlaywrightHomeTimelineProvider()
    if (!homeTimeline.enabled) return 'home timeline not available — X auth tokens not set'

    const candidates = await homeTimeline.getViralFromHome(200, 1440)
    if (!candidates.length) return 'no viral tweets found in home feed right now'

    // Filter by topic hint if given
    let pool = candidates.filter(c => c.authorHandle !== (process.env.OWNER_HANDLE ?? ''))
    if (topicHint) {
      const hint = topicHint.toLowerCase()
      const topicMatch = pool.filter(c => c.text.toLowerCase().includes(hint))
      if (topicMatch.length > 0) pool = topicMatch
    }

    // Pick the most liked from top 5
    pool.sort((a, b) => b.likeCount - a.likeCount)
    const pick = pool[0]
    if (!pick) return 'no suitable tweets found'

    // Generate comment in owner's voice
    const client = new Anthropic()
    const pp = this.profile
    const ws = pp?.writingStats ?? {}
    const system = [
      `You are @${process.env.OWNER_HANDLE ?? 'owner'} writing a quote tweet comment. Real human, NOT a bot.`,
      ws.caseStyle ? `Case style: ${ws.caseStyle}` : '',
      ws.emojiUsage ? `Emoji usage: ${ws.emojiUsage}` : '',
      pp?.avoids?.length ? `You avoid: ${pp.avoids.join(', ')}` : '',
      `Write ONE sharp, opinionated comment on this tweet. Under 200 chars. No hashtags. Sound like you, not a generic take.`,
    ].filter(Boolean).join('\n')

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      temperature: 1.0,
      system,
      messages: [{ role: 'user', content: `Tweet by @${pick.authorHandle}: "${pick.text}"\n\nYour QT comment:` }],
    })
    const comment = resp.content[0].type === 'text' ? resp.content[0].text.trim().slice(0, 200) : ''
    if (!comment) return 'failed to generate comment'

    await this.playwrightClient.quoteTweet(pick.tweetId, comment)
    return `quote tweeted @${pick.authorHandle} (${pick.likeCount} likes):\ntheir tweet: "${pick.text.slice(0, 80)}"\nyour comment: "${comment}"`
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
