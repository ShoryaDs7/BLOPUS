import Anthropic           from '@anthropic-ai/sdk'
import { TavilyClient }    from '../adapters/search/TavilyClient'
import type { FrictionState } from './frictionEngine'
import type { GapType, ResolutionSignal } from './resolutionEngine'

const ORCHESTRATION_TIMEOUT = 12_000   // give up after 12s — bubble can't wait longer

export interface OrchestrationInput {
  topic:        string
  pageTitle:    string
  frictionState: FrictionState
  resolution:   ResolutionSignal
  recentTopics: string[]
}

export interface OrchestrationResult {
  answer:    string
  latencyMs: number
  action:    'web_search' | 'synthesis_only'
  source?:   string
}

const GAP_QUERY: Record<GapType, (topic: string, pageTitle: string) => string> = {
  concept_boundary:   (t, p) => `${p.replace(/- Google Search.*$/i, '').trim() || t} key difference explained simply`,
  definition_gap:     (t)    => `what is ${t} simple concrete explanation`,
  intuition_gap:      (t)    => `${t} intuition analogy how to understand`,
  implementation_gap: (t, p) => `${p.replace(/- Google Search.*$/i, '').trim() || t} common mistakes how to fix`,
  general:            (t)    => `${t} core concept explained`,
}

const GAP_INSTRUCTION: Record<GapType, string> = {
  concept_boundary:   'Give the one-line distinction that separates the two things. What is the fundamental difference in goal or mechanism?',
  definition_gap:     'Give what this IS in the most concrete terms. No jargon. One analogy if it helps.',
  intuition_gap:      'Give the physical or visual intuition. Not the math, not the definition — the feel of it.',
  implementation_gap: 'Give the specific thing that is probably wrong or missing. What do most people get wrong here?',
  general:            'Give the most commonly missing insight. What do most explanations skip?',
}

const SYNTHESIS_SYSTEM = `You are the resolution layer of a cognitive assistance system.

The user is stuck. You have search results. Extract the specific fact that resolves the confusion.

Rules:
- 2-3 sentences max. Hard limit.
- No preamble. No "Based on the results". No "According to". No "I".
- Mechanical and direct — not wise, not warm, not assistant-y
- Only use what the search results actually say — do not add context or elaboration
- If search results don't directly address the gap, output the single most relevant fact and stop
- Short. Concrete. Specific.`

export class Orchestrator {
  private tavily = new TavilyClient()
  private ai     = new Anthropic()

  get enabled(): boolean { return true }

  async resolve(ctx: OrchestrationInput): Promise<OrchestrationResult | null> {
    const t0 = Date.now()

    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), ORCHESTRATION_TIMEOUT)

    try {
      // Search with gap-targeted query
      const query        = GAP_QUERY[ctx.resolution.gap](ctx.topic, ctx.pageTitle)
      const searchChunks = this.tavily.enabled
        ? await this.tavily.search(query, 3, 'basic')
        : []

      const action = searchChunks.length > 0 ? 'web_search' : 'synthesis_only'

      const userMsg = [
        `Topic: "${ctx.topic}"`,
        `Gap type: ${ctx.resolution.gap}`,
        GAP_INSTRUCTION[ctx.resolution.gap],
        ctx.recentTopics.length > 1
          ? `Context: user has been exploring ${ctx.recentTopics.slice(0, 4).join(' → ')}`
          : '',
        searchChunks.length > 0
          ? `Search results:\n${searchChunks.slice(0, 3).join('\n')}`
          : '',
      ].filter(Boolean).join('\n\n')

      const resp = await this.ai.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system:     SYNTHESIS_SYSTEM,
        messages:   [{ role: 'user', content: userMsg }],
      })

      const answer    = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
      const latencyMs = Date.now() - t0

      if (!answer) return null

      console.log(`[Orchestrator] action=${action} gap=${ctx.resolution.gap} latency=${latencyMs}ms`)
      console.log(`[Orchestrator] answer → "${answer.slice(0, 100)}"`)

      return { answer, latencyMs, action }

    } catch (e: any) {
      if (e.name === 'AbortError') {
        console.warn('[Orchestrator] timeout — falling back to nudge')
      } else {
        console.error('[Orchestrator] error:', e.message?.slice(0, 80))
      }
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}
