import type { FrictionState } from './frictionEngine'

export type GapType =
  | 'concept_boundary'    // user comparing two things — the line between them is unclear
  | 'definition_gap'      // user can't pin down what the thing fundamentally IS
  | 'intuition_gap'       // user has the words, the feel hasn't clicked
  | 'implementation_gap'  // user understands it conceptually, stuck on doing it
  | 'general'             // no clear signal — fall back to friction state alone

export interface ResolutionSignal {
  gap:        GapType
  confidence: number
}

export interface ResolutionInput {
  topic:        string
  pageTitle:    string      // raw pre-clean title of current page
  frictionState: FrictionState
  recentLabels: string[]    // raw window titles of recent visits to this topic
  platforms:    string[]    // platforms this topic has been seen on
}

const COMPARISON = /\bvs\.?\b|\bdifference\b|\bcompare[sd]?\b|\bbetter\b|\bwhich\s+(is|one)\b/i
const DEFINITION = /what\s+exactly|meaning\s+of|\bdefine\b|\bdefinition\b|\bwhat\s+is\s+a?\b|\bexplain\b|\bunderstand\b/i
const IMPL       = /not\s+working|\bhow\s+to\b|\bexample\b|\berror\b|\bfix\b|\bdebug\b|\bimplementi?n?g?\b/i

export function resolveGap(ctx: ResolutionInput): ResolutionSignal {
  const allText = [ctx.pageTitle, ...ctx.recentLabels].join(' ')

  // concept boundary: user is comparing two things
  if (COMPARISON.test(allText))  return { gap: 'concept_boundary',   confidence: 0.85 }

  // definition gap: user can't pin down what it is
  if (DEFINITION.test(allText))  return { gap: 'definition_gap',     confidence: 0.80 }

  // implementation gap: trying to use it, not understand it
  if (IMPL.test(allText))        return { gap: 'implementation_gap', confidence: 0.78 }

  // intuition gap: YouTube-first path hitting a wall (visual learner needs the feel)
  if (ctx.platforms.includes('youtube') && ctx.platforms.length >= 2) {
    return { gap: 'intuition_gap', confidence: 0.72 }
  }

  return { gap: 'general', confidence: 0.60 }
}
