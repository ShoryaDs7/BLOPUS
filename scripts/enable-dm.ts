/**
 * enable-dm.ts — sets dmEnabled: true in the creator's config.json
 * Run: npm run enable-dm
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'

const creator = process.env.CREATOR
if (!creator) {
  console.error('[enable-dm] CREATOR env var not set. Add CREATOR=yourfoldername to your .env')
  process.exit(1)
}

const configPath = path.resolve(`./creators/${creator}/config.json`)
if (!fs.existsSync(configPath)) {
  console.error(`[enable-dm] Config not found at ${configPath}`)
  process.exit(1)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
config.dmEnabled = true
fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
console.log(`[enable-dm] dmEnabled = true written to ${configPath}`)
