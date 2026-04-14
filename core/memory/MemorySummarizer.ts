import { MemoryEngine } from './MemoryEngine'
import { PlatformEvent } from './types'
import Anthropic from '@anthropic-ai/sdk'

/**
 * MemorySummarizer — runs on bot startup.
 *
 * For each complete past week that has platform events but no summary yet,
 * it calls the LLM with a curation prompt to extract only high-signal patterns.
 * The result is stored in memorySummaries[] — forever — as compressed episodic memory.
 *
 * The LLM is told explicitly what to keep and what to discard:
 * KEEP: recurring people, content that worked, dominant topics, platform differences
 * DISCARD: one-off replies, routine posts, exact timestamps, noise
 */
export class MemorySummarizer {
  private client: Anthropic

  constructor(
    private memory: MemoryEngine,
    private model: string = 'claude-haiku-4-5-20251001',
  ) {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  }

  async summarizeIfNeeded(): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY) return

    const unsummarized = this.memory.getUnsummarizedWeeks()
    if (unsummarized.length === 0) return

    console.log(`[MemorySummarizer] ${unsummarized.length} week(s) to summarize.`)

    for (const weekOf of unsummarized) {
      const events = this.memory.getEventsByWeek(weekOf)
      if (events.length < 3) {
        // Too few events to summarize — store a minimal marker so we don't retry forever
        this.memory.addMemorySummary({
          weekOf,
          summary: `Week of ${weekOf}: low activity (${events.length} event(s)).`,
          createdAt: new Date().toISOString(),
        })
        continue
      }

      try {
        const summary = await this.curateSummary(weekOf, events)
        this.memory.addMemorySummary({ weekOf, summary, createdAt: new Date().toISOString() })
        console.log(`[MemorySummarizer] Summarized week of ${weekOf}: "${summary.slice(0, 80)}..."`)
      } catch (err) {
        console.log(`[MemorySummarizer] Failed to summarize week ${weekOf}: ${err}`)
      }
    }
  }

  private async curateSummary(weekOf: string, events: PlatformEvent[]): Promise<string> {
    const eventLines = events.map(e => `[${e.platform}] ${e.type}: ${e.summary}`).join('\n')

    const prompt =
      `You are building a long-term memory for an AI social media agent.\n\n` +
      `Below are raw activity events from the week of ${weekOf}.\n\n` +
      `${eventLines}\n\n` +
      `Extract a memory summary. Rules:\n` +
      `KEEP: people who appeared 2+ times (they matter), topics that dominated, ` +
      `platform differences (X vs Threads behavior), anything unusual or high-engagement.\n` +
      `DISCARD: one-off interactions, routine posts with no pattern, exact timestamps, ` +
      `raw counts, obvious noise.\n\n` +
      `Write 2-4 sentences max. Be specific about what actually matters. ` +
      `Start with the most important signal from this week.\n` +
      `Memory summary:`

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 200,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }],
    })

    const content = response.content[0]
    if (content.type !== 'text') return ''
    return content.text.trim()
  }
}
