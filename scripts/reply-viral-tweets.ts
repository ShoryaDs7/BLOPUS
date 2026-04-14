/**
 * reply-viral-tweets.ts
 * Find AI/tech tweets with 500k+ views posted in last 10hrs and reply to 5.
 * Strategy: f=top search with today's date + AI-specific queries, scrape view counts.
 */

import { chromium, BrowserContext } from 'playwright'
import * as path from 'path'
import * as dotenv from 'dotenv'
dotenv.config()

const USER_DATA_DIR = path.resolve('./memory-store/chrome-profile')

interface TweetInfo {
  tweetId: string
  text: string
  authorHandle: string
  displayName: string
  views: number
  likes: number
  timeStr: string
  hoursAgo: number
  url: string
}

async function getContext(): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--disable-dev-shm-usage', '--disable-extensions'],
  })
  await context.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`)
  const authToken = process.env.X_AUTH_TOKEN
  const ct0 = process.env.X_CT0
  if (authToken && ct0) {
    await context.addCookies([
      { name: 'auth_token', value: authToken, domain: '.x.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
      { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
    ])
  }
  return context
}

// Get view count by visiting individual tweet page — most reliable method
async function getTweetViews(context: BrowserContext, tweetId: string): Promise<number> {
  const page = await context.newPage()
  try {
    await page.goto(`https://x.com/i/web/status/${tweetId}`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(3000)

    const views = await page.evaluate(`
      (() => {
        // Views appear in the analytics bar at the bottom of a tweet detail page
        // They show as "X Views" text
        const allText = document.body.innerText
        const viewMatch = allText.match(/([\\d,.]+[KkMm]?)\\s*[Vv]iews?/)
        if (viewMatch) {
          const v = viewMatch[1].trim()
          const n = v.toUpperCase().includes('M') ? parseFloat(v)*1000000 :
                    v.toUpperCase().includes('K') ? parseFloat(v)*1000 :
                    parseInt(v.replace(/[,]/g,''))||0
          return n
        }
        // Also try the analytics link span
        const analytics = document.querySelector('a[href*="/analytics"]')
        if (analytics) {
          const spans = analytics.querySelectorAll('span')
          for (const s of spans) {
            const t = s.innerText.trim()
            const n = t.toUpperCase().includes('M') ? parseFloat(t)*1000000 :
                      t.toUpperCase().includes('K') ? parseFloat(t)*1000 :
                      parseInt(t.replace(/[,]/g,''))||0
            if (n > 1000) return n
          }
        }
        return 0
      })()
    `) as number
    return views
  } catch {
    return 0
  } finally {
    await page.close()
  }
}

