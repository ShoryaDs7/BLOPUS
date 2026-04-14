import { chromium, BrowserContext, Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

// Base chrome profile dir — each handle gets its own subdirectory to prevent session conflicts
const CHROME_PROFILE_BASE = path.resolve('./memory-store/chrome-profiles')

/**
 * PlaywrightXClient — posts to X via persistent Chrome browser profile.
 *
 * Uses a dedicated Chrome user data directory (like a real browser profile)
 * so login state, cookies, and session persist forever across restarts.
 * Only needs to log in once manually — never again unless X forces re-auth.
 */
export class PlaywrightXClient {
  private handle: string
  private password: string
  private context: BrowserContext | null = null
  private customUserDataDir?: string

  constructor(handle: string, password: string, userDataDir?: string) {
    this.handle = handle.replace(/^@/, '')
    this.password = password
    this.customUserDataDir = userDataDir
  }

  async postReply(tweetId: string, text: string): Promise<void> {
    const context = await this.getContext()
    const page = await context.newPage()

    try {
      const url = `https://x.com/i/web/status/${tweetId}`
      console.log(`[PlaywrightX] Navigating to tweet ${tweetId}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      // Wait for React to hydrate after initial load
      await page.waitForTimeout(6000)
      // Extra wait if page still loading
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

      await page.screenshot({ path: './memory-store/pw-debug.png', fullPage: false })
      console.log('[PlaywrightX] Screenshot saved → memory-store/pw-debug.png')

      await this.typeAndSubmitReply(page, text, tweetId)
    } finally {
      await page.close()
    }
  }

  async retweet(tweetId: string): Promise<void> {
    const context = await this.getContext()
    const page = await context.newPage()
    try {
      await page.goto(`https://x.com/i/web/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      // Wait for tweet content to actually render
      await page.locator('[data-testid="tweetText"]').first().waitFor({ state: 'visible', timeout: 20000 })
      await page.waitForTimeout(1500 + Math.random() * 1000)

      const retweetBtn = page.locator('[data-testid="retweet"]').first()
      await retweetBtn.waitFor({ state: 'visible', timeout: 10000 })
      await retweetBtn.click()
      await page.waitForTimeout(800 + Math.random() * 600)

      // Click "Repost" (not Quote) from the dropdown
      const repostOption = page.getByRole('menuitem', { name: /repost/i }).first()
      await repostOption.waitFor({ state: 'visible', timeout: 5000 })
      await repostOption.click()
      await page.waitForTimeout(1500 + Math.random() * 1000)

      console.log(`[PlaywrightX] Retweeted ${tweetId}`)
    } finally {
      await page.close()
    }
  }

  async quoteTweet(tweetId: string, text: string): Promise<void> {
    const context = await this.getContext()
    const page = await context.newPage()
    try {
      await page.goto(`https://x.com/i/web/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(3000 + Math.random() * 1000)

      // Click the retweet button to open dropdown
      const retweetBtn = page.locator('[data-testid="retweet"]').first()
      await retweetBtn.waitFor({ state: 'visible', timeout: 10000 })
      await retweetBtn.click()
      await page.waitForTimeout(800 + Math.random() * 400)

      // Select "Quote" from the dropdown menu
      const quoteOption = page.getByRole('menuitem', { name: /quote/i }).first()
      await quoteOption.waitFor({ state: 'visible', timeout: 5000 })
      await quoteOption.click()
      await page.waitForTimeout(1500 + Math.random() * 500)

      // Type comment in the compose box
      const composeBox = page.locator('[data-testid="tweetTextarea_0"]').first()
      await composeBox.waitFor({ state: 'visible', timeout: 10000 })
      await composeBox.click()
      await page.keyboard.type(text, { delay: 35 + Math.random() * 30 })
      await page.waitForTimeout(600 + Math.random() * 400)

      // Submit
      const submitBtn = page.locator('[data-testid="tweetButton"]').first()
      await submitBtn.waitFor({ state: 'visible', timeout: 5000 })
      await submitBtn.click()
      await page.waitForTimeout(2000)
      console.log(`[PlaywrightX] Quote tweeted ${tweetId}`)
    } finally {
      await page.close()
    }
  }

  async postTweet(text: string): Promise<void> {
    const context = await this.getContext()
    const page = await context.newPage()

    try {
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 })

      const composeBox = page.locator('[data-testid="tweetTextarea_0"]').first()
      await composeBox.waitFor({ state: 'visible', timeout: 10000 })
      await composeBox.click()
      await page.keyboard.type(text, { delay: 35 + Math.random() * 30 })
      await page.waitForTimeout(600 + Math.random() * 400)

      // X uses tweetButton on some pages and tweetButtonInline on home compose
      const submitBtn = page.locator('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]').first()
      await submitBtn.waitFor({ state: 'visible', timeout: 8000 })
      await submitBtn.click()
      await page.waitForTimeout(2000)
      console.log(`[PlaywrightX] Tweet posted`)
    } finally {
      await page.close()
    }
  }

  // Scrape tweet articles from a loaded page — shared by search and trending
  private async scrapeTweetArticles(
    page: import('playwright').Page,
    label: string,
  ): Promise<{ tweetId: string; text: string; authorHandle: string }[]> {
    // Wait for first tweet article to appear — up to 10s
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})
    // Scroll once to trigger lazy loading
    await page.evaluate('window.scrollBy(0, 400)')
    await page.waitForTimeout(1500)

    const tweets = await page.evaluate(`
      (() => {
        const items = []
        document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
          if ((article.textContent || '').includes('Replying to')) return
          const links = article.querySelectorAll('a[href*="/status/"]')
          let tweetId = ''
          for (const link of links) {
            const match = link.href.match(/\\/status\\/(\\d+)/)
            if (match) { tweetId = match[1]; break }
          }
          const textEl = article.querySelector('[data-testid="tweetText"]')
          const text = textEl ? textEl.innerText || textEl.textContent : ''
          const handleEl = article.querySelector('[data-testid="User-Name"] a[href^="/"]')
          const handle = handleEl ? handleEl.getAttribute('href').replace('/', '') : ''
          if (tweetId && text && text.length > 10 && handle) {
            items.push({ tweetId, text: text.trim(), authorHandle: handle })
          }
        })
        return items
      })()
    `) as { tweetId: string; text: string; authorHandle: string }[]

    console.log(`[PlaywrightX] ${label}: scraped ${tweets.length} tweets`)
    return tweets
  }

  // Search for tweets — root tweets only, sorted by Top (high engagement)
  async searchTweets(
    query: string,
    count: number = 10,
  ): Promise<{ tweetId: string; text: string; authorHandle: string }[]> {
    const context = await this.getContext()
    const page = await context.newPage()

    try {
      const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=top`
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
      await page.waitForTimeout(2000)

      const tweets = await this.scrapeTweetArticles(page, `search "${query}"`)

      // Retry once with networkidle if nothing found
      if (tweets.length === 0) {
        await page.waitForTimeout(3000)
        const retry = await this.scrapeTweetArticles(page, `search "${query}" retry`)
        await page.screenshot({ path: './memory-store/pw-search-debug.png', fullPage: false })
        console.log(`[PlaywrightX] Search "${query}" (top/root): found ${retry.length} tweets`)
        return retry.slice(0, count)
      }

      await page.screenshot({ path: './memory-store/pw-search-debug.png', fullPage: false })
      console.log(`[PlaywrightX] Search "${query}" (top/root): found ${tweets.length} tweets`)
      return tweets.slice(0, count)
    } catch (err) {
      console.warn(`[PlaywrightX] Search failed:`, err)
      return []
    } finally {
      await page.close()
    }
  }

  // Get trending tweets by category.
  // Strategy: explore/tabs/trending shows topic cards not tweet articles.
  // Real fix: search top tweets for category-specific high-signal queries.
  async getTrendingTweets(
    category: string,
    count: number = 10,
  ): Promise<{ tweetId: string; text: string; authorHandle: string }[]> {
    const context = await this.getContext()
    const page = await context.newPage()

    // Category → list of high-signal search queries (tried in order until we get results)
    const CATEGORY_QUERIES: Record<string, string[]> = {
      technology:   ['AI 2026', 'tech startup founder', 'software engineering', 'developer'],
      ai:           ['AI agents', 'LLM OpenAI', 'artificial intelligence startup', 'Claude GPT'],
      science:      ['science discovery 2026', 'research breakthrough', 'physics space'],
      crypto:       ['Bitcoin 2026', 'crypto web3', 'blockchain DeFi'],
      business:     ['startup funding', 'founder build', 'SaaS growth'],
      politics:     ['policy 2026', 'election government', 'politics news'],
      sports:       ['football NBA cricket 2026', 'sports highlights'],
    }

    const cat = category.toLowerCase()
    const queries = CATEGORY_QUERIES[cat]
      ?? CATEGORY_QUERIES[Object.keys(CATEGORY_QUERIES).find(k => cat.includes(k) || k.includes(cat)) ?? '']
      ?? [`${category} trending 2026`, category]

    try {
      // First attempt: x.com/explore — click first trending topic that matches category
      await page.goto('https://x.com/explore', { waitUntil: 'domcontentloaded', timeout: 25000 })
      await page.waitForTimeout(3000)

      // Try to find and click a trending topic link matching the category
      const clicked = await page.evaluate(`
        (() => {
          const cat = ${JSON.stringify(cat)}
          // Trending topics appear as links or cells in the explore sidebar
          const cells = document.querySelectorAll('[data-testid="trend"], [href*="/search?q="], a[href*="trend"]')
          for (const el of cells) {
            const text = (el.textContent || '').toLowerCase()
            if (text.includes(cat) || cat.includes(text.trim().split('\\n')[0])) {
              el.click()
              return true
            }
          }
          return false
        })()
      `)

      if (clicked) {
        await page.waitForTimeout(3000)
        const tweets = await this.scrapeTweetArticles(page, `trending explore (${category})`)
        if (tweets.length > 0) {
          console.log(`[PlaywrightX] Trending explore (${category}): found ${tweets.length} tweets`)
          return tweets.slice(0, count)
        }
      }

      // Fallback: search top tweets for category queries one by one until we get enough
      console.log(`[PlaywrightX] Explore click failed for "${category}" — trying search fallback`)
      const all: { tweetId: string; text: string; authorHandle: string }[] = []
      const seen = new Set<string>()

      for (const q of queries) {
        if (all.length >= count) break
        await page.goto(`https://x.com/search?q=${encodeURIComponent(q)}&f=top`, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(2000)
        const batch = await this.scrapeTweetArticles(page, `trending fallback "${q}"`)
        for (const t of batch) {
          if (!seen.has(t.tweetId)) { seen.add(t.tweetId); all.push(t) }
          if (all.length >= count) break
        }
      }

      console.log(`[PlaywrightX] Trending (${category}): found ${all.length} tweets via search fallback`)
      return all.slice(0, count)
    } catch (err) {
      console.warn(`[PlaywrightX] getTrendingTweets failed:`, err)
      return this.searchTweets(`${category} trending`, count)
    } finally {
      await page.close()
    }
  }

  /**
   * getTrendingByCategory — for user commands only (not autonomous system).
   * Goes to x.com/explore, finds the tab matching the requested category,
   * verifies it actually loaded, scrapes tweets, filters by topic relevance.
   * Dynamic — works for any category: tech, politics, sports, poland, crypto, etc.
   */
  async getTrendingByCategory(
    category: string,
    count: number = 10,
  ): Promise<{ tweetId: string; text: string; authorHandle: string; likes: number }[]> {
    const context = await this.getContext()
    const page = await context.newPage()

    // Category → related keywords for relevance filtering (unchanged)
    const CATEGORY_KEYWORDS: Record<string, string[]> = {
      politics: ['government', 'president', 'election', 'congress', 'senate', 'policy', 'trump', 'biden', 'democrat', 'republican', 'vote', 'law', 'bill', 'minister', 'parliament'],
      news: ['breaking', 'report', 'announced', 'official', 'government', 'crisis', 'attack', 'died', 'killed'],
      sports: ['game', 'match', 'win', 'loss', 'goal', 'score', 'player', 'team', 'nba', 'nfl', 'cricket', 'football', 'champion'],
      entertainment: ['movie', 'show', 'album', 'song', 'actor', 'actress', 'film', 'music', 'celebrity', 'award'],
      technology: ['ai', 'tech', 'software', 'startup', 'code', 'model', 'agent', 'llm', 'openai', 'google', 'apple', 'microsoft'],
      crypto: ['bitcoin', 'btc', 'eth', 'crypto', 'blockchain', 'token', 'defi', 'nft', 'web3'],
    }

    // Scrape tweet articles with like counts from whatever page is currently loaded
    const scrapeWithLikes = async (): Promise<{ tweetId: string; text: string; authorHandle: string; likes: number }[]> => {
      await page.evaluate('window.scrollBy(0, 600)')
      await page.waitForTimeout(1500)
      return (await page.evaluate(`
        (() => {
          const items = []
          document.querySelectorAll('article[data-testid="tweet"]').forEach(article => {
            const links = article.querySelectorAll('a[href*="/status/"]')
            let tweetId = ''
            for (const link of links) {
              const match = link.href.match(/\\/status\\/(\\d+)/)
              if (match) { tweetId = match[1]; break }
            }
            const textEl = article.querySelector('[data-testid="tweetText"]')
            const text = textEl ? textEl.innerText : ''
            const handleEl = article.querySelector('[data-testid="User-Name"] a[href^="/"]')
            const handle = handleEl ? handleEl.getAttribute('href').replace('/', '') : ''
            const likeBtn = article.querySelector('[data-testid="like"] span')
            const likeText = likeBtn ? likeBtn.innerText : '0'
            const likeNum = likeText.includes('K') ? parseFloat(likeText) * 1000 :
                            likeText.includes('M') ? parseFloat(likeText) * 1000000 :
                            parseInt(likeText) || 0
            if (tweetId && text && text.length > 10 && handle) {
              items.push({ tweetId, text: text.trim(), authorHandle: handle, likes: likeNum })
            }
          })
          return items
        })()
      `)) as { tweetId: string; text: string; authorHandle: string; likes: number }[]
    }

    // Filter + sort by relevance then likes (unchanged logic)
    const filterAndSort = (tweets: { tweetId: string; text: string; authorHandle: string; likes: number }[]) => {
      const catLower = category.toLowerCase()
      const extraKeywords = CATEGORY_KEYWORDS[catLower]
        ?? CATEGORY_KEYWORDS[Object.keys(CATEGORY_KEYWORDS).find(k => catLower.includes(k)) ?? '']
        ?? []
      const keywords = [...catLower.split(/\s+/).filter(w => w.length > 3), ...extraKeywords]
      const relevant = tweets.filter(t => keywords.some(k => t.text.toLowerCase().includes(k)))
      const result = relevant.length >= 2 ? relevant : tweets
      result.sort((a, b) => b.likes - a.likes)
      console.log(`[PlaywrightX] ${relevant.length} topic-relevant tweets, returning top ${count}`)
      return result.slice(0, count)
    }

    try {
      const catLower = category.toLowerCase()
      console.log(`[PlaywrightX] Going to explore for category: "${category}"`)
      await page.goto('https://x.com/explore', { waitUntil: 'domcontentloaded', timeout: 30000 })

      // Wait for tabs to render before interacting
      await page.waitForSelector('[role="tab"]', { timeout: 20000 }).catch(() => {})
      await page.waitForTimeout(1500)

      // Map category to X's actual explore tabs
      const TAB_MAP: Record<string, string> = {
        politics: 'trending', news: 'news', current: 'news', world: 'news',
        sports: 'sports', football: 'sports', cricket: 'sports', nba: 'sports',
        entertainment: 'entertainment', movies: 'entertainment', music: 'entertainment',
        technology: 'trending', tech: 'trending', ai: 'trending', crypto: 'trending',
        business: 'trending', startup: 'trending',
      }
      const targetTab = TAB_MAP[catLower]
        ?? TAB_MAP[Object.keys(TAB_MAP).find(k => catLower.includes(k)) ?? '']
        ?? 'trending'

      // --- Step 1: click the correct tab via Playwright locator (not page.evaluate) ---
      let tabClicked = false
      const allTabs = await page.locator('[role="tab"]').all()
      for (const tab of allTabs) {
        const text = (await tab.textContent() ?? '').toLowerCase().trim()
        if (text === targetTab || text.includes(targetTab)) {
          await tab.click()
          console.log(`[PlaywrightX] Clicked tab: "${text}" for category "${category}"`)
          tabClicked = true
          break
        }
      }

      if (!tabClicked) {
        console.log(`[PlaywrightX] Tab "${targetTab}" not found — staying on default explore`)
      }

      // --- Step 2: wait for trend cards to actually appear (not a blind timeout) ---
      const trendCardsVisible = await page.waitForSelector('[data-testid="trend"]', { timeout: 10000 })
        .then(() => true).catch(() => false)

      await page.screenshot({ path: './memory-store/pw-trending-debug.png', fullPage: false })

      if (trendCardsVisible) {
        // --- Step 3: pick the best matching trend card via Playwright locator ---
        const trendLocators = await page.locator('[data-testid="trend"]').all()
        console.log(`[PlaywrightX] Found ${trendLocators.length} trend cards`)

        // Score each card by keyword match; fall back to first card if none match
        const cardKeywords = CATEGORY_KEYWORDS[catLower] ?? []
        let bestCard = trendLocators[0] ?? null
        let bestScore = -1
        for (const card of trendLocators) {
          const cardText = (await card.textContent() ?? '').toLowerCase()
          const score = cardKeywords.filter(k => cardText.includes(k)).length
          if (score > bestScore) { bestScore = score; bestCard = card }
        }

        if (bestCard && bestScore > 0) {
          const cardText = (await bestCard.textContent() ?? '').trim().slice(0, 60)
          console.log(`[PlaywrightX] Clicking trend card: "${cardText}" (score: ${bestScore})`)

          // Click via Playwright locator — properly tracked by navigation
          await bestCard.click()

          // --- Step 4: wait for tweet articles to load after card click ---
          const articlesLoaded = await page.waitForSelector('article[data-testid="tweet"]', { timeout: 12000 })
            .then(() => true).catch(() => false)

          if (articlesLoaded) {
            await page.waitForTimeout(1000)
            const tweets = await scrapeWithLikes()
            console.log(`[PlaywrightX] Scraped ${tweets.length} tweets via trend card click`)
            if (tweets.length > 0) return filterAndSort(tweets)
          } else {
            console.log(`[PlaywrightX] Articles didn't load after card click — falling back to search`)
          }
        }
      } else {
        console.log(`[PlaywrightX] Trend cards didn't appear — falling back to search`)
      }

      // --- Search fallback (last resort only) ---
      console.log(`[PlaywrightX] Search fallback for category: "${category}"`)
      const FALLBACK_QUERIES: Record<string, string[]> = {
        technology:   ['AI 2026', 'tech startup founder', 'software engineering'],
        ai:           ['AI agents', 'LLM OpenAI', 'Claude GPT'],
        science:      ['science discovery 2026', 'research breakthrough'],
        crypto:       ['Bitcoin 2026', 'crypto web3'],
        business:     ['startup funding', 'founder build'],
        politics:     ['policy 2026', 'election government'],
        sports:       ['football NBA cricket 2026'],
        entertainment: ['movie release 2026', 'music celebrity'],
      }
      const queries = FALLBACK_QUERIES[catLower]
        ?? FALLBACK_QUERIES[Object.keys(FALLBACK_QUERIES).find(k => catLower.includes(k)) ?? '']
        ?? [`${category} trending 2026`, category]

      const all: { tweetId: string; text: string; authorHandle: string; likes: number }[] = []
      const seen = new Set<string>()
      for (const q of queries) {
        if (all.length >= count) break
        await page.goto(`https://x.com/search?q=${encodeURIComponent(q)}&f=top`, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForSelector('article[data-testid="tweet"]', { timeout: 8000 }).catch(() => {})
        const batch = await scrapeWithLikes()
        for (const t of batch) {
          if (!seen.has(t.tweetId)) { seen.add(t.tweetId); all.push(t) }
          if (all.length >= count) break
        }
      }
      console.log(`[PlaywrightX] Search fallback found ${all.length} tweets for "${category}"`)
      return filterAndSort(all)

    } catch (err) {
      console.warn(`[PlaywrightX] getTrendingByCategory failed:`, err)
      return []
    } finally {
      await page.close()
    }
  }

  async followUser(handle: string): Promise<'followed' | 'already_following' | 'not_found'> {
    const context = await this.getContext()
    const page = await context.newPage()
    try {
      const h = handle.replace(/^@/, '')
      await page.goto(`https://x.com/${h}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      // Already following — aria-label contains "Following"
      const alreadyFollowing = page.locator('[aria-label*="Following"]').first()
      if (await alreadyFollowing.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`[PlaywrightX] Already following @${h}`)
        return 'already_following'
      }

      // Try multiple selectors for follow button
      const selectors = [
        '[data-testid="followButton"]',
        '[aria-label^="Follow @"]',
        'button[aria-label*="Follow"]',
      ]
      for (const sel of selectors) {
        const btn = page.locator(sel).first()
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click()
          await page.waitForTimeout(1500)
          console.log(`[PlaywrightX] Followed @${h}`)
          return 'followed'
        }
      }

      await page.screenshot({ path: './memory-store/follow-debug.png' })
      console.log(`[PlaywrightX] Follow button not found for @${h} — screenshot saved to follow-debug.png`)
      return 'not_found'
    } finally {
      await page.close()
    }
  }

  async likeTweets(tweetIds: string[]): Promise<number> {
    const context = await this.getContext()
    const page = await context.newPage()
    let liked = 0
    try {
      for (const tweetId of tweetIds) {
        await page.goto(`https://x.com/i/web/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
        await page.waitForTimeout(2000)
        // data-testid="like" = not yet liked, "unlike" = already liked
        const alreadyLiked = page.locator('[data-testid="unlike"]').first()
        if (await alreadyLiked.isVisible({ timeout: 2000 }).catch(() => false)) {
          console.log(`[PlaywrightX] Tweet ${tweetId} already liked — skipping`)
          continue
        }
        const likeBtn = page.locator('[data-testid="like"]').first()
        if (await likeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await likeBtn.click()
          liked++
          console.log(`[PlaywrightX] Liked tweet ${tweetId}`)
          await page.waitForTimeout(2000 + Math.random() * 1000)
        }
      }
    } finally {
      await page.close()
    }
    return liked
  }

  /**
   * updateBio — navigates to profile edit page and appends or replaces bio text.
   *
   * mode 'append': adds text to end of existing bio (e.g. " | blopus:a3f9b2")
   * mode 'replace': overwrites bio entirely
   *
   * Returns true if saved successfully.
   */
  async updateBio(text: string, mode: 'append' | 'replace' = 'append'): Promise<boolean> {
    const context = await this.getContext()
    const page = await context.newPage()
    try {
      await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      // Bio textarea
      const bioField = page.locator('[data-testid="bioTextArea"], textarea[name="description"]').first()
      if (!await bioField.isVisible({ timeout: 8000 }).catch(() => false)) {
        await page.screenshot({ path: './memory-store/bio-update-debug.png' })
        console.log('[PlaywrightX] Bio field not found — screenshot saved to bio-update-debug.png')
        return false
      }

      const currentBio = await bioField.inputValue()

      let newBio: string
      if (mode === 'replace') {
        newBio = text
      } else {
        // Don't append if already present
        if (currentBio.includes(text.trim())) {
          console.log('[PlaywrightX] Bio already contains text — skipping update')
          return true
        }
        newBio = (currentBio + ' ' + text).trim()
      }

      await bioField.fill(newBio)
      await page.waitForTimeout(1000)

      // Save button
      const saveBtn = page.locator('[data-testid="Profile_Save_Button"]').first()
      if (!await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('[PlaywrightX] Save button not found')
        return false
      }
      await saveBtn.click()
      await page.waitForTimeout(2000)

      console.log(`[PlaywrightX] Bio updated — "${newBio}"`)
      return true
    } finally {
      await page.close()
    }
  }

  /**
   * sendDm — sends a direct message to a user on X.
   * Navigates to x.com/messages, opens or creates a conversation with the handle,
   * types the message, and sends it.
   * Returns true if sent successfully.
   */
  async sendDm(handle: string, text: string): Promise<boolean> {
    const context = await this.getContext()
    const page = await context.newPage()
    try {
      const h = handle.replace(/^@/, '')
      await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      // Handle encryption passcode screen — appears immediately on messages page
      const passcodeScreen = page.locator('text=Enter Passcode').first()
      if (await passcodeScreen.isVisible({ timeout: 3000 }).catch(() => false)) {
        const passcode = process.env.X_DM_PASSCODE ?? ''
        if (!passcode) {
          console.log('[PlaywrightX] DM passcode screen appeared but X_DM_PASSCODE not set')
          return false
        }
        for (const digit of passcode) {
          await page.keyboard.press(digit)
          await page.waitForTimeout(400)
        }
        await page.waitForTimeout(5000)
        console.log('[PlaywrightX] DM passcode entered')
      }

      // Click compose button to open new DM dialog
      const composeSelectors = [
        '[data-testid="NewDM_Button"]',
        '[data-testid="dmNewMessagePillButton"]',
        '[aria-label="New message"]',
        'a[href="/messages/new"]',
      ]
      let opened = false
      for (const sel of composeSelectors) {
        const btn = page.locator(sel).first()
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await btn.click()
          await page.waitForTimeout(2000)
          opened = true
          break
        }
      }
      // Fallback: click "New chat" or "Write a message" button text
      if (!opened) {
        for (const txt of ['New chat', 'Write a message', 'New message']) {
          const writeBtn = page.locator('button', { hasText: txt }).first()
          if (await writeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await writeBtn.click()
            await page.waitForTimeout(2000)
            opened = true
            break
          }
        }
      }
      if (!opened) {
        await page.screenshot({ path: './memory-store/dm-debug.png' })
        console.log(`[PlaywrightX] Could not open DM compose dialog`)
        return false
      }

      // Search for handle in the DM compose search box
      const searchInput = page.locator(
        '[data-testid="searchPeople"], input[placeholder="Search name or username"], input[placeholder*="Search"]'
      ).first()
      if (!await searchInput.isVisible({ timeout: 8000 }).catch(() => false)) {
        await page.screenshot({ path: './memory-store/dm-debug.png' })
        console.log(`[PlaywrightX] DM search input not found — screenshot saved`)
        return false
      }

      // Click suggestion by handle text (works both before and after typing)
      const clickUser = async (): Promise<boolean> => {
        // Try text-based match first (most reliable)
        const byText = page.locator(`text=@${h}`).first()
        if (await byText.isVisible({ timeout: 2000 }).catch(() => false)) {
          await byText.click()
          return true
        }
        // Try data-testid variants
        const byTestId = page.locator(
          `[data-testid="TypeaheadUser"], [data-testid="UserCell"], [role="option"]`
        ).first()
        if (await byTestId.isVisible({ timeout: 2000 }).catch(() => false)) {
          await byTestId.click()
          return true
        }
        return false
      }

      // First check suggestions pre-loaded in modal
      if (!await clickUser()) {
        // Type handle and retry
        await searchInput.click()
        await searchInput.fill(h)
        await page.waitForTimeout(2500)
        if (!await clickUser()) {
          await page.screenshot({ path: './memory-store/dm-debug.png' })
          console.log(`[PlaywrightX] DM: @${h} not found in search results`)
          return false
        }
      }
      await page.waitForTimeout(1000)

      // Click Next to open the compose window
      const nextBtn = page.locator('[data-testid="nextButton"]').first()
      if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nextBtn.click()
        await page.waitForTimeout(2000)
      }

      // Type message
      const msgBox = page.locator(
        '[data-testid="dmComposerTextInput"], [data-testid="tweetTextarea_0"], [contenteditable="true"], textarea'
      ).first()
      if (!await msgBox.isVisible({ timeout: 8000 }).catch(() => false)) {
        await page.screenshot({ path: './memory-store/dm-debug.png' })
        console.log(`[PlaywrightX] DM compose box not found`)
        return false
      }

      await msgBox.fill(text)
      await page.waitForTimeout(500)

      // Send
      const sendBtn = page.locator('[data-testid="dmComposerSendButton"]').first()
      if (!await sendBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log(`[PlaywrightX] DM send button not found`)
        return false
      }
      await sendBtn.click()
      await page.waitForTimeout(1500)

      console.log(`[PlaywrightX] DM sent to @${h}`)
      return true
    } catch (err) {
      console.log(`[PlaywrightX] sendDm failed: ${err}`)
      return false
    } finally {
      await page.close()
    }
  }

  // Expose an authenticated page for BrowserAgent — caller must close it
  async createPage(): Promise<{ page: import('playwright').Page; close: () => Promise<void> }> {
    const context = await this.getContext()
    const page = await context.newPage()
    return { page, close: () => page.close() }
  }

  async close(): Promise<void> {
    await this.context?.close()
    this.context = null
  }

  // --- Internal ---

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context

    // Each handle gets its own profile dir — no session conflicts between accounts
    const profileDir = this.customUserDataDir ?? path.resolve(CHROME_PROFILE_BASE, this.handle)
    fs.mkdirSync(profileDir, { recursive: true })

    // launchPersistentContext = real Chrome profile, remembers everything
    // Stealth args from website-understanding-sdk — masks headless detection
    this.context = await chromium.launchPersistentContext(profileDir, {
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

    // Mask navigator.webdriver so X doesn't detect headless browser
    // Runs in browser context as a string — masks headless detection
    await this.context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete window.__playwright;
      delete window.__pwInitScripts;
    `)

    // Inject auth cookies directly — no login form needed
    const authToken = process.env.X_AUTH_TOKEN
    const ct0 = process.env.X_CT0
    if (authToken && ct0) {
      await this.context.addCookies([
        { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
        { name: 'ct0',        value: ct0,       domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax'  },
      ])
      console.log('[PlaywrightX] Auth cookies injected — no login needed')
    } else {
      // Fallback: login via form if no cookies in env
      const page = await this.context.newPage()
      try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 })
        const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible({ timeout: 5000 }).catch(() => false)
        if (!isLoggedIn) {
          console.log('[PlaywrightX] Not logged in — performing form login')
          await this.doLogin(page)
        }
      } finally {
        await page.close()
      }
    }

    return this.context
  }

  private async typeAndSubmitReply(page: Page, text: string, tweetId: string): Promise<void> {
    // Click the reply button first to open/activate compose box
    const replyBtn = page.locator('[data-testid="reply"]').first()
    if (await replyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await replyBtn.click()
      await page.waitForTimeout(1500)
    }

    const composeSelectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0Root"]',
      'div[contenteditable="true"]',
      '[placeholder="Post your reply"]',
    ]

    let composeBox = null
    for (const sel of composeSelectors) {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 8000 }).catch(() => false)) {
        composeBox = el
        break
      }
    }

    if (!composeBox) throw new Error(`[PlaywrightX] Could not find reply compose box on tweet ${tweetId}`)

    await composeBox.click()
    await page.waitForTimeout(500)
    await page.keyboard.type(text, { delay: 35 + Math.random() * 30 })
    await page.waitForTimeout(600 + Math.random() * 400)

    // Submit — "Reply" button appears after typing
    const submitSelectors = [
      '[data-testid="tweetButton"]',
      '[data-testid="tweetButtonInline"]',
    ]

    let submitted = false
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
        try {
          await btn.click({ timeout: 8000 })
        } catch {
          // Overlay div intercepting pointer events — fall back to JS click which bypasses it
          await btn.evaluate((el: HTMLElement) => el.click())
          await page.waitForTimeout(500)
        }
        submitted = true
        break
      }
    }

    if (!submitted) throw new Error(`[PlaywrightX] Could not find submit button on tweet ${tweetId}`)

    await page.waitForTimeout(2000)
    console.log(`[PlaywrightX] Reply posted to tweet ${tweetId}`)
  }

  private async doLogin(page: Page): Promise<void> {
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 })

    // Step 1: username
    const usernameInput = page.locator('input[autocomplete="username"]').first()
    await usernameInput.waitFor({ state: 'visible', timeout: 15000 })
    await usernameInput.fill(this.handle)
    await page.getByRole('button', { name: /next/i }).click()
    await page.waitForTimeout(2000)

    // Step 2: X may ask for email/phone verification before password
    const isVerifyStep = await page.locator('input[data-testid="ocfEnterTextTextInput"]').isVisible({ timeout: 3000 }).catch(() => false)
    if (isVerifyStep) {
      console.log('[PlaywrightX] X asking for email/phone verification')
      await page.locator('input[data-testid="ocfEnterTextTextInput"]').fill(process.env.X_AUTH_EMAIL || '')
      await page.getByRole('button', { name: /next/i }).click()
      await page.waitForTimeout(2000)
    }

    // Step 3: password
    const passwordInput = page.locator('input[name="password"]').first()
    await passwordInput.waitFor({ state: 'visible', timeout: 20000 })
    await passwordInput.fill(this.password)
    await page.getByRole('button', { name: /log in/i }).click()

    await page.waitForURL('**/home', { timeout: 30000 })
    console.log('[PlaywrightX] Login successful — profile saved permanently')
  }
}
