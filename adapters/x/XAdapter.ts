import { XClient, ViralTweet } from './XClient'
import { MentionEvent, ReplyPayload } from './types'
import { PlaywrightXClient } from './PlaywrightXClient'

/**
 * XAdapter — platform adapter layer.
 * Wraps XClient with business-logic-free normalization.
 * BlopusAgent talks to this; not to XClient directly.
 */
export class XAdapter {
  private client: XClient
  private botHandle: string
  playwright: PlaywrightXClient | null = null

  constructor(client: XClient, botHandle: string) {
    this.client = client
    this.botHandle = botHandle.replace(/^@/, '')

    const password = process.env.X_PASSWORD
    if (password) {
      this.playwright = new PlaywrightXClient(botHandle, password)
      console.log('[XAdapter] Playwright client ready for autonomous replies')
    } else {
      console.log('[XAdapter] X_PASSWORD not set — autonomous (unprompted) replies disabled')
    }
  }

  async fetchOwnMentions(sinceId?: string): Promise<MentionEvent[]> {
    const apiMentions = await this.client.getMentions(sinceId)

    // Second detection path: v2 recent search — catches deep-thread mentions
    // that the userMentionTimeline indexes slowly. Returns [] on any error.
    const searchMentions = await this.client.searchMentions(this.botHandle, sinceId)

    // Merge: API results are authoritative; add any search-only finds
    const seen = new Set(apiMentions.map(m => m.tweetId))
    const extra = searchMentions.filter(m => !seen.has(m.tweetId))
    const mentions = [...apiMentions, ...extra].sort((a, b) => (a.tweetId < b.tweetId ? -1 : 1))

    console.log(
      `[XAdapter] Fetched ${mentions.length} mention(s)` +
      (extra.length > 0 ? ` (${extra.length} via search)` : '')
    )

    for (const mention of mentions) {
      const snippet = mention.text.slice(0, 60).replace(/\n/g, ' ')
      console.log(
        `[XAdapter] Mention ${mention.tweetId} from @${mention.authorHandle}: "${snippet}..."` +
        (mention.inReplyToTweetId ? ` [reply to ${mention.inReplyToTweetId}]` : '') +
        ` [conv ${mention.conversationId}]`
      )

      // Thread context: walk full reply chain from parent back to root
      if (mention.inReplyToTweetId) {
        type Snippet = { id: string; text: string; authorHandle?: string }
        const chain: Snippet[] = []

        let currentId: string | undefined = mention.inReplyToTweetId
        let depth = 0
        while (currentId && currentId !== mention.conversationId && depth < 15) {
          const tweet = await this.client.getTweetById(currentId)
          if (!tweet) break
          chain.unshift({ id: tweet.id, text: tweet.text, authorHandle: tweet.authorHandle })
          currentId = tweet.inReplyToTweetId
          depth++
        }

        // Always include the root tweet at the front
        const rootTweet = await this.client.getTweetById(mention.conversationId)
        if (rootTweet) {
          chain.unshift({ id: rootTweet.id, text: rootTweet.text, authorHandle: rootTweet.authorHandle })

          // Merge root tweet images into the mention's mediaUrls so Claude can see them
          if (rootTweet.mediaUrls?.length) {
            mention.mediaUrls = [...(mention.mediaUrls ?? []), ...rootTweet.mediaUrls]
          }
        }

        if (chain.length > 0) {
          mention.threadContext = {
            replyChain: chain,
            rootTweet: chain[0],
            parentTweet: chain[chain.length - 1],
          }
          console.log(`[ThreadContext] chain: ${chain.length} tweet(s) — ${chain.map(t => '@' + (t.authorHandle ?? '?')).join(' → ')}`)
        }
      }
    }

    return mentions
  }

  async postReply(payload: ReplyPayload): Promise<string> {
    return this.client.postReply(payload)
  }

  /**
   * Reply to any tweet autonomously — even without being mentioned.
   * Uses Playwright browser automation (X API bans unsolicited replies since 2026).
   */
  async postAutonomousReply(tweetId: string, text: string): Promise<void> {
    if (!this.playwright) {
      throw new Error('[XAdapter] Playwright not available — set X_PASSWORD in .env')
    }
    await this.playwright.postReply(tweetId, text)
  }

  async postTweet(text: string): Promise<string> {
    return this.client.postTweet(text)
  }

  async getOwnerRecentReplies(ownerUserId: string): Promise<ViralTweet[]> {
    return this.client.getOwnerRecentReplies(ownerUserId)
  }

  async getUserRecentTweets(userId: string): Promise<ViralTweet[]> {
    return this.client.getUserRecentTweets(userId)
  }

  async postQuoteTweet(text: string, quoteTweetId: string): Promise<string> {
    if (this.playwright) {
      await this.playwright.quoteTweet(quoteTweetId, text)
      return quoteTweetId
    }
    return this.client.postQuoteTweet(text, quoteTweetId)
  }

  async getBotFollowers(botUserId: string): Promise<{ userId: string; handle: string }[]> {
    return this.client.getBotFollowers(botUserId)
  }

  async sendDm(handle: string, text: string): Promise<boolean> {
    if (!this.playwright) return false
    return this.playwright.sendDm(handle, text)
  }
}
