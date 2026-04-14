/**
 * run-blopus-reddit.ts — Phase 3
 * Blopus controlling owner's Reddit account in owner's voice.
 *
 * Usage: CREATOR=yourname npx tsx agent/run-blopus-reddit.ts
 *
 * Required .env additions:
 *   REDDIT_CLIENT_ID=your_app_client_id
 *   REDDIT_CLIENT_SECRET=your_app_client_secret
 *   REDDIT_USERNAME=your_reddit_username
 *   REDDIT_PASSWORD=your_reddit_password
 *
 * How to get Reddit credentials:
 *   1. Go to https://www.reddit.com/prefs/apps
 *   2. Create a "script" type app
 *   3. Copy client_id and secret
 */
import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'

const creator = process.env.CREATOR
if (!creator) {
  console.error('[Blopus] CREATOR env var not set. Add CREATOR=yourfoldername to your .env')
  process.exit(1)
}

dotenv.config({ path: path.resolve(`./creators/${creator}/.env`), override: true })

process.env.BLOPUS_CONFIG_PATH = `./creators/${creator}/config.json`
process.env.BLOPUS_MEMORY_PATH = `./creators/${creator}/memory.json`

import { bootReddit } from './BlopusAgentReddit'

bootReddit().catch(err => {
  console.error('[Blopus/Reddit] [FATAL]', err)
  process.exit(1)
})
