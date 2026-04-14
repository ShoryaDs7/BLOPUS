const TOPIC_KEYWORDS = [
  'ai', 'chatbot', 'grok', 'openai', 'llm', 'model',
  'video', 'photo', 'image', 'footage', 'screenshot',
  'crypto', 'bitcoin', 'blockchain',
  'politics', 'election', 'vote',
  'war', 'conflict', 'military',
  'climate', 'energy',
  'fake', 'hoax', 'conspiracy', 'misinformation', 'evidence', 'sources',
  'epstein',
]

export function extractTopics(texts: string[]): string[] {
  const combined = texts.join(' ').toLowerCase()
  return TOPIC_KEYWORDS.filter(kw => combined.includes(kw)).slice(0, 5)
}
