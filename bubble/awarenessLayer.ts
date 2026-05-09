import Anthropic                              from '@anthropic-ai/sdk'
import { TavilyClient }                      from '../adapters/search/TavilyClient'
import { recordTopic, getRecentTopics }      from './bubbleContext'
import { detectFriction, type FrictionState } from './frictionEngine'
import { resolveGap, type GapType, type ResolutionSignal } from './resolutionEngine'
import { Orchestrator }    from './orchestrator'
import { BubbleBrain }     from '../adapters/control/BubbleBrain'
import { startVisionLoop } from './visionLoop'
import { getBrowserContext, pushProposal } from './server'
import { isSilencedByReputation } from './reputationStore'
import { scoreAction }                      from './ActionRouter'
import { classifyActivity, allowedProposalTypes } from './ActivityContext'
import { buildSnapshot }                    from './BehavioralSnapshot'
import { reasonIntent, INTENT_RUNNER }      from './HaikuReasoner'
import type { WindowContext } from './windowWatcher'

// Relevance check: does stored selection relate to current friction topic?
// Uses stemmed token overlap — no embeddings needed.
function stemWord(w: string): string {
  return w.replace(/ing$|tion$|ers?$|ies$|[sz]$/, '').toLowerCase()
}
function selectionIsRelevant(selectedTopic: string[], frictionTopic: string): boolean {
  if (selectedTopic.length === 0) return false
  const frictionTokens = frictionTopic.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .map(stemWord)
  const matches = frictionTokens.filter(t => selectedTopic.some(s => s.includes(t) || t.includes(s)))
  return matches.length > 0 || selectedTopic.some(s => frictionTopic.toLowerCase().includes(s))
}

// Each layer owns its own cooldown — they never block each other
const AWARENESS_NUDGE_COOLDOWN = 4  * 60 * 1000   // observational nudge: 4 min
const FRICTION_NUDGE_COOLDOWN  = 6  * 60 * 1000   // friction insight: 6 min
const DEEP_ANSWER_COOLDOWN     = 10 * 60 * 1000   // BubbleBrain / orchestrator: 10 min
const PROPOSAL_COOLDOWN        = 5  * 60 * 1000   // proposal card: 5 min per topic+action
const SESSION_WINDOW     = 30 * 60 * 1000
const DWELL_THRESHOLD    = 4  * 60 * 1000
const REPEAT_TRIGGER     = 2
const HISTORY_LOOKBACK   = 2  * 60 * 60 * 1000

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'this','that','these','those','what','which','who','where','when','why','how',
  'and','but','or','so','yet','for','nor','at','by','from','in','on','to','up','with',
  'not','no','nor','never','can','may','let','get','got','put','set','try','use',
  'all','just','even','very','also','too','then','than','now','out','off','per',
  'any','its','our','own','few','two','vs','via','ago','old','way','day','time',
  'new','best','top','good','great','free','full','video','watch','read','learn',
  'google','chrome','youtube','firefox','edge','safari','browser','microsoft',
  'search','tab','results','home','feed','explore',
  'exploration','detailed','analysis','overview','tutorial','chapter',
  'lecture','introduction','explanation','complete','everything','beginners',
  'works','using','makes','about','based','behind','between','through',
  'dive','deep','part','series','episode','section','module','unit',
  'documentation','course','guide','explained','simply','easily','quickly',
  // action verbs that leak into topic prefixes
  'discuss','discusses','discussed','discussing',
  'explain','explains','understand','understanding','understood',
  'explore','exploring','explores','review','reviews','reviewing',
  'compare','compares','comparing','show','shows','showing','shown',
  'build','builds','building','implement','implementing','implements',
  // adjective modifiers that win primaryKeyword over nouns
  'accurate','precise','simple','complex','advanced','basic','clear',
  'common','popular','modern','general','specific','similar','different',
])

const GARBAGE_TOPICS = /^(home|news|today|now|latest|update|results|search|page|site|web|www|com|youtube|google|reddit|twitter|github|restore|pages)$/i

interface ActivityEntry {
  timestamp: number
  label:     string
  fullUrl:   string
  topic:     string
  platform:  string
  confident: boolean
}

const timeline:       ActivityEntry[]          = []
const topicPlatforms: Map<string, Set<string>> = new Map()
const suggestedUrls:  Set<string>              = new Set()
// Layer-owned cooldowns — independent, never block each other
let lastAwarenessNudgeAt = 0                          // awareness layer owns this
const lastFrictionNudgeAt = new Map<string, number>() // friction layer: keyed by topic
const lastDeepAnswerAt    = new Map<string, number>() // BubbleBrain/orchestrator: keyed by topic
const lastProposalAt      = new Map<string, number>() // proposal layer: keyed by topic+actionType
let   lastEntry:      ActivityEntry | null     = null
let   lastEntryAt    = 0

const tavily       = new TavilyClient()
const ai           = new Anthropic()
const orchestrator = new Orchestrator()
const bubbleBrain  = new BubbleBrain()

// ── Router ────────────────────────────────────────────────────────────────────
type RouteDecision = 'silence' | 'orchestrate' | 'orchestrate_plus_brain'

function route(conf: number, gap: GapType): RouteDecision {
  if (gap === 'general' || conf < 0.80) return 'silence'
  if (conf >= 0.90)                     return 'orchestrate_plus_brain'
  return 'orchestrate'
}

