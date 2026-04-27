/**
 * TavilyClient — fetches current events for autonomous post grounding.
 *
 * Requires TAVILY_API_KEY in .env (free tier: 1,000 searches/month).
 * Returns [] silently if key is missing — bot works normally without it.
 */
export class TavilyClient {
  private apiKey: string | undefined

  constructor() {
    this.apiKey = process.env.TAVILY_API_KEY
  }

  get enabled(): boolean {
    return !!this.apiKey
  }

  async fetchCurrentEvents(topics?: string[]): Promise<string[]> {
    const query = topics?.length
      ? `trending news debates ${topics.slice(0, 3).join(' ')} today`
      : 'trending news debates today'
    return this.search(query, 5)
  }

  /**
   * Search for a specific query. Used during reply generation for factual questions.
   * Returns answer + top result snippets as a flat string array.
   */
  async search(query: string, maxResults = 3, depth: 'basic' | 'advanced' = 'basic'): Promise<string[]> {
    if (!this.apiKey) return []

    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          search_depth: depth,
          max_results: maxResults,
          include_answer: true,
        }),
      })

      if (!res.ok) return []

      const data = await res.json() as {
        answer?: string
        results: Array<{ title: string; content: string; url?: string }>
      }

      const results: string[] = []
      if (data.answer) results.push(data.answer.slice(0, 200))
      for (const r of (data.results ?? []).slice(0, 3)) {
        results.push(`${r.title}: ${r.content.slice(0, 120)}`)
      }
      return results
    } catch {
      return []
    }
  }

  /**
   * Search for tweets on a topic via web search — returns tweet IDs found in x.com URLs.
   * Fallback when X's own search/feed is dry. Requires TAVILY_API_KEY.
   */
  async searchTweetIds(topic: string, maxResults = 10): Promise<string[]> {
    if (!this.apiKey) return []
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: `site:x.com ${topic}`,
          search_depth: 'basic',
          max_results: maxResults,
          include_answer: false,
        }),
      })
      if (!res.ok) return []
      const data = await res.json() as { results: Array<{ url?: string }> }
      const ids: string[] = []
      for (const r of data.results ?? []) {
        const m = (r.url ?? '').match(/x\.com\/[^/]+\/status\/(\d+)/)
        if (m && !ids.includes(m[1])) ids.push(m[1])
      }
      return ids
    } catch {
      return []
    }
  }
}
