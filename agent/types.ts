import { MentionType } from '../core/personality/types'
import { MentionEvent } from '../adapters/x/types'

export interface Decision {
  type: MentionType
  mention: MentionEvent
  targetHandle?: string
}

export interface OsBotConfig {
  blopus: {
    handle: string
    userId: string
    displayName: string
  }
  owner: {
    handle: string
    displayName: string
  }
  platform: {
    primary: string
    pollIntervalMinutes: number
    maxRepliesPerPollCycle: number
    maxRepliesPerDay: number
    replyDelayMinutes: { min: number; max: number }
  }
  personality: {
    traits: {
      aggression: number
      warmth: number
      humor: number
      formality: number
      verbosity: number
    }
    quirks: {
      responseRate: number
    }
    replyTemplates?: Record<string, string[]>  // optional: used as LLM fallback only
  }
  llm: {
    model: string
    maxTokens: number
    temperature: number
    enabled: boolean
  }
  summon: {
    keywords: string[]
    requireOwnerHandle: boolean
  }
  pack: {
    knownOsBots: string[]
    tagProbability: number
    maxTagsPerReply: number
  }
  memory: {
    storePath: string
    maxRecords: number
    pruneAfterDays: number
  }
  rateLimits: {
    monthlyPostBudget: number
    safetyBufferPercent: number
    minimumPollIntervalMinutes: number
    backoffOnErrorMs: number
    threadCooldownMinutes: number
  }
  filters?: {
    ignoreRetweets?: boolean
    blocklist?: string[]
    keywords?: {
      mustNotContain?: string[]
    }
  }
  botDisclosure?: {
    appendToReplies?: boolean
    disclosureText?: string
  }
  threads?: {
    enabled: boolean
    userId: string   // numeric Threads user ID
  }
}
