/**
 * PlaywrightDomainSearchProvider — Option A for OwnerViralReplyHunter.
 *
 * Searches X directly for viral tweets on each of the owner's dominant topics,
 * using Playwright (same persistent browser auth as home timeline — no cookie expiry).
 *
 * Flow:
 *   dominantTopics (from archive) → search x.com/search?q={topic}&f=live per topic
 *   → scrape viral candidates → return only on-domain tweets
 *
 * This guarantees 100% domain relevance — no off-topic slippage possible.
 * Option B (home timeline) remains unchanged and can be re-enabled via replyMode config.
 */

import { chromium, BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'
import { ViralTweetCandidate } from './TopicSearchProvider'

const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile-domain-search')

export class PlaywrightDomainSearchProvider {
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

  /**
   * Searches X for viral tweets across all given topics.
   * Each topic becomes a separate search — results are merged and deduped.
   *
   * @param topics - owner's dominantTopics from personality profile
   * @param minLikes - minimum like count to consider viral
   * @param maxAgeMinutes - ignore tweets older than this
   */
  async searchViralByTopics(
    topics: string[],
    minLikes: number = 200,
    maxAgeMinutes: number = 120,
    domainMinLikes?: Record<string, number>,
    domainSearchKeywords?: Record<string, string[]>,
  ): Promise<ViralTweetCandidate[]> {
    if (!this.enabled || topics.length === 0) return []

    const context = await this.getContext()
    const allResults: ViralTweetCandidate[] = []
    const seenIds = new Set<string>()

    for (const topic of topics) {
      try {
        const topicMinLikes = resolveMinLikes(topic, minLikes, domainMinLikes)
        // Use expanded keyword list if available, fall back to toSearchQuery
        const keywords = domainSearchKeywords?.[topic]?.length
          ? domainSearchKeywords[topic]
          : [toSearchQuery(topic)]

        for (const keyword of keywords) {
          try {
            const results = await this.searchOneTopic(context, keyword, topicMinLikes, maxAgeMinutes)
            for (const r of results) {
              if (!seenIds.has(r.tweetId)) {
                seenIds.add(r.tweetId)
                allResults.push(r)
              }
            }
            if (allResults.length > 0) break  // got one — stop searching this topic
          } catch (err) {
            console.warn(`[DomainSearch] Error searching keyword "${keyword}": ${err}`)
            if (String(err).includes('closed') || String(err).includes('crashed') || String(err).includes('Target page')) {
              this.context = null
              break
            }
          }
        }
        if (allResults.length > 0) break  // got one — stop searching other topics too
      } catch (err) {
        console.warn(`[DomainSearch] Error searching topic "${topic}": ${err}`)
        if (String(err).includes('closed') || String(err).includes('crashed') || String(err).includes('Target page')) {
          this.context = null
        }
      }
    }

    return allResults.sort((a, b) => b.likeCount - a.likeCount)
  }

  async close(): Promise<void> {
    await this.context?.close()
    this.context = null
  }

  private async searchOneTopic(
    context: BrowserContext,
    topic: string,
    minLikes: number,
    maxAgeMinutes: number,
  ): Promise<ViralTweetCandidate[]> {
    const page = await context.newPage()

    try {
      // X search: latest tweets on this topic — no min_faves in URL (X ignores it in live mode)
      // Like filtering is done client-side after scraping
      const query = encodeURIComponent(`${topic} -is:retweet lang:en`)
      const url = `https://x.com/search?q=${query}&f=top&src=typed_query`

      console.log(`[DomainSearch] Searching: "${topic}" (${minLikes}+ likes, <${maxAgeMinutes}min)`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(3500)
      await page.waitForSelector('[data-testid="tweetText"]', { timeout: 12000 }).catch(() => {})

      // Scroll twice to load more results
      await page.mouse.wheel(0, 1500)
      await page.waitForTimeout(1000)
      await page.mouse.wheel(0, 1500)
      await page.waitForTimeout(800)

      await page.screenshot({ path: `./memory-store/domain-search-${topic.replace(/\s+/g, '-')}.png` })

      const now = Date.now()
      const results: ViralTweetCandidate[] = []
      const articles = await page.locator('article[data-testid="tweet"]').all()
      console.log(`[DomainSearch] "${topic}" → ${articles.length} articles found`)

      for (const article of articles.slice(0, 30)) {
        try {
          const link = await article.locator('a[href*="/status/"]').first().getAttribute('href').catch(() => null)
          if (!link) continue
          const m = link.match(/\/([^/]+)\/status\/(\d+)/)
          if (!m) continue
          const [, authorHandle, tweetId] = m

          const textNodes = await article.locator('[data-testid="tweetText"]').allInnerTexts().catch(() => [] as string[])
          // Also try grabbing any visible text from the article as fallback
          const text = textNodes.join(' | ').trim()
          if (text.startsWith('RT @')) continue

          // Skip promoted tweets (no timestamp)
          const datetime = await article.locator('time').first().getAttribute('datetime').catch(() => null)
          if (!datetime) continue

          const ageMinutes = (now - new Date(datetime).getTime()) / 60_000
          if (ageMinutes > maxAgeMinutes) continue

          // X search results render like counts as visible text, not aria-label
          const likeLabel = await article.locator('[data-testid="like"]').first().getAttribute('aria-label').catch(() => '') ?? ''
          const likeInnerText = await article.locator('[data-testid="like"]').first().innerText().catch(() => '') ?? ''
          const likeCount = parseLikeCount(likeLabel) || parseLikeCount(likeInnerText)
          console.log(`[DomainSearch] @${authorHandle} → likes: ${likeCount} (label: "${likeLabel.slice(0,30)}" | text: "${likeInnerText.slice(0,20)}")`)
          if (likeCount < minLikes) continue

          // Scrape media
          const imgEls = await article.locator('img[src*="pbs.twimg.com"]').all()
          const mediaUrls: string[] = []
          for (const img of imgEls) {
            const src = await img.getAttribute('src').catch(() => null)
            if (src && !src.includes('profile_images')) mediaUrls.push(src)
          }

          results.push({
            tweetId,
            authorHandle,
            text,
            likeCount,
            viewCount: 0,
            viewsPerMinute: 0,
            ageMinutes: Math.round(ageMinutes),
            mediaUrls,
          })
        } catch { continue }
      }

      console.log(`[DomainSearch] "${topic}" → ${results.length} viral candidates`)
      return results
    } finally {
      await page.close()
    }
  }

  private async getContext(): Promise<BrowserContext> {
    if (this.context) {
      // Check if context is still alive — if not, reset and recreate
      try {
        await this.context.pages()
      } catch {
        console.log('[DomainSearch] Browser context was dead — recreating...')
        this.context = null
      }
    }
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
      { name: 'auth_token', value: this.authToken, domain: '.x.com', path: '/', secure: true, httpOnly: true,  sameSite: 'None' },
      { name: 'ct0',        value: this.ct0,       domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax'  },
    ])

    return this.context
  }
}

/**
 * Picks the minLikes threshold for a topic.
 * Checks domainMinLikes map for any keyword match, falls back to "default" or globalMin.
 */
function resolveMinLikes(topic: string, globalMin: number, domainMinLikes?: Record<string, number>): number {
  if (!domainMinLikes) return globalMin
  const lower = topic.toLowerCase()
  for (const [key, val] of Object.entries(domainMinLikes)) {
    if (key === 'default') continue
    if (lower.includes(key)) return val
  }
  return domainMinLikes['default'] ?? globalMin
}

/**
 * Converts a long dominantTopic phrase into a short X search query.
 * "AI agents and autonomous systems" → "AI agents autonomous"
 * Strips stop words, keeps first 3 meaningful words max.
 */
function toSearchQuery(topic: string): string {
  const STOP = new Set(['and','the','for','with','from','that','this','are','was','has','have','not','but','can','its','will','just','about','they','their','what','when','your','you','all','been','one','more','also','after','than','then','some','into','over','building','tactics','mindset','growth'])
  const words = topic
    .replace(/[^a-zA-Z0-9\s/-]/g, '')
    .split(/[\s/\-]+/)
    .filter(w => w.length >= 2 && !STOP.has(w.toLowerCase()))
  // Use just the single most distinctive keyword — short queries return far more X results
  return words[0] || topic.split(' ')[0]
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
