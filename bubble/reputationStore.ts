/**
 * reputationStore — session-scoped dismiss/accept tracking per topic.
 * Pure module, no server deps — importable by tests and server alike.
 */

const proposalReputation = new Map<string, { accepts: number; dismisses: number }>()
const DISMISS_SILENCE_THRESHOLD = 3

export function recordDismiss(topic: string): void {
  const r = proposalReputation.get(topic) ?? { accepts: 0, dismisses: 0 }
  r.dismisses++
  proposalReputation.set(topic, r)
}

export function recordAccept(topic: string): void {
  const r = proposalReputation.get(topic) ?? { accepts: 0, dismisses: 0 }
  r.accepts++
  r.dismisses = Math.max(0, r.dismisses - 1)
  proposalReputation.set(topic, r)
}

export function isSilencedByReputation(topic: string): boolean {
  return (proposalReputation.get(topic)?.dismisses ?? 0) >= DISMISS_SILENCE_THRESHOLD
}

export function getReputation(topic: string) {
  return proposalReputation.get(topic) ?? { accepts: 0, dismisses: 0 }
}

export function resetReputation(): void {
  proposalReputation.clear()
}