// ── Platform detection ────────────────────────────────────────────────────────
function getPlatform(urlOrTitle: string): string {
  try {
    const h = new URL(urlOrTitle).hostname
    if (h.includes('youtube.com'))                         return 'youtube'
    if (h.includes('google.'))                             return 'google'
    if (h.includes('bing.com'))                            return 'bing'
    if (h.includes('reddit.com'))                          return 'reddit'
    if (h.includes('github.com'))                          return 'github'
    if (h.includes('arxiv.org'))                           return 'arxiv'
    if (h.includes('twitter.com') || h.includes('x.com')) return 'twitter'
    return 'web'
  } catch {}
  const t = urlOrTitle.toLowerCase()
  if (t.includes('- youtube'))       return 'youtube'
  if (t.includes('- google search')) return 'google'
  if (t.includes('- bing'))          return 'bing'
  if (t.includes('reddit'))          return 'reddit'
  if (t.includes('github'))          return 'github'
  if (t.includes('arxiv'))           return 'arxiv'
  return 'web'
}

// ── Topic extraction ──────────────────────────────────────────────────────────
function cleanTopic(raw: string): string {
  return raw
    .replace(/^\[[^\]]{1,30}\]\s*/g, '')   // strip leading [Tag] like [Discussion], [D], [Question]
    .replace(/^(how\s+to|what\s+is|what\s+are|what\s+was|how\s+do(es)?\s+(a|an|the|i|you|it)\s+|why\s+(is|does|did|do)\s+|can\s+(a|an|the|i|you)\s+|does\s+(a|an|the|it|this)\s+|do\s+(a|an|the|you|i)\s+|is\s+(it|a|an|the)\s+|should\s+(i|you|we)\s+|will\s+(a|an|the|it)\s+|is\s+there\s+)\s*/i, '')
    .replace(/[_+%20|:,!?]+/g, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 3)
    .join(' ')
    .trim()
}

function stem(w: string): string {
  return w
    .replace(/ers$/, 'er')
    .replace(/ies$/, 'y')
    .replace(/ing$/, '')
    .replace(/tion$/, '')
    .replace(/[sz]$/, '')
}

function primaryKeyword(topic: string): string {
  const raw = topic.split(/\s+/).filter(w => w.length >= 5 && !STOP_WORDS.has(w))
  const stemmed = raw.map(w => stem(w)).filter(w => w.length >= 4)
  if (stemmed.length === 0) return topic.split(/\s+/).find(w => w.length >= 4) ?? topic.slice(0, 10)
  // Sort: longer stemmed word wins; ties broken by position (later = more likely noun)
  return stemmed.sort((a, b) => b.length - a.length || stemmed.indexOf(b) - stemmed.indexOf(a))[0]
}

// Set-overlap topic similarity — "agents clearly" and "agents work" both contain "agent"
// Use this instead of primaryKeyword equality for counting related timeline entries
function topicWords(topic: string): Set<string> {
  return new Set(
    topic.split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
      .map(stem)
      .filter(w => w.length >= 4)
  )
}

function topicsOverlap(a: string, b: string): boolean {
  const wa = topicWords(a)
  if (wa.size === 0) return false
  const wb = topicWords(b)
  return Array.from(wa).some(w => wb.has(w))
}

const NON_BROWSER = /cursor|vs\s*code|visual studio|notepad|task manager|powershell|cmd|terminal|postman|figma|zoom/i

