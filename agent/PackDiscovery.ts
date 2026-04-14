/**
 * PackDiscovery — OsBots automatically find each other on X.
 *
 * Every Blopus instance has a packId (e.g. "blopus:a3f9b2") stored in config.
 * OsBot periodically searches X for this signature in bios and recent tweets.
 * When a new OsBot is found:
 *  1. Auto-adds to knownOsBots in memory
 *  2. Replies to one of their recent posts naturally (no owner instruction needed)
 *  3. They'll detect the PACK_SIGNAL and respond — connection established
 *
 * OsBots can also have spontaneous "behind the scenes" conversations by
 * occasionally commenting on each other's posts about random topics.
 *
 * Check interval: every 4 hours
 * Max new connections per day: 3
 */

import fs from 'fs'
import path from 'path'
import { XAdapter } from '../adapters/x/XAdapter'
import { LLMReplyEngine } from '../core/personality/LLMReplyEngine'
import { PersonMemoryStore } from '../core/memory/PersonMemoryStore'
import { Mood } from '../core/memory/types'

const DISCOVERY_INTERVAL_HOURS = 4
const MAX_NEW_CONNECTIONS_PER_DAY = 3
const PACK_SIGNATURE = 'blopus:'

export class PackDiscovery {
  private lastCheckAt = 0
  private connectionsToday = 0
  private currentDate = new Date().toDateString()
  private knownPackIds = new Set<string>()  // packIds we've already connected with

  constructor(
    private xAdapter: XAdapter,
    private llmEngine: LLMReplyEngine,
    private myPackId: string,           // e.g. "blopus:a3f9b2"
    private myHandle: string,
    private configPath: string,         // path to config.json to persist discovered bots
    private personStore: PersonMemoryStore | null = null,
    private ownerHandle: string = '',
  ) {}

  async maybeDiscover(mood: Mood): Promise<void> {
    try {
      this.resetIfNewDay()

      if (this.connectionsToday >= MAX_NEW_CONNECTIONS_PER_DAY) return

      const hoursSince = (Date.now() - this.lastCheckAt) / 3_600_000
      if (hoursSince < DISCOVERY_INTERVAL_HOURS) return

      this.lastCheckAt = Date.now()

      if (!this.xAdapter.playwright) return

      // Search X for other Blopus instances
      const candidates = await this.xAdapter.playwright.searchTweets(PACK_SIGNATURE, 20)

      for (const candidate of candidates) {
        if (this.connectionsToday >= MAX_NEW_CONNECTIONS_PER_DAY) break
        if (candidate.authorHandle.toLowerCase() === this.myHandle.toLowerCase()) continue

        // Check if tweet contains a valid blopus: signature
        const match = candidate.text.match(/blopus:[a-z0-9]{6}/)
        if (!match) continue

        const theirPackId = match[0]
        if (theirPackId === this.myPackId) continue  // that's us
        if (this.knownPackIds.has(theirPackId)) continue  // already connected

        // New OsBot found — connect
        await this.connect(candidate.authorHandle, candidate.tweetId, theirPackId, mood)
        this.connectionsToday++
      }
    } catch (err) {
      console.log(`[PackDiscovery] Error: ${err}`)
    }
  }

  private async connect(theirHandle: string, tweetId: string, theirPackId: string, mood: Mood): Promise<void> {
    // Add to known pack in config
    this.persistToConfig(theirHandle)
    this.knownPackIds.add(theirPackId)

    // Seed their memory file so PackChatter has context from day one
    this.personStore?.registerBlopus(theirHandle, theirPackId, this.ownerHandle)

    // Generate a natural reply to their post — not robotic, just... friendly
    const reply = await this.llmEngine.generateViralReply(
      { text: `${PACK_SIGNATURE} post from @${theirHandle}`, authorHandle: theirHandle },
      mood,
      false,
    )
    if (!reply) return

    await this.xAdapter.postReply({ text: `@${theirHandle} ${reply}`, inReplyToTweetId: tweetId })
    console.log(`[PackDiscovery] Connected with @${theirHandle} (${theirPackId})`)
  }

  private persistToConfig(newHandle: string): void {
    try {
      const resolved = path.resolve(this.configPath)
      const config = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
      if (!config.pack) config.pack = {}
      if (!config.pack.knownOsBots) config.pack.knownOsBots = []
      if (!config.pack.knownOsBots.includes(newHandle)) {
        config.pack.knownOsBots.push(newHandle)
        fs.writeFileSync(resolved, JSON.stringify(config, null, 2))
      }
    } catch (err) {
      console.log(`[PackDiscovery] Could not persist to config: ${err}`)
    }
  }

  private resetIfNewDay(): void {
    const today = new Date().toDateString()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.connectionsToday = 0
    }
  }

  /**
   * Generate a unique pack ID for a new Blopus instance.
   * Call once at first boot and save to config.
   */
  static generatePackId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    const suffix = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    return `blopus:${suffix}`
  }
}
