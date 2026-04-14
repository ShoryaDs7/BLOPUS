import { Mood, TraitVector } from '../memory/types'

export type TraitKey = 'aggression_high' | 'warmth_high' | 'humor_high' | 'formality_high' | 'defense' | 'generic'

export interface PersonalityQuirks {
  responseRate: number   // 0-1, probability of replying at all
}

export type MentionType = 'SUMMON' | 'PACK_SIGNAL' | 'GENERIC' | 'IGNORE'

/**
 * Thread context fetched from the X API before generating a reply.
 * parentTweet = the tweet this mention directly replies to.
 * rootTweet   = the root of the thread (conversationId tweet), if different from parent.
 */
export interface ThreadContext {
  parentTweet?: { id: string; text: string; authorHandle?: string }
  rootTweet?: { id: string; text: string; authorHandle?: string }
  atmosphereTweets?: Array<{ id: string; text: string; authorHandle?: string }>
  replyChain?: Array<{ id: string; text: string; authorHandle?: string }>
}

export interface ReplyContext {
  mentionText: string
  authorHandle: string
  authorId: string
  mentionType: MentionType
  previousInteractions: number
  mood: Mood
  traits: TraitVector
  threadContext?: ThreadContext
  mediaUrls?: string[]        // images/video thumbnails from the mention tweet
  isConversationCloser?: boolean  // true on the final reply — LLM should wrap up naturally
  quotedTweetText?: string    // text of the quoted tweet embedded in the mention (Phase 1 only)
  relationshipContext?: string // prior history with this person from RelationshipMemory
  ownPostContext?: string      // set when this mention is a reply to OsBot's own autonomous tweet
  ownerContext?: string        // facts the owner has shared about themselves (from UserContext via Telegram)
}
