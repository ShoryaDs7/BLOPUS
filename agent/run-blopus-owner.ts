/**
 * run-blopus-owner.ts
 * Runs Blopus AS the owner's X account — posts in their voice, trained on their archive.
 *
 * Usage: CREATOR=yourname npx tsx agent/run-blopus-owner.ts
 *        or set CREATOR in your .env file
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

// Crash alert — send Telegram message if OsBot dies unexpectedly
async function sendCrashAlert(err: unknown): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!token || !chatId) return
  const msg = `OsBot crashed!\n${String(err).slice(0, 300)}`
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg }),
  }).catch(() => {})
}

process.on('uncaughtException', async (err) => {
  console.error('[Blopus] Uncaught exception:', err)
  await sendCrashAlert(err)
  process.exit(1)
})

process.on('unhandledRejection', async (reason) => {
  console.error('[Blopus] Unhandled rejection:', reason)
  await sendCrashAlert(reason)
  process.exit(1)
})

// Dynamic import so env vars above are set BEFORE BlopusAgent reads them.
import('./BlopusAgent')
