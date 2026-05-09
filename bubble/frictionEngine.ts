export type FrictionState =
  | 'confusion_loop'
  | 'unresolved_exploration'
  | 'rapid_switching'
  | 'prolonged_effort'
  | 'repeated_return'

export interface FrictionSignal {
  state:      FrictionState
  topic:      string
  confidence: number
}

export interface FrictionInput {
  topic:         string
  currentUrl:    string
  dwellMs:       number
  timeline:      ReadonlyArray<{ timestamp: number; topic: string; fullUrl: string }>
  topicCount:    number   // times this topic key appears in current timeline window
  platformCount: number   // platforms this topic has been seen on
}

const CONFUSION_REPEAT   = 3
const EXPLORE_PLATFORMS  = 3
const PROLONGED_DWELL_MS = 10 * 60_000   // 10 min on same page
const RAPID_WINDOW_MS    =  2 * 60_000   // 2 min window
const RAPID_MIN_ENTRIES  = 5             // 5+ entries in 2 min = avg 24s each

export function detectFriction(ctx: FrictionInput): FrictionSignal | null {
  const { topic, currentUrl, dwellMs, timeline, topicCount, platformCount } = ctx

  // same topic across 3+ platforms → unresolved exploration (check before confusion_loop
  // because 3 platform visits also means topicCount=3, and platform diversity is more specific)
  if (platformCount >= EXPLORE_PLATFORMS) {
    return { state: 'unresolved_exploration', topic, confidence: 0.82 }
  }

  // same topic hit 3+ times on fewer platforms → confusion loop
  if (topicCount >= CONFUSION_REPEAT) {
    const conf = Math.min(0.95, 0.70 + (topicCount - CONFUSION_REPEAT) * 0.08)
    return { state: 'confusion_loop', topic, confidence: conf }
  }

  // 10+ min on page they've visited before → prolonged effort
  if (dwellMs >= PROLONGED_DWELL_MS && topicCount >= 2) {
    return { state: 'prolonged_effort', topic, confidence: 0.75 }
  }

  // 5+ entries in last 2 min → rapid switching
  const now         = Date.now()
  const recentCount = timeline.filter(e => e.timestamp > now - RAPID_WINDOW_MS).length
  if (recentCount >= RAPID_MIN_ENTRIES) {
    return { state: 'rapid_switching', topic, confidence: 0.73 }
  }

  // same URL visited twice → repeated return
  if (currentUrl.startsWith('http')) {
    const urlReturns = timeline.filter(e => e.fullUrl === currentUrl).length
    if (urlReturns >= 2) {
      return { state: 'repeated_return', topic, confidence: 0.78 }
    }
  }

  return null
}
