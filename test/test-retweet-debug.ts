import * as path from 'path'
import * as dotenv from 'dotenv'
dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

import { PlaywrightXClient } from '../adapters/x/PlaywrightXClient'

const client = new PlaywrightXClient(
  process.env.OWNER_HANDLE ?? 'shoryaDs7',
  process.env.X_PASSWORD!,
)

async function debug() {
  const ctx = await (client as any).getContext()
  const page = await ctx.newPage()
  await page.goto('https://x.com/i/web/status/2043772671742349754', { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(4000)
  await page.screenshot({ path: 'test/retweet-debug.png', fullPage: false })

  // dump all data-testid on page
  const testIds = await page.locator('[data-testid]').evaluateAll((els: Element[]) =>
    [...new Set(els.map((e: Element) => e.getAttribute('data-testid')))].filter(Boolean)
  )
  console.log('testids on page:', testIds.join(', '))
  await page.close()
  process.exit(0)
}
debug().catch(e => { console.error(e); process.exit(1) })
