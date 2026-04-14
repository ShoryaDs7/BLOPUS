import { TweetSnippet } from './XClient'

// X web client public bearer token — stable, does not require user credentials
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I4xL1Um%2FyLgMuP2NjG8='

// TweetDetail GraphQL hash — hardcoded with env override
// If requests start returning 404, update X_TWEET_DETAIL_HASH in .env
const GRAPHQL_HASH = process.env.X_TWEET_DETAIL_HASH ?? 'nBS-WpgA6ZG0CyNHD517JQ'

const FEATURES = JSON.stringify({
  rweb_lists_timeline_redesign_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_media_download_video_enabled: false,
  responsive_web_enhance_cards_enabled: false,
})

export class BranchContextProvider {
  private authToken: string
  private ct0: string

  constructor() {
    this.authToken = process.env.X_AUTH_TOKEN ?? ''
    this.ct0 = process.env.X_CT0 ?? ''
  }

  get enabled(): boolean {
    return Boolean(this.authToken && this.ct0)
  }

  async fetchSiblingReplies(parentTweetId: string): Promise<TweetSnippet[]> {
    if (!this.enabled) return []

    try {
      const variables = JSON.stringify({
        focalTweetId: parentTweetId,
        count: 20,
        includePromotedContent: false,
        withCommunity: false,
        withQuickPromoteEligibilityTweetFields: false,
        withBirdwatchNotes: false,
        withVoice: false,
        withV2Timeline: true,
      })

      const url =
        `https://x.com/i/api/graphql/${GRAPHQL_HASH}/TweetDetail` +
        `?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(FEATURES)}`

      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${BEARER}`,
          'x-csrf-token': this.ct0,
          cookie: `auth_token=${this.authToken}; ct0=${this.ct0}`,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'content-type': 'application/json',
        },
      })

      if (!res.ok) return []

      const data = await res.json() as Record<string, unknown>
      const tweets = this.extractTweets(data, parentTweetId)
      return this.sample(tweets)
    } catch {
      return []
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTweets(data: Record<string, unknown>, parentTweetId: string): TweetSnippet[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = (data as any)?.data?.threaded_conversation_with_injections_v2
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instructions: any[] = conv?.instructions ?? []
      const results: TweetSnippet[] = []

      for (const instruction of instructions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: any[] = instruction.entries ?? []
        for (const entry of entries) {
          // Replies live in conversationthread entries as items
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const items: any[] = entry.content?.items ?? []
          for (const item of items) {
            const tweetResult =
              item.item?.itemContent?.tweet_results?.result ??
              item.item?.itemContent?.tweet_results?.result?.tweet
            const legacy = tweetResult?.legacy ?? tweetResult?.tweet?.legacy
            const userLegacy =
              tweetResult?.core?.user_results?.result?.legacy ??
              tweetResult?.tweet?.core?.user_results?.result?.legacy

            if (!legacy?.full_text) continue
            if (legacy.in_reply_to_status_id_str !== parentTweetId) continue

            results.push({
              id: tweetResult.rest_id ?? legacy.id_str ?? '',
              text: legacy.full_text,
              authorHandle: userLegacy?.screen_name,
            })
          }
        }
      }
      return results
    } catch {
      return []
    }
  }

  private sample(tweets: TweetSnippet[]): TweetSnippet[] {
    if (tweets.length === 0) return []

    const sorted = [...tweets].sort((a, b) => (a.id < b.id ? -1 : 1))
    const first5 = sorted.slice(0, 5)
    const last5 = sorted.slice(-5)
    const edgeIds = new Set([...first5, ...last5].map(t => t.id))
    const random5 = sorted
      .filter(t => !edgeIds.has(t.id))
      .sort(() => Math.random() - 0.5)
      .slice(0, 5)

    const seen = new Set<string>()
    return [...first5, ...last5, ...random5]
      .filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .slice(0, 15)
  }
}
