import fs from 'fs'
import path from 'path'

export interface RuntimeConfig {
  maxRepliesPerDay?: number        // daily cap for viral reply hunter (default 10)
  cooldownMinutes?: number         // min minutes between viral replies (default 3)
  minLikes?: number                // min likes to consider a tweet viral (default 500)
  maxAgeTweetMinutes?: number      // max age of tweet to reply to (default 120)
  consecutiveTopicLimit?: number   // same topic streak before forcing change (default 2)
  maxAutonomousPostsPerDay?: number // autonomous post daily cap (default 50)
  minPostIntervalHours?: number    // min hours between autonomous posts (default 3)
  updatedAt?: string
}

const DEFAULTS: Required<Omit<RuntimeConfig, 'updatedAt'>> = {
  maxRepliesPerDay: 10,
  cooldownMinutes: 3,
  minLikes: 500,
  maxAgeTweetMinutes: 120,
  consecutiveTopicLimit: 2,
  maxAutonomousPostsPerDay: 50,
  minPostIntervalHours: 3,
}

function getRuntimeConfigPath(): string {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  return path.join(path.dirname(path.resolve(configPath)), 'runtime_config.json')
}

export function readRuntimeConfig(): Required<Omit<RuntimeConfig, 'updatedAt'>> {
  try {
    const file = getRuntimeConfigPath()
    if (!fs.existsSync(file)) return { ...DEFAULTS }
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as RuntimeConfig
    return { ...DEFAULTS, ...data }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Returns only keys explicitly written to the runtime config file by the user via Telegram.
 * Used to distinguish "user override" from "just a default" — so archive-derived values
 * are only replaced when the user actually made a conscious choice.
 */
export function readRuntimeConfigOverrides(): Partial<RuntimeConfig> {
  try {
    const file = getRuntimeConfigPath()
    if (!fs.existsSync(file)) return {}
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as RuntimeConfig
  } catch {
    return {}
  }
}

export function writeRuntimeConfig(updates: Partial<RuntimeConfig>): RuntimeConfig {
  const file = getRuntimeConfigPath()
  // Only persist what was explicitly overridden — never write defaults back to disk
  // This ensures readRuntimeConfigOverrides() can distinguish real user choices from defaults
  const existing = readRuntimeConfigOverrides()
  const merged: RuntimeConfig = { ...existing, ...updates, updatedAt: new Date().toISOString() }
  fs.writeFileSync(file, JSON.stringify(merged, null, 2))
  return merged
}

export function getRuntimeConfigPath_public(): string {
  return getRuntimeConfigPath()
}
