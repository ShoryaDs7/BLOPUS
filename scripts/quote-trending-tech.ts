import * as dotenv from 'dotenv'
dotenv.config()

import { PlaywrightXClient } from '../adapters/x/PlaywrightXClient'

async function main() {
  const client = new PlaywrightXClient(
    process.env.X_HANDLE || 'openocta',
    process.env.X_PASSWORD || ''
  )

  // Try multiple tech queries for best results
  const queries = ['AI agents 2026', 'tech startup founder', 'software engineering']
  let allTweets: { tweetId: string; text: string; authorHandle: string }[] = []

  for (const q of queries) {
    console.log(`[QuoteTrending] Searching: "${q}"`)
    const results = await client.searchTweets(q, 5)
    allTweets = [...allTweets, ...results]
    if (allTweets.length >= 5) break
  }

  if (allTweets.length === 0) {
    console.log('[QuoteTrending] No tweets found.')
    await client.close()
    return
  }

  // Deduplicate
  const seen = new Set<string>()
  const unique = allTweets.filter(t => {
    if (seen.has(t.tweetId)) return false
    seen.add(t.tweetId)
    return true
  })

  console.log('\n=== FOUND TECH TWEETS ===')
  unique.forEach((t, i) => {
    console.log(`\n[${i}] @${t.authorHandle}`)
    console.log(`    ID: ${t.tweetId}`)
    console.log(`    "${t.text.slice(0, 150)}"`)
  })

  const best = unique[0]
  console.log(`\n[QuoteTrending] SELECTED: @${best.authorHandle}`)
  console.log(`    Tweet: "${best.text.slice(0, 150)}"`)
  console.log(`    ID: ${best.tweetId}`)

  const fs = await import('fs')
  fs.writeFileSync('./memory-store/trending-pick.json', JSON.stringify(best, null, 2))
  console.log('[QuoteTrending] Saved pick.')

  await client.close()
}

main().catch(console.error)