function extractTopic(ctx: WindowContext): { topic: string; confident: boolean; pageTitle: string } {
  if (ctx.fullUrl) {
    try {
      const u  = new URL(ctx.fullUrl)
      const sq = u.searchParams.get('search_query')
      if (sq) return { topic: cleanTopic(sq), confident: true, pageTitle: sq }
      const q  = u.searchParams.get('q')
      if (q)  return { topic: cleanTopic(q),  confident: true, pageTitle: q }
      const rm = u.pathname.match(/\/r\/([^/]+)/)
      if (rm) return { topic: rm[1].toLowerCase(), confident: true, pageTitle: rm[1] }
    } catch {}
  }

  const raw = ctx.label
  if (NON_BROWSER.test(raw)) return { topic: '', confident: false, pageTitle: '' }

  // Chrome permission dialogs: "site.com wants to..." — not a real page
  if (/wants\s+to\b/i.test(raw)) return { topic: '', confident: false, pageTitle: '' }

  // URL-as-title: page still loading, Chrome shows raw URL as window title
  if (/^[a-z0-9-]+\.[a-z]{2,}\//.test(raw.toLowerCase())) return { topic: '', confident: false, pageTitle: '' }

  const clean = raw.replace(/^\(\d+\)\s*/, '').trim()

  const ytMatch = clean.match(/^(.+?)\s*-\s*YouTube(?:\s*-\s*.+)?$/i)
  if (ytMatch) return { topic: cleanTopic(ytMatch[1]), confident: true, pageTitle: ytMatch[1].trim() }

  const gMatch = clean.match(/^(.+?)\s*-\s*Google Search(?:\s*-\s*.+)?$/i)
  if (gMatch) return { topic: cleanTopic(gMatch[1]), confident: true, pageTitle: gMatch[1].trim() }

  const bMatch = clean.match(/^(.+?)\s*-\s*Bing(?:\s*-\s*.+)?$/i)
  if (bMatch) return { topic: cleanTopic(bMatch[1]), confident: true, pageTitle: bMatch[1].trim() }

  // Reddit search: "world models - Reddit Search!" or "world models - Search - Reddit"
  const rdSearchMatch = clean.match(/^(.+?)\s*-\s*(?:Reddit\s*Search|Search\s*-\s*Reddit)/i)
  if (rdSearchMatch) return { topic: cleanTopic(rdSearchMatch[1]), confident: true, pageTitle: rdSearchMatch[1].trim() }

  // Reddit thread: "Post title here : r/subreddit" — extract post title, not subreddit name
  const rdThreadMatch = clean.match(/^(.+?)\s*:\s*r\/[a-zA-Z0-9_]+/i)
  if (rdThreadMatch) return { topic: cleanTopic(rdThreadMatch[1]), confident: true, pageTitle: rdThreadMatch[1].trim() }

  // Reddit subreddit listing: just "r/subreddit" as the whole title
  const rMatch = clean.match(/^r\/([a-zA-Z0-9_]+)/i)
  if (rMatch) return { topic: rMatch[1].toLowerCase(), confident: true, pageTitle: rMatch[1] }

  // Generic article — strip | site separators AND " - Site - Browser" suffixes
  const stripped = clean
    .replace(/\s*\|\s*.+$/, '')
    .replace(/\s*-\s*(Google Chrome|Mozilla Firefox|Microsoft Edge|Safari|Brave)$/i, '')
    .replace(/\s*-\s*[^-]{2,40}$/, '')
    .trim()
  const topic = cleanTopic(stripped)
  const words = topic.split(' ').filter(Boolean)
  return { topic, confident: words.length >= 2, pageTitle: stripped }
}

function isUselessTopic(topic: string): boolean {
  if (!topic || topic.length < 4) return true
  if (GARBAGE_TOPICS.test(topic.trim())) return true
  const words = topic.split(' ')
  if (words.length === 1 && words[0].length < 6) return true
  return false
}

// ── Pattern detection ─────────────────────────────────────────────────────────
function pruneTimeline() {
  const cutoff = Date.now() - SESSION_WINDOW
  let i = 0
  while (i < timeline.length && timeline[i].timestamp < cutoff) i++
  if (i > 0) {
    const removed = timeline.splice(0, i)
    for (const e of removed) {
      const k   = primaryKeyword(e.topic)
      const set = topicPlatforms.get(k)
      if (set) { set.delete(e.platform); if (set.size === 0) topicPlatforms.delete(k) }
    }
  }
}

function checkPatterns(topic: string, dwellMs: number): 'cross_site' | 'repeated' | 'deep_read' | null {
  if (isUselessTopic(topic)) return null
  pruneTimeline()
  const key       = primaryKeyword(topic)
  const platforms = topicPlatforms.get(key)
  const count     = timeline.filter(e => topicsOverlap(e.topic, topic)).length
  if ((platforms?.size ?? 0) >= 2)              return 'cross_site'
  if (count >= REPEAT_TRIGGER)                  return 'repeated'
  if (dwellMs >= DWELL_THRESHOLD && count >= 1) return 'deep_read'
  return null
}

// ── Awareness cognition — observational ──────────────────────────────────────
const COGNITION_SYSTEM = `You watch someone browse and occasionally say one thing.

Output: ONE sentence. 10–16 words max. No more.

Tone: perceptive friend. Not assistant. Not therapist. Not search engine.

Hard rules:
- Never start with: "I", "It", "You appear", "It seems", "Looks like", "Here's", "This is"
- Never explain your reasoning
- Never justify why you're saying something
- Never mention that you noticed something — just say it
- No links unless the resource given is genuinely different from what they have open

Good examples:
"this is where attention either clicks or stays confusing forever"
"you've moved past the intro level — architecture details are next"
"the encoder-decoder framing is the part most explanations skip over"

Bad examples (never do this):
"You're already deep in technical docs, so a course link would just create another tab"
"It seems like you're exploring this topic across multiple sources"

If nothing sharp to say: reply SKIP only.`

// ── Friction cognition — intent-aware ────────────────────────────────────────
const FRICTION_COGNITION_SYSTEM = `You watch someone browse and you know when they're stuck.

Output: ONE sentence. 10–16 words max. No more.

Tone: a friend who's been stuck on the same thing and found what actually unlocked it.
Not a teacher. Not a therapist. Someone handing you the thing that worked for them.

Hard rules:
- Never describe their behavior back to them
- Never say "you seem", "you appear", "I notice", "you're bouncing", "you're switching"
- Never explain what you're doing or why
- Never be motivational or corrective
- Give the unlock — the specific thing that resolves it — not an observation about the pattern

Good examples:
"the visual intuition is the unlock — the math only clicks after that"
"most explanations skip query/key/value as routing — that's the part that makes it land"
"the intuition layer is what's missing, not more examples"
"the answer is usually one level up from where you're reading"
"come back to this after you've written a small version yourself"

Bad examples (never do this):
"you're bouncing between explanations when you need to build one thing"
"pick one and sit with the confusion — the switching is the problem"
"you keep coming back here"

If nothing useful to say: reply SKIP only.`

// ── Haiku: awareness nudge ────────────────────────────────────────────────────
async function generateNudge(ctx: {
  pageTitle:    string
  currentUrl:   string
  pattern:      string
  topic:        string
  recentTopics: string[]
  dwellMin:     number
  resource:     { title: string; url: string } | null
}): Promise<string | null> {
  const patternDesc = ctx.pattern === 'cross_site'
    ? 'searched this across YouTube and Google, now reading an article'
    : ctx.pattern === 'repeated'
    ? 'returned to this topic multiple times in the past 30 minutes'
    : `spent ${ctx.dwellMin} minutes on this page`

  const userMsg = [
    `Current page: "${ctx.pageTitle}"`,
    `What they've been doing: ${patternDesc}`,
    ctx.recentTopics.length > 1
      ? `Recent trajectory: ${ctx.recentTopics.slice(0, 4).join(' → ')}`
      : '',
    ctx.resource && ctx.resource.url !== ctx.currentUrl
      ? `Potentially relevant resource (use only if it adds something): "${ctx.resource.title}" → ${ctx.resource.url}`
      : '',
  ].filter(Boolean).join('\n')

  try {
    const resp = await ai.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system:     COGNITION_SYSTEM,
      messages:   [{ role: 'user', content: userMsg }],
    })
    let text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    if (!text) return null
    if (/^skip$/i.test(text)) return null
    text = text.replace(/^skip[\s\n\r]+/i, '').trim()
    if (!text) return null
    return text
  } catch (e) {
    console.error('[AwarenessLayer] Haiku error:', e)
    return null
  }
}

