import fs   from 'fs'
import path from 'path'

export interface GlobalEvent {
  ts:        string   // ISO timestamp
  platform:  string   // 'x' | 'reddit' | 'discord' | 'threads' | 'telegram' | 'goal'
  type:      string   // 'post' | 'reply' | 'quote' | 'goal_session' | 'dm'
  text:      string   // truncated to 120 chars
  topic?:    string
  replyTo?:  string   // handle replied to
}

function getLogPath(): string {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  return path.join(path.dirname(path.resolve(configPath)), 'global_events.jsonl')
}

export function appendEvent(event: Omit<GlobalEvent, 'ts'>): void {
  try {
    const entry: GlobalEvent = {
      ts: new Date().toISOString(),
      ...event,
      text: event.text.slice(0, 120),
    }
    fs.appendFileSync(getLogPath(), JSON.stringify(entry) + '\n', 'utf-8')
  } catch {
    // never crash an agent over a log write
  }
}

export function readRecentEvents(n: number): GlobalEvent[] {
  try {
    const file = getLogPath()
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-n)
    return lines.map(l => JSON.parse(l) as GlobalEvent)
  } catch {
    return []
  }
}

export function formatEventsBlock(events: GlobalEvent[]): string {
  if (!events.length) return ''
  const lines = events.map(e => {
    const date = e.ts.slice(0, 10)
    const reply = e.replyTo ? ` → @${e.replyTo}` : ''
    const topic = e.topic ? ` [${e.topic}]` : ''
    return `- ${date} [${e.platform}] ${e.type}${reply}${topic}: "${e.text}"`
  })
  return `# Recent activity across all platforms (read before acting — do not repeat, use for context)\n${lines.join('\n')}`
}
