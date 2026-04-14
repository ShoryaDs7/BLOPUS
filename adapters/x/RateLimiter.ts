import { MemoryEngine } from '../../core/memory/MemoryEngine'

interface RateLimiterConfig {
  monthlyPostBudget: number
  safetyBufferPercent: number
  maxRepliesPerDay: number
  maxRepliesPerPollCycle: number
  backoffOnErrorMs: number
  threadCooldownMinutes: number
}

export class RateLimiter {
  private config: RateLimiterConfig
  private memory: MemoryEngine
  private backoffUntil = 0
  private backoffMultiplier = 1

  constructor(config: RateLimiterConfig, memory: MemoryEngine) {
    this.config = config
    this.memory = memory
  }

  /**
   * Check 1: Should this cron cycle even run?
   * Fails if in backoff period OR monthly budget is exhausted.
   */
  canRunCycle(): boolean {
    if (Date.now() < this.backoffUntil) {
      const waitSec = Math.round((this.backoffUntil - Date.now()) / 1000)
      console.info(`[RateLimiter] In backoff. ${waitSec}s remaining.`)
      return false
    }

    const effective = this.effectiveMonthlyBudget()
    const used = this.memory.getMonthlyUsage()
    if (used >= effective) {
      console.warn(`[RateLimiter] Monthly budget exhausted (${used}/${effective}). Skipping replies this cycle.`)
      return false
    }

    return true
  }

  /**
   * Check 2: Can we post right now?
   * Checks monthly AND daily caps.
   */
  canPostNow(): boolean {
    const monthlyUsed = this.memory.getMonthlyUsage()
    if (monthlyUsed >= this.effectiveMonthlyBudget()) {
      console.warn('[RateLimiter] Monthly cap reached mid-cycle.')
      return false
    }

    const dailyUsed = this.memory.getDailyUsage()
    if (dailyUsed >= this.config.maxRepliesPerDay) {
      console.warn(`[RateLimiter] Daily cap reached (${dailyUsed}/${this.config.maxRepliesPerDay}).`)
      return false
    }

    return true
  }

  /**
   * Record a successful post.
   * Resets backoff multiplier on success.
   */
  recordPost(): void {
    this.backoffMultiplier = 1
    // Monthly counter is incremented in MemoryEngine.recordReply(),
    // so nothing to do here beyond resetting backoff state.
  }

  /**
   * Handle API errors. 429 triggers exponential backoff.
   */
  recordError(statusCode: number): void {
    if (statusCode === 429) {
      const delayMs = this.config.backoffOnErrorMs * this.backoffMultiplier
      this.backoffUntil = Date.now() + delayMs
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, 16)
      console.warn(`[RateLimiter] 429 received. Backoff ${delayMs}ms (multiplier: ${this.backoffMultiplier}).`)
    } else {
      console.error(`[RateLimiter] API error ${statusCode} recorded.`)
    }
  }

  /**
   * Returns the per-cycle cap for slicing the mention queue.
   */
  getCycleLimit(): number {
    return this.config.maxRepliesPerPollCycle
  }

  getMonthlyUsage(): number {
    return this.memory.getMonthlyUsage()
  }

  getEffectiveBudget(): number {
    return this.effectiveMonthlyBudget()
  }

  private effectiveMonthlyBudget(): number {
    return Math.floor(this.config.monthlyPostBudget * (1 - this.config.safetyBufferPercent / 100))
  }
}