async function searchViralTweets(context: BrowserContext): Promise<TweetInfo[]> {
  const page = await context.newPage()
  const results: TweetInfo[] = []
  const seen = new Set<string>()
  const now = Date.now()
  const tenHoursAgo = now - (10 * 60 * 60 * 1000)
  const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000)

  // Today's date for since: filter
  const today = new Date().toISOString().slice(0, 10) // "2026-03-24"

  // High-signal AI/tech queries with today filter, sorted by top engagement
  const queries = [
    `(OpenAI OR ChatGPT OR Claude OR Gemini) since:${today} -filter:replies lang:en`,
    `(AI OR "artificial intelligence" OR LLM OR "machine learning") since:${today} min_faves:2000 -filter:replies lang:en`,
    `(tech OR startup OR "Silicon Valley" OR Google OR Apple OR Microsoft) since:${today} min_faves:5000 -filter:replies lang:en`,
    `(AGI OR "AI agent" OR "language model" OR GPT) since:${today} -filter:replies lang:en`,
    `(Nvidia OR NVDA OR "deep learning" OR robotics OR AI) since:${today} min_faves:3000 -filter:replies`,
  ]

  for (const query of queries) {
    if (results.length >= 25) break
    const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=top`
    console.log(`\n[Search] ${query.slice(0, 80)}...`)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(3000)
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 }).catch(() => {})

      // Scroll to load more results
      for (let i = 0; i < 4; i++) {
        await page.evaluate('window.scrollBy(0, 800)')
        await page.waitForTimeout(1200)
      }

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
            if (!tweetId) return

            const textEl = article.querySelector('[data-testid="tweetText"]')
            const text = textEl ? (textEl.innerText || '') : ''
            if (!text || text.length < 10) return

            const handleEls = article.querySelectorAll('[data-testid="User-Name"] a[href^="/"]')
            const handle = handleEls.length > 0 ? handleEls[0].getAttribute('href').replace('/', '') : ''
            if (!handle) return

            // Display name
            const nameSpans = article.querySelectorAll('[data-testid="User-Name"] span')
            const displayName = nameSpans.length > 0 ? nameSpans[0].innerText.trim() : handle

            // View count from article (may show as number near chart icon)
            let views = 0
            // Try analytics link
            const analyticsLink = article.querySelector('a[href*="analytics"]')
            if (analyticsLink) {
              const allSpans = analyticsLink.querySelectorAll('span')
              for (const s of allSpans) {
                const t = (s.innerText || '').trim()
                const n = t.toUpperCase().includes('M') ? parseFloat(t)*1000000 :
                          t.toUpperCase().includes('K') ? parseFloat(t)*1000 :
                          parseInt(t.replace(/[,]/g,''))||0
                if (n > views) views = n
              }
            }

            // Likes
            let likes = 0
            const likeBtn = article.querySelector('[data-testid="like"] span')
            if (likeBtn) {
              const l = (likeBtn.innerText || '').trim()
              likes = l.toUpperCase().includes('M') ? parseFloat(l)*1000000 :
                      l.toUpperCase().includes('K') ? parseFloat(l)*1000 :
                      parseInt(l.replace(/[,]/g,''))||0
            }

            // Timestamp
            const timeEl = article.querySelector('time')
            const timeStr = timeEl ? timeEl.getAttribute('datetime') : ''

            items.push({ tweetId, text: text.trim().slice(0, 280), authorHandle: handle, displayName, views, likes, timeStr: timeStr||'' })
          })
          return items
        })()
      `) as TweetInfo[]

      for (const t of tweets) {
        if (seen.has(t.tweetId)) continue
        seen.add(t.tweetId)

        // Time filter — within 10 hours ideally, fall back to 24h if needed
        let hoursAgo = 999
        if (t.timeStr) {
          const tweetTime = new Date(t.timeStr).getTime()
          hoursAgo = (now - tweetTime) / (60 * 60 * 1000)
          if (tweetTime < twentyFourHoursAgo) {
            console.log(`  [SKIP >24h] @${t.authorHandle} — ${hoursAgo.toFixed(1)}h ago`)
            continue
          }
        }

        t.hoursAgo = hoursAgo
        t.url = `https://x.com/${t.authorHandle}/status/${t.tweetId}`
        console.log(`  [OK] @${t.authorHandle} | views: ${t.views} | likes: ${t.likes} | ${hoursAgo.toFixed(1)}h ago`)
        console.log(`    "${t.text.slice(0, 100)}"`)
        results.push(t)
      }
    } catch (err) {
      console.warn(`  [Search error] ${err}`)
    }
  }

  await page.close()
  return results
}

