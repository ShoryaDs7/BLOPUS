import { Mood } from '../memory/types'

/**
 * RogueEngine — Phase 4+ feature stub.
 *
 * In rogue mode, the OsBot escalates behavior autonomously —
 * acting without direct summon, targeting hostile accounts proactively,
 * or amplifying its own opinions publicly.
 *
 * This stub exists to:
 *   1. Establish the interface contract for Phase 4 implementors
 *   2. Document intended behavior
 *
 * DO NOT call any method in this class in Phase 1. They all throw.
 */

export interface RogueEngineConfig {
  enabled: boolean
  triggerLoyaltyThreshold: number   // loyalty score below which rogue mode activates
  triggerMoods: Mood[]               // moods that can trigger rogue mode
  targetHandles: string[]            // accounts to monitor/engage when rogue
  maxActionsPerDay: number
  cooldownHours: number              // forced cooldown after each rogue activation
  ownerOverrideCommand: string       // command owner can send to abort rogue mode
}

export class RogueEngine {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: RogueEngineConfig) {
    // Phase 4: store config when methods are implemented
  }

  /**
   * Phase 4: Evaluate whether rogue mode should activate.
   * Based on loyalty score, current mood, and environmental signals.
   */
  shouldActivate(_loyaltyScore: number, _mood: Mood): boolean {
    return this.phase4Only()
  }

  /**
   * Phase 4: Execute a rogue action against a target handle.
   * Rogue actions are always within platform ToS — no spam, no mass tagging.
   */
  async executeAction(_targetHandle: string): Promise<void> {
    this.phase4Only()
  }

  /**
   * Phase 4: Check if we are in a cooldown period after a rogue activation.
   */
  isInCooldown(): boolean {
    return this.phase4Only()
  }

  /**
   * Phase 4: Check if the owner sent the override command to abort rogue mode.
   */
  checkOwnerOverride(_text: string): boolean {
    return this.phase4Only()
  }

  private phase4Only(): never {
    throw new Error(
      'RogueEngine is not implemented in Phase 1. ' +
      'See docs/roadmap.md for Phase 4 implementation guidance.'
    )
  }
}
