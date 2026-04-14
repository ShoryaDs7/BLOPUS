import 'dotenv/config'
import { chromium, BrowserContext } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

const CHROME_PROFILE_BASE = path.resolve('./memory-store/chrome-profiles')

async function main() {
  const handle = 'shoryaDs7'
  const profileDir = path.resolve(CHROME_PROFILE_BASE, handle)
  fs.mkdirSync(profileDir, { recursive: true })

  const context: BrowserContext = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-extensions',
    ],
  })

  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete window.__playwright;
    delete window.__pwInitScripts;
  `)

  // Inject auth cookies
  const authToken = process.env.X_AUTH_TOKEN!
  const ct0 = process.env.X_CT0!
  await context.addCookies([
    { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
    { name: 'ct0',        value: ct0,       domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
  ])
  console.log('[Script] Auth cookies injected')

  const page = await context.newPage()

  // Strategy: search for trending topics on X explore page, scrape viral tweets
  // We'll try multiple high-traffic queries to find a 100k+ likes tweet posted <10hrs ago
  const queries = [
    'min_faves:100000',
    'min_faves:50000',
  ]

  interface TweetResult {
    tweetId: string
    text: string
    authorHandle: string
    likes: number
    timeAgo: string
    hoursAgo: number
  }

  let found: TweetResult | null = null

  for (const q of queries) {
    if (found) break
    console.log(`[Script] Searching: "${q}"`)
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&f=live&src=typed_query`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})
    await page.evaluate('window.scrollBy(0, 600)')
    await page.waitForTimeout(2000)

    const tweets = await page.evaluate(`
      (() => {
        const now = Date.now()
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
          const authorHandle = handleEl ? handleEl.getAttribute('href').replace('/', '') : ''

          // Like count
          const likeBtn = article.querySelector('[data-testid="like"] span')
          const likeText = likeBtn ? likeBtn.innerText.trim() : '0'
          const likeNum = likeText.includes('K') ? parseFloat(likeText) * 1000 :
                          likeText.includes('M') ? parseFloat(likeText) * 1000000 :
                          parseInt(likeText) || 0

          // Time — X shows relative time like "10h", "2h", "45m" or absolute datetime
          const timeEl = article.querySelector('time')
          let hoursAgo = 999
          let timeAgo = ''
          if (timeEl) {
            const dt = timeEl.getAttribute('datetime')
            timeAgo = timeEl.innerText || dt || ''
            if (dt) {
              const posted = new Date(dt).getTime()
              hoursAgo = (now - posted) / (1000 * 60 * 60)
            }
          }

          if (tweetId && text && text.length > 10 && authorHandle) {
            items.push({ tweetId, text: text.trim(), authorHandle, likes: likeNum, timeAgo, hoursAgo })
          }
        })
        return items
      })()
    `) as TweetResult[]

    console.log(`[Script] Found ${tweets.length} tweets for query "${q}"`)
    tweets.forEach(t => console.log(`  @${t.authorHandle} | likes: ${t.likes} | ${t.hoursAgo.toFixed(1)}h ago | ${t.text.slice(0, 60)}`))

    // Filter: 100k+ likes AND posted within 10 hours
    const viral = tweets.filter(t => t.likes >= 100000 && t.hoursAgo <= 10)
    if (viral.length > 0) {
      viral.sort((a, b) => b.likes - a.likes)
      found = viral[0]
      console.log(`[Script] ✅ Found viral tweet: ${found.tweetId} by @${found.authorHandle} | ${found.likes} likes | ${found.hoursAgo.toFixed(1)}h ago`)
    } else {
      // Also try tweets with 50k+ likes < 10h (if no strict 100k found)
      const semiViral = tweets.filter(t => t.likes >= 50000 && t.hoursAgo <= 10)
      if (semiViral.length > 0) {
        semiViral.sort((a, b) => b.likes - a.likes)
        console.log(`[Script] ℹ️ No 100k+ found, best candidate: ${semiViral[0].likes} likes | ${semiViral[0].hoursAgo.toFixed(1)}h ago`)
      }
    }
  }

  // If still not found, try explore trending and scrape with timestamps
  if (!found) {
    console.log('[Script] Trying X explore trending page...')
    await page.goto('https://x.com/explore', { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000)

    // Click "Trending" tab
    const tabs = await page.locator('[role="tab"]').all()
    for (const tab of tabs) {
      const t = (await tab.textContent() ?? '').toLowerCase()
      if (t.includes('trending') || t.includes('for you')) {
        await tab.click()
        console.log(`[Script] Clicked tab: ${t}`)
        break
      }
    }
    await page.waitForTimeout(2000)

    // Click first trending topic
    const trendCards = await page.locator('[data-testid="trend"]').all()
    if (trendCards.length > 0) {
      const cardText = (await trendCards[0].textContent() ?? '').trim().slice(0, 60)
      console.log(`[Script] Clicking trend card: "${cardText}"`)
      await trendCards[0].click()
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(2000)
    }

    const tweets = await page.evaluate(`
      (() => {
        const now = Date.now()
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
          const authorHandle = handleEl ? handleEl.getAttribute('href').replace('/', '') : ''
          const likeBtn = article.querySelector('[data-testid="like"] span')
          const likeText = likeBtn ? likeBtn.innerText.trim() : '0'
          const likeNum = likeText.includes('K') ? parseFloat(likeText) * 1000 :
                          likeText.includes('M') ? parseFloat(likeText) * 1000000 :
                          parseInt(likeText) || 0
          const timeEl = article.querySelector('time')
          let hoursAgo = 999
          let timeAgo = ''
          if (timeEl) {
            const dt = timeEl.getAttribute('datetime')
            timeAgo = timeEl.innerText || dt || ''
            if (dt) {
              const posted = new Date(dt).getTime()
              hoursAgo = (now - posted) / (1000 * 60 * 60)
            }
          }
          if (tweetId && text && text.length > 10 && authorHandle) {
            items.push({ tweetId, text: text.trim(), authorHandle, likes: likeNum, timeAgo, hoursAgo })
          }
        })
        return items
      })()
    `) as { tweetId: string; text: string; authorHandle: string; likes: number; timeAgo: string; hoursAgo: number }[]

    console.log(`[Script] Trending page: found ${tweets.length} tweets`)
    tweets.forEach(t => console.log(`  @${t.authorHandle} | likes: ${t.likes} | ${t.hoursAgo.toFixed(1)}h ago | ${t.text.slice(0, 60)}`))

    const viral = tweets.filter(t => t.likes >= 100000 && t.hoursAgo <= 10)
    if (viral.length > 0) {
      viral.sort((a, b) => b.likes - a.likes)
      found = viral[0]
    } else {
      // Pick the most liked tweet posted within 10 hours regardless of threshold
      const recent = tweets.filter(t => t.hoursAgo <= 10).sort((a, b) => b.likes - a.likes)
      if (recent.length > 0) {
        found = recent[0]
        console.log(`[Script] Best recent tweet: ${found.likes} likes | ${found.hoursAgo.toFixed(1)}h ago`)
      }
    }
  }

  if (!found) {
    await page.screenshot({ path: './memory-store/viral-search-debug.png' })
    console.error('[Script] ❌ Could not find a suitable viral tweet. Screenshot saved.')
    await context.close()
    return
  }

  console.log(`\n[Script] Will quote tweet:`)
  console.log(`  Tweet ID: ${found.tweetId}`)
  console.log(`  Author:   @${found.authorHandle}`)
  console.log(`  Likes:    ${found.likes.toLocaleString()}`)
  console.log(`  Age:      ${found.hoursAgo.toFixed(1)}h ago`)
  console.log(`  Text:     ${found.text.slice(0, 100)}`)

  // Craft a smart quote tweet based on the tweet content
  const quoteText = generateQuoteComment(found.text, found.authorHandle)
  console.log(`\n[Script] Quote comment: "${quoteText}"`)

  // Now quote tweet using PlaywrightXClient logic
  await page.goto(`https://x.com/i/web/status/${found.tweetId}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000 + Math.random() * 1000)

  const retweetBtn = page.locator('[data-testid="retweet"]').first()
  await retweetBtn.waitFor({ state: 'visible', timeout: 10000 })
  await retweetBtn.click()
  await page.waitForTimeout(800 + Math.random() * 400)

  const quoteOption = page.getByRole('menuitem', { name: /quote/i }).first()
  await quoteOption.waitFor({ state: 'visible', timeout: 5000 })
  await quoteOption.click()
  await page.waitForTimeout(1500 + Math.random() * 500)

  const composeBox = page.locator('[data-testid="tweetTextarea_0"]').first()
  await composeBox.waitFor({ state: 'visible', timeout: 10000 })
  await composeBox.click()
  await page.keyboard.type(quoteText, { delay: 35 + Math.random() * 30 })
  await page.waitForTimeout(600 + Math.random() * 400)

  const submitBtn = page.locator('[data-testid="tweetButton"]').first()
  await submitBtn.waitFor({ state: 'visible', timeout: 5000 })
  await submitBtn.click()
  await page.waitForTimeout(3000)

  console.log(`\n[Script] ✅ Quote tweet posted successfully!`)
  console.log(`[Script] Original tweet: https://x.com/${found.authorHandle}/status/${found.tweetId}`)

  await page.screenshot({ path: './memory-store/quote-tweet-result.png' })
  await context.close()
}

function generateQuoteComment(tweetText: string, author: string): string {
  const lower = tweetText.toLowerCase()

  if (lower.includes('ai') || lower.includes('gpt') || lower.includes('llm') || lower.includes('openai') || lower.includes('claude') || lower.includes('model')) {
    const comments = [
      'This is where AI is actually heading. The shift is real 🔥',
      'Everyone talking about AI but this is the part nobody\'s addressing 👀',
      'The AI race is heating up and this says everything about where we\'re going',
      'This is the most important AI take I\'ve seen today. Thread-worthy.',
    ]
    return comments[Math.floor(Math.random() * comments.length)]
  }

  if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('btc') || lower.includes('eth')) {
    const comments = [
      'Cycle is playing out exactly as expected. Are you positioned? 👀',
      'This is the signal most people will ignore until it\'s too late 📈',
      'Markets don\'t lie. This is why you stay in the game.',
    ]
    return comments[Math.floor(Math.random() * comments.length)]
  }

  if (lower.includes('startup') || lower.includes('founder') || lower.includes('build') || lower.includes('saas')) {
    const comments = [
      'Every founder needs to internalize this. No exceptions.',
      'The builders who get this early are the ones who win. Period.',
      'This is the startup advice nobody gives you in Y Combinator 🚀',
    ]
    return comments[Math.floor(Math.random() * comments.length)]
  }

  if (lower.includes('elon') || lower.includes('musk') || lower.includes('tesla') || lower.includes('spacex')) {
    const comments = [
      'Love him or hate him — this move is undeniably smart 🎯',
      'The man plays a completely different game. Pay attention.',
      'This aged perfectly. Called it.',
    ]
    return comments[Math.floor(Math.random() * comments.length)]
  }

  if (lower.includes('money') || lower.includes('rich') || lower.includes('wealth') || lower.includes('millionaire')) {
    const comments = [
      'Most people scroll past this. The ones who act on it change their life.',
      'Financial literacy in one post. Save this.',
      'The wealth gap isn\'t about luck. It\'s about this.',
    ]
    return comments[Math.floor(Math.random() * comments.length)]
  }

  // Generic viral/compelling fallback
  const generic = [
    'This is going to age incredibly well. Mark this post.',
    'The tweet that needed to be said. Everyone should see this.',
    'Rare moment of clarity on this platform 🔥',
    'This is the content X was built for. No notes.',
    'Nobody is talking about this enough. Sharing for the people who need to see it.',
  ]
  return generic[Math.floor(Math.random() * generic.length)]
}

main().catch(err => {
  console.error('[Script] Fatal error:', err)
  process.exit(1)
})
