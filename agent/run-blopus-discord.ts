/**
 * run-blopus-discord.ts — Phase 4
 * Blopus controlling owner's Discord presence in owner's voice.
 *
 * Usage: CREATOR=yourname npx tsx agent/run-blopus-discord.ts
 *
 * Required .env additions:
 *   DISCORD_BOT_TOKEN=your_bot_token
 *   DISCORD_GUILD_IDS=guild_id_1,guild_id_2   (comma-separated server IDs to monitor)
 *
 * How to get Discord credentials:
 *   1. Go to https://discord.com/developers/applications
 *   2. Create an application → Bot → copy Token
 *   3. Under Bot > Privileged Gateway Intents: enable Message Content Intent
 *   4. Invite bot to your servers via OAuth2 URL with scopes: bot + permissions: Send Messages, Read Message History
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

import { bootDiscord } from './BlopusAgentDiscord'

bootDiscord().catch(err => {
  console.error('[Blopus/Discord] [FATAL]', err)
  process.exit(1)
})
