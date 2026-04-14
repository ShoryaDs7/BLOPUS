import * as path from 'path'
import * as fs from 'fs'
import { chromium, BrowserContext } from 'playwright'

const X_AUTH_TOKEN = '84b1ee2f2f854086cf492800b6da1652050ad20f'
const X_CT0 = '2024fd08179f6143496b763d92e117f9114f5248900fb27849181fb81d4578821438b6dda057b3240809b215fcfeda39daa1c5a97aa3358dd73e0ddbe0d2e04235c0d011d0933b0568760a5565e84c43'
const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile-shoryaDs7')

interface Tweet {
  tweetId: string
  text: string
  authorHandle: string
  likes: number
}

const SCRAPE_JS = `
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
    const likeNum = likeText.includes('K') ? parseFloat(likeText) * 1000
      : likeText.includes('M') ? parseFloat(likeText) * 1000000
      : parseInt(likeText) || 0
    if (tweetId && text && text.length > 10 && handle) {
      items.push({ tweetId, text: text.trim(), authorHandle: handle, likes: likeNum })
    }
  })
  return items
})()
`

async function scrapePage(page: import('playwright').Page): Promise<Tweet[]> {
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})
  await page.evaluate('window.scrollBy(0, 400)')
  await page.waitForTimeout(1500)
  return page.evaluate(SCRAPE_JS) as Promise<Tweet[]>
}

;(async () => {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })

  const context: BrowserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
    ],
  })

  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete window.__playwright;
  `)

  await context.addCookies([
    { name: 'auth_token', value: X_AUTH_TOKEN, domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
    { name: 'ct0',        value: X_CT0,        domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
  ])
  console.log('[fetch-tech] Cookies injected for @shoryaDs7')

  const queries = ['AI 2026', 'tech startup', 'software engineering', 'OpenAI GPT', 'LLM model']
  const all: Tweet[] = []
  const seen = new Set<string>()

  for (const q of queries) {
    if (all.length >= 15) break
    const page = await context.newPage()
    try {
      const url = `https://x.com/search?q=${encodeURIComponent(q)}&f=top`
      console.log(`[fetch-tech] Searching: "${q}"`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
      await page.waitForTimeout(2000)
      const tweets = await scrapePage(page)
      console.log(`[fetch-tech] Got ${tweets.length} tweets for "${q}"`)
      for (const t of tweets) {
        if (!seen.has(t.tweetId)) {
          seen.add(t.tweetId)
          all.push(t)
        }
      }
    } catch (err) {
      console.warn(`[fetch-tech] Query "${q}" failed:`, err)
    } finally {
      await page.close()
    }
  }

  await context.close()

  all.sort((a, b) => b.likes - a.likes)
  const top5 = all.slice(0, 5)

  if (top5.length === 0) {
    console.error('[fetch-tech] No tweets found — session may be invalid')
    process.exit(1)
  }

  const top = top5[0]
  console.log('\n========================================')
  console.log('  TOP TRENDING TECHNOLOGY TWEET ON X')
  console.log('========================================')
  console.log(JSON.stringify({
    tweetId: top.tweetId,
    tweetUrl: `https://x.com/i/web/status/${top.tweetId}`,
    authorHandle: `@${top.authorHandle}`,
    likes: top.likes,
    text: top.text,
  }, null, 2))

  console.log('\n--- Top 5 ---')
  top5.forEach((t, i) => {
    console.log(`\n#${i + 1} | @${t.authorHandle} | likes: ${t.likes} | id: ${t.tweetId}`)
    console.log(t.text.slice(0, 300))
  })
})()
