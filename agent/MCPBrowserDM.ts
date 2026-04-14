/**
 * MCPBrowserDM — vision-based DM sender and inbox reader.
 *
 * Uses PlaywrightXClient (already authenticated) + BrowserAgent (Claude vision)
 * to navigate x.com/messages the same way a human would — reads what's on screen,
 * finds buttons by their label, not by hardcoded CSS selectors.
 *
 * Works for both accounts:
 *   - OsBot (@aiblopus): autonomous pack DMs
 *   - Owner (@shoryaDs7): polling inbox, drafting replies
 *
 * Never breaks on X UI changes — Claude reads the page semantically.
 */

import Anthropic from '@anthropic-ai/sdk'
import { BrowserAgent } from '../adapters/control/BrowserAgent'
import { PlaywrightXClient } from '../adapters/x/PlaywrightXClient'

export interface DmConversation {
  handle: string
  lastMessage: string
  isUnread: boolean
  userId?: string   // Twitter numeric ID from conversation URL — never changes on rename
}

export class MCPBrowserDM {
  private agent = new BrowserAgent()

  constructor(private playwright: PlaywrightXClient) {}

  // ── Send ─────────────────────────────────────────────────────────────────────

  async send(handle: string, text: string): Promise<boolean> {
    const { page, close } = await this.playwright.createPage()
    try {
      const h = handle.replace(/^@/, '')

      await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      // Handle passcode first — appears before any UI is usable
      await this.handlePasscode(page)

      // Step 1: click compose button — find by role/text, not CSS selector
      const opened = await this.clickFirst(page, [
        () => page.getByRole('button', { name: /new message/i }).first(),
        () => page.getByRole('button', { name: /new chat/i }).first(),
        () => page.getByRole('link',   { name: /new message/i }).first(),
        () => page.getByText('New chat').first(),
        () => page.getByText('New message').first(),
      ])
      if (!opened) {
        await page.screenshot({ path: './memory-store/dm-debug.png' })
        console.log(`[MCPBrowserDM] compose button not found`)
        return false
      }
      await page.waitForTimeout(2000)

      // Step 2: blocked message check (X privacy — "cannot send DMs")
      const blocked = await page.getByText(/cannot send Direct Messages/i).isVisible({ timeout: 1000 }).catch(() => false)
      if (blocked) { console.log(`[MCPBrowserDM] @${h} has DMs restricted`); return false }

      // Step 3: find search input and type handle
      const searchInput = page.getByPlaceholder(/search name or username/i).first()
      if (!await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await page.screenshot({ path: './memory-store/dm-debug.png' })
        console.log(`[MCPBrowserDM] search input not found`)
        return false
      }
      await searchInput.click()
      await searchInput.fill(h)
      await page.waitForTimeout(2500)

      // Step 4: click the matching user result
      const userResult = await this.clickFirst(page, [
        () => page.getByText(`@${h}`).first(),
        () => page.getByRole('option').first(),
        () => page.locator('[data-testid="TypeaheadUser"]').first(),
        () => page.locator('[data-testid="UserCell"]').first(),
      ])
      if (!userResult) {
        // blocked message may appear after typing
        const blockedAfter = await page.getByText(/cannot send Direct Messages/i).isVisible({ timeout: 1000 }).catch(() => false)
        if (blockedAfter) { console.log(`[MCPBrowserDM] @${h} has DMs restricted`); return false }
        console.log(`[MCPBrowserDM] user @${h} not found in search results`)
        return false
      }
      await page.waitForTimeout(1000)

      // Step 5: click Next if present
      const nextBtn = page.getByRole('button', { name: /next/i }).first()
      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click()
        await page.waitForTimeout(2000)
      }

      // Step 6: find message input and type
      const msgInput = page.getByRole('textbox').last()
      if (!await msgInput.isVisible({ timeout: 8000 }).catch(() => false)) {
        await page.screenshot({ path: './memory-store/dm-debug.png' })
        console.log(`[MCPBrowserDM] message input not found`)
        return false
      }
      await msgInput.click()
      await page.keyboard.type(text, { delay: 30 })
      await page.waitForTimeout(500)

      // Step 7: send — try multiple selectors for the blue send button
      const sendBtn = await this.clickFirst(page, [
        () => page.locator('[data-testid="dmComposerSendButton"]').first(),
        () => page.getByRole('button', { name: /send/i }).first(),
        () => page.getByRole('button', { name: /send message/i }).first(),
        // blue arrow button at right of input — last button in the composer area
        () => page.locator('[data-testid="toolBar"] button').last(),
        () => page.locator('button[type="submit"]').last(),
        // any button containing a send/arrow SVG near the input
        () => page.locator('div[data-testid="dmComposer"] button').last(),
      ])
      if (!sendBtn) {
        // Last resort: press Enter to send
        await msgInput.press('Enter')
        await page.waitForTimeout(500)
        console.log(`[MCPBrowserDM] send button not found — tried Enter`)
      }
      await page.waitForTimeout(2000)

      // Verify: message input should now be empty (cleared after send)
      await page.screenshot({ path: './memory-store/dm-after-send.png' })
      const inputAfter = await msgInput.inputValue().catch(() => '')
      const textContent = await msgInput.textContent().catch(() => '')
      const sentConfirmed = (inputAfter === '' && textContent === '') || !await msgInput.isVisible().catch(() => true)

      if (sentConfirmed) {
        console.log(`[MCPBrowserDM] DM sent to @${h} ✓`)
        return true
      } else {
        console.log(`[MCPBrowserDM] message still in input — send may have failed. screenshot: dm-after-send.png`)
        return false
      }
    } catch (err) {
      console.log(`[MCPBrowserDM] send() error: ${err}`)
      return false
    } finally {
      await close()
    }
  }

  // ── Read inbox ────────────────────────────────────────────────────────────────

  async readInbox(): Promise<DmConversation[]> {
    const { page, close } = await this.playwright.createPage()
    try {
      await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      await this.handlePasscode(page)

      // Wait for actual conversation items to appear in DOM
      await page.waitForSelector('[data-testid*="dm-conversation-item"]', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(500)

      const screenshotBuf = await page.screenshot({ path: './memory-store/dm-inbox-debug.png' })

      // DOM: get userId + lastMessage (reliable, never breaks on theme)
      const domConvos = await this.readInboxFromDom(page)

      // Vision: get unread status from screenshot (reliable, theme-agnostic)
      // Direct API call — no BrowserAgent to avoid auto-navigate side effects
      const client = new Anthropic()
      const visionResp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBuf.toString('base64') } },
            { type: 'text', text:
              `This is the x.com DM inbox. Look at the conversation list on the left.\n` +
              `For each conversation, tell me if it has an unread indicator (blue dot, bold name, or any unread marker).\n` +
              `Output one line per conversation in order:\n` +
              `UNREAD: <display name>\n` +
              `READ: <display name>\n` +
              `Only these lines, nothing else.`
            },
          ],
        }],
      }).catch(() => null)

      const visionText = visionResp?.content[0]?.type === 'text' ? visionResp.content[0].text : ''
      const unreadNames = new Set(
        visionText.split('\n')
          .filter(l => l.startsWith('UNREAD:'))
          .map(l => l.slice(7).trim().toLowerCase())
      )
      console.log(`[MCPBrowserDM] Vision unread names: ${[...unreadNames].join(', ') || 'none'}`)

      // Merge: DOM gives userId, vision gives isUnread
      if (domConvos.length > 0) {
        return domConvos.map(c => ({
          ...c,
          isUnread: unreadNames.has(c.handle.toLowerCase()),
        }))
      }

      return []
    } catch (err) {
      console.log(`[MCPBrowserDM] readInbox() error: ${err}`)
      return []
    } finally {
      await close()
    }
  }

  /** Read inbox + open a specific thread — all in one browser session, no extra page load */
  async readInboxAndThread(handle: string, userId?: string): Promise<{ convos: DmConversation[], thread: Array<{by: 'me'|'them', text: string}> }> {
    const { page, close } = await this.playwright.createPage()
    try {
      await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)
      await this.handlePasscode(page)
      await page.waitForSelector('[data-testid*="dm-conversation-item"]', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(500)

      const convos = await this.readInboxFromDom(page)

      // Click the thread in the same page
      let clicked = false
      if (userId) {
        const items = await page.locator('[data-testid*="dm-conversation-item-"]').all()
        for (const item of items) {
          const testId = await item.getAttribute('data-testid').catch(() => '')
          if (testId && testId.includes(userId)) { await item.click(); clicked = true; break }
        }
      }
      if (!clicked) {
        const h = handle.replace(/^@/, '')
        clicked = await this.clickFirst(page, [
          () => page.getByText(h, { exact: true }).first(),
          () => page.getByText(h, { exact: false }).first(),
        ])
      }

      let thread: Array<{by: 'me'|'them', text: string}> = []
      if (clicked) {
        await page.waitForTimeout(3000)
        thread = await this.readThreadVision(page, handle)
        console.log(`[MCPBrowserDM] readInboxAndThread: got ${thread.length} messages from @${handle}'s thread`)
      } else {
        console.log(`[MCPBrowserDM] readInboxAndThread: could not open thread for @${handle}`)
      }

      return { convos, thread }
    } catch (err) {
      console.log(`[MCPBrowserDM] readInboxAndThread error: ${err}`)
      return { convos: [], thread: [] }
    } finally {
      await close()
    }
  }

  /** Read inbox using CDP to get real unread state — never breaks on theme changes */
  private async readInboxFromDom(page: import('playwright').Page): Promise<DmConversation[]> {
    try {
      // Open CDP session on this page — direct access to DOM, no color guessing
      const cdp = await page.context().newCDPSession(page)

      // Get all dm-conversation-item nodes via CDP Runtime.evaluate
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `
          (function() {
            const items = document.querySelectorAll('[data-testid*="dm-conversation-item-"]');
            const results = [];
            for (const item of items) {
              const testId = item.getAttribute('data-testid') ?? '';
              const idPart = testId.replace('dm-conversation-item-', '');
              const parts = idPart.split(':');
              const userId = parts[1] ?? parts[0];
              if (!userId || !/^\\d{10,}$/.test(userId)) continue;

              const lines = (item.innerText ?? '').split('\\n').map(s => s.trim()).filter(Boolean);
              const displayName = lines[0] ?? userId;
              const lastMessage = lines.slice(1).find(l => l.length > 0 && !/^\\d+[smhd]$|^now$/i.test(l)) ?? '';

              // Use aria-label for unread detection — semantic, works on any theme/color
              const ariaLabel = (item.getAttribute('aria-label') ?? '').toLowerCase();
              const itemHtml = item.innerHTML;
              const isUnread = ariaLabel.includes('unread')
                || itemHtml.includes('data-testid="unread"')
                || !!item.querySelector('[data-testid*="unread"]')
                || !!item.querySelector('[aria-label*="nread"]');

              results.push({ userId, displayName, lastMessage, isUnread });
            }
            return JSON.stringify(results);
          })()
        `,
        returnByValue: true,
      })

      await cdp.detach()
      const raw: any[] = JSON.parse(result.value ?? '[]')

      console.log(`[MCPBrowserDM] DOM found ${raw.length} conversations`)
      return raw.map((r: any) => ({ handle: r.displayName, lastMessage: r.lastMessage, isUnread: r.isUnread, userId: r.userId }))
    } catch (err) {
      console.log(`[MCPBrowserDM] readInboxFromDom error: ${err}`)
      return []
    }
  }

  /** Scrape userId from DM conversation hrefs in the DOM — returns handle→userId map */
  private async scrapeUserIds(page: import('playwright').Page): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    try {
      // Each DM conversation is a link like /messages/<userId> or /messages/<userId>-<myId>
      const hrefs: string[] = await page.evaluate(() =>
        Array.from((globalThis as any).document.querySelectorAll('a[href*="/messages/"]'))
          .map((a: any) => a.getAttribute('href') ?? '')
          .filter((h: string) => h.includes('/messages/'))
      )
      // Also grab the visible username near each link so we can pair them
      const cells = await page.locator('[data-testid="conversation"]').all()
      for (const cell of cells) {
        try {
          const link = cell.locator('a[href*="/messages/"]').first()
          const href  = await link.getAttribute('href').catch(() => null)
          if (!href) continue
          // href is /messages/<numericId> — extract the first numeric segment
          const match = href.match(/\/messages\/(\d+)/)
          if (!match) continue
          const userId = match[1]
          // Get the handle from the cell — look for @username text
          const text = await cell.innerText().catch(() => '')
          const handleMatch = text.match(/@([\w\d_]+)/)
          if (handleMatch) map.set(handleMatch[1].toLowerCase(), userId)
        } catch {}
      }
      // Fallback: parse hrefs directly if cells approach got nothing
      if (map.size === 0) {
        for (const href of hrefs) {
          const match = href.match(/\/messages\/(\d+)/)
          if (match) {
            // Can't pair to handle without cell context — skip, not worth guessing
          }
        }
      }
    } catch (err) {
      console.log(`[MCPBrowserDM] scrapeUserIds error: ${err}`)
    }
    return map
  }

  // ── Read a specific conversation thread ──────────────────────────────────────

  async readConversation(handle: string, userId?: string): Promise<Array<{by: 'me'|'them', text: string}>> {
    return this.readConversationOnPage(handle, userId)
  }

  /** Opens inbox + clicks thread in a single browser session — no extra page load */
  private async readConversationOnPage(handle: string, userId?: string): Promise<Array<{by: 'me'|'them', text: string}>> {
    const { page, close } = await this.playwright.createPage()
    try {
      await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)
      await this.handlePasscode(page)
      await page.waitForSelector('[data-testid*="dm-conversation-item"]', { timeout: 10000 }).catch(() => {})

      // Click the conversation — match by userId in testid first (most reliable)
      let clicked = false
      if (userId) {
        const items = await page.locator('[data-testid*="dm-conversation-item-"]').all()
        for (const item of items) {
          const testId = await item.getAttribute('data-testid').catch(() => '')
          if (testId && testId.includes(userId)) {
            await item.click()
            clicked = true
            break
          }
        }
      }
      if (!clicked) {
        const h = handle.replace(/^@/, '')
        clicked = await this.clickFirst(page, [
          () => page.getByText(h, { exact: true }).first(),
          () => page.getByText(h, { exact: false }).first(),
        ])
      }
      if (!clicked) {
        console.log(`[MCPBrowserDM] readConversation: could not open thread for @${handle}`)
        return []
      }

      await page.waitForTimeout(3000)
      const messages = await this.readThreadVision(page, handle)
      console.log(`[MCPBrowserDM] readConversation: got ${messages.length} messages from @${handle}'s thread`)
      return messages
    } catch (err) {
      console.log(`[MCPBrowserDM] readConversation error: ${err}`)
      return []
    } finally {
      await close()
    }
  }

  private async readThreadVision(page: import('playwright').Page, handle: string): Promise<Array<{by: 'me'|'them', text: string}>> {
    try {
      // Take screenshot directly — do NOT use BrowserAgent.execute() because its system prompt
      // auto-navigates away whenever it sees a handle in the task text.
      const buf = await page.screenshot({ fullPage: false })
      const client = new Anthropic()
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } },
            { type: 'text', text:
              `This is a screenshot of x.com DM messages. The chat thread is open on the right side of the screen.\n\n` +
              `Inside the chat thread panel:\n` +
              `- Bubbles aligned to the RIGHT side of the chat panel = sent by ME (outgoing, usually blue)\n` +
              `- Bubbles aligned to the LEFT side of the chat panel = sent by the other person (incoming, usually grey/white)\n\n` +
              `List every message visible in order from oldest to newest.\n` +
              `Output one line per message:\n` +
              `ME: <text>\n` +
              `THEM: <text>\n\n` +
              `Only these lines. If no chat is open or no messages visible output: EMPTY`
            },
          ],
        }],
      })
      const result = resp.content[0].type === 'text' ? resp.content[0].text : ''
      if (result.toUpperCase().includes('EMPTY')) return []
      return result.split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('ME:') || l.startsWith('THEM:'))
        .map(l => l.startsWith('ME:')
          ? { by: 'me' as const, text: l.slice(3).trim() }
          : { by: 'them' as const, text: l.slice(5).trim() }
        )
    } catch (err) {
      console.log(`[MCPBrowserDM] readThreadVision error: ${err}`)
      return []
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private async handlePasscode(page: import('playwright').Page): Promise<void> {
    const passcode = process.env.X_DM_PASSCODE ?? ''
    const screen = page.locator('text=Enter Passcode').first()
    if (!await screen.isVisible({ timeout: 3000 }).catch(() => false)) return
    if (!passcode) { console.log('[MCPBrowserDM] Passcode screen appeared but X_DM_PASSCODE not set'); return }
    for (const digit of passcode) {
      await page.keyboard.press(digit)
      await page.waitForTimeout(400)
    }
    await page.waitForTimeout(5000)
    console.log('[MCPBrowserDM] Passcode entered')
  }

  // Try each locator in order, click the first visible one, return true if clicked
  private async clickFirst(
    page: import('playwright').Page,
    locators: Array<() => import('playwright').Locator>,
  ): Promise<boolean> {
    for (const fn of locators) {
      try {
        const loc = fn()
        if (await loc.isVisible({ timeout: 1500 })) {
          await loc.click()
          return true
        }
      } catch {}
    }
    return false
  }

  private parseInbox(raw: string): DmConversation[] {
    return raw
      .split('\n')
      .filter(l => l.includes('CONVO:'))
      .map(line => {
        const rest = line.split('CONVO:')[1] ?? ''
        const parts = rest.split('|').map(s => s.trim())
        return {
          handle: (parts[0] ?? '').replace('@', '').trim(),
          lastMessage: (parts[1] ?? '').trim(),
          isUnread: (parts[2] ?? '').toUpperCase().includes('UNREAD'),
        }
      })
      .filter(c => c.handle.length > 0)
  }
}
