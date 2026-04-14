import { Mood } from '../memory/types'
import { MemoryEngine } from '../memory/MemoryEngine'

export type MoodEvent =
  | 'SUMMONED'
  | 'PACK_TAGGED_IN'
  | 'NO_ACTIVITY'
  | 'TICK'   // Called each cron cycle to apply time-of-day drift

const HEATED_SUMMON_THRESHOLD = 3
const HEATED_WINDOW_MS = 60 * 60 * 1000          // 1 hour
const DISTRACTED_INACTIVITY_MS = 2 * 24 * 60 * 60 * 1000  // 2 days

export class MoodEngine {
  private memory: MemoryEngine
  private recentSummonTimestamps: number[] = []

  constructor(memory: MemoryEngine) {
    this.memory = memory
  }

  getCurrentMood(): Mood {
    return this.memory.getMood()
  }

  /**
   * Call this on each relevant event to update mood.
   * Mood is always persisted immediately via MemoryEngine.
   */
  updateMood(event: MoodEvent): void {
    const currentMood = this.getCurrentMood()

    if (event === 'SUMMONED') {
      this.recentSummonTimestamps.push(Date.now())
      // Prune timestamps outside the heated window
      const windowStart = Date.now() - HEATED_WINDOW_MS
      this.recentSummonTimestamps = this.recentSummonTimestamps.filter(t => t > windowStart)

      if (this.recentSummonTimestamps.length >= HEATED_SUMMON_THRESHOLD) {
        this.memory.setMood('heated')
        return
      }
    }

    if (event === 'PACK_TAGGED_IN') {
      if (currentMood !== 'heated') {
        this.memory.setMood('defensive')
      }
      return
    }

    if (event === 'TICK') {
      // Check for long inactivity → distracted
      const lastMoodUpdate = this.memory.getMoodUpdatedAt()
      const msSinceUpdate = Date.now() - lastMoodUpdate.getTime()

      if (msSinceUpdate > DISTRACTED_INACTIVITY_MS && currentMood !== 'distracted') {
        this.memory.setMood('distracted')
        return
      }

      // Time-of-day drift (UTC hour)
      const hour = new Date().getUTCHours()
      if (hour >= 22 || hour < 6) {
        // Night → chill (only drift from non-extreme moods)
        if (currentMood !== 'heated' && currentMood !== 'chill') {
          this.memory.setMood('chill')
        }
      } else if (hour >= 6 && hour < 10) {
        // Morning → defensive
        if (currentMood === 'chill' || currentMood === 'distracted') {
          this.memory.setMood('defensive')
        }
      }
    }
  }

  /**
   * Returns a delay multiplier based on mood.
   * heated → reply faster (urgency), distracted → reply slower
   */
  getDelayMultiplier(): number {
    const mood = this.getCurrentMood()
    switch (mood) {
      case 'heated': return 0.4
      case 'defensive': return 0.7
      case 'chill': return 1.0
      case 'snarky': return 0.9
      case 'distracted': return 1.5
      default: return 1.0
    }
  }

  /**
   * Directly set mood, bypassing event-based logic.
   * Used by Telegram control adapter for owner overrides.
   */
  forceMood(mood: Mood): void {
    this.memory.setMood(mood)
  }

  /**
   * Returns a tag probability boost based on mood.
   */
  getTagProbabilityBoost(): number {
    const mood = this.getCurrentMood()
    switch (mood) {
      case 'heated': return 0.25
      case 'defensive': return 0.10
      default: return 0
    }
  }
}
