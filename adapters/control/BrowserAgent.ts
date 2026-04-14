import Anthropic from '@anthropic-ai/sdk'
import { Page } from 'playwright'

/**
 * BrowserAgent — Claude Vision loop.
 *
 * Takes a screenshot of the current page, asks Claude what it sees,
 * and optionally scrolls/navigates for more context.
 *
 * For read tasks (summarize, find, check): one screenshot is usually enough.
 * For tasks needing navigation: Claude says what URL to go to next.
 *
 * No deprecated computer-use API needed — just vision + Playwright.
 */
export class BrowserAgent {
  private client = new Anthropic()

  async execute(task: string, page: Page): Promise<string> {
    let iterations = 0
    const MAX_ITER = 8

    const messages: Anthropic.MessageParam[] = []

    // First message: screenshot + task
    const buf = await page.screenshot({ fullPage: false })
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') },
        },
        {
          type: 'text',
          text: `You are looking at a real browser window showing x.com. The user is already logged in.\n\nTask: ${task}\n\nRules:\n- If the task mentions a @handle or username, your FIRST action must be NAVIGATE:https://x.com/<handle> (without the @).\n- If the task asks for N items (e.g. last 5 tweets), do NOT answer until you have found ALL N clearly visible on screen. Say SCROLL_DOWN to load more.\n- Never guess or fill in content you cannot clearly read — say exactly what you can see.\n- To navigate say exactly: NAVIGATE:<full_url>\n- To scroll say exactly: SCROLL_DOWN\n- Only give your final answer when you have found everything the task asks for.`,
        },
      ],
    })

    while (iterations++ < MAX_ITER) {
      const response = await this.client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages,
      })

      const text = response.content.find(b => b.type === 'text')?.type === 'text'
        ? (response.content.find(b => b.type === 'text') as Anthropic.TextBlock).text
        : ''

      // Claude is done — return the answer
      if (!text.startsWith('NAVIGATE:') && !text.startsWith('SCROLL_DOWN')) {
        return text
      }

      messages.push({ role: 'assistant', content: text })

      // Claude wants to navigate to a URL
      if (text.startsWith('NAVIGATE:')) {
        const url = text.replace('NAVIGATE:', '').trim()
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(3000)
      }

      // Claude wants to scroll down — scroll 5x aggressively so new tweets load
      if (text.startsWith('SCROLL_DOWN')) {
        for (let i = 0; i < 5; i++) {
          await page.mouse.wheel(0, 900)
          await page.waitForTimeout(500)
        }
        await page.waitForTimeout(1500)
      }

      // Take new screenshot and continue
      const newBuf = await page.screenshot({ fullPage: false })
      messages.push({
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: newBuf.toString('base64') },
          },
          { type: 'text', text: 'Here is the updated screen. Continue with the task.' },
        ],
      })
    }

    return 'could not complete task in time — try being more specific'
  }
}
