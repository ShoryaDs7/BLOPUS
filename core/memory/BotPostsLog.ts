import fs   from 'fs'
import path from 'path'

export interface BotPostEntry {
  timestamp:  string
  writtenBy:  'blopus'
  platform:   string
  type:       'original_post' | 'reply' | 'quote_tweet'
  tweetId?:   string
  text:       string
  topic?:     string
  replyToHandle?: string
  replyToText?:   string
}

function getLogPath(): string {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  return path.join(path.dirname(path.resolve(configPath)), 'bot_posts.jsonl')
}

export function logBotPost(entry: Omit<BotPostEntry, 'timestamp' | 'writtenBy'>): void {
  try {
    const line: BotPostEntry = {
      timestamp: new Date().toISOString(),
      writtenBy: 'blopus',
      ...entry,
    }
    fs.appendFileSync(getLogPath(), JSON.stringify(line) + '\n', 'utf-8')
  } catch {
    // never crash the agent over a log write
  }
}
