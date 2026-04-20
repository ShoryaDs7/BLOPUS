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
        results: Array<{ title: string; content: string }>
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
}
