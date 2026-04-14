/**
 * PlaywrightHomeTimelineProvider — Phase 2 only.
 *
 * Instead of searching by topic, reads tweets directly from @shoryaDs7's
 * For You home timeline — exactly like a human scrolling their feed.
 * X's algorithm already curates it for the account's interests.
 */

import { chromium, BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { ViralTweetCandidate } from './TopicSearchProvider'

const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile-home')

export class PlaywrightHomeTimelineProvider {
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

  async getViralFromHome(
    minLikes: number = 200,
    maxAgeMinutes: number = 120,
  ): Promise<ViralTweetCandidate[]> {
    if (!this.enabled) return []

    const context = await this.getContext()
    const page = await context.newPage()

    try {
      console.log(`[HomeTimeline] Loading For You feed...`)
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(3000)
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})

      // Scroll deep to load more tweets — home timeline needs multiple scrolls
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 2000)
        await page.waitForTimeout(800)
      }

      await page.screenshot({ path: './memory-store/home-debug.png', fullPage: false })

      const now = Date.now()
      const results: ViralTweetCandidate[] = []
      const articles = await page.locator('article[data-testid="tweet"]').all()
      console.log(`[HomeTimeline] Found ${articles.length} articles on feed`)

      for (const article of articles.slice(0, 60)) {
        try {
          const link = await article.locator('a[href*="/status/"]').first().getAttribute('href').catch(() => null)
          if (!link) continue
          const m = link.match(/\/([^/]+)\/status\/(\d+)/)
          if (!m) continue
          const [, authorHandle, tweetId] = m

          // Grab all tweetText nodes — quote tweets have two (outer + quoted)
          const textNodes = await article.locator('[data-testid="tweetText"]').allInnerTexts().catch(() => [] as string[])
          const text = textNodes.join(' | ').trim()
          // Skip retweets, empty, and promoted
          if (!text || text.startsWith('RT @')) continue

          // Skip promoted tweets (no timestamp)
          const datetime = await article.locator('time').first().getAttribute('datetime').catch(() => null)
          if (!datetime) continue

          const ageMinutes = (now - new Date(datetime).getTime()) / 60_000
          if (ageMinutes > maxAgeMinutes) continue

          const likeLabel = await article.locator('[data-testid="like"]').first().getAttribute('aria-label').catch(() => '') ?? ''
          const likeCount = parseLikeCount(likeLabel)
          if (likeCount < minLikes) continue

          // Scrape thumbnail/image URLs — video thumbnails and photos
          const imgEls = await article.locator('img[src*="pbs.twimg.com"]').all()
          const mediaUrls: string[] = []
          for (const img of imgEls) {
            const src = await img.getAttribute('src').catch(() => null)
            if (src && !src.includes('profile_images')) mediaUrls.push(src)
          }

          results.push({ tweetId, authorHandle, text, likeCount, viewCount: 0, viewsPerMinute: 0, ageMinutes: Math.round(ageMinutes), mediaUrls })
        } catch { continue }
      }

      console.log(`[HomeTimeline] Found ${results.length} candidates (${minLikes}+ likes, <${maxAgeMinutes}min old)`)
      return results.sort((a, b) => b.likeCount - a.likeCount)
    } catch (err) {
      console.warn(`[HomeTimeline] Error: ${err}`)
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
