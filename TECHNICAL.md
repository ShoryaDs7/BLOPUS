# BLOPUS Bubble — Technical Reference

Full implementation detail for every layer of the Bubble pipeline. All of this is verified against source code in [`bubble/`](bubble/) and [`adapters/control/BubbleBrain.ts`](adapters/control/BubbleBrain.ts).

---

## Three Input Streams

Three independent sources feed AwarenessLayer simultaneously:

**WindowWatcher** (`bubble/windowWatcher.ts`) — polls every 500ms via PowerShell + Win32 `GetForegroundWindow`. Uses UIAutomation to read the actual browser address bar URL, not the tab title. Fires `WindowContext { label, fullUrl }` on every change.

**VS Code / Cursor extension** (`bubble/vscode-extension/`) — `POST /vscode` with event type:
- `edit_loop` — same file opened 3+ times
- `error` — diagnostic appeared in the editor
- `terminal_fail` — command exited non-zero

Two signals within 5 minutes triggers the code path. `terminal_fail` fires immediately on the first hit without waiting for the threshold.

**Browser extension** (`bubble/extension/`) — `POST /browser` with either:
- `selection` — text the user highlighted + extracted page keywords
- `page_load` — full page content on navigation

Feeds compose-surface awareness and topic context into AwarenessLayer.

---

## Signal Processing

AwarenessLayer extracts a clean topic from every window change (`bubble/awarenessLayer.ts`):

- Strips noise from titles: `"how to"`, `"what is"`, `"[D]"`, `"vs"` prefixes, YouTube/Reddit suffixes
- Platform-specific regex for: YouTube (`- YouTube`), Google Search (`- Google Search`), Bing, Reddit search, Reddit threads (`r/sub`), subreddits, arXiv, GitHub, generic articles
- Detected platforms: `youtube` / `google` / `bing` / `reddit` / `github` / `arxiv` / `web`
- Maintains a rolling 30-minute timeline of every page visited (pruned continuously)

Patterns detected over the timeline:

| Pattern | Trigger |
|---------|---------|
| `cross_site` | same topic on 2+ different platforms |
| `repeated` | 3+ hits on the same topic within 30 minutes |
| `deep_read` | 4+ minutes dwell time AND a prior visit to the same page |

---

## FrictionEngine States

FrictionEngine (`bubble/frictionEngine.ts`) scores every signal into a named state with a calibrated confidence:

| State | Trigger | Confidence |
|-------|---------|-----------|
| `unresolved_exploration` | bouncing across 2+ platforms on the same topic | 0.82 |
| `confusion_loop` | 3+ topic hits in 30min | 0.70 – 0.95 (scales with count) |
| `prolonged_effort` | same topic for 15+ minutes | 0.75 |
| `rapid_switching` | high context churn, low dwell per window | 0.73 |
| `repeated_return` | exact same URL visited twice | 0.78 |

Platform diversity boosts confidence — hitting the same topic on YouTube, then Reddit, then arXiv scores higher than three Google hits alone.

---

## Suspicion Gate (Non-Browser Apps)

For apps where WindowWatcher can't read URLs (Notion, Gmail, Figma, PowerPoint, Zoom), a suspicion gate scores the session and fires vision if threshold is crossed:

| Signal | Score |
|--------|-------|
| Known productive app detected | +0.30 |
| Dwell > 3 minutes | +0.25 |
| Dwell > 8 minutes | +0.15 |
| 4+ window switches | +0.20 |
| 7+ window switches | +0.10 |

**Threshold: 0.50** — below it, nothing happens. Above it, `structuredScan()` fires.

---

## Independent Cooldowns

Each layer owns its own cooldown timer. They never block each other:

| Layer | Cooldown |
|-------|---------|
| Awareness nudge | 4 min |
| Friction insight | 6 min |
| BubbleBrain deep answer | 10 min |
| Proposal card (per topic + action type) | 5 min |

---

## ResolutionEngine — Gap Classification

ResolutionEngine (`bubble/resolutionEngine.ts`) classifies every friction signal into a gap type using regex — no LLM:

| Gap type | Keywords |
|----------|---------|
| `concept_boundary` | "vs", "difference", "compare", "which" |
| `definition_gap` | "what is", "definition", "explain", "meaning" |
| `implementation_gap` | "how to", "error", "fix", "debug", "example" |
| `intuition_gap` | 2+ platforms including YouTube |
| `general` | everything else |

---

## Three Racing Paths

Once gap type is known, three paths fire simultaneously. First to return a real answer wins:

**Orchestrator** (`bubble/orchestrator.ts`) — 12s timeout. Builds a gap-targeted Tavily query, calls Haiku with the results, returns 2–3 sentences. Fast, specific, no agent loop.