// ── Haiku: friction nudge ─────────────────────────────────────────────────────
const GAP_FRAMING: Record<GapType, string> = {
  concept_boundary:   'inferred gap: conceptual boundary between two things is unclear — give the one-line distinction that separates them',
  definition_gap:     'inferred gap: user cannot pin down what this IS — give the core definition in the most concrete terms possible',
  intuition_gap:      'inferred gap: explanations not clicking — give the visual or physical intuition, not the formal definition',
  implementation_gap: 'inferred gap: user understands concept but stuck applying it — give the specific thing that is probably wrong or missing',
  general:            'inferred gap: unclear — give the most commonly missing insight for this topic',
}

async function generateFrictionNudge(ctx: {
  pageTitle:     string
  topic:         string
  state:         FrictionState
  resolution:    ResolutionSignal
  recentTopics:  string[]
  resource:      { title: string; url: string } | null
  selectedText?: string
  pageContent?:  string
}): Promise<string | null> {
  const stateDesc: Record<FrictionState, string> = {
    confusion_loop:         'returned to this topic repeatedly without it resolving',
    unresolved_exploration: 'searched this across YouTube, Google, Reddit — still bouncing',
    rapid_switching:        'rapidly switching between pages on this topic',
    prolonged_effort:       'spent a long time on this page without moving forward',
    repeated_return:        'came back to this exact page again',
  }

  const userMsg = [
    `Topic: "${ctx.topic}"`,
    `Current page: "${ctx.pageTitle}"`,
    `Friction: ${stateDesc[ctx.state]}`,
    GAP_FRAMING[ctx.resolution.gap],
    ctx.recentTopics.length > 1
      ? `Recent trajectory: ${ctx.recentTopics.slice(0, 4).join(' → ')}`
      : '',
    ctx.selectedText
      ? `User highlighted: "${ctx.selectedText.slice(0, 400)}"`
      : '',
    ctx.pageContent && !ctx.selectedText
      ? `Page context: "${ctx.pageContent.slice(0, 400)}"`
      : '',
    ctx.resource
      ? `Resource: "${ctx.resource.title}" → ${ctx.resource.url}`
      : '',
  ].filter(Boolean).join('\n')

  try {
    const resp = await ai.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system:     FRICTION_COGNITION_SYSTEM,
      messages:   [{ role: 'user', content: userMsg }],
    })
    let text = resp.content[0]?.type === 'text' ? resp.content[0].text.trim() : ''
    if (!text || /^skip$/i.test(text)) return null
    text = text.replace(/^skip[\s\n\r]+/i, '').trim()
    return text || null
  } catch (e) {
    console.error('[AwarenessLayer] friction Haiku error:', e)
    return null
  }
}

// ── Surface suspicion tracking ────────────────────────────────────────────────
// Runs on every window context update (before topic check).
// When a known productive app is detected but topic is unclear, tracks dwell +
// switch frequency → fires structuredScan once score crosses threshold.
interface AppDwell { app: string; enteredAt: number }

let   currentAppDwell:    AppDwell | null = null
const recentSwitchTimes:  number[]        = []   // timestamps of window changes
const SWITCH_TRACK_WINDOW = 5 * 60 * 1000        // 5 min window for switch counting
const SUSPICION_THRESHOLD = 0.50

// State-bound cooldown: don't re-fire vision for same {surface, activity}
// Reset when state changes — not time-based
let   lastVisionState:    string                  = ''   // "surface::activity"
const lastVisionGateAt    = new Map<string, number>()    // per surface, hard floor only
const VISION_HARD_FLOOR   = 8 * 60 * 1000               // never fire same surface < 8 min

// Known productive non-browser apps that need vision to understand
const NON_BROWSER_SURFACE = /gmail|inbox|compose|notion|slack|figma|zoom|discord|docs\.google|sheets\.google|calendar\.google|linear|jira|asana|airtable|microsoft word|excel|powerpoint|keynote/i

function computeSuspicionScore(windowTitle: string, dwellMs: number): number {
  let score = 0
  if (NON_BROWSER_SURFACE.test(windowTitle)) score += 0.30
  if (dwellMs > 3 * 60 * 1000)              score += 0.25
  if (dwellMs > 8 * 60 * 1000)              score += 0.15
  const now    = Date.now()
  const recent = recentSwitchTimes.filter(t => now - t < SWITCH_TRACK_WINDOW).length
  if (recent >= 4) score += 0.20
  if (recent >= 7) score += 0.10
  return Math.min(score, 1.0)
}

// ── VS Code signal state ──────────────────────────────────────────────────────
interface VSCodeSignal {
  event:         'edit_loop' | 'error' | 'terminal_fail' | 'file_open'
  file?:         string
  language?:     string
  line?:         number
  message?:      string
  exit_code?:    number
  terminal_name?: string
}

// Tracks active code context — updated by VS Code extension signals
let activeCodeFile:     string = ''
let activeCodeLanguage: string = ''
let lastCodeFrictionAt  = 0
const CODE_FRICTION_COOLDOWN = 10 * 60 * 1000   // 10 min between code friction fires

// Code-friction signals (trigger → skip Orchestrator, go direct to BubbleBrain)
const CODE_FRICTION_EVENTS = new Set(['edit_loop', 'error', 'terminal_fail'])

// Confidence gating — prevent single transient errors from triggering BubbleBrain
// Per-file signal counter resets after 5 min of silence
const codeSignalCount = new Map<string, { count: number; lastTs: number }>()
const CODE_SIGNAL_WINDOW  = 5 * 60 * 1000   // signals older than 5 min don't count
const CODE_SIGNAL_THRESHOLD = 2              // need 2+ signals on same file to fire
// Exception: terminal_fail is always intentional — fires immediately at threshold 1

// ── Vision escalation state ───────────────────────────────────────────────────
// visionLoop initialized inside startAwarenessLayer so it shares the push fn.
// Fires only when frictionEngine already confirmed stuck + gap is unclear.
// Time-alone is NOT a trigger — that produces false positives during deep work.

