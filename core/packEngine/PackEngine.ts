/**
 * PackEngine — Phase 3+ feature stub.
 *
 * In pack mode, multiple OsBot instances coordinate behavior.
 * One OsBot can signal others to amplify, defend, or swarm a target.
 * Phase 1 uses a static `knownOsBots` list in config — actual coordination
 * is handled by Phase 3.
 *
 * Planned coordination channels (TBD in Phase 3):
 *   - Webhook mesh (each OsBot exposes a signed webhook)
 *   - Or: signed DM protocol on X (reading DMs requires elevated API access)
 *   - Or: shared external signal bus (Redis/Supabase)
 *
 * This stub exists to establish the interface contract for Phase 3 implementors.
 * DO NOT call any method in Phase 1.
 */

export interface PackMember {
  osbotHandle: string
  ownerHandle: string
  endpoint?: string     // Phase 3: webhook URL for coordination signals
  publicKey?: string    // Phase 3: for signed message verification
}

export interface PackSignal {
  type: 'amplify' | 'defend' | 'disengage'
  targetTweetId: string
  initiatorHandle: string
  timestamp: string
  ttlSeconds: number
}

export class PackEngine {
  private members: PackMember[] = []

  /**
   * Phase 3: Register a peer OsBot as a pack member.
   * Discovery method TBD: bio tag scan, handle pattern, manual config.
   */
  registerMember(_member: PackMember): void {
    this.phase3Only()
  }

  /**
   * Phase 3: Broadcast a coordination signal to all pack members.
   * Signal transport method TBD (webhook, shared bus, etc.)
   */
  async broadcastSignal(_signal: PackSignal): Promise<void> {
    this.phase3Only()
  }

  /**
   * Phase 3: Listen for incoming signals from other OsBots.
   * Returns verified signals from the current TTL window.
   */
  async listenForSignals(): Promise<PackSignal[]> {
    return this.phase3Only()
  }

  getMembers(): PackMember[] {
    return this.members
  }

  private phase3Only(): never {
    throw new Error(
      'PackEngine is not implemented in Phase 1. ' +
      'See docs/roadmap.md for Phase 3 implementation guidance.'
    )
  }
}
