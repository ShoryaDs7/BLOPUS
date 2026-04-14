/**
 * DiscordAdapter — Phase 4 (Playwright-based)
 * Controls the owner's real Discord account via browser automation.
 * Uses Playwright persistent context — logs in once, session persists forever.
 * Appears as a real human — no BOT tag, no token issues.
 *
 * Auth: DISCORD_EMAIL + DISCORD_PASSWORD in .env
 * Profile stored in: memory-store/chrome-profile-discord/
 */

import { chromium, BrowserContext, Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import type { MentionEvent, ReplyPayload } from '../x/types'

const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile-discord')

export interface DiscordHotMessage {
  id: string
  channelId: string
  guildId: string
  guildName: string
  channelName: string
  text: string
  authorHandle: string
  reactionCount: number
  createdAt: string
  isThread: boolean
  isForumPost: boolean
}

export interface DiscordForumThread {
  threadId: string
  forumChannelId: string
  guildId: string
  guildName: string
  forumName: string
  title: string
  messageCount: number
  createdAt: string
}

export class DiscordAdapter {
  private context: BrowserContext | null = null
  private page: Page | null = null
  private ownerHandle: string
  private email: string
  private password: string
  private pendingMentions: MentionEvent[] = []
  private myUsername: string = ''

  constructor(ownerHandle: string) {
    this.ownerHandle = ownerHandle
    this.email = process.env.DISCORD_EMAIL ?? ''
    this.password = process.env.DISCORD_PASSWORD ?? ''
  }

  async connect(): Promise<void> {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true })

    // Run headed so user can see what's happening (set DISCORD_HEADLESS=true to hide)
    const headless = process.env.DISCORD_HEADLESS === 'true'
    this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    })

    this.page = await this.context.newPage()
    await this.page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await this.page.waitForTimeout(3000)

    // Check if already logged in — URL not containing /login is the most reliable signal
    const checkLoggedIn = async () => {
      const url = this.page!.url()
      if (url.includes('/login') || url.includes('/register')) return false
      // Also check for any known logged-in UI element
      const hasApp = await this.page!.$('[data-list-id="guildsnav"], [aria-label="Direct Messages"], [class*="sidebar"], [class*="guilds"]')
        .then(el => !!el).catch(() => false)
      return hasApp || (!url.includes('/login') && url.includes('discord.com'))
    }

    let isLoggedIn = await checkLoggedIn()

    // Not logged in — relaunch headed so Discord doesn't block the login form
    if (!isLoggedIn) {
      console.log('[DiscordAdapter] Not logged in. Relaunching headed browser for login...')
      await this.context.close()
      this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 900 },
      })
      this.page = await this.context.newPage()
      await this.page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await this.page.waitForTimeout(3000)
      isLoggedIn = await checkLoggedIn()
    }

    if (!isLoggedIn) {
      console.log('[DiscordAdapter] Not logged in — logging in...')
      await this.login()
    } else {
      console.log('[DiscordAdapter] Already logged in (persistent session).')
    }

    // Get own username
    try {
      const nameEl = await this.page.$('[class*="nameTag"] [class*="username"]')
      if (nameEl) {
        this.myUsername = (await nameEl.innerText()).trim()
        console.log(`[DiscordAdapter] Connected as: ${this.myUsername}`)
      }
    } catch {
      console.log('[DiscordAdapter] Connected.')
    }
  }

  private async login(): Promise<void> {
    if (!this.page) throw new Error('[DiscordAdapter] No page')

    await this.page.goto('https://discord.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Wait for React to render the form — domcontentloaded fires before the SPA renders
    await this.page.waitForSelector('input[name="email"]', { timeout: 30000 })

    await this.page.fill('input[name="email"]', this.email)
    await this.page.waitForTimeout(500)
    await this.page.fill('input[name="password"]', this.password)
    await this.page.waitForTimeout(500)
    await this.page.click('button[type="submit"]')
    await this.page.waitForTimeout(5000)

    // Handle captcha / 2FA prompt — just wait and log
    const needs2FA = await this.page.$('input[placeholder*="6-digit"]').then(el => !!el).catch(() => false)
    if (needs2FA) {
      console.warn('[DiscordAdapter] 2FA required — please enter code in the browser window. Waiting 30s...')
      await this.page.waitForTimeout(30000)
    }

    const loggedIn = await this.page.$('[data-list-id="guildsnav"]').then(el => !!el).catch(() => false)
    if (!loggedIn) {
      throw new Error('[DiscordAdapter] Login failed. Check DISCORD_EMAIL and DISCORD_PASSWORD.')
    }
    console.log('[DiscordAdapter] Login successful.')
  }

  /**
   * Scans the Recent Mentions panel for @mentions of the owner.
   */
  async fetchOwnMentions(_sinceId?: string): Promise<MentionEvent[]> {
    if (!this.page) return []

    try {
      // Open Recent Mentions panel via keyboard shortcut or button
      // Navigate to mentions via URL hack — Discord's mentions panel
      await this.page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded', timeout: 15000 })
      await this.page.waitForTimeout(2000)

      // Click the @ (mentions) button in top right
      const mentionBtn = await this.page.$('button[aria-label="Recent Mentions"]')
        ?? await this.page.$('[aria-label="Recent Mentions"]')
      if (!mentionBtn) {
        return []
      }
      await mentionBtn.click()
      await this.page.waitForTimeout(1500)

      const mentions: MentionEvent[] = []

      // Scrape mention items from the panel
      const items = await this.page.$$('[data-list-id="mentions"] > li, [class*="mentionItem"], [class*="message-"]')
      for (const item of items.slice(0, 10)) {
        try {
          const text = await item.$eval('[id^="message-content-"]', el => el.textContent ?? '').catch(() => '')
          const author = await item.$eval('[class*="username"]', el => el.textContent ?? '').catch(() => 'unknown')
          const msgId = await item.getAttribute('id').catch(() => '') ?? ''
          const id = msgId.replace('chat-messages-', '').split('-').pop() ?? Date.now().toString()

          if (!text || text.length < 2) continue

          mentions.push({
            tweetId: id,
            authorId: author,
            authorHandle: author,
            text: text.replace(/@\S+/g, '').trim() || text,
            createdAt: new Date().toISOString(),
            conversationId: id,
            inReplyToTweetId: undefined,
            platform: 'discord' as any,
          })
        } catch { /* skip */ }
      }

      // Close the panel
      await this.page.keyboard.press('Escape')

      return mentions
    } catch (err) {
      console.error('[DiscordAdapter] fetchOwnMentions error:', err)
      return []
    }
  }

  /**
   * Reply to a Discord message by navigating to the channel and replying.
   */
  async postReply(payload: ReplyPayload): Promise<string> {
    if (!this.page) throw new Error('[DiscordAdapter] Not connected')

    // payload.conversationId is channelId, inReplyToTweetId is messageId
    const channelId = payload.inReplyToTweetId // reuse field as channel/message ref
    await this.postMessage(channelId, payload.text)
    return Date.now().toString()
  }

  /**
   * Navigate to a channel and post a message.
   * channelId can be a full Discord channel URL or just a channel ID.
   */
  async postMessage(channelId: string, text: string): Promise<string> {
    if (!this.page) throw new Error('[DiscordAdapter] Not connected')

    const url = channelId.startsWith('http')
      ? channelId
      : `https://discord.com/channels/@me/${channelId}`

    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
    await this.page.waitForTimeout(2000)

    await this.typeAndSend(text)
    return Date.now().toString()
  }

  /**
   * Navigate to a channel identified by guildId/channelId and post.
   */
  async postToChannel(guildId: string, channelId: string, text: string): Promise<string> {
    if (!this.page) throw new Error('[DiscordAdapter] Not connected')

    await this.page.goto(`https://discord.com/channels/${guildId}/${channelId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    })
    await this.page.waitForTimeout(2000)
    await this.typeAndSend(text)
    return Date.now().toString()
  }

  /**
   * Scan server channels for messages with high reaction counts.
   */
  async getHotMessages(guildIds: string[], _limit = 20): Promise<DiscordHotMessage[]> {
    if (!this.page) return []
    const results: DiscordHotMessage[] = []

    for (const guildId of guildIds) {
      try {
        // Navigate to the server — land on first available channel
        await this.page.goto(`https://discord.com/channels/${guildId}/@`, {
          waitUntil: 'domcontentloaded',
          timeout: 15000,
        }).catch(() => {})
        await this.page.waitForTimeout(2000)

        // Get current channel from URL
        const url = this.page.url()
        const channelMatch = url.match(/channels\/(\d+)\/(\d+)/)
        if (!channelMatch) continue
        const [, , channelId] = channelMatch

        // Get channel name
        const channelName = await this.page.$eval(
          'h2[class*="title"] span, [class*="headerText"]',
          el => el.textContent ?? 'general'
        ).catch(() => 'general')

        // Get guild name
        const guildName = await this.page.$eval(
          '[class*="guildName"], [class*="headerName"]',
          el => el.textContent ?? guildId
        ).catch(() => guildId)

        // Scrape messages with reactions
        const messages = await this.page.$$('li[id^="chat-messages-"]')
        for (const msg of messages.slice(0, 30)) {
          try {
            const text = await msg.$eval('[id^="message-content-"]', el => el.textContent ?? '').catch(() => '')
            if (!text || text.length < 10) continue

            const author = await msg.$eval('[class*="username"]', el => el.textContent ?? '').catch(() => 'unknown')

            // Count reactions
            const reactionEls = await msg.$$('[class*="reactionCount"]')
            let reactionCount = 0
            for (const r of reactionEls) {
              const count = parseInt(await r.innerText().catch(() => '0'), 10)
              reactionCount += isNaN(count) ? 0 : count
            }
            if (reactionCount < 3) continue

            const msgId = await msg.getAttribute('id') ?? ''
            const id = msgId.split('-').pop() ?? Date.now().toString()

            results.push({
              id,
              channelId,
              guildId,
              guildName,
              channelName,
              text,
              authorHandle: author,
              reactionCount,
              createdAt: new Date().toISOString(),
              isThread: false,
              isForumPost: false,
            })
          } catch { /* skip */ }
        }
      } catch (err) {
        console.error(`[DiscordAdapter] getHotMessages error for guild ${guildId}:`, err)
      }
    }

    return results.sort((a, b) => b.reactionCount - a.reactionCount)
  }

  /**
   * Create a new forum post by navigating to the forum channel.
   */
  async postForumThread(forumChannelUrl: string, title: string, text: string): Promise<string> {
    if (!this.page) throw new Error('[DiscordAdapter] Not connected')

    await this.page.goto(forumChannelUrl.startsWith('http') ? forumChannelUrl : `https://discord.com/channels/-/${forumChannelUrl}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    })
    await this.page.waitForTimeout(2000)

    // Click "New Post" button in forum channels
    const newPostBtn = await this.page.$('button:has-text("New Post")')
      ?? await this.page.$('[class*="newPost"]')
    if (!newPostBtn) {
      console.warn('[DiscordAdapter] Could not find New Post button in forum channel.')
      return ''
    }
    await newPostBtn.click()
    await this.page.waitForTimeout(1000)

    // Fill title
    const titleInput = await this.page.$('input[placeholder*="Post Title"], input[aria-label*="title" i]')
    if (titleInput) {
      await titleInput.fill(title)
      await this.page.waitForTimeout(300)
    }

    // Fill body
    await this.typeAndSend(text)
    return Date.now().toString()
  }

  /**
   * Stub — forum thread scanning via Playwright requires navigating each forum channel.
   * Returns empty for now; hot message hunting covers the main use case.
   */
  async getHotForumThreads(_guildIds: string[]): Promise<DiscordForumThread[]> {
    return []
  }

  /**
   * Reply inside an existing thread channel.
   */
  async replyInThread(threadChannelUrl: string, text: string): Promise<string> {
    return this.postMessage(threadChannelUrl, text)
  }

  /**
   * Join a Discord server by navigating to its invite link.
   */
  async joinServer(inviteCode: string): Promise<string | null> {
    if (!this.page) return null

    // Direct guild ID — navigate into the guild directly
    if (inviteCode.startsWith('__guild_')) {
      const guildId = inviteCode.replace('__guild_', '')
      await this.page.goto(`https://discord.com/channels/${guildId}`, {
        waitUntil: 'domcontentloaded', timeout: 15000,
      })
      await this.page.waitForTimeout(2000)
      const joinBtn = await this.page.$('button:has-text("Join Server"), button:has-text("Join")')
      if (joinBtn) {
        await joinBtn.click()
        await this.page.waitForTimeout(2000)
        console.log(`[DiscordAdapter] Joined guild: ${guildId}`)
      }
      return guildId
    }

    try {
      await this.page.goto(`https://discord.com/invite/${inviteCode}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      })
      await this.page.waitForTimeout(2000)

      // Click "Accept Invite" button
      const acceptBtn = await this.page.$('button:has-text("Accept Invite")')
        ?? await this.page.$('button:has-text("Join")')
      if (acceptBtn) {
        await acceptBtn.click()
        await this.page.waitForTimeout(2000)
        console.log(`[DiscordAdapter] Joined server via invite: ${inviteCode}`)
      }

      // Extract guild ID from redirect URL
      const url = this.page.url()
      const match = url.match(/channels\/(\d+)/)
      return match ? match[1] : null
    } catch (err) {
      console.error(`[DiscordAdapter] joinServer error (${inviteCode}):`, err)
      return null
    }
  }

  getPage(): import('playwright').Page | null {
    return this.page
  }

  isReady(): boolean {
    return this.context !== null && this.page !== null
  }

  async close(): Promise<void> {
    await this.context?.close()
    this.context = null
    this.page = null
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async typeAndSend(text: string): Promise<void> {
    if (!this.page) return

    // Find the message input box
    const input = await this.page.$('div[role="textbox"][data-slate-editor="true"]')
      ?? await this.page.$('[class*="textArea"] div[contenteditable="true"]')
      ?? await this.page.$('div[contenteditable="true"]')

    if (!input) {
      console.warn('[DiscordAdapter] Could not find message input box.')
      return
    }

    await input.click()
    await this.page.waitForTimeout(300)
    await this.page.keyboard.type(text, { delay: 30 + Math.random() * 20 })
    await this.page.waitForTimeout(400)
    await this.page.keyboard.press('Enter')
    await this.page.waitForTimeout(1000)
    console.log(`[DiscordAdapter] Message sent: "${text.slice(0, 60)}..."`)
  }
}
