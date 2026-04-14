import fs from 'fs'
import path from 'path'

export interface FocusOverride {
  paused?: boolean
  pausedUntil?: string   // ISO string — auto-resumes after this time
  topics?: string[]      // restrict autonomous to these topics
  instruction?: string   // extra instruction injected into autonomous posts
  expiresAt?: string     // ISO string — whole override expires after this
  setAt?: string
}

function getFocusPath(): string {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  return path.join(path.dirname(configPath), 'focus_override.json')
}

/**
 * Read the focus override file. Returns null if not set or expired.
 * Auto-cleans expired files. Safe to call every poll cycle — fast fs read.
 */
export function readFocusOverride(): FocusOverride | null {
  try {
    const file = getFocusPath()
    if (!fs.existsSync(file)) return null

    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as FocusOverride

    // Auto-resume if pausedUntil has passed
    if (data.pausedUntil && new Date(data.pausedUntil) < new Date()) {
      data.paused = false
      fs.writeFileSync(file, JSON.stringify(data, null, 2))
    }

    // Auto-clean whole override if expired
    if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
      fs.unlinkSync(file)
      return null
    }

    return data
  } catch {
    return null
  }
}
