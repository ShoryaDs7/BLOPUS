import { TwitterApi, TweetV2, UserV2, MediaObjectV2 } from 'twitter-api-v2'
import { MentionEvent, ReplyPayload, ViralTweet } from './types'

export { ViralTweet }

export interface TweetSnippet {
  id: string
  text: string
  authorHandle?: string
  inReplyToTweetId?: string
  mediaUrls?: string[]
}

/**
 * XClient — authenticated wrapper around twitter-api-v2.
 *
 * Only the bot's own OAuth 1.0a credentials are required.
 * The bot reads its OWN mention timeline (free tier compatible).
 */
export class XClient {
  private client: TwitterApi
  private botUserId: string

  constructor(botUserId: string) {
    const apiKey = process.env.TWITTER_API_KEY
    const apiSecret = process.env.TWITTER_API_SECRET
    const accessToken = process.env.TWITTER_ACCESS_TOKEN
    const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET

    if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
      throw new Error(
        'Missing Twitter credentials. Set TWITTER_API_KEY, TWITTER_API_SECRET, ' +
        'TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET in .env'
      )
    }

    this.client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken,
      accessSecret: accessTokenSecret,
    })

    this.botUserId = botUserId
  }

  /**
   * Fetch the bot's own mention timeline.
   *
   * Includes referenced_tweets so we can detect if this mention is a reply
   * and identify the parent tweet ID.
   *
   * On first run (no sinceId), fetches only the 5 most recent to avoid a flood.
   */
  async getMentions(sinceId?: string): Promise<MentionEvent[]> {
    const params: Record<string, unknown> = {
      max_results: 10,
      'tweet.fields': ['author_id', 'created_at', 'conversation_id', 'text', 'referenced_tweets', 'attachments'],
      expansions: ['author_id', 'attachments.media_keys', 'referenced_tweets.id'],
      'user.fields': ['username'],
      'media.fields': ['url', 'preview_image_url', 'type'],
    }

    // Only fetch mentions newer than the last seen tweet
    if (sinceId) {
      params['since_id'] = sinceId
    }

    try {
      const response = await this.client.v2.userMentionTimeline(
        this.botUserId,
        params as Parameters<typeof this.client.v2.userMentionTimeline>[1],
      )

      const tweets: TweetV2[] = response.data.data ?? []
      const users: UserV2[] = response.data.includes?.users ?? []
      const mediaObjects: MediaObjectV2[] = (response.data.includes as { media?: MediaObjectV2[] })?.media ?? []
      const includedTweets: TweetV2[] = (response.data.includes as { tweets?: TweetV2[] })?.tweets ?? []

      const userMap = new Map(users.map(u => [u.id, u.username]))
      const mediaMap = new Map(mediaObjects.map(m => [m.media_key, m]))
      const includedTweetMap = new Map(includedTweets.map(t => [t.id, t]))

      // Sort oldest first (ascending ID) so we process in chronological order
      const sorted = [...tweets].sort((a, b) => (a.id < b.id ? -1 : 1))

      return sorted.map((t): MentionEvent => {
        const quotedId = t.referenced_tweets?.find(r => r.type === 'quoted')?.id
        const quotedTweetText = quotedId ? includedTweetMap.get(quotedId)?.text : undefined
        return {
          tweetId: t.id,
          authorId: t.author_id ?? '',
          authorHandle: userMap.get(t.author_id ?? '') ?? 'unknown',
          text: t.text,
          createdAt: t.created_at ?? new Date().toISOString(),
          conversationId: t.conversation_id ?? t.id,
          inReplyToTweetId: t.referenced_tweets?.find(r => r.type === 'replied_to')?.id,
          mediaUrls: (t.attachments?.media_keys ?? [])
            .map(key => { const m = mediaMap.get(key); return m?.url ?? m?.preview_image_url ?? null })
            .filter((url): url is string => url !== null),
          quotedTweetText,
        }
      })
    } catch (err: unknown) {
      const apiError = err as { code?: number }
      if (apiError?.code === 429) {
        throw Object.assign(new Error('Rate limited'), { statusCode: 429 })
      }
      throw err
    }
  }

  /**
   * Search recent tweets mentioning the bot handle.
   * Catches deep-thread mentions that the userMentionTimeline indexes slowly.
   * Returns [] silently on any error (403 insufficient tier, 429, etc.)
   */
  async searchMentions(handle: string, sinceId?: string): Promise<MentionEvent[]> {
    const params: Record<string, unknown> = {
      max_results: 20,
      'tweet.fields': ['author_id', 'created_at', 'conversation_id', 'text', 'referenced_tweets', 'attachments'],
      expansions: ['author_id', 'attachments.media_keys'],
      'user.fields': ['username'],
      'media.fields': ['url', 'preview_image_url', 'type'],
    }
    if (sinceId) {
      params['since_id'] = sinceId
    }

    try {
      const response = await this.client.v2.search(
        `@${handle} -is:retweet`,
        params as Parameters<typeof this.client.v2.search>[1],
      )

      const tweets: TweetV2[] = response.data.data ?? []
      const users: UserV2[] = response.data.includes?.users ?? []
      const mediaObjects: MediaObjectV2[] = (response.data.includes as { media?: MediaObjectV2[] })?.media ?? []
      const userMap = new Map(users.map(u => [u.id, u.username]))
      const mediaMap = new Map(mediaObjects.map(m => [m.media_key, m]))

      const sorted = [...tweets].sort((a, b) => (a.id < b.id ? -1 : 1))

      return sorted.map((t): MentionEvent => ({
        tweetId: t.id,
        authorId: t.author_id ?? '',
        authorHandle: userMap.get(t.author_id ?? '') ?? 'unknown',
        text: t.text,
        createdAt: t.created_at ?? new Date().toISOString(),
        conversationId: t.conversation_id ?? t.id,
        inReplyToTweetId: t.referenced_tweets?.find(r => r.type === 'replied_to')?.id,
        mediaUrls: (t.attachments?.media_keys ?? [])
          .map(key => { const m = mediaMap.get(key); return m?.url ?? m?.preview_image_url ?? null })
          .filter((url): url is string => url !== null),
      }))
    } catch {
      return []
    }
  }

  /**
   * Fetch a single tweet by ID for thread context enrichment.
   * Returns null on any error (e.g. deleted tweet, protected account, 404).
   */
  async getTweetById(id: string): Promise<TweetSnippet | null> {
    try {
      const response = await this.client.v2.singleTweet(id, {
        'tweet.fields': ['author_id', 'text', 'referenced_tweets', 'attachments'],
        expansions: ['author_id', 'attachments.media_keys'],
        'user.fields': ['username'],
        'media.fields': ['url', 'preview_image_url', 'type'],
      } as Parameters<typeof this.client.v2.singleTweet>[1])

      if (!response.data) return null

      const authorHandle = response.includes?.users?.[0]?.username
      const inReplyToTweetId = response.data.referenced_tweets?.find(r => r.type === 'replied_to')?.id
      const mediaObjects: MediaObjectV2[] = (response.includes as { media?: MediaObjectV2[] })?.media ?? []
      const mediaMap = new Map(mediaObjects.map(m => [m.media_key, m]))
      const mediaUrls = (response.data.attachments?.media_keys ?? [])
        .map(key => { const m = mediaMap.get(key); return m?.url ?? m?.preview_image_url ?? null })
        .filter((url): url is string => url !== null)

      return { id: response.data.id, text: response.data.text, authorHandle, inReplyToTweetId, mediaUrls }
    } catch {
      // Silently return null — deleted, protected, or unavailable tweet
      return null
    }
  }

  /**
   * Post a reply tweet.
   */
  async postReply(payload: ReplyPayload): Promise<string> {
    try {
      const result = await this.client.v2.tweet({
        text: payload.text,
        reply: { in_reply_to_tweet_id: payload.inReplyToTweetId },
      })
      return result.data.id
    } catch (err: unknown) {
      const apiError = err as { code?: number }
      if (apiError?.code === 429) {
        throw Object.assign(new Error('Rate limited'), { statusCode: 429 })
      }
      throw err
    }
  }

  /**
   * Fetch posts the owner has recently engaged with as reply targets.
   *
   * Strategy:
   * - If owner replied directly to a root post → OsBot replies to that root post (prominent, open)
   * - If owner replied to a nested comment → OsBot replies to that same comment (guaranteed open,
   *   since the owner got through there)
   *
   * Deduplicates by conversation_id so OsBot only engages once per thread.
   */
  async getOwnerRecentReplies(ownerUserId: string): Promise<ViralTweet[]> {
    try {
      const response = await this.client.v2.userTimeline(ownerUserId, {
        max_results: 20,
        exclude: ['retweets'],
        'tweet.fields': ['author_id', 'text', 'public_metrics', 'referenced_tweets', 'created_at', 'conversation_id'],
        expansions: ['referenced_tweets.id', 'referenced_tweets.id.author_id', 'author_id'],
        'user.fields': ['username'],
      } as Parameters<typeof this.client.v2.userTimeline>[1])

      const ownerTweets: TweetV2[] = response.data.data ?? []
      const includedTweets: TweetV2[] = response.data.includes?.tweets ?? []
      const includedUsers: UserV2[] = response.data.includes?.users ?? []

      const userMap = new Map(includedUsers.map(u => [u.id, u.username]))
      const parentMap = new Map(includedTweets.map(t => [t.id, t]))

      // Deduplicate by conversation_id — only one reply per thread
      const seenConversations = new Set<string>()

      return ownerTweets
        .filter(t => {
          const convId = t.conversation_id
          if (!convId || !t.referenced_tweets?.some(r => r.type === 'replied_to')) return false
          if (seenConversations.has(convId)) return false
          seenConversations.add(convId)
          return true
        })
        .map(t => {
          const directParentId = t.referenced_tweets!.find(r => r.type === 'replied_to')!.id
          const rootId = t.conversation_id!

          // Use root if owner replied directly to it (directParent === root, already in includes)
          // Otherwise use the direct parent — owner replied there so it's open
          const targetId = (directParentId === rootId) ? rootId : directParentId
          const target = parentMap.get(targetId)
          if (!target) return null

          const m = target.public_metrics
          return {
            id: targetId,
            text: target.text,
            authorId: target.author_id ?? '',
            authorHandle: userMap.get(target.author_id ?? '') ?? 'unknown',
            likeCount: m?.like_count ?? 0,
            replyCount: m?.reply_count ?? 0,
            retweetCount: m?.retweet_count ?? 0,
            viewCount: m ? m.like_count + m.reply_count * 2 + (m.retweet_count ?? 0) * 2 : 0,
          } as ViralTweet
        })
        .filter((t): t is ViralTweet => t !== null)
    } catch (err) {
      console.log(`[XClient] getOwnerRecentReplies error: ${err}`)
      return []
    }
  }

  /**
   * Fetch a user's recent standalone tweets (no replies, no retweets).
   * Used by ViralReplyHunter to find engager posts OsBot can reply to.
   */
  async getUserRecentTweets(userId: string): Promise<ViralTweet[]> {
    try {
      const response = await this.client.v2.userTimeline(userId, {
        max_results: 5,
        exclude: ['retweets', 'replies'],
        'tweet.fields': ['author_id', 'text', 'public_metrics', 'created_at'],
        expansions: ['author_id'],
        'user.fields': ['username'],
      } as Parameters<typeof this.client.v2.userTimeline>[1])

      const tweets: TweetV2[] = response.data.data ?? []
      const users: UserV2[] = response.data.includes?.users ?? []
      const userMap = new Map(users.map(u => [u.id, u.username]))

      return tweets.map(t => {
        const m = t.public_metrics
        return {
          id: t.id,
          text: t.text,
          authorId: t.author_id ?? userId,
          authorHandle: userMap.get(t.author_id ?? '') ?? 'unknown',
          likeCount: m?.like_count ?? 0,
          replyCount: m?.reply_count ?? 0,
          retweetCount: m?.retweet_count ?? 0,
          viewCount: m ? m.like_count + m.reply_count * 2 + (m.retweet_count ?? 0) * 2 : 0,
        } as ViralTweet
      })
    } catch (err) {
      console.log(`[XClient] getUserRecentTweets(${userId}) error: ${err}`)
      return []
    }
  }

  /**
   * Fetch the bot's followers.
   * People who follow OsBot have "engaged" — Twitter may allow replying to their tweets.
   */
  async getBotFollowers(botUserId: string): Promise<{ userId: string; handle: string }[]> {
    try {
      const response = await this.client.v2.followers(botUserId, {
        max_results: 100,
        'user.fields': ['username'],
      } as Parameters<typeof this.client.v2.followers>[1])
      const users: UserV2[] = response.data.data ?? []
      return users.map(u => ({ userId: u.id, handle: u.username }))
    } catch (err) {
      console.log(`[XClient] getBotFollowers error: ${err}`)
      return []
    }
  }

  /**
   * Post a quote tweet — attaches OsBot's comment on top of the original tweet.
   * No engagement restriction — any public tweet can be quoted.
   */
  async postQuoteTweet(text: string, quoteTweetId: string): Promise<string> {
    try {
      const result = await this.client.v2.tweet({
        text,
        quote_tweet_id: quoteTweetId,
      })
      return result.data.id
    } catch (err: unknown) {
      const apiError = err as { code?: number }
      if (apiError?.code === 429) {
        throw Object.assign(new Error('Rate limited'), { statusCode: 429 })
      }
      throw err
    }
  }

  /**
   * Post a standalone tweet (not a reply).
   */
  async postTweet(text: string): Promise<string> {
    try {
      const result = await this.client.v2.tweet({ text })
      return result.data.id
    } catch (err: unknown) {
      const apiError = err as { code?: number }
      if (apiError?.code === 429) {
        throw Object.assign(new Error('Rate limited'), { statusCode: 429 })
      }
      throw err
    }
  }

  /**
   * One-time helper: fetch the bot's own numeric user ID by handle.
   */
  async fetchUserIdByHandle(handle: string): Promise<string> {
    const result = await this.client.v2.userByUsername(handle.replace(/^@/, ''))
    if (!result.data) throw new Error(`User @${handle} not found`)
    return result.data.id
  }
}
