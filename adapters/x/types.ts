import { ThreadContext } from '../../core/personality/types'

export interface MentionEvent {
  tweetId: string
  authorId: string
  authorHandle: string
  text: string
  createdAt: string           // ISO 8601
  conversationId: string      // root post ID of the thread
  inReplyToTweetId?: string   // direct parent post ID (only set if this is a reply)
  threadContext?: ThreadContext
  mediaUrls?: string[]        // image URLs (photos) or video thumbnails attached to the post
  platform?: 'x' | 'threads' // which platform this mention came from (default: 'x')
  quotedTweetText?: string    // text of the quoted tweet embedded inside this mention (if any)
}

export interface ReplyPayload {
  text: string
  inReplyToTweetId: string
}

export interface ViralTweet {
  id: string
  text: string
  authorId: string
  authorHandle: string
  likeCount: number
  replyCount: number
  retweetCount: number
  viewCount: number
}
