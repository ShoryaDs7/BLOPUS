import { ThreadsClient } from './ThreadsClient'
import { MentionEvent, ReplyPayload, ViralTweet } from '../x/types'

/**
 * ThreadsAdapter — same interface as XAdapter.
 * BlopusAgent talks to this; not to ThreadsClient directly.
 */
export class ThreadsAdapter {
  private client: ThreadsClient

  constructor(client: ThreadsClient) {
    this.client = client
  }

  async fetchOwnMentions(): Promise<MentionEvent[]> {
    const replies = await this.client.getReplies()

    console.log(`[ThreadsAdapter] Fetched ${replies.length} reply(s)`)

    for (const reply of replies) {
      const snippet = reply.text.slice(0, 60).replace(/\n/g, ' ')
      console.log(
        `[ThreadsAdapter] Reply ${reply.tweetId} from @${reply.authorHandle}: "${snippet}..."` +
        (reply.inReplyToTweetId ? ` [reply to ${reply.inReplyToTweetId}]` : '')
      )

      // Thread context: walk reply chain up to root
      if (reply.inReplyToTweetId) {
        const chain: { id: string; text: string }[] = []
        let currentId: string | undefined = reply.inReplyToTweetId
        let depth = 0
        while (currentId && depth < 5) {
          const post = await this.client.getPostById(currentId)
          if (!post) break
          chain.unshift({ id: post.id, text: post.text })
          currentId = post.replyToId
          depth++
        }

        if (chain.length > 0) {
          reply.threadContext = {
            replyChain: chain,
            rootTweet: chain[0],
            parentTweet: chain[chain.length - 1],
          }
        }
      }
    }

    return replies
  }

  async postReply(payload: ReplyPayload): Promise<string> {
    return this.client.postReply(payload.text, payload.inReplyToTweetId)
  }

  async postThread(text: string): Promise<string> {
    return this.client.postThread(text)
  }

  async getBotFollowers(): Promise<{ userId: string; handle: string }[]> {
    return this.client.getFollowers()
  }

  async getUserRecentThreads(userId: string): Promise<ViralTweet[]> {
    return this.client.getUserRecentThreads(userId)
  }
}
