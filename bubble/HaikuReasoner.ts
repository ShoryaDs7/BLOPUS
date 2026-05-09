/**
 * HaikuReasoner — infers human intent from behavioral context.
 *
 * Sits between ActionRouter (cheap gate) and proposal push.
 * ActionRouter says: "something is happening, here's a rough signal."
 * Haiku says: "what does this human actually WANT?"
 *
 * Haiku never chooses tools. Only intent + label + goal.
 * Runner mapping happens here in code — Haiku stays out of execution decisions.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { BehavioralSnapshot } from './BehavioralSnapshot'

export type IntentType =
  | 'build'       // user wants to CREATE something
  | 'debug'       // user is stuck on a technical problem
  | 'compare'     // user is evaluating options
  | 'synthesize'  // user consumed a lot, wants distillation
  | 'draft'       // user wants written content (email, post, doc)
  | 'prepare'     // user has something upcoming (meeting, deadline)
  | 'automate'    // user wants a process handled for them
  | 'learn'       // user genuinely wants to understand
  | 'silence'     // no clear actionable intent — stay quiet

export interface IntentResult {
  intent:     IntentType
  label:      string   // proposal card text — a question user would say YES to
  goal:       string   // goal for SessionBrain — actionable, no follow-up needed
  confidence: number
}

// Intent → runner mapping. Haiku never picks tools.
export const INTENT_RUNNER: Record<IntentType, 'session_brain' | 'task_executor'> = {
  build:     'session_brain',
  debug:     'session_brain',
  compare:   'session_brain',
  synthesize: 'task_executor',
  draft:     'session_brain',
  prepare:   'session_brain',
  automate:  'session_brain',
  learn:     'task_executor',
  silence:   'task_executor',
}

const client = new Anthropic()

const SYSTEM_PROMPT = `You analyze behavioral signals to understand what a human ACTUALLY wants — their goal, not their surface.

Output ONLY valid JSON, nothing else:
{
  "intent": "build|debug|compare|synthesize|draft|prepare|automate|learn|silence",
  "label": "Proposal question using the EXACT thing they searched/need. Max 8 words.",
  "goal": "Goal for the executor. Specific, actionable, includes full context. Max 2 sentences. No follow-up questions.",
  "confidence": 0.0-1.0
}

Intent guide:
- build: user wants to CREATE something (pitch deck, website, code, plan, model, tool)
- debug: user is stuck on a technical error or code problem
- compare: user is evaluating multiple options side by side
- synthesize: user consumed a lot of content and needs it distilled into key insights
- draft: user wants written content (email, tweet, post, cover letter, message)
- prepare: user has something upcoming (meeting, call, demo, deadline)
- automate: user wants a repeating task handled or a workflow built
- learn: user genuinely wants to understand — NO artifact needed
- silence: intent unclear, confidence < 0.65, or passive browsing

Label rules — THIS IS CRITICAL:
- Use the EXACT topic from their search/context, not generic words
- BAD: "Ready to draft your landing page copy?"
- GOOD: "Want me to build the landing page for your startup?"
- BAD: "Help with your document?"
- GOOD: "Want me to build a pitch deck for investors?"
- BAD: "Want me to help with this?"
- GOOD: "Want me to build a burn rate calculator?"
- Always start with "Want me to" or "Build" or "Draft" — action-first
- Never say "copy", "content", "material" — say what it IS (landing page, pitch deck, email)

Goal rules:
- Include the specific topic + active app + what they were doing
- Must be actionable without asking the user ANYTHING
- If app is open → mention it: "User has PowerPoint open and is building a pitch deck..."
- Never pick 'learn' when an artifact is clearly wanted
- Use 'silence' if truly unclear`

function buildUserMessage(snapshot: BehavioralSnapshot): string {
  const lines: string[] = [
    `Active app: ${snapshot.activeApp}`,
    `Topic they're focused on: "${snapshot.topic}"`,
    `Behavioral signal: ${snapshot.frictionDescription}`,
  ]

  if (snapshot.visitCount > 1) {
    lines.push(`Pages visited on this topic: ${snapshot.visitCount}`)
  }
  if (snapshot.recentTopics.length > 1) {
    lines.push(`Recent browsing trajectory: ${snapshot.recentTopics.join(' → ')}`)
  }
  if (snapshot.filePath) {
    lines.push(`Active file: ${snapshot.filePath}`)
  }
  if (snapshot.activeCodeFile) {
    lines.push(`Active code file: ${snapshot.activeCodeFile}`)
  }
  if (snapshot.selectedText) {
    lines.push(`Text they highlighted: "${snapshot.selectedText.slice(0, 300)}"`)
  }

  lines.push(`\nWhat does this human actually want? Return JSON only.`)
  return lines.join('\n')
}

export async function reasonIntent(snapshot: BehavioralSnapshot): Promise<IntentResult | null> {
  try {
    const resp = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: buildUserMessage(snapshot) }],
    })

    const raw   = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    const match = raw.match(/\{[\s\S]+\}/)
    if (!match) {
      console.log('[HaikuReasoner] no JSON in response — silence')
      return null
    }

    const parsed = JSON.parse(match[0]) as IntentResult
    if (!parsed.intent || !parsed.label || !parsed.goal) return null
    if (parsed.confidence < 0.65) {
      console.log(`[HaikuReasoner] low confidence (${parsed.confidence.toFixed(2)}) — silence`)
      return null
    }
    if (parsed.intent === 'silence') {
      console.log('[HaikuReasoner] intent=silence')
      return null
    }

    console.log(`[HaikuReasoner] intent=${parsed.intent} conf=${parsed.confidence.toFixed(2)} label="${parsed.label}"`)
    return parsed
  } catch (e) {
    console.error('[HaikuReasoner] error:', (e as Error).message?.slice(0, 80))
    return null
  }
}
