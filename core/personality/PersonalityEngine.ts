import { PersonalityQuirks } from './types'

/**
 * PersonalityEngine (slimmed for Phase 1.5)
 *
 * After moving to LLM-based generation, this class handles:
 * - shouldReply(): responseRate probability gate (human-like ignore)
 *
 * Reply text generation is now handled by LLMReplyEngine.
 * Pack tagging and bot disclosure are handled by BlopusAgent directly.
 */
export class PersonalityEngine {
  private quirks: PersonalityQuirks

  constructor(quirks: PersonalityQuirks) {
    this.quirks = quirks
  }

  /**
   * Returns false with probability (1 - responseRate).
   * Simulates the human behavior of missing/ignoring notifications.
   */
  shouldReply(): boolean {
    return Math.random() < this.quirks.responseRate
  }
}
