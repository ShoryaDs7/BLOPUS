/**
 * ActionRouter — scores behavioral context and proposes a task.
 * Rule-based, no LLM. Fast. Two execution paths:
 *   task_executor — fast isolated search (< 30s)
 *   session_brain — full agent with all tools (multi-step, file generation, etc.)
 */

import type { VisionSurfaceState } from './visionLoop'

export type IntentCategory =
  | 'research'
  | 'comparison'
  | 'summary'
  | 'coding_help'
  | 'content_creation'
  | 'workflow_setup'
  | 'communication'
  | 'learning'

export interface TaskEnvelope {
  goal:         string
  runner:       'task_executor' | 'session_brain'
  allowedTools: string[]
  toolBudget:   Record<string, number>
  maxTurns:     number
  maxTokens:    number
  timeout:      number
  returnFormat: string
  // Scope caps — session_brain only. Prevent runaway execution.
  maxRuntimeMs?:    number
  maxToolCalls?:    number
  requireApproval?: boolean
  context: {
    topic:           string
    selectedText?:   string
    pageContent?:    string
    pageUrl?:        string
    filePath?:       string
    intentCategory?: IntentCategory
    evidence?:       string[]
  }
}

export interface ActionProposal {
  actionType:  'find_video' | 'find_article' | 'find_discussion' | 'find_resource' | 'draft_tweet'
             | 'compare_options' | 'synthesize_research' | 'debug_code' | 'generate_content'
             | 'draft_email' | 'improve_doc' | 'meeting_prep' | 'summarize_doc'
  label:       string
  envelope:    TaskEnvelope
  confidence:  number
  proposalId:  string
}

export interface RouterInput {
  topic:         string
  gap:           string
  conf:          number
  pattern:       string
  visitCount?:   number    // pages visited on this topic this session
  selectedText?: string
  pageContent?:  string
  pageUrl?:      string
  filePath?:     string
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 9)
}

type Surface = 'youtube' | 'reddit' | 'github' | 'web'

function detectSurface(url: string): Surface {
  if (!url) return 'web'
  if (/youtube\.com|youtu\.be/i.test(url))  return 'youtube'
  if (/reddit\.com/i.test(url))             return 'reddit'
  if (/github\.com/i.test(url))             return 'github'
  return 'web'
}

const COMMON_TYPOS: Record<string, string> = {
  'atten':       'attention',
  'attentiin':   'attention',
  'attnetion':   'attention',
  'mechnaism':   'mechanism',
  'mechansim':   'mechanism',
  'transofrmer': 'transformer',
  'transformre': 'transformer',
  'langauge':    'language',
  'learnign':    'learning',
  'modle':       'model',
  'netowrk':     'network',
  'algorihtm':   'algorithm',
}

function cleanDisplayTopic(raw: string): string {
  const words = raw.trim().toLowerCase().split(/\s+/)
  const fixed = words.map(w => COMMON_TYPOS[w] ?? w)
  if (fixed.length === 0) return raw
  fixed[0] = fixed[0].charAt(0).toUpperCase() + fixed[0].slice(1)
  return fixed.join(' ')
}