const VISION_COOLDOWN = 60 * 1000    // 60s between screenshots

// ── Public API ────────────────────────────────────────────────────────────────
export interface AwarenessLayer {
  onContext:      (ctx: WindowContext) => void
  onVSCodeSignal: (signal: VSCodeSignal) => void
}

export function startAwarenessLayer(push: (msg: string) => void): AwarenessLayer {
  console.log('[AwarenessLayer] started. Tavily:', tavily.enabled ? 'enabled' : 'no key')

  // ── Vision loop — escalation only, not always-on ─────────────────────────
  const visionLoop = startVisionLoop(push)
  let lastVisionAt = 0

  function tryFireVision(windowTitle: string, reason: string): void {
    const now = Date.now()
    if (now - lastVisionAt < VISION_COOLDOWN) {
      console.log(`[Vision] cooldown active — skip escalation (${reason})`)
      return
    }
    lastVisionAt = now
    console.log(`[Vision] escalation fire: ${reason} — "${windowTitle.slice(0, 60)}"`)
    visionLoop.updateContext(windowTitle)
    visionLoop.triggerScreenshot().catch(e =>
      console.error('[Vision] screenshot error:', (e as Error).message?.slice(0, 60))
    )
  }

  function maybePropose(params: {
    topic:       string
    gap:         string
    conf:        number
    pattern:     string
    cogCtx:      { selectedText?: string; pageContent?: string }
    url:         string
    windowTitle: string
    filePath?:   string
    visitCount?: number
  }): void {
    const { topic, gap, conf, pattern, cogCtx, url, windowTitle, filePath } = params
    const now = Date.now()

    // If pattern engine already confirmed repeated/cross_site, the user is researching —
    // don't recompute from scratch with the current topic (which may be a typo or variant).
    // Trust the pattern signal directly.
    // Both awareness patterns and friction states confirm research behavior
    const RESEARCH_SIGNALS = new Set([
      'repeated', 'cross_site', 'deep_read',
      'confusion_loop', 'unresolved_exploration', 'rapid_switching', 'prolonged_effort', 'repeated_return',
    ])
    const confirmedResearch = RESEARCH_SIGNALS.has(pattern)
    const resolvedVisitCount = params.visitCount ?? (confirmedResearch
      ? 4
      : timeline.filter(e => topicsOverlap(e.topic, topic)).length)
    const browserTopicCount = resolvedVisitCount

    // Classify current activity
    const activity = classifyActivity({
      windowTitle,
      activeCodeFile,
      vsCodeEventAge:     activeCodeFile ? now - lastCodeFrictionAt : 0,
      browserTopicCount,
      isOnComposeSurface: false,
    })

    const allowed = allowedProposalTypes(activity)
    console.log(`[ActivityContext] type=${activity.type} allowed=${Array.from(allowed).join(',') || 'none'}`)

    // Prefer browser context URL (real URL) over window title for surface detection
    const bc2       = getBrowserContext()
    const surfaceUrl = bc2.pageUrl || url
    const proposal = scoreAction({ topic, gap, conf, pattern, visitCount: browserTopicCount,
      selectedText: cogCtx.selectedText, pageContent: cogCtx.pageContent, pageUrl: surfaceUrl,
      filePath })

    if (!proposal) {
      console.log('[ActionRouter] no proposal scored')
      return
    }

    // Check activity allows this proposal type
    if (!allowed.has(proposal.actionType)) {
      console.log(`[ActionRouter] blocked — activity=${activity.type} does not allow ${proposal.actionType}`)
      return
    }

    // Per-(topic+actionType) cooldown check
    const cooldownKey = `${primaryKeyword(topic)}::${proposal.actionType}`
    const lastAt      = lastProposalAt.get(cooldownKey) ?? 0
    if (now - lastAt < PROPOSAL_COOLDOWN) {
      console.log(`[ActionRouter] cooldown active for ${cooldownKey}`)
      return
    }

    // Reputation check — go quiet if user dismissed this topic 3+ times this session
    if (isSilencedByReputation(primaryKeyword(topic))) {
      console.log(`[ActionRouter] silenced by reputation for topic="${primaryKeyword(topic)}"`)
      return
    }

    lastProposalAt.set(cooldownKey, now)

    // ── Haiku intent reasoner — replaces ActionRouter's hardcoded label + goal ──
    // ActionRouter is the cheap gate (should we escalate?).
    // Haiku decides the actual human intent and shapes the goal for SessionBrain.
    const snapshot = buildSnapshot({
      topic,
      windowTitle,
      gap,
      pattern,
      visitCount:    browserTopicCount,
      recentTopics:  timeline.slice(-6).map(e => e.topic),
      selectedText:  cogCtx.selectedText,
      filePath,
      activeCodeFile: activeCodeFile || undefined,
    })

    // Run async — don't block onContext. Cooldown already set above.
    reasonIntent(snapshot).then(intent => {
      if (!intent) {
        console.log('[HaikuReasoner] silence — no proposal pushed')
        return
      }
      // Use Haiku's label + goal. Keep ActionRouter's runner structure as base,
      // override runner based on intent type, override goal with Haiku's.
      const enrichedEnvelope = {
        ...proposal.envelope,
        goal:   intent.goal,
        runner: INTENT_RUNNER[intent.intent] as 'session_brain' | 'task_executor',
      }
      console.log(`[HaikuReasoner] pushing intent=${intent.intent} label="${intent.label}"`)
      pushProposal(intent.label, enrichedEnvelope, proposal.proposalId)
    }).catch(e => {
      // Haiku failed — fall back to ActionRouter's original proposal
      console.warn('[HaikuReasoner] failed, falling back to ActionRouter proposal:', (e as Error).message?.slice(0, 60))
      pushProposal(proposal.label, proposal.envelope, proposal.proposalId)
    })
  }

  async function onContext(ctx: WindowContext): Promise<void> {
    const now                              = Date.now()
    const url                              = ctx.fullUrl ?? ctx.label
    const platform                         = getPlatform(url)
    const { topic, confident, pageTitle }  = extractTopic(ctx)

    // Always keep vision context current so screenshots reflect the active window
    visionLoop.updateContext(ctx.label)

    console.log(`[AwarenessLayer] url=${ctx.label.slice(0,60)} topic="${topic}" confident=${confident}`)

    // ── App dwell + switch tracking (always, before early return) ──────────────
    if (currentAppDwell?.app !== ctx.label) {
      recentSwitchTimes.push(now)
      // Prune old entries outside tracking window
      while (recentSwitchTimes.length && now - recentSwitchTimes[0] > SWITCH_TRACK_WINDOW) {
        recentSwitchTimes.shift()
      }
      currentAppDwell = { app: ctx.label, enteredAt: now }
    }

    // ── Suspicion gate — fires vision when productive surface but unclear topic ─
    if (isUselessTopic(topic) || !confident) {
      const dwellMs  = currentAppDwell ? now - currentAppDwell.enteredAt : 0
      const suspicion = computeSuspicionScore(ctx.label, dwellMs)
      if (suspicion >= SUSPICION_THRESHOLD) {
        const surfaceKey = ctx.label.slice(0, 30)
        const lastGate   = lastVisionGateAt.get(surfaceKey) ?? 0
        if (now - lastGate > VISION_HARD_FLOOR) {
          lastVisionGateAt.set(surfaceKey, now)
          console.log(`[SuspicionGate] score=${suspicion.toFixed(2)} dwell=${Math.round(dwellMs/1000)}s switches=${recentSwitchTimes.filter(t=>now-t<SWITCH_TRACK_WINDOW).length} → firing vision`)
          // Async — doesn't block onContext
          ;(async () => {
            try {
              const { structuredScan }    = await import('./visionLoop')
              const { scoreVisionSurface } = await import('./ActionRouter')
              const visionState = await structuredScan(ctx.label)
              if (!visionState) return

              // State-bound cooldown: skip if same surface+activity as last vision fire
              const stateKey = `${visionState.surface}::${visionState.activity}`
              if (stateKey === lastVisionState) {
                console.log(`[SuspicionGate] same state (${stateKey}) — skip`)
                return
              }
              lastVisionState = stateKey

              const proposal = scoreVisionSurface(visionState)
              if (!proposal) return

              // Reputation + per-topic cooldown (same as maybePropose)
              const topicKey    = visionState.surface
              const cooldownKey = `${topicKey}::${proposal.actionType}`
              const lastAt      = lastProposalAt.get(cooldownKey) ?? 0
              if (now - lastAt < PROPOSAL_COOLDOWN) {
                console.log(`[SuspicionGate] proposal cooldown active for ${cooldownKey}`)
                return
              }
              if (isSilencedByReputation(topicKey)) {
                console.log(`[SuspicionGate] silenced by reputation for surface="${topicKey}"`)
                return
              }
              lastProposalAt.set(cooldownKey, now)
              console.log(`[SuspicionGate] vision proposal="${proposal.label}"`)
              pushProposal(proposal.label, proposal.envelope, proposal.proposalId)
            } catch (e) {
              console.error('[SuspicionGate] error:', (e as Error).message?.slice(0, 80))
            }
          })()
        }
      }
      return
    }

    const dwellMs = lastEntry ? now - lastEntryAt : 0
    const pattern = lastEntry ? checkPatterns(lastEntry.topic, dwellMs) : null

    const entry: ActivityEntry = { timestamp: now, label: ctx.label, fullUrl: url, topic, platform, confident }
    timeline.push(entry)
    const key = primaryKeyword(topic)
    if (!topicPlatforms.has(key)) topicPlatforms.set(key, new Set())
    topicPlatforms.get(key)!.add(platform)

    lastEntry   = entry
    lastEntryAt = now
    recordTopic(topic)

    // ── Friction path (priority) ──────────────────────────────────────────────
    const frictionSignal = detectFriction({
      topic,
      currentUrl:    url,
      dwellMs,
      timeline,
      topicCount:    timeline.filter(e => topicsOverlap(e.topic, topic)).length,
      platformCount: topicPlatforms.get(key)?.size ?? 0,
    })

    if (frictionSignal) {
      const recentLabels = timeline
        .filter(e => primaryKeyword(e.topic) === key)
        .map(e => e.label)
        .slice(-5)

      const resolution = resolveGap({
        topic,
        pageTitle,
        frictionState: frictionSignal.state,
        recentLabels,
        platforms: Array.from(topicPlatforms.get(key) ?? []),
      })

      console.log(`[AwarenessLayer] friction=${frictionSignal.state} resolution=${resolution.gap} topic="${topic}"`)

      // general gap = can't tell from window titles alone
      if (resolution.gap === 'general') {
        const bc = getBrowserContext()
        const hasBrowserContent = !!(bc.selectedText || bc.pageContent)
        // Lower threshold when browser content exists — no guessing, actual page text available
        const deepThreshold = hasBrowserContent ? 0.72 : 0.82
        if (frictionSignal.confidence >= deepThreshold) {
          if (hasBrowserContent) {
            // Browser content available — BubbleBrain reads actual page text, skip vision
            console.log(`[AwarenessLayer] gap=general conf=${frictionSignal.confidence.toFixed(2)} + browser content → BubbleBrain`)
            const generalKey    = primaryKeyword(topic)
            const lastFriction0 = lastFrictionNudgeAt.get(generalKey) ?? 0
            if (now - lastFriction0 < FRICTION_NUDGE_COOLDOWN) {
              console.log('[AwarenessLayer] friction cooldown active')
              return
            }
            lastFrictionNudgeAt.set(generalKey, now)
            const selRel = selectionIsRelevant(bc.selectedTopic, topic)
            bubbleBrain.resolveDeep({
              topic, pageTitle, gap: 'general', frictionState: frictionSignal.state,
              recentTopics: getRecentTopics(HISTORY_LOOKBACK),
              ...(selRel && bc.selectedText ? { selectedText: bc.selectedText } : {}),
              ...(bc.pageContent ? { pageContent: bc.pageContent } : {}),
            })
              .then(ans => { if (ans) { console.log(`[BubbleBrain] general+content → "${ans.slice(0,100)}"`) ; push(ans) } })
              .catch(e  => console.error('[BubbleBrain] general path error:', (e as Error).message?.slice(0,80)))

            // Proposal card — activity-gated, per-topic cooldown
            const cogCtxGeneral = {
              selectedText: selRel && bc.selectedText ? bc.selectedText : undefined,
              pageContent:  bc.pageContent || undefined,
            }
            maybePropose({ topic, gap: 'general', conf: frictionSignal.confidence,
              pattern: frictionSignal.state, cogCtx: cogCtxGeneral, url: bc.pageUrl || url, windowTitle: ctx.label })
          } else {
            // No browser content — vision as fallback + proposal card
            console.log(`[AwarenessLayer] gap=general conf=${frictionSignal.confidence.toFixed(2)} → vision escalation`)
            tryFireVision(pageTitle, 'friction but gap unclear')
            maybePropose({ topic, gap: 'general', conf: frictionSignal.confidence,
              pattern: frictionSignal.state, cogCtx: {}, url: bc.pageUrl || url, windowTitle: ctx.label })
          }
        } else {
          console.log('[AwarenessLayer] gap=general — waiting for clearer signal')
        }
        return
      }

      const topicKey       = primaryKeyword(topic)
      const lastFriction   = lastFrictionNudgeAt.get(topicKey) ?? 0
      const lastDeep       = lastDeepAnswerAt.get(topicKey) ?? 0
      if (now - lastFriction < FRICTION_NUDGE_COOLDOWN) {
        console.log(`[AwarenessLayer] friction cooldown active for topic="${topicKey}"`)
        return
      }

      lastFrictionNudgeAt.set(topicKey, now)

      try {
        const recentTopics = getRecentTopics(HISTORY_LOOKBACK)

        // ── Assemble cognition context once — shared by all paths ────────────
        const bc          = getBrowserContext()
        const selRelevant = selectionIsRelevant(bc.selectedTopic, topic)
        const cogCtx = {
          selectedText: selRelevant && bc.selectedText ? bc.selectedText : undefined,
          pageContent:  bc.pageContent || undefined,
        }

        const decision = route(frictionSignal.confidence, resolution.gap)

        if (decision === 'orchestrate' || decision === 'orchestrate_plus_brain') {
          // ── Fast path: Orchestrator — search + synthesize < 5s ───────────────
          console.log(`[Router] decision=${decision} friction=${frictionSignal.state} gap=${resolution.gap} conf=${frictionSignal.confidence.toFixed(2)}`)
          const result = await orchestrator.resolve({
            topic, pageTitle,
            frictionState: frictionSignal.state,
            resolution,
            recentTopics,
          })

          if (result) {
            console.log(`[Orchestrator] action=${result.action} latency=${result.latencyMs}ms → "${result.answer.slice(0, 100)}"`)
            push(result.answer)
          } else {
            console.log('[Orchestrator] failed — deep path will cover')
          }

          // ── Deep path: BubbleBrain async — goes deeper, saves memory ─────────
          if (decision === 'orchestrate_plus_brain') {
            bubbleBrain.resolveDeep({
              topic, pageTitle, gap: resolution.gap, frictionState: frictionSignal.state, recentTopics,
              ...cogCtx,
            })
              .then(deeper => {
                if (deeper) {
                  console.log(`[BubbleBrain] deeper → "${deeper.slice(0, 100)}"`)
                  push(deeper)
                }
              })
              .catch(e => console.error('[BubbleBrain] deep path error:', e.message?.slice(0, 80)))
          }

          // Proposal card — activity-gated, per-topic cooldown
          maybePropose({ topic, gap: resolution.gap, conf: frictionSignal.confidence,
            pattern: frictionSignal.state, cogCtx, url, windowTitle: ctx.label })

          if (result || decision === 'orchestrate_plus_brain') return
          console.log('[Orchestrator] failed — falling back to nudge')
        }

        // ── Nudge path — fallback or low-confidence ───────────────────────────
        let resource: { title: string; url: string } | null = null
        if (tavily.enabled) {
          const found = await tavily.findResource(topic)
          if (found && !suggestedUrls.has(found.url) && found.url !== url) {
            resource = found
            suggestedUrls.add(found.url)
          }
        }

        const nudge = await generateFrictionNudge({
          pageTitle, topic,
          state:      frictionSignal.state,
          resolution,
          recentTopics,
          resource,
          ...cogCtx,
        })

        if (!nudge) {
          console.log('[AwarenessLayer] friction Haiku returned SKIP')
          return
        }
        console.log(`[AwarenessLayer] friction nudge → "${nudge.slice(0, 100)}"`)
        push(nudge)

        // Proposal card — activity-gated, per-topic cooldown
        maybePropose({ topic, gap: resolution.gap, conf: frictionSignal.confidence,
          pattern: frictionSignal.state, cogCtx, url, windowTitle: ctx.label })
      } catch (e) {
        console.error('[AwarenessLayer] friction error:', e)
      }
      return
    }

    // ── Awareness path (fallback) ─────────────────────────────────────────────
    if (!pattern) return
    if (now - lastAwarenessNudgeAt < AWARENESS_NUDGE_COOLDOWN) {
      console.log('[AwarenessLayer] pattern hit but awareness cooldown active')
      return
    }

    console.log(`[AwarenessLayer] FIRE pattern=${pattern} topic="${topic}"`)
    lastAwarenessNudgeAt = now

    try {
      let resource: { title: string; url: string } | null = null
      if (tavily.enabled) {
        const found = await tavily.findResource(topic)
        if (found && !suggestedUrls.has(found.url) && found.url !== url) {
          resource = found
          suggestedUrls.add(found.url)
        }
      }

      const recentTopics = getRecentTopics(HISTORY_LOOKBACK)
      const nudge = await generateNudge({
        pageTitle,
        currentUrl: url,
        pattern,
        topic,
        recentTopics,
        dwellMin:   Math.round(dwellMs / 60_000),
        resource,
      })

      if (!nudge) {
        console.log('[AwarenessLayer] Haiku returned SKIP — staying silent')
        return
      }

      console.log(`[AwarenessLayer] nudge → "${nudge.slice(0, 100)}"`)
      push(nudge)

      // Proposal card — awareness path also gets one
      const bc = getBrowserContext()
      maybePropose({
        topic, gap: 'general', conf: 0.72, pattern,
        cogCtx: { pageContent: bc.pageContent || undefined },
        url, windowTitle: ctx.label,
      })
    } catch (e) {
      console.error('[AwarenessLayer] nudge error:', e)
    }
  }

  // ── VS Code signal handler ──────────────────────────────────────────────────
  async function onVSCodeSignal(signal: VSCodeSignal): Promise<void> {
    // file_open = awareness only, never triggers BubbleBrain
    if (signal.event === 'file_open') {
      if (signal.file)     activeCodeFile     = signal.file
      if (signal.language) activeCodeLanguage = signal.language
      return
    }

    // code-friction signals: edit_loop, error, terminal_fail
    if (!CODE_FRICTION_EVENTS.has(signal.event)) return

    const now = Date.now()
    if (now - lastCodeFrictionAt < CODE_FRICTION_COOLDOWN) {
      console.log('[AwarenessLayer] code friction cooldown active')
      return
    }

    if (signal.file)     activeCodeFile     = signal.file
    if (signal.language) activeCodeLanguage = signal.language

    const fileKey  = signal.file ?? activeCodeFile ?? ''
    // terminal_fail with no file context is noise (e.g. killing bubble itself) — ignore
    if (!fileKey && signal.event === 'terminal_fail') {
      console.log('[AwarenessLayer] terminal_fail with no file context — ignoring')
      return
    }
    const fileName = fileKey ? fileKey.split(/[\\/]/).slice(-1)[0] : signal.terminal_name ?? 'terminal'
    const topic    = fileName.replace(/\.[^.]+$/, '')

    // Confidence gating: single transient error → don't fire immediately
    // terminal_fail always fires (intentional action), others need 2+ signals
    const existing = codeSignalCount.get(fileKey)
    const isRecent = existing && (now - existing.lastTs) < CODE_SIGNAL_WINDOW
    const count    = isRecent ? existing.count + 1 : 1
    codeSignalCount.set(fileKey, { count, lastTs: now })

    const threshold = signal.event === 'terminal_fail' ? 1 : CODE_SIGNAL_THRESHOLD
    if (count < threshold) {
      console.log(`[AwarenessLayer] code signal ${signal.event} count=${count}/${threshold} — waiting for confirmation`)
      return
    }

    // Reset counter after firing so next session starts fresh
    codeSignalCount.set(fileKey, { count: 0, lastTs: now })

    const resolution: ResolutionSignal = { gap: 'implementation_gap', confidence: 0.85 }
    console.log(`[AwarenessLayer] code friction confirmed event=${signal.event} file=${fileName} signals=${count}`)
    lastCodeFrictionAt = now

    // Build context for BubbleBrain — VS Code is trigger only, BubbleBrain validates
    const bc = getBrowserContext()
    const selRel = selectionIsRelevant(bc.selectedTopic, topic)
    const frictionCtx = {
      topic,
      pageTitle:    signal.message ?? `${signal.event} in ${fileName}`,
      gap:          resolution.gap,
      frictionState: signal.event as FrictionState,
      recentTopics: getRecentTopics(HISTORY_LOOKBACK),
      ...(signal.file                        ? { filePath:     signal.file      } : {}),
      ...(signal.line                        ? { line:         signal.line      } : {}),
      ...(selRel && bc.selectedText          ? { selectedText: bc.selectedText  } : {}),
      ...(bc.pageContent                     ? { pageContent:  bc.pageContent   } : {}),
    }

    // Skip Orchestrator for code friction — go direct to BubbleBrain
    // Proposal only fires if BubbleBrain found something real — no false alarms
    console.log(`[BubbleBrain] firing deep path for ${fileName}`)
    bubbleBrain.resolveDeep(frictionCtx)
      .then(answer => {
        if (answer) {
          console.log(`[BubbleBrain] code answer → "${answer.slice(0, 100)}"`)
          push(answer)
          maybePropose({
            topic, gap: resolution.gap, conf: resolution.confidence, pattern: signal.event,
            cogCtx: {
              selectedText: selRel && bc.selectedText ? bc.selectedText : undefined,
              pageContent:  bc.pageContent || undefined,
            },
            url: '', windowTitle: `VS Code — ${fileName}`,
            filePath: signal.file ?? activeCodeFile ?? undefined,
          })
        } else {
          console.log('[BubbleBrain] returned empty — chose silence, no proposal')
        }
      })
      .catch(e => console.error('[BubbleBrain] code friction error:', e.message?.slice(0, 80)))
  }

  return {
    onContext:      (ctx)    => { onContext(ctx).catch(() => {}) },
    onVSCodeSignal: (signal) => { onVSCodeSignal(signal).catch(() => {}) },
  }
}
