/**
 * BehavioralSnapshot — assembles full behavioral context into one object.
 * Passed to HaikuReasoner so it can infer human intent without reading raw signals.
 */

export interface BehavioralSnapshot {
  topic:              string
  activeApp:          string   // human-readable app name extracted from window title
  windowTitle:        string
  gap:                string
  pattern:            string
  visitCount:         number
  recentTopics:       string[] // last 5 topics from timeline
  frictionDescription: string  // human-readable friction state
  selectedText?:      string
  filePath?:          string
  activeCodeFile?:    string
}

const APP_PATTERNS: [RegExp, string][] = [
  [/microsoft powerpoint/i,       'PowerPoint'],
  [/google slides/i,              'Google Slides'],
  [/keynote/i,                    'Keynote'],
  [/notion/i,                     'Notion'],
  [/gmail|inbox.*gmail/i,         'Gmail'],
  [/cursor/i,                     'Cursor IDE'],
  [/visual studio code/i,         'VS Code'],
  [/figma/i,                      'Figma'],
  [/zoom/i,                       'Zoom'],
  [/slack/i,                      'Slack'],
  [/discord/i,                    'Discord'],
  [/linear/i,                     'Linear'],
  [/jira/i,                       'Jira'],
  [/asana/i,                      'Asana'],
  [/airtable/i,                   'Airtable'],
  [/google docs/i,                'Google Docs'],
  [/microsoft word/i,             'Word'],
  [/google chrome|chrome/i,       'Chrome browser'],
  [/youtube/i,                    'YouTube'],
  [/reddit/i,                     'Reddit'],
  [/github/i,                     'GitHub'],
]

function extractActiveApp(windowTitle: string): string {
  for (const [pattern, name] of APP_PATTERNS) {
    if (pattern.test(windowTitle)) return name
  }
  // Fallback: last segment after " - "
  const parts = windowTitle.split(' - ')
  return parts[parts.length - 1]?.split(' ').slice(0, 3).join(' ') ?? 'unknown'
}

const FRICTION_DESCRIPTIONS: Record<string, string> = {
  confusion_loop:         'repeatedly returning to this topic without it resolving',
  unresolved_exploration: 'searching across multiple sites without finding an answer',
  rapid_switching:        'rapidly switching between pages on this topic',
  prolonged_effort:       'spent a long time on one page without progress',
  repeated_return:        'came back to this same page again',
  repeated:               'visited this topic multiple times this session',
  cross_site:             'researched this across multiple different sites',
  deep_read:              'spent significant time reading about this',
  implementation_gap:     'trying to apply this but getting stuck on execution',
  edit_loop:              'repeatedly editing without reaching a working result',
  error:                  'hitting errors repeatedly',
  terminal_fail:          'terminal command failing',
  general:                'unclear friction — something is not clicking',
}

export function buildSnapshot(params: {
  topic:          string
  windowTitle:    string
  gap:            string
  pattern:        string
  visitCount:     number
  recentTopics:   string[]
  selectedText?:  string
  filePath?:      string
  activeCodeFile?: string
}): BehavioralSnapshot {
  return {
    topic:              params.topic,
    activeApp:          extractActiveApp(params.windowTitle),
    windowTitle:        params.windowTitle,
    gap:                params.gap,
    pattern:            params.pattern,
    visitCount:         params.visitCount,
    recentTopics:       params.recentTopics.slice(-5),
    frictionDescription: FRICTION_DESCRIPTIONS[params.pattern] ?? FRICTION_DESCRIPTIONS[params.gap] ?? 'showing signs of friction',
    selectedText:       params.selectedText,
    filePath:           params.filePath,
    activeCodeFile:     params.activeCodeFile,
  }
}
