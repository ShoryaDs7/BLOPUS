/**
 * ActivityContext — lightweight rule-based classifier.
 * Uses already-available signals (window title, VS Code events, browser state)
 * to classify what the user is actually doing before ActionRouter fires.
 *
 * No LLM. Pure rules. ~0ms.
 */

export type ActivityType =
  | 'research'       // browser: multiple searches, docs, articles, arxiv
  | 'coding'         // VS Code / Cursor active, diagnostics, edit_loop
  | 'writing'        // Notion, Gmail, Twitter compose, Docs
  | 'watching'       // YouTube video playing
  | 'communication'  // Zoom, Meet, Slack, Discord
  | 'browsing'       // general browser, no clear research pattern
  | 'unknown'

export interface ActivityContext {
  type:          ActivityType
  hasBrowser:    boolean   // user has Chrome/browser in the loop
  hasVSCode:     boolean   // VS Code or Cursor is active or recently active
  isOnCompose:   boolean   // user is on a compose surface
  isResearching: boolean   // multiple searches detected on same topic
}

// Window title patterns → activity type
const CODING_APPS   = /cursor|vs\s?code|visual studio|neovim|vim|sublime|intellij|webstorm|xcode|android studio/i
const COMMS_APPS    = /zoom|google meet|microsoft teams|discord|slack/i
const WRITING_APPS  = /notion|google docs|microsoft word|libreoffice/i
const YOUTUBE_VIDEO = /- youtube/i

// Browser research signals in window title
const SEARCH_ENGINES = /- google search|- bing|- duckduckgo|- reddit search/i
const RESEARCH_SITES = /arxiv|github\.com|stackoverflow|docs\.|developer\.|wikipedia|medium\.com|substack|hackernews|hacker news/i

export function classifyActivity(params: {
  windowTitle:      string
  activeCodeFile:   string   // non-empty = VS Code was recently active
  vsCodeEventAge:   number   // ms since last VS Code signal (0 = never)
  browserTopicCount: number  // how many times this topic appeared in browser
  isOnComposeSurface: boolean
}): ActivityContext {
  const { windowTitle, activeCodeFile, vsCodeEventAge, browserTopicCount, isOnComposeSurface } = params
  const title = windowTitle.toLowerCase()

  const hasVSCode  = !!activeCodeFile || (vsCodeEventAge > 0 && vsCodeEventAge < 10 * 60 * 1000)
  const hasBrowser = /google chrome|firefox|edge|safari|brave/i.test(windowTitle)
    || /youtube|google search|bing|reddit/i.test(windowTitle)

  // Research by trajectory — 3+ visits to same topic overrides everything except coding/comms
  // Must come early: user can be on YouTube/Reddit/any site and still be researching
  if (browserTopicCount >= 3 && !CODING_APPS.test(windowTitle) && !COMMS_APPS.test(windowTitle)) {
    return { type: 'research', hasBrowser: true, hasVSCode, isOnCompose: false, isResearching: true }
  }

  // Coding: VS Code/Cursor is current window OR was active < 10 min ago
  if (CODING_APPS.test(windowTitle)) {
    return { type: 'coding', hasBrowser: false, hasVSCode: true, isOnCompose: false, isResearching: false }
  }

  // Communication
  if (COMMS_APPS.test(windowTitle)) {
    return { type: 'communication', hasBrowser, hasVSCode, isOnCompose: false, isResearching: false }
  }

  // Writing apps
  if (WRITING_APPS.test(windowTitle)) {
    return { type: 'writing', hasBrowser, hasVSCode, isOnCompose: true, isResearching: false }
  }

  // YouTube — only if clearly a video page (has video title, not just YouTube home)
  if (YOUTUBE_VIDEO.test(windowTitle) && !/^\(?\d*\)?\s*youtube\s*-/i.test(windowTitle)) {
    return { type: 'watching', hasBrowser: true, hasVSCode, isOnCompose: false, isResearching: false }
  }

  // Compose surface (Gmail, Twitter, LinkedIn, etc.)
  if (isOnComposeSurface) {
    return { type: 'writing', hasBrowser: true, hasVSCode, isOnCompose: true, isResearching: false }
  }

  // Browser research: trajectory count is the strongest signal
  // 3+ visits to same topic across any sites = research, regardless of current page
  if (browserTopicCount >= 3) {
    return { type: 'research', hasBrowser: true, hasVSCode, isOnCompose: false, isResearching: true }
  }

  // 2 visits + currently on a search engine or known research site = research
  const isResearching = (SEARCH_ENGINES.test(windowTitle) || RESEARCH_SITES.test(windowTitle))
    && browserTopicCount >= 2

  if (isResearching) {
    return { type: 'research', hasBrowser: true, hasVSCode, isOnCompose: false, isResearching: true }
  }

  // General browser but not clear research
  if (hasBrowser) {
    return { type: 'browsing', hasBrowser: true, hasVSCode, isOnCompose: false, isResearching: false }
  }

  return { type: 'unknown', hasBrowser, hasVSCode, isOnCompose: false, isResearching: false }
}

// Which proposal types are valid for each activity type
export function allowedProposalTypes(activity: ActivityContext): Set<string> {
  const allowed = new Set<string>()

  switch (activity.type) {
    case 'research':
      allowed.add('find_article')
      allowed.add('find_video')
      allowed.add('find_discussion')
      allowed.add('find_resource')
      allowed.add('summarize_page')
      allowed.add('compare_options')
      allowed.add('synthesize_research')
      break
    case 'coding':
      allowed.add('find_resource')
      allowed.add('debug_code')
      break
    case 'writing':
      allowed.add('draft_tweet')
      allowed.add('generate_content')
      break
    case 'watching':
      // watching YouTube → don't interrupt with proposals
      break
    case 'communication':
      // in a meeting → never propose
      break
    case 'browsing':
      // general browsing, not clear research → no proposals
      break
    case 'unknown':
      // can't tell → stay silent
      break
  }

  return allowed
}
