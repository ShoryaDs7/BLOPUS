/**
 * ThreadsClient — wraps Meta's Threads Graph API.
 *
 * Auth: long-lived access token (valid 60 days, refresh with refreshToken()).
 * Get your token: developers.facebook.com → Threads API → User Token Generator
 *
 * Env vars needed:
 *   THREADS_ACCESS_TOKEN  — long-lived user access token
 *   THREADS_USER_ID       — numeric Threads user ID
 */

import { MentionEvent, ViralTweet } from '../x/types'

const BASE_URL = 'https://graph.threads.net/v1.0'

interface ThreadsReply {
  id: string
  text?: string
  timestamp: string
  username?: string
  replied_to?: { id: string }
}

interface ThreadsApiResponse<T> {
  data?: T[]
  error?: { message: string; code: number }
}

export class ThreadsClient {
  private accessToken: string
  readonly userId: string
  private ownHandle: string

  constructor(accessToken: string, userId: string, ownHandle: string = '') {
    this.accessToken = accessToken
    this.userId = userId
    this.ownHandle = ownHandle
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`)
    url.searchParams.set('access_token', this.accessToken)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const res = await fetch(url.toString())
    const body = await res.json() as T & { error?: { message: string } }
    if (!res.ok || (body as any).error) {
      throw new Error(`[ThreadsClient] GET ${path} failed: ${JSON.stringify((body as any).error ?? res.status)}`)
    }
    return body
  }

  private async post<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`)
    url.searchParams.set('access_token', this.accessToken)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const res = await fetch(url.toString(), { method: 'POST' })
    const body = await res.json() as T & { error?: { message: string } }
    if (!res.ok || (body as any).error) {
      throw new Error(`[ThreadsClient] POST ${path} failed: ${JSON.stringify((body as any).error ?? res.status)}`)
    }
    return body
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Fetch replies received on the user's threads.
   * Returns as MentionEvent[] so BlopusAgent can treat them identically to X mentions.
   * Uses hasReplied() dedup in the agent — no sinceId needed here.
   */
  async getReplies(): Promise<MentionEvent[]> {
    try {
      // Step 1: get recent threads posted by this account
      const threadsData = await this.get<ThreadsApiResponse<{ id: string }>>(
        `/${this.userId}/threads`,
        { fields: 'id', limit: '10' }
      )
      const myThreads = threadsData.data ?? []
      if (myThreads.length === 0) return []

      // Step 2: for each thread, fetch replies other people made to it
      const results: MentionEvent[] = []
      for (const thread of myThreads) {
        const replyData = await this.get<ThreadsApiResponse<ThreadsReply>>(
          `/${thread.id}/replies`,
          { fields: 'id,text,timestamp,username,replied_to', limit: '10' }
        )
        for (const reply of replyData.data ?? []) {
          // Skip replies from the account itself (username matches userId owner)
          if (!reply.username || reply.username === this.ownHandle) continue
          results.push({
            tweetId: reply.id,
            authorId: reply.id,
            authorHandle: reply.username ?? 'unknown',
            text: reply.text ?? '',
            createdAt: reply.timestamp,
            conversationId: thread.id,
            inReplyToTweetId: thread.id,
            platform: 'threads' as const,
          })
        }
      }
      return results
    } catch (err) {
      console.log(`[ThreadsClient] getReplies error: ${err}`)
      return []
    }
  }

  /**
   * Fetch a single thread post by ID (for thread context).
   */
  async getPostById(id: string): Promise<{ id: string; text: string; replyToId?: string } | null> {
    try {
      const data = await this.get<{ id: string; text?: string; replied_to?: { id: string } }>(
        `/${id}`,
        { fields: 'id,text,replied_to' }
      )
      return {
        id: data.id,
        text: data.text ?? '',
        replyToId: data.replied_to?.id,
      }
    } catch {
      return null
    }
  }

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Post a reply to a Threads post. Two-step: create container → publish.
   * Returns the published post ID.
   */
  async postReply(text: string, replyToId: string): Promise<string> {
    const container = await this.post<{ id: string }>(
      `/${this.userId}/threads`,
      { media_type: 'TEXT', text, reply_to_id: replyToId }
    )

    const published = await this.post<{ id: string }>(
      `/${this.userId}/threads_publish`,
      { creation_id: container.id }
    )

    return published.id
  }

  /**
   * Post a new standalone thread (autonomous posting).
   */
  async postThread(text: string): Promise<string> {
    const container = await this.post<{ id: string }>(
      `/${this.userId}/threads`,
      { media_type: 'TEXT', text }
    )

    const published = await this.post<{ id: string }>(
      `/${this.userId}/threads_publish`,
      { creation_id: container.id }
    )

    return published.id
  }

  /**
   * Fetch followers of this account.
   */
  async getFollowers(): Promise<{ userId: string; handle: string }[]> {
    try {
      const data = await this.get<ThreadsApiResponse<{ id: string; username?: string }>>(
        `/${this.userId}/followers`,
        { fields: 'id,username', limit: '100' }
      )
      return (data.data ?? []).map(u => ({ userId: u.id, handle: u.username ?? 'unknown' }))
    } catch (err) {
      console.log(`[ThreadsClient] getFollowers error: ${err}`)
      return []
    }
  }

  /**
   * Fetch recent threads posted by a user (for follower-hunt).
   */
  async getUserRecentThreads(userId: string): Promise<ViralTweet[]> {
    try {
      const data = await this.get<ThreadsApiResponse<{
        id: string
        text?: string
        username?: string
        like_count?: number
        reply_count?: number
        repost_count?: number
      }>>(
        `/${userId}/threads`,
        { fields: 'id,text,username,like_count,reply_count,repost_count', limit: '10' }
      )
      return (data.data ?? []).map(post => ({
        id: post.id,
        text: post.text ?? '',
        authorId: userId,
        authorHandle: post.username ?? 'unknown',
        likeCount: post.like_count ?? 0,
        replyCount: post.reply_count ?? 0,
        retweetCount: post.repost_count ?? 0,
        viewCount: (post.like_count ?? 0) + (post.reply_count ?? 0) * 2 + (post.repost_count ?? 0) * 2,
      }))
    } catch (err) {
      console.log(`[ThreadsClient] getUserRecentThreads error: ${err}`)
      return []
    }
  }

  /**
   * Refresh a short-lived token to a long-lived one (60 days).
   * Call this periodically to avoid expiry.
   */
  async refreshToken(): Promise<string> {
    const data = await this.get<{ access_token: string }>(
      '/refresh_access_token',
      { grant_type: 'th_refresh_token' }
    )
    this.accessToken = data.access_token
    return data.access_token
  }
}
