/**
 * LoyaltyEngine
 *
 * Handles summon keyword detection and pack signal detection.
 * Does NOT classify the full decision (that's DecisionEngine).
 * This module only answers: "does this text contain a summon?"
 */
export class LoyaltyEngine {
  private ownerHandle: string
  private summonKeywords: string[]
  private requireOwnerHandle: boolean

  constructor(ownerHandle: string, summonKeywords: string[], requireOwnerHandle: boolean) {
    this.ownerHandle = ownerHandle.replace(/^@/, '').toLowerCase()
    this.summonKeywords = summonKeywords.map(k => k.toLowerCase())
    this.requireOwnerHandle = requireOwnerHandle
  }

  /**
   * Returns true if the mention text contains a summon keyword.
   * If requireOwnerHandle is true, the owner's @handle must also be present.
   */
  isSummon(mentionText: string): boolean {
    const text = mentionText.toLowerCase()

    const hasSummonKeyword = this.summonKeywords.some(k => text.includes(k))
    if (!hasSummonKeyword) return false

    if (this.requireOwnerHandle) {
      const hasOwner = text.includes('@' + this.ownerHandle)
      return hasOwner
    }

    return true
  }

  /**
   * Returns true if the mention text references the owner's handle at all.
   * Used for boosting priority in the sort queue.
   */
  mentionsOwner(mentionText: string): boolean {
    return mentionText.toLowerCase().includes('@' + this.ownerHandle)
  }
}
