/**
 * run-blopus-threads.ts
 * Runs Blopus AS the owner's Threads account — posts in their voice.
 *
 * Usage: CREATOR=yourname npx tsx agent/run-blopus-threads.ts
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

process.env.BLOPUS_CONFIG_PATH  = `./creators/${creator}/config.json`
process.env.BLOPUS_MEMORY_PATH  = `./creators/${creator}/memory.json`
process.env.OSBOT_PLATFORM     = 'threads'

import './BlopusAgent'