**BubbleBrain** (`adapters/control/BubbleBrain.ts`) — direct Anthropic API loop, no agent SDK, no MCP servers. Available tools:

`web_fetch` · `tavily_search` · `read_file` · `bash_command` (read-only) · `save_insight` · `read_insights` · `open_url` · `gmail_unread`

Saves findings to `bubble_insights.jsonl`. Returns an empty string if it cannot form a real diagnosis — never hallucinates a proposal.

**Nudge** — one sentence, 10–16 words hard limit. Two types:
- Awareness nudge — surfaced from AwarenessLayer before friction fires
- Friction nudge — after FrictionEngine scores the state

If the sentence isn't worth saying, outputs `SKIP` and stays silent.

---

## HaikuReasoner

HaikuReasoner (`bubble/HaikuReasoner.ts`) runs before any path fires. Classifies intent into one of nine types:

`build` / `debug` / `compare` / `synthesize` / `draft` / `prepare` / `automate` / `learn` / `silence`

Generates a specific proposal label ("Want me to build a burn rate calculator?") and a confidence score.

- Confidence < 0.65 → silence, nothing shown
- `build`, `debug`, `draft`, `prepare`, `automate` → SessionBrain
- `synthesize`, `learn` → TaskExecutor

---

## ActionRouter

ActionRouter (`bubble/ActionRouter.ts`) is rule-based — no LLM. Maps `(topic + gap + pattern + surface)` to one of 13 action types:

`find_video` · `find_article` · `find_discussion` · `find_resource` · `draft_tweet` · `compare_options` · `synthesize_research` · `debug_code` · `generate_content` · `draft_email` · `improve_doc` · `meeting_prep` · `summarize_doc`

Builds a full `TaskEnvelope` before anything executes:

```
goal, runner, allowedTools, toolBudget, maxTurns,
maxTokens, timeout, returnFormat, maxRuntimeMs,
maxToolCalls, requireApproval, context
```

Vision surfaces route by detected `activity` (what the user is doing), not by app name.

---

## ActivityContext — Execution Blocking

ActivityContext (`bubble/ActivityContext.ts`) blocks proposals based on what you're doing:

| Activity | Allowed actions |
|----------|----------------|
| `research` | find_article, find_video, find_discussion, find_resource, summarize_page, compare_options, synthesize_research |
| `coding` | find_resource, debug_code |
| `writing` | draft_tweet, generate_content |
| `watching` | none — all proposals blocked |
| `communication` | none — all proposals blocked |
| `browsing` | none — all proposals blocked |

---

## VS Code Path

A separate lane that bypasses Orchestrator entirely (`bubble/awarenessLayer.ts`):

- Requires 2+ code signals within a 5-minute window
- `terminal_fail` fires immediately on the first hit (threshold = 1, not 2)
- Skips Orchestrator — goes direct to BubbleBrain
- Only surfaces a proposal if BubbleBrain returns a non-empty answer
- Empty string from BubbleBrain = silence, no card shown

---

## IntentEngine — Compose Surfaces

IntentEngine (`bubble/intentEngine.ts`) watches compose surfaces across Gmail, X, LinkedIn, Reddit, Outlook, Notion, Slack.

When the browser extension detects a 300ms pause mid-draft:
- IntentEngine pre-computes a sharper version in the background
- On hover over Send — ghost suggestion appears inline
- On send click — can auto-inject the improved version
- Results cached 60 seconds per compose surface

---

## Vision Flow

Full vision path when the suspicion gate crosses 0.50:

1. Bubble hides via `win.setOpacity(0)` + 180ms compositor flush — never appears in the screenshot
2. `structuredScan()` (`bubble/visionLoop.ts`) takes screenshot, sends to Haiku
3. Returns structured JSON: `{ surface, activity, intent, friction, confidence, contextSnippet }`
4. ActionRouter's `scoreVisionSurface()` routes on `activity`, not on app name
5. State-bound cooldown — same state doesn't re-trigger until it changes
6. Total time: ~5 seconds

Manual vision button in the chat bar follows the same path. `fastVisionAnswer()` in `server.ts` is a single direct Haiku call — no agent loop, result in ~2–3 seconds.

---

## Bubble UI Specs

Electron window (`bubble/main.js`):
- Always-on-top, frameless, transparent
- 320px wide, collapses to 52px pill
- Drag anywhere on screen — anchor position persists across expand/collapse
- Double-ESC resets to bottom-right corner
- Pulsing dot indicates new message or active task
- Ghost suggestions injected directly into compose boxes via browser extension content script
- Thinking bubble: expandable with live step log, color-coded tool dots, stop button
- Stop button kills in-flight fetch via AbortController + signals `/chat/cancel` to abort the agent