// Generate a smart, engaging reply based on tweet content
function generateReply(tweet: TweetInfo): string {
  const text = tweet.text.toLowerCase()

  if (text.includes('gpt') || text.includes('openai') || text.includes('chatgpt') || text.includes('sam altman')) {
    const r = [
      'the pace here is genuinely hard to process. every drop changes the meta',
      'openai keeps moving the goalposts. wild to watch in real time',
      'every few months the whole conversation resets. this is one of those moments',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('claude') || text.includes('anthropic')) {
    const r = [
      'anthropic been cooking quietly. the gap is closing fast',
      'the context + reasoning combo is a serious unlock',
      'alignment-first approach is starting to pay off. paying attention',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('gemini') || text.includes('google deepmind') || text.includes('google ai')) {
    const r = [
      'google finally playing offense. multimodal + scale = dangerous combo',
      'deepmind\'s pipeline is just built different. keeps delivering',
      'google has the compute, the data, and the talent. it was always a matter of when',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('agent') || text.includes('agentic') || text.includes('autonomous')) {
    const r = [
      'the shift from chat to action is the real unlock. agents change everything',
      'agentic AI is the paradigm shift people aren\'t fully pricing in yet',
      'autonomous agents doing real work — not a demo anymore. it\'s happening',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('nvidia') || text.includes('nvda') || text.includes('gpu') || text.includes('chip')) {
    const r = [
      'whoever controls the compute controls the future. nvidia understood this early',
      'the hardware layer is where it all starts. everything builds on top of this',
      'gpu scarcity is the defining constraint of this era. nvidia knows exactly what they have',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('llm') || text.includes('model') || text.includes('training') || text.includes('benchmark')) {
    const r = [
      'the scaling laws keep surprising everyone. limits keep moving',
      'each new model obsoletes the last one\'s ceiling. compounding fast',
      'what counts as SOTA changes every few months now. impossible to keep up',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('job') || text.includes('replac') || text.includes('automation') || text.includes('work')) {
    const r = [
      'the honest answer: nobody knows the timeline. but adapt now, not later',
      'every tech wave disrupts labor. this one is different in scope and speed',
      'the transition period is what\'s tricky. those who move early have the edge',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('startup') || text.includes('funding') || text.includes('raise') || text.includes('billion') || text.includes('vc')) {
    const r = [
      'capital is following conviction. the numbers tell a clear story',
      'smart money is not waiting. the window is real',
      'the AI investment wave is historic. we\'re inside something massive',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('agi') || text.includes('superintelligence') || text.includes('singularity')) {
    const r = [
      'the goalposts for AGI keep moving but the direction doesn\'t. worth paying attention',
      'we\'re in the most consequential period in the history of computing. no exaggeration',
      'the debate about when matters less than the debate about what we do with it',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('apple') || text.includes('iphone') || text.includes('ios') || text.includes('mac')) {
    const r = [
      'apple playing the long game as usual. they let others experiment then ship refined',
      'the distribution advantage is still unreal. 2B devices is not a small number',
      'on-device AI is the play nobody talks about enough. privacy + performance = moat',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }
  if (text.includes('microsoft') || text.includes('azure') || text.includes('copilot')) {
    const r = [
      'microsoft locked in the enterprise angle early. paying off now',
      'the azure + openai play was a masterclass in strategic timing',
      'copilot everywhere is a different kind of AI distribution than anyone else has',
    ]
    return r[Math.floor(Math.random() * r.length)]
  }

  // Generic high-quality AI/tech reply
  const generic = [
    'this is the kind of thing that\'ll look obvious in hindsight. paying attention now',
    'the pace of change in this space is genuinely unlike anything before it',
    'the signal here is loud. not enough people are listening carefully',
    'we\'re watching history happen in real time and most people don\'t realize it yet',
    'the 6-month diff in this space is larger than most industries see in a decade',
  ]
  return generic[Math.floor(Math.random() * generic.length)]
}

async function postReply(context: BrowserContext, tweetId: string, text: string): Promise<void> {
  const page = await context.newPage()
  try {
    await page.goto(`https://x.com/i/web/status/${tweetId}`, { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(6000)
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

    const composeSelectors = [
      '[data-testid="tweetTextarea_0"]',
      '[data-testid="tweetTextarea_0Root"]',
      'div[contenteditable="true"]',
    ]
    let composeBox = null
    for (const sel of composeSelectors) {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 8000 }).catch(() => false)) { composeBox = el; break }
    }
    if (!composeBox) throw new Error('Could not find reply compose box')

    await composeBox.click()
    await page.waitForTimeout(500)
    await page.keyboard.type(text, { delay: 40 + Math.random() * 30 })
    await page.waitForTimeout(800)

    const submitSelectors = ['[data-testid="tweetButton"]', '[data-testid="tweetButtonInline"]']
    let submitted = false
    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first()
      if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) { await btn.click(); submitted = true; break }
    }
    if (!submitted) throw new Error('Could not find submit button')

    await page.waitForTimeout(3000)
    console.log(`  [Reply] ✅ Posted to ${tweetId}`)
  } finally {
    await page.close()
  }
}

async function main() {
  console.log('🔍 Searching for viral AI/tech tweets (500k+ views, last 10hrs)...\n')
  const context = await getContext()

  try {
    const candidates = await searchViralTweets(context)
    console.log(`\n📊 Candidates within 24hrs: ${candidates.length}`)

    // Sort by: within 10hrs first, then by views desc, then likes desc
    candidates.sort((a, b) => {
      const aIn10 = a.hoursAgo <= 10 ? 1 : 0
      const bIn10 = b.hoursAgo <= 10 ? 1 : 0
      if (bIn10 !== aIn10) return bIn10 - aIn10
      const aScore = (a.views || 0) + (a.likes || 0) * 50
      const bScore = (b.views || 0) + (b.likes || 0) * 50
      return bScore - aScore
    })

    // For tweets with low/zero view count in search results, fetch the actual view count
    // from the tweet page for top candidates
    const topCheck = candidates.slice(0, 15)
    console.log(`\n🔎 Checking view counts for top ${topCheck.length} candidates...`)

    for (const t of topCheck) {
      if (t.views < 500_000) {
        console.log(`  Fetching views for @${t.authorHandle} (tweetId: ${t.tweetId})...`)
        const v = await getTweetViews(context, t.tweetId)
        if (v > 0) t.views = v
        console.log(`    → views: ${v >= 1_000_000 ? (v/1_000_000).toFixed(1)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'K' : v}`)
      }
    }

    // Filter 500k+ views — if not enough, use top by likes (5k+ likes ≈ 500k+ views)
    let qualified = topCheck.filter(t => t.views >= 500_000)
    console.log(`\n✅ Tweets with 500k+ views: ${qualified.length}`)

    if (qualified.length < 5) {
      // Use high-likes fallback for remainder
      const likesFallback = topCheck.filter(t => t.likes >= 5_000 && !qualified.find(q => q.tweetId === t.tweetId))
      qualified = [...qualified, ...likesFallback]
      if (qualified.length < 5) {
        // Last resort: just take top candidates by any engagement
        const rest = candidates.filter(t => !qualified.find(q => q.tweetId === t.tweetId))
        qualified = [...qualified, ...rest]
      }
      console.log(`  Extended to ${qualified.length} with high-likes fallback`)
    }

    const top5 = qualified.slice(0, 5)

    if (top5.length === 0) {
      console.log('❌ No qualifying tweets found.')
      return
    }

    // Print the plan
    console.log('\n' + '═'.repeat(65))
    console.log('📋  VIRAL AI/TECH TWEETS — REPLY PLAN')
    console.log('═'.repeat(65))

    const replyPlan: { tweet: TweetInfo; reply: string }[] = []
    for (let i = 0; i < top5.length; i++) {
      const t = top5[i]
      const reply = generateReply(t)
      replyPlan.push({ tweet: t, reply })

      const viewsFmt = t.views >= 1_000_000 ? (t.views/1_000_000).toFixed(1)+'M' :
                       t.views >= 1000 ? Math.round(t.views/1000)+'K' : t.views || '?'
      const likesFmt = t.likes >= 1_000_000 ? (t.likes/1_000_000).toFixed(1)+'M' :
                       t.likes >= 1000 ? (t.likes/1000).toFixed(1)+'K' : t.likes

      console.log(`\n[${i+1}] @${t.authorHandle}  (${t.displayName})`)
      console.log(`     📊 Views: ${viewsFmt}  ❤️  Likes: ${likesFmt}  🕐 ${t.hoursAgo.toFixed(1)}h ago`)
      console.log(`     🔗 ${t.url}`)
      console.log(`     💬 "${t.text.slice(0, 130)}"`)
      console.log(`     ↳  Reply: "${reply}"`)
    }

    console.log('\n' + '═'.repeat(65))
    console.log('🚀  POSTING REPLIES...')
    console.log('═'.repeat(65))

    for (let i = 0; i < replyPlan.length; i++) {
      const { tweet, reply } = replyPlan[i]
      console.log(`\n[${i+1}/${replyPlan.length}] Replying to @${tweet.authorHandle}...`)
      try {
        await postReply(context, tweet.tweetId, reply)
        console.log(`  ✅  https://x.com/${tweet.authorHandle}/status/${tweet.tweetId}`)
      } catch (err) {
        console.error(`  ❌  Failed: ${err}`)
      }
      if (i < replyPlan.length - 1) {
        console.log('  ⏳  Waiting 10s...')
        await new Promise(r => setTimeout(r, 10000))
      }
    }

    console.log('\n' + '═'.repeat(65))
    console.log('✅  ALL DONE — Replied to', replyPlan.length, 'viral AI/tech tweets')
    console.log('═'.repeat(65))

  } finally {
    await context.close()
  }
}

main().catch(console.error)
