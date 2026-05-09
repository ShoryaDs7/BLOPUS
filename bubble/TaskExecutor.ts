/**
 * TaskExecutor — direct Anthropic API loop for bubble task envelopes.
 * Not the Agent SDK. Full control: tool allowlist, per-tool budget, hard turn cap.
 */

import Anthropic from '@anthropic-ai/sdk'
import https     from 'https'
import http      from 'http'
import { TavilyClient } from '../adapters/search/TavilyClient'
import type { TaskEnvelope } from './ActionRouter'

const client = new Anthropic()
const tavily = new TavilyClient()

const TASK_SYSTEM = `You are a focused research assistant built into a desktop overlay called Blopus.
Complete ONLY the task given. Return ONLY in the format specified.
Rules:
- No preamble, no "I found...", no "Based on my research..."
- Stop as soon as you have enough to fulfill the return format — do not over-search
- If a search result already contains the answer, do NOT also fetch the URL
- If you cannot find relevant results after 1-2 searches: return what you have, do not apologize`

const ALL_TOOLS: Record<string, Anthropic.Tool> = {
  tavily_search: {
    name:        'tavily_search',
    description: 'Search the web. Returns top result snippets.',
    input_schema: {
      type:       'object' as const,
      properties: { query: { type: 'string', description: 'Search query' } },
      required:   ['query'],
    },
  },
  web_fetch: {
    name:        'web_fetch',
    description: 'Fetch and read the text content of a URL.',
    input_schema: {
      type:       'object' as const,
      properties: { url: { type: 'string', description: 'Full URL' } },
      required:   ['url'],
    },
  },
}

function fetchUrl(url: string): Promise<string> {
  return new Promise(resolve => {
    try {
      const mod = url.startsWith('https') ? https : http
      const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchUrl(res.headers.location)); return
        }
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          resolve(data
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 4000) || 'empty page')
        })
      })
      req.on('error', () => resolve('fetch failed'))
      req.setTimeout(10000, () => { req.destroy(); resolve('timed out') })
    } catch { resolve('fetch failed') }
  })
}

export async function executeTask(envelope: TaskEnvelope): Promise<string> {
  const budgets = { ...envelope.toolBudget }

  const tools = envelope.allowedTools
    .map(name => ALL_TOOLS[name])
    .filter((t): t is Anthropic.Tool => !!t)

  const userMsg = [
    `Task: ${envelope.goal}`,
    `Return format: ${envelope.returnFormat}`,
    envelope.context.selectedText
      ? `User highlighted: "${envelope.context.selectedText}"`
      : '',
    envelope.context.pageContent
      ? `Page context: "${envelope.context.pageContent.slice(0, 600)}"`
      : '',
  ].filter(Boolean).join('\n')

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  const deadline = Date.now() + envelope.timeout

  for (let turn = 0; turn < envelope.maxTurns; turn++) {
    if (Date.now() > deadline) {
      console.log('[TaskExecutor] deadline exceeded')
      break
    }

    const resp = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: envelope.maxTokens,
      system:     TASK_SYSTEM,
      tools:      tools.length > 0 ? tools : undefined,
      messages,
    })

    console.log(`[TaskExecutor] turn=${turn} stop=${resp.stop_reason}`)

    if (resp.stop_reason === 'end_turn') {
      const block = resp.content.find(b => b.type === 'text')
      return (block as any)?.text?.trim() ?? ''
    }

    if (resp.stop_reason === 'tool_use') {
      const toolBlocks = resp.content.filter(b => b.type === 'tool_use')
      messages.push({ role: 'assistant', content: resp.content })

      const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolBlocks.map(async (b: any): Promise<Anthropic.ToolResultBlockParam> => {
          // Allowlist check
          if (!envelope.allowedTools.includes(b.name)) {
            console.log(`[TaskExecutor] blocked tool=${b.name} (not in allowlist)`)
            return { type: 'tool_result', tool_use_id: b.id, content: 'tool not permitted for this task' }
          }

          // Budget check
          if (b.name in budgets) {
            if (budgets[b.name] <= 0) {
              console.log(`[TaskExecutor] budget exhausted for tool=${b.name}`)
              return { type: 'tool_result', tool_use_id: b.id, content: 'budget exhausted — summarize with what you have' }
            }
            budgets[b.name]--
          }

          console.log(`[TaskExecutor] tool=${b.name} budget_remaining=${budgets[b.name] ?? '∞'}`)

          let content = ''
          if (b.name === 'tavily_search') {
            const res = await tavily.search(b.input.query, 3, 'basic')
            content = res.join('\n') || 'no results'
          } else if (b.name === 'web_fetch') {
            content = await fetchUrl(b.input.url)
          } else {
            content = 'unknown tool'
          }
          return { type: 'tool_result', tool_use_id: b.id, content }
        })
      )

      messages.push({ role: 'user', content: results })
      continue
    }

    break
  }

  // Loop exhausted without end_turn — compress only successful tool outputs, discard garbage
  const JUNK = /budget exhausted|timed out|fetch failed|empty page|tool not permitted|no results/i
  const recovered: string[] = []
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as any[]) {
      if (block.type === 'tool_result' && typeof block.content === 'string' && !JUNK.test(block.content)) {
        recovered.push(block.content.slice(0, 1200))
      }
    }
  }

  if (recovered.length === 0) {
    console.log('[TaskExecutor] forced final: no usable tool output — returning empty')
    return ''
  }

  try {
    const recoveryContext = `You previously retrieved:\n\n${recovered.map((r, i) => `[${i + 1}]\n${r}`).join('\n\n')}`
    const final = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: Math.min(envelope.maxTokens, 2000),
      system:     TASK_SYSTEM,
      messages:   [
        { role: 'user', content: `Task: ${envelope.goal}\nReturn format: ${envelope.returnFormat}` },
        { role: 'user', content: recoveryContext + '\n\nWrite your final answer using ONLY the content above.' },
      ],
    })
    const block = final.content.find(b => b.type === 'text')
    const text  = (block as any)?.text?.trim() ?? ''
    console.log(`[TaskExecutor] forced final answer: "${text.slice(0, 80)}"`)
    return text
  } catch (e: any) {
    console.error('[TaskExecutor] forced final call failed:', e.message?.slice(0, 80))
  }

  return ''
}
