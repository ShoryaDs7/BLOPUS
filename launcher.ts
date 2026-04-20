/**
 * Blopus Multi-Tenant Launcher
 *
 * Scans the creators/ folder and spawns one BlopusAgent process per creator.
 * Each agent runs in isolation with its own config, memory, and API keys.
 *
 * Usage:
 *   npm run launch                    — start all creators
 *   CREATOR=yourhandle npm run launch  — start one specific creator
 *
 * Each creator folder must contain:
 *   config.json  — bot identity, personality, platform settings
 *   .env         — Twitter API keys for that specific account
 *
 * Per-creator .env overrides the root .env Twitter credentials,
 * so each creator authenticates as their own account.
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { spawn, ChildProcess } from 'child_process'
import dotenv from 'dotenv'

const CREATORS_DIR = path.resolve('./creators')
const RESTART_DELAY_MS = 15_000

function getCreators(): string[] {
  const target = process.env.CREATOR
  if (target) {
    const configPath = path.join(CREATORS_DIR, target, 'config.json')
    if (!fs.existsSync(configPath)) {
      console.error(`[Launcher] No config.json found for creator "${target}"`)
      process.exit(1)
    }
    return [target]
  }

  if (!fs.existsSync(CREATORS_DIR)) {
    console.error('[Launcher] No creators/ folder found.')
    console.error('Create creators/{name}/config.json to get started.')
    console.error('Copy creators/template/config.json as a starting point.')
    process.exit(1)
  }

  return fs.readdirSync(CREATORS_DIR).filter(name => {
    if (name === 'template') return false
    const configPath = path.join(CREATORS_DIR, name, 'config.json')
    return fs.existsSync(configPath) && fs.statSync(path.join(CREATORS_DIR, name)).isDirectory()
  })
}

function loadCreatorEnv(creatorName: string): Record<string, string> {
  const envPath = path.join(CREATORS_DIR, creatorName, '.env')
  if (!fs.existsSync(envPath)) return {}
  const parsed = dotenv.parse(fs.readFileSync(envPath))
  return parsed
}

function spawnAgent(creatorName: string): void {
  const configPath = path.join(CREATORS_DIR, creatorName, 'config.json')
  const creatorEnv = loadCreatorEnv(creatorName)

  console.log(`[Launcher] Starting OsBot for: ${creatorName}`)

  const child: ChildProcess = spawn(
    'npx',
    ['ts-node', 'agent/BlopusAgent.ts'],
    {
      env: {
        ...process.env,
        ...creatorEnv,          // creator's own API keys override root .env
        BLOPUS_CONFIG_PATH: configPath,
        CREATOR_NAME: creatorName,
      },
      stdio: 'inherit',
      shell: true,
    }
  )

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.log(`[Launcher] Agent ${creatorName} stopped (${signal}).`)
      return
    }
    console.log(`[Launcher] Agent ${creatorName} exited (code ${code}). Restarting in ${RESTART_DELAY_MS / 1000}s...`)
    setTimeout(() => spawnAgent(creatorName), RESTART_DELAY_MS)
  })

  child.on('error', (err) => {
    console.error(`[Launcher] Failed to spawn agent for ${creatorName}:`, err)
    setTimeout(() => spawnAgent(creatorName), RESTART_DELAY_MS)
  })
}

// --- Main ---

const creators = getCreators()

if (creators.length === 0) {
  console.error('[Launcher] No creator configs found in creators/. Nothing to launch.')
  process.exit(1)
}

console.log(`[Launcher] Launching ${creators.length} OsBot(s): ${creators.join(', ')}`)
creators.forEach(spawnAgent)

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Launcher] Shutting down all agents...')
  process.exit(0)
})
