/**
 * Personality Ingestion Script
 *
 * Reads your Twitter/X archive and generates a personality_profile.json
 * that OsBot uses to match your exact voice, tone, and opinions.
 *
 * Usage:
 *   npm run ingest -- --tweets path/to/tweets.js --creator openocta
 *
 * How to get your tweets.js:
 *   1. Go to X → Settings → Your Account → Download an archive of your data
 *   2. Wait for the email (can take hours/days)
 *   3. Extract the ZIP → find data/tweets.js
 *   4. Pass that file path to this script
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { parseTweetsJsFull, analyzePersonalityFull } from '../core/personality/PersonalityIngester'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const tweetsFlag = args.indexOf('--tweets')
  const creatorFlag = args.indexOf('--creator')

  if (tweetsFlag === -1 || creatorFlag === -1) {
    console.error('Usage: npm run ingest -- --tweets path/to/tweets.js --creator your_creator_name')
    process.exit(1)
  }

  const tweetsPath = args[tweetsFlag + 1]
  const creatorName = args[creatorFlag + 1]

  if (!fs.existsSync(tweetsPath)) {
    console.error(`File not found: ${tweetsPath}`)
    process.exit(1)
  }

  const creatorDir = path.resolve(`./creators/${creatorName}`)
  if (!fs.existsSync(creatorDir)) {
    console.error(`Creator folder not found: ${creatorDir}`)
    console.error(`Create creators/${creatorName}/config.json first.`)
    process.exit(1)
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set in .env')
    process.exit(1)
  }

  console.log(`Parsing tweets from: ${tweetsPath}`)
  const tweets = parseTweetsJsFull(fs.readFileSync(tweetsPath, 'utf-8'))
  console.log(`Found ${tweets.originals.length} original tweets + ${tweets.replies.length} replies. Analyzing with Claude...`)

  const profile = await analyzePersonalityFull(tweets, creatorName)

  const outputPath = path.join(creatorDir, 'personality_profile.json')
  fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2), 'utf-8')

  console.log(`\nDone! Saved to: ${outputPath}`)
  console.log(JSON.stringify(profile, null, 2))
}

main().catch(err => {
  console.error('[ingestPersonality] Fatal error:', err)
  process.exit(1)
})