// ── Vision surface routing ────────────────────────────────────────────────────
// Routes based on ACTIVITY + INTENT — not surface name.
// Surface is just context passed to the goal. SessionBrain handles any app.
export function scoreVisionSurface(state: VisionSurfaceState): ActionProposal | null {
  const { surface, activity, intent, friction, confidence, contextSnippet } = state
  if (confidence < 0.65) return null

  // Always silent — never interrupt meetings or idle reading
  if (activity === 'in_meeting') return null
  if (activity === 'reading' && friction === 'none') return null

  const snippet  = contextSnippet?.slice(0, 60) ?? ''
  const appLabel = surface === 'other' ? 'current app' : surface

  // ── Composing any message / email (Gmail, Slack, Discord, Superhuman, anything) ─
  if (activity === 'composing_email') {
    return {
      actionType: 'draft_email',
      label:      snippet ? `Help draft this message (${snippet})?` : `Help draft this message in ${appLabel}?`,
      confidence,
      proposalId: makeId(),
      envelope: {
        goal:         `Help draft or improve a message the user is composing in ${appLabel}. Visible context: "${snippet}". Intent: ${intent}. Write a clear, sharp version in the owner's voice.`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: 'Draft only. No meta-commentary.',
        maxRuntimeMs:    3 * 60 * 1000,
        maxToolCalls:    6,
        requireApproval: true,
        context: { topic: snippet || intent || 'message', intentCategory: 'communication', evidence: [`surface:${surface}`, `intent:${intent}`] },
      },
    }
  }

  // ── Writing or editing a document (Notion, Docs, Word, Confluence, Coda, anything) ─
  if (activity === 'writing_doc' || activity === 'editing_doc') {
    const stalled = friction === 'stalled'
    return {
      actionType: stalled ? 'improve_doc' : 'summarize_doc',
      label:      snippet
        ? `${stalled ? 'Improve' : 'Outline'} this doc — "${snippet}"?`
        : `${stalled ? 'Improve' : 'Outline'} this document in ${appLabel}?`,
      confidence,
      proposalId: makeId(),
      envelope: {
        goal:         `${stalled ? 'Improve and sharpen' : 'Create a structured outline for'} a document in ${appLabel}. Context visible: "${snippet}". Intent: ${intent}. ${stalled ? 'Fix structure, tighten prose, fill gaps.' : 'Produce clear section headings with 1-line descriptions.'}`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: stalled ? 'Improved content only.' : 'Outline: headings + 1-line per section.',
        maxRuntimeMs:    3 * 60 * 1000,
        maxToolCalls:    8,
        requireApproval: true,
        context: { topic: snippet || intent || 'document', intentCategory: 'content_creation', evidence: [`surface:${surface}`, `intent:${intent}`] },
      },
    }
  }

  // ── Calendar / meeting context visible on any surface ─────────────────────
  if (surface === 'calendar' || /meeting|call|interview|sync|standup|demo|pitch/i.test(contextSnippet ?? '')) {
    return {
      actionType: 'meeting_prep',
      label:      snippet ? `Prep for "${snippet}"?` : 'Prep for this meeting?',
      confidence,
      proposalId: makeId(),
      envelope: {
        goal:         `Prepare a tight brief for: "${snippet || intent}". Talking points, questions to ask, relevant context. Keep it under 10 bullets.`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: 'Bullets: Talking Points / Questions / Context. Max 10 lines.',
        maxRuntimeMs:    3 * 60 * 1000,
        maxToolCalls:    8,
        requireApproval: true,
        context: { topic: snippet || intent || 'meeting', intentCategory: 'workflow_setup', evidence: [`surface:${surface}`, `intent:${intent}`] },
      },
    }
  }

  // ── Universal fallthrough — any other surface/activity with clear intent ──
  // Surface name doesn't matter. If vision sees something with clear intent,
  // SessionBrain can help. This covers Figma, Linear, Jira, enterprise tools,
  // anything — as long as Haiku extracted a meaningful intent + contextSnippet.
  if (intent && snippet && confidence >= 0.72) {
    return {
      actionType: 'generate_content',
      label:      `Help with "${snippet}" in ${appLabel}?`,
      confidence,
      proposalId: makeId(),
      envelope: {
        goal:         `User is working in ${appLabel}. What they're doing: ${activity}. Their visible context: "${snippet}". Likely intent: ${intent}. Help them move forward — ask nothing, act on what you see.`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: 'Useful output only. No preamble.',
        maxRuntimeMs:    3 * 60 * 1000,
        maxToolCalls:    10,
        requireApproval: true,
        context: { topic: snippet || intent, intentCategory: 'workflow_setup', evidence: [`surface:${surface}`, `activity:${activity}`, `intent:${intent}`] },
      },
    }
  }

  return null
}

// Comparison signals in topic or page content
const COMPARISON_SIGNALS = /\b(vs\.?|versus|compar|alternative|pricing|price|features|review|which\s+is\s+better|best\s+\w+\s+for|top\s+\d)\b/i

// Content/writing signals
const CONTENT_SIGNALS = /\b(blog|article|post|write|draft|essay|newsletter|thread|script|copy|content)\b/i

