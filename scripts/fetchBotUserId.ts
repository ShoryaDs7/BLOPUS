/**
 * fetchBotUserId.ts
 *
 * One-time helper script. Run this after setting up your .env to
 * get your bot account's numeric user ID.
 *
 * Usage:
 *   npx ts-node scripts/fetchBotUserId.ts <@botHandle>
 *
 * Then paste the printed ID into config/octant.config.json → octant.userId
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'

const creator = process.env.CREATOR
if (creator) dotenv.config({ path: path.resolve(`./creators/${creator}/.env`), override: true })

import { XClient } from '../adapters/x/XClient'

async function main(): Promise<void> {
  const handle = process.argv[2]?.replace('@', '')
  if (!handle) {
    console.error('Usage: npx ts-node scripts/fetchBotUserId.ts <@botHandle>')
    process.exit(1)
  }

  // Pass a placeholder userId — we only use fetchUserIdByHandle here
  const client = new XClient('placeholder')
  const userId = await client.fetchUserIdByHandle(handle)

  console.log(`\n@${handle} numeric user ID: ${userId}`)
  console.log('\nPaste this into config/octant.config.json → octant.userId\n')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
