/**
 * RedditAdapter — Phase 3
 * Controls the owner's Reddit account using snoowrap (official Reddit API OAuth).
 * Interface mirrors XAdapter so BlopusAgentReddit can use the same LLM/RAG/memory core.
 */

import Snoowrap from 'snoowrap'
import type { MentionEvent, ReplyPayload } from '../x/types'

export interface RedditPost {
  id: string
  title: string
  text: string
  authorHandle: string
  upvotes: number
  commentCount: number
  subreddit: string
  url: string
  createdAt: string
}

export class RedditAdapter {
  private client: Snoowrap
  private ownerUsername: string
  private lastCheckedEpoch: number

  constructor(
    clientId: string,
    clientSecret: string,
    username: string,
    password: string,
    ownerUsername: string,
  ) {
    this.client = new Snoowrap({
      userAgent: `Blopus/1.0 by u/${username}`,
      clientId,
      clientSecret,
      username,
      password,
    })
    this.ownerUsername = ownerUsername
    // Start from 1 hour ago on first run
    this.lastCheckedEpoch = Math.floor(Date.now() / 1000) - 3600
  }

  /**
   * Fetch new inbox messages (replies to owner's posts/comments + username mentions).
   * sinceId is unused — Reddit uses epoch timestamps instead.
   */
  async fetchOwnMentions(_sinceId?: string): Promise<MentionEvent[]> {
    const mentions: MentionEvent[] = []

    try {
      // Inbox contains replies + username mentions
      const inbox = await (this.client as any).getInbox({ filter: 'unread', limit: 25 })

      for (const item of inbox) {
        const createdEpoch: number = item.created_utc ?? 0
        if (createdEpoch <= this.lastCheckedEpoch) continue
        if (item.author?.name === this.ownerUsername) continue // skip own messages

        mentions.push({
          tweetId: item.id,
          authorId: item.author?.name ?? 'unknown',
          authorHandle: item.author?.name ?? 'unknown',
          text: item.body ?? item.selftext ?? '',
          createdAt: new Date(createdEpoch * 1000).toISOString(),
          conversationId: item.link_id ?? item.id,
          inReplyToTweetId: item.parent_id ?? undefined,
          platform: 'reddit' as any,
        })
      }

      // Mark as read
      if (inbox.length > 0) {
        await (this.client as any).markMessagesAsRead(inbox)
      }
    } catch (err) {
      console.error('[RedditAdapter] fetchOwnMentions error:', err)
    }

    this.lastCheckedEpoch = Math.floor(Date.now() / 1000)
    return mentions
  }

  /**
   * Reply to a comment or post.
   * inReplyToTweetId is the Reddit thing ID (e.g. "t1_abc123" for comment, "t3_abc123" for post)
   */
  async postReply(payload: ReplyPayload): Promise<string> {
    const thingId = payload.inReplyToTweetId
    let reply: any

    if (thingId.startsWith('t3_')) {
      // Replying to a post (submission)
      const submission = this.client.getSubmission(thingId.replace('t3_', ''))
      reply = await submission.reply(payload.text)
    } else {
      // Replying to a comment
      const commentId = thingId.replace('t1_', '')
      const comment = this.client.getComment(commentId)
      reply = await comment.reply(payload.text)
    }

    return (reply as any).id ?? 'posted'
  }

  /**
   * Get hot posts from specified subreddits for viral hunting.
   */
  async getHotPosts(subreddits: string[], limit = 10): Promise<RedditPost[]> {
    const posts: RedditPost[] = []

    for (const sub of subreddits) {
      try {
        const hotPosts = await this.client.getSubreddit(sub).getHot({ limit })
        for (const post of hotPosts) {
          const p = post as any
          // Skip posts less than 30 mins old or too new (not enough engagement signal)
          const ageMinutes = (Date.now() / 1000 - p.created_utc) / 60
          if (ageMinutes < 30 || ageMinutes > 360) continue
          if (p.score < 50) continue

          posts.push({
            id: `t3_${p.id}`,
            title: p.title ?? '',
            text: p.selftext ?? '',
            authorHandle: p.author?.name ?? 'unknown',
            upvotes: p.score ?? 0,
            commentCount: p.num_comments ?? 0,
            subreddit: sub,
            url: p.url ?? '',
            createdAt: new Date(p.created_utc * 1000).toISOString(),
          })
        }
      } catch (err) {
        console.error(`[RedditAdapter] Error fetching hot posts from r/${sub}:`, err)
      }
    }

    return posts.sort((a, b) => b.upvotes - a.upvotes)
  }

  /**
   * Post a standalone comment to a submission (viral hunting use case).
   */
  async postComment(submissionId: string, text: string): Promise<string> {
    const id = submissionId.replace('t3_', '')
    const submission = this.client.getSubmission(id)
    const comment = await submission.reply(text)
    return (comment as any).id ?? 'posted'
  }

  /**
   * Search for relevant subreddits by topic keyword.
   * Returns subreddit names sorted by subscriber count.
   * Used for dynamic subreddit discovery — no hardcoded lists.
   */
  async searchSubreddits(topic: string, limit = 5): Promise<string[]> {
    try {
      const results = await (this.client as any).searchSubreddits({ query: topic, limit })
      return results
        .filter((s: any) => s.subscribers > 10000) // only established communities
        .map((s: any) => s.display_name as string)
    } catch (err) {
      console.error(`[RedditAdapter] searchSubreddits error for "${topic}":`, err)
      return []
    }
  }

  /**
   * Post a new text submission (thread) to a subreddit.
   * Equivalent to posting a tweet — creates new content, not a reply.
   */
  async postSubmission(subreddit: string, title: string, text: string): Promise<string> {
    const submission = await this.client.getSubreddit(subreddit).submitSelfpost({
      title,
      text,
    })
    return (submission as any).id ?? 'posted'
  }
}
