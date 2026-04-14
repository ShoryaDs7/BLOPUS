/**
 * PlaywrightTopicSearchProvider — Phase 2 only.
 *
 * Replaces TopicSearchProvider's raw fetch (which fails with 401).
 * Uses a headless Playwright browser with auth cookies injected,
 * so X sees it as a real logged-in browser — no session cookie issues.
 */

import { chromium, BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { ViralTweetCandidate } from './TopicSearchProvider'

const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile-search')

export class PlaywrightTopicSearchProvider {
  private context: BrowserContext | null = null
  private authToken: string
  private ct0: string

  constructor() {
    this.authToken = process.env.X_AUTH_TOKEN ?? ''
    this.ct0 = process.env.X_CT0 ?? ''
  }

  get enabled(): boolean {
    return Boolean(this.authToken && this.ct0)
  }

  async searchViral(
    topic: string,
    minLikes: number = 500,
    maxAgeMinutes: number = 120,
  ): Promise<ViralTweetCandidate[]> {
    if (!this.enabled) return []

    const context = await this.getContext()
    const page = await context.newPage()

    try {
      const query = `${topic} min_faves:${minLikes} -is:retweet lang:en`
      const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`
      console.log(`[PlaywrightSearch] Searching: "${topic}" min_faves:${minLikes}`)

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(3000)
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})
      await page.screenshot({ path: './memory-store/search-debug.png', fullPage: false })
      console.log('[PlaywrightSearch] Screenshot → memory-store/search-debug.png')

      const now = Date.now()
      const results: ViralTweetCandidate[] = []
      const articles = await page.locator('article[data-testid="tweet"]').all()

      for (const article of articles.slice(0, 20)) {
        try {
          const link = await article.locator('a[href*="/status/"]').first().getAttribute('href').catch(() => null)
          if (!link) continue
          const m = link.match(/\/([^/]+)\/status\/(\d+)/)
          if (!m) continue
          const [, authorHandle, tweetId] = m

          const textNodes = await article.locator('[data-testid="tweetText"]').allInnerTexts().catch(() => [] as string[])
          const text = textNodes.join(' | ').trim()
          if (!text || text.startsWith('RT @')) continue

          const datetime = await article.locator('time').first().getAttribute('datetime').catch(() => null)
          if (!datetime) continue
          const ageMinutes = (now - new Date(datetime).getTime()) / 60_000
          if (ageMinutes > maxAgeMinutes) continue

          const likeLabel = await article.locator('[data-testid="like"]').first().getAttribute('aria-label').catch(() => '') ?? ''
          const likeCount = parseLikeCount(likeLabel)

          results.push({ tweetId, authorHandle, text, likeCount, viewCount: 0, viewsPerMinute: 0, ageMinutes: Math.round(ageMinutes) })
        } catch { continue }
      }

      console.log(`[PlaywrightSearch] Found ${results.length} candidates`)
      return results.sort((a, b) => b.likeCount - a.likeCount)
    } catch (err) {
      console.warn(`[PlaywrightSearch] Error: ${err}`)
      return []
    } finally {
      await page.close()
    }
  }

  async close(): Promise<void> {
    await this.context?.close()
    this.context = null
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context

    fs.mkdirSync(USER_DATA_DIR, { recursive: true })

    this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--ignore-certificate-errors',
      ],
    })

    await this.context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete window.__playwright;
      delete window.__pwInitScripts;
    `)

    await this.context.addCookies([
      { name: 'auth_token', value: this.authToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
      { name: 'ct0',        value: this.ct0,       domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
    ])

    return this.context
  }
}

function parseLikeCount(label: string): number {
  const m = label.match(/([\d,.]+)\s*([KkMm]?)/)
  if (!m) return 0
  const n = parseFloat(m[1].replace(/,/g, ''))
  const suffix = m[2].toUpperCase()
  if (suffix === 'K') return Math.round(n * 1000)
  if (suffix === 'M') return Math.round(n * 1_000_000)
  return Math.round(n)
}
