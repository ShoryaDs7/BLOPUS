/**
 * TopicSearchProvider
 *
 * Searches X for viral tweets on given topics using session cookies.
 * Used by OwnerViralReplyHunter (Phase 2 — owner account mode).
 * Zero API cost — uses same GraphQL endpoint as SearchMentionsProvider.
 */

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I4xL1Um%2FyLgMuP2NjG8='
const SEARCH_HASH = process.env.X_SEARCH_TIMELINE_HASH ?? 'oKkjeoNFNQN7IeK7AHYc0A'

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

export interface ViralTweetCandidate {
  tweetId: string
  authorHandle: string
  text: string
  likeCount: number
  viewCount: number
  viewsPerMinute: number
  ageMinutes: number
  mediaUrls?: string[]
}

export class TopicSearchProvider {
  private authToken: string
  private ct0: string
  private userId: string

  constructor(userId: string) {
    this.authToken = process.env.X_AUTH_TOKEN ?? ''
    this.ct0 = process.env.X_CT0 ?? ''
    this.userId = userId
  }

  get enabled(): boolean {
    return Boolean(this.authToken && this.ct0)
  }

  /**
   * Search for viral tweets on a topic.
   * Uses min_faves filter in query to pre-filter at X's end.
   * Then applies age filter client-side.
   */
  async searchViral(
    topic: string,
    minLikes: number = 500,
    maxAgeMinutes: number = 120,
  ): Promise<ViralTweetCandidate[]> {
    if (!this.enabled) return []

    try {
      const query = `${topic} min_faves:${minLikes} -is:retweet lang:en`
      const variables = JSON.stringify({
        rawQuery: query,
        count: 20,
        product: 'Latest',
        querySource: 'typed_query',
      })

      const url =
        `https://x.com/i/api/graphql/${SEARCH_HASH}/SearchTimeline` +
        `?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(FEATURES)}`

      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${BEARER}`,
          'x-csrf-token': this.ct0,
          cookie: `auth_token=${this.authToken}; ct0=${this.ct0}; twid=u%3D${this.userId}; lang=en`,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          referer: 'https://x.com/search',
          accept: '*/*',
          'accept-language': 'en-US,en;q=0.9',
          origin: 'https://x.com',
        },
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[TopicSearch] Request failed: ${res.status} — ${body.slice(0, 300)}`)
        return []
      }

      const data = await res.json() as Record<string, unknown>
      return this.extract(data, maxAgeMinutes)
    } catch {
      return []
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extract(data: Record<string, unknown>, maxAgeMinutes: number): ViralTweetCandidate[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instructions: any[] =
        (data as any)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? []
      const results: ViralTweetCandidate[] = []
      const now = Date.now()

      for (const instruction of instructions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries: any[] = instruction.entries ?? []
        for (const entry of entries) {
          const tweetResult = entry.content?.itemContent?.tweet_results?.result
          if (!tweetResult) continue

          const legacy = tweetResult.legacy ?? tweetResult.tweet?.legacy
          const userLegacy =
            tweetResult.core?.user_results?.result?.legacy ??
            tweetResult.tweet?.core?.user_results?.result?.legacy

          if (!legacy?.full_text) continue

          const tweetId = tweetResult.rest_id ?? legacy.id_str ?? ''
          if (!tweetId) continue

          // Skip retweets and replies
          if (legacy.full_text.startsWith('RT @')) continue
          if (legacy.in_reply_to_status_id_str) continue

          const createdAt = new Date(legacy.created_at ?? 0).getTime()
          const ageMinutes = (now - createdAt) / 60_000
          if (ageMinutes > maxAgeMinutes) continue

          const likeCount = legacy.favorite_count ?? 0

          results.push({
            tweetId,
            authorHandle: userLegacy?.screen_name ?? 'unknown',
            text: legacy.full_text,
            likeCount,
            viewCount: 0,
            viewsPerMinute: 0,
            ageMinutes: Math.round(ageMinutes),
          })
        }
      }

      // Sort by most liked first
      return results.sort((a, b) => b.likeCount - a.likeCount)
    } catch {
      return []
    }
  }
}
