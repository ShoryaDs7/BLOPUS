import { MentionEvent } from './types'

// X web client public bearer token — stable, does not require user credentials
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I4xL1Um%2FyLgMuP2NjG8='

// SearchTimeline GraphQL hash — hardcoded with env override
// If requests start returning 404, update X_SEARCH_TIMELINE_HASH in .env
const SEARCH_HASH = process.env.X_SEARCH_TIMELINE_HASH ?? 'flaR-PUMshxFWZWPNpq4zA'

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

export class SearchMentionsProvider {
  private authToken: string
  private ct0: string
  private botHandle: string
  private botUserId: string

  constructor(botHandle: string, botUserId: string) {
    this.authToken = process.env.X_AUTH_TOKEN ?? ''
    this.ct0 = process.env.X_CT0 ?? ''
    this.botHandle = botHandle.replace(/^@/, '')
    this.botUserId = botUserId
  }

  get enabled(): boolean {
    return Boolean(this.authToken && this.ct0)
  }

  async searchMentions(sinceId?: string): Promise<MentionEvent[]> {
    if (!this.enabled) return []

    try {
      const variables = JSON.stringify({
        rawQuery: `to:${this.botHandle}`,
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
          cookie: `auth_token=${this.authToken}; ct0=${this.ct0}; twid=u%3D${this.botUserId}; lang=en`,
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'referer': 'https://x.com/search',
          'accept': '*/*',
          'accept-language': 'en-US,en;q=0.9',
          'origin': 'https://x.com',
        },
      })

      if (!res.ok) {
        console.warn(`[SearchMentions] Request failed: ${res.status} — update X_SEARCH_TIMELINE_HASH in .env if 404, re-paste cookies if 401/403`)
        return []
      }

      const data = await res.json() as Record<string, unknown>
      const mentions = this.extractMentions(data)
      console.log(`[SearchMentions] Raw results: ${mentions.length} tweets`)

      if (!sinceId) return mentions
      return mentions.filter(m => BigInt(m.tweetId) > BigInt(sinceId))
    } catch {
      return []
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractMentions(data: Record<string, unknown>): MentionEvent[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instructions: any[] =
        (data as any)?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? []
      const results: MentionEvent[] = []

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

          results.push({
            tweetId,
            authorId: userLegacy?.id_str ?? '',
            authorHandle: userLegacy?.screen_name ?? 'unknown',
            text: legacy.full_text,
            createdAt: legacy.created_at ?? new Date().toISOString(),
            conversationId: legacy.conversation_id_str ?? tweetId,
            inReplyToTweetId: legacy.in_reply_to_status_id_str || undefined,
          })
        }
      }
      return results
    } catch {
      return []
    }
  }
}