export function scoreAction(input: RouterInput): ActionProposal | null {
  const { topic, gap, conf, pattern, visitCount = 0, selectedText, pageContent, pageUrl, filePath } = input

  if (!topic) { console.log('[ActionRouter] no topic — skip'); return null }

  const displayTopic = cleanDisplayTopic(topic)
  const surface      = detectSurface(pageUrl ?? '')
  const actionConf   = Math.max(conf, 0.70)
  const selSnippet   = selectedText
    ? ` The user is focused on: "${selectedText.slice(0, 200)}"`
    : ''

  // ── debug_code: implementation gap + file context → session_brain ──────────
  if (gap === 'implementation_gap' && filePath) {
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath
    return {
      actionType: 'debug_code',
      label:      `Debug the issue in "${fileName}"?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Debug the issue in ${filePath} related to "${topic}". Read the file, identify the root cause, propose a specific code fix with exact line changes. Do not modify files without asking.`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: 'Root cause + exact fix. Show the lines to change. No preamble.',
        maxRuntimeMs:    5 * 60 * 1000,
        maxToolCalls:    25,
        requireApproval: true,
        context: { topic, filePath, intentCategory: 'coding_help', evidence: ['implementation_gap', 'file_context'] },
      },
    }
  }

  // ── draft_tweet: expression gap + highlighted text ─────────────────────────
  if (gap === 'expression' && (selectedText?.length ?? 0) > 60) {
    return {
      actionType: 'draft_tweet',
      label:      `Draft a tweet about "${displayTopic}"?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Draft a tweet about "${topic}" based on what the user highlighted: "${selectedText!.slice(0, 400)}"`,
        runner:       'task_executor',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     1,
        maxTokens:    400,
        timeout:      8000,
        returnFormat: 'One tweet under 240 chars. No explanation, no quotes around it.',
        context: { topic, selectedText: selectedText?.slice(0, 500), intentCategory: 'content_creation' },
      },
    }
  }

  // ── generate_content: content creation signal + selected text ─────────────
  if (CONTENT_SIGNALS.test(topic) && (selectedText?.length ?? 0) > 40) {
    return {
      actionType: 'generate_content',
      label:      `Draft content about "${displayTopic}"?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Draft content about "${topic}" based on what the user is working on: "${selectedText?.slice(0, 400) ?? topic}". Write in the owner's natural voice. Output only the content.`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: 'The drafted content only. No meta-commentary.',
        maxRuntimeMs:    3 * 60 * 1000,
        maxToolCalls:    10,
        requireApproval: true,
        context: { topic, selectedText: selectedText?.slice(0, 500), intentCategory: 'content_creation' },
      },
    }
  }

  // ── find_resource: knowledge gap + VS Code file context ───────────────────
  if (gap === 'knowledge' && filePath) {
    return {
      actionType: 'find_resource',
      label:      `Find docs for "${displayTopic}"?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Find the official documentation or best technical resource for "${topic}". File: ${filePath}`,
        runner:       'task_executor',
        allowedTools: ['tavily_search', 'web_fetch'],
        toolBudget:   { tavily_search: 2, web_fetch: 2 },
        maxTurns:     3,
        maxTokens:    4000,
        timeout:      20000,
        returnFormat: 'Best documentation link + 2-sentence explanation. No preamble.',
        context: { topic, pageUrl, filePath, intentCategory: 'coding_help' },
      },
    }
  }

  // ── Research gaps ──────────────────────────────────────────────────────────
  const isResearchGap = gap === 'general' || gap === 'intuition_gap' || gap === 'concept_boundary'
    || gap === 'definition_gap' || gap === 'implementation_gap'

  if (!isResearchGap) return null

  // compare_options: comparison signals + cross_site or high visitCount
  const hasComparisonSignal = COMPARISON_SIGNALS.test(topic)
  const isComparisonPattern = pattern === 'cross_site' || visitCount >= 4

  if (hasComparisonSignal && isComparisonPattern) {
    const compLabel = visitCount >= 4
      ? `Compare the ${displayTopic} options you've been researching?`
      : `Compare pricing and features of ${displayTopic} options?`
    return {
      actionType: 'compare_options',
      label:      compLabel,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Research and compare "${topic}" options. Find top 3-5 options. For each: name, pricing (if applicable), key features, best suited for, verdict. Return a clean structured comparison. No files needed.`,
        runner:       'session_brain',
        allowedTools: [],
        toolBudget:   {},
        maxTurns:     0,
        maxTokens:    0,
        timeout:      0,
        returnFormat: 'Comparison table: option | price | key features | best for | verdict. Then one-line final recommendation.',
        maxRuntimeMs:    5 * 60 * 1000,
        maxToolCalls:    20,
        requireApproval: true,
        context: {
          topic, pageContent: pageContent?.slice(0, 800), pageUrl,
          intentCategory: 'comparison',
          evidence: [
            hasComparisonSignal ? 'comparison keywords detected' : '',
            pattern === 'cross_site' ? 'visited across multiple sites' : '',
            visitCount >= 4 ? `${visitCount} pages on this topic` : '',
          ].filter(Boolean),
        },
      },
    }
  }

  // synthesize_research: deep research loop — distill everything visited
  if (visitCount >= 6 && (pattern === 'cross_site' || pattern === 'repeated' || pattern === 'confusion_loop')) {
    return {
      actionType: 'synthesize_research',
      label:      `Synthesize ${visitCount} pages of research on "${displayTopic}" into key insights?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Synthesize the research session on "${topic}". Do targeted web research, then produce: (1) 4-5 key insights, (2) main tensions or open debates, (3) one concrete recommended next step.${selSnippet}`,
        runner:       'task_executor',
        allowedTools: ['tavily_search'],
        toolBudget:   { tavily_search: 3 },
        maxTurns:     4,
        maxTokens:    5000,
        timeout:      25000,
        returnFormat: '3 sections: Key Insights / Tensions / Next Step. Tight bullets. No preamble.',
        context: {
          topic, selectedText: selectedText?.slice(0, 400), pageUrl,
          intentCategory: 'summary',
          evidence: [`${visitCount} pages visited`, pattern],
        },
      },
    }
  }

  // Surface-aware search — YouTube / Reddit / web / github
  if (surface === 'youtube') {
    return {
      actionType: 'find_video',
      label:      `Find the best YouTube video on "${displayTopic}"?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Find the 3 best YouTube videos about "${topic}" that explain it clearly.${selSnippet}`,
        runner:       'task_executor',
        allowedTools: ['tavily_search'],
        toolBudget:   { tavily_search: 2 },
        maxTurns:     3,
        maxTokens:    3000,
        timeout:      20000,
        returnFormat: '3 bullets: video title + channel name + youtube.com URL + 1 sentence why it\'s the best for this topic. No preamble.',
        context: { topic, selectedText: selectedText?.slice(0, 400), pageUrl, intentCategory: 'learning' },
      },
    }
  }

  if (surface === 'reddit') {
    return {
      actionType: 'find_discussion',
      label:      `Find the top Reddit discussion on "${displayTopic}"?`,
      confidence: actionConf,
      proposalId: makeId(),
      envelope: {
        goal:         `Find the best Reddit thread or discussion about "${topic}".${selSnippet}`,
        runner:       'task_executor',
        allowedTools: ['tavily_search', 'web_fetch'],
        toolBudget:   { tavily_search: 2, web_fetch: 2 },
        maxTurns:     3,
        maxTokens:    3000,
        timeout:      20000,
        returnFormat: '2-3 bullets: subreddit + post title + reddit.com URL + key takeaway from the thread. No preamble.',
        context: { topic, selectedText: selectedText?.slice(0, 400), pageUrl, intentCategory: 'research' },
      },
    }
  }

  // Default: find best article
  return {
    actionType: 'find_article',
    label:      `Find the best article on "${displayTopic}"?`,
    confidence: actionConf,
    proposalId: makeId(),
    envelope: {
      goal:         `Find the best recent (2023-2025) article or paper about "${topic}".${selSnippet}`,
      runner:       'task_executor',
      allowedTools: ['tavily_search', 'web_fetch'],
      toolBudget:   { tavily_search: 2, web_fetch: 3 },
      maxTurns:     4,
      maxTokens:    5000,
      timeout:      25000,
      returnFormat: '3 bullet points: title + 1-sentence key insight + URL. No preamble.',
      context: { topic, selectedText: selectedText?.slice(0, 500), pageContent: pageContent?.slice(0, 800), pageUrl, intentCategory: 'research' },
    },
  }
}
