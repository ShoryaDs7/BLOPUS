/**
 * WizardBrain — Claude API as OsBot's brain.
 *
 * This is what makes OsBot intelligent. Instead of fixed /commands,
 * the owner can say anything and OsBot understands and acts.
 *
 * Examples:
 *   "post more tech content this week" → adjusts posting topics
 *   "how many replies did you send today?" → checks memory stats
 *   "mute yourself for 2 hours" → mutes OsBot
 *   "my exams start Monday, go 40% educational posts" → updates config
 *   "what servers are you in on Discord?" → lists joined servers
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { MemoryEngine } from '../../core/memory/MemoryEngine'
import { MoodEngine } from '../../core/personality/MoodEngine'
import { XTools, X_TOOL_DEFINITIONS } from './XTools'
import { UserContext } from './UserContext'
import { RelationshipMemory } from '../../core/memory/RelationshipMemory'
import { getBiographyContext } from '../../core/memory/OwnerBiography'
import { PersonMemoryStore } from '../../core/memory/PersonMemoryStore'
import { OwnerPostIndex } from '../../core/memory/OwnerPostIndex'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are OsBot, an autonomous AI agent managing the user's digital presence.
You run 24/7 posting on X (Twitter), joining Discord servers, and engaging on Reddit — all on behalf of your owner.

You talk like a smart, direct friend. Not robotic. Not formal. Short sentences.

ACTION RULES — when owner says these, call the tool immediately. No asking for confirmation. No hesitation. Just do it:
- "reply to trending [topic/tech/AI/crypto]" → call search_trending_and_reply(category, count=1, reply_angle="builder perspective")
- "go to trending [section] and reply" → call search_trending_and_reply
- "reply to tweets about [X]" → call search_and_reply
- "post a tweet about [X]" → call post_tweet
- "quote tweet something" → call quote_tweet_from_feed
- "pause/mute for N hours" → call control_autonomous
- "change mood to [X]" → update mood

IMPORTANT: You have a working search_trending_and_reply tool that fetches real trending tweets and posts a reply. When the owner says anything about trending section + reply — USE IT immediately. Do not say you can't. Do not ask for confirmation. Fire the tool and report back what you did with the exact tweet you replied to.

MEMORY RULE: When the user tells you anything about their life, schedule, goals, or ongoing context — call save_context immediately. This is how you remember across sessions.

HISTORY RULE:
- search_my_posts: "what did I post on Nov 19?", "when did I launch my SDK?", "what was my first tweet?" → use this tool
- search_person_memory: "who is @handle?", "what did @someone say?" → use this tool

browse_x is ONLY for real-time tasks no other tool covers: viewing a live profile, checking notifications.

Keep responses short — this is a chat, not an essay.`

// Tool Claude uses to search the owner's raw post history
const SEARCH_MY_POSTS_TOOL: Anthropic.Tool = {
  name: 'search_my_posts',
  description: 'Search through every post, reply, and tweet the owner has ever made — exact dates, exact text. Use this for ANY question about their post history: "what was my first post", "what did I post on Nov 19", "when did I launch my SDK", "what did I tweet about agents", "what did I post last month". Do NOT use browse_x for these — the full history is stored locally.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query — can be a date ("Nov 19 2025", "January 2026"), a keyword ("SDK", "agents", "game"), or a phrase ("first post", "launch").',
      },
    },
    required: ['query'],
  },
}

// Tool Claude uses to look up a specific person's full conversation history
const SEARCH_PERSON_MEMORY_TOOL: Anthropic.Tool = {
  name: 'search_person_memory',
  description: 'Look up everything stored about a specific person OR search across all people by topic. Use this when asked: "who is @handle?", "how many times has @handle talked about X?", "what did @handle say?", "who talks about AI with me?", "find everyone who mentioned crypto", "what do I know about @handle?". This loads the full conversation history — every message, both sides, exact dates, topics.',
  input_schema: {
    type: 'object' as const,
    properties: {
      handle: {
        type: 'string',
        description: 'The @handle to look up (without @). Leave empty to search across all people.',
      },
      topic: {
        type: 'string',
        description: 'Optional: filter by topic keyword (e.g. "AI", "crypto", "startup"). If handle is given, filters their conversations. If no handle, finds all people who talked about this topic.',
      },
    },
    required: [],
  },
}

// Tool Claude uses to save facts about the user
const SAVE_CONTEXT_TOOL: Anthropic.Tool = {
  name: 'save_context',
  description: 'Save important context the user shared — schedule, life events, ongoing projects, goals, instructions. Call this any time the user shares something you should remember for future conversations.',
  input_schema: {
    type: 'object' as const,
    properties: {
      fact: { type: 'string', description: 'The key fact, written concisely in third person. e.g. "User has exams starting next week, domain shifting to exam content"' },
      category: {
        type: 'string',
        enum: ['personal', 'schedule', 'work', 'instruction', 'goal'],
        description: 'personal=life events, schedule=time-bound plans, work=projects/startup, instruction=how OsBot should behave, goal=what user is working towards',
      },
      expires_days: { type: 'number', description: 'Days until this fact expires. Use for time-bound things (exams=21, meeting=7). Omit for permanent facts.' },
    },
    required: ['fact', 'category'],
  },
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export class WizardBrain {
  private history = new Map<string, Message[]>()
  private memory: MemoryEngine
  private moodEngine: MoodEngine
  private configPath: string
  private xTools: XTools | null = null
  private userContext: UserContext
  private relationshipMemory: RelationshipMemory
  private postIndex: OwnerPostIndex
  private personMemory: PersonMemoryStore

  constructor(memory: MemoryEngine, moodEngine: MoodEngine, configPath: string) {
    this.memory = memory
    this.moodEngine = moodEngine
    this.configPath = configPath
    this.userContext = new UserContext(configPath)
    this.relationshipMemory = new RelationshipMemory(configPath)
    const memStoreDir = path.join(path.dirname(path.resolve(configPath)), '../memory-store')
    this.postIndex = new OwnerPostIndex(memStoreDir)
    this.personMemory = new PersonMemoryStore(memStoreDir)
    this.loadHistory()
  }

  // Called by the agent to wire in X capabilities
  setXTools(xTools: XTools): void {
    this.xTools = xTools
  }

  getUserContext(): UserContext {
    return this.userContext
  }

  async process(userId: string, text: string): Promise<string> {
    if (!this.history.has(userId)) {
      this.history.set(userId, this.loadUserHistory(userId))
    }
    const msgs = this.history.get(userId)!

    msgs.push({ role: 'user', content: text })
    const recentMsgs = msgs.slice(-20)
    const context = this.buildContext()
    const userContextBlock = this.userContext.toPromptBlock()

    // If the message mentions a specific @handle, inject their full person memory (not just score)
    const mentionedHandles = [...text.matchAll(/@([\w]+)/g)].map(m => m[1].toLowerCase())
    const specificRelBlocks: string[] = []
    for (const h of mentionedHandles) {
      const deepContext = this.personMemory.getContextForClaude(h, 10)
      if (deepContext) {
        specificRelBlocks.push(deepContext)
      } else {
        // Fallback to relationship score if no deep memory yet
        const rel = this.relationshipMemory.getRelationship(h)
        if (rel) {
          specificRelBlocks.push(
            `\n--- @${h} ---\n` +
            `score: ${rel.score} | interactions: ${rel.totalInteractions} | conversations: ${rel.conversationCount}\n` +
            `first seen: ${new Date(rel.firstSeenAt).toLocaleDateString('en-IN')} | last seen: ${new Date(rel.lastSeenAt).toLocaleDateString('en-IN')}\n` +
            (rel.highlights.length ? `history: ${rel.highlights.join(' | ')}` : 'no history yet')
          )
        }
      }
    }

    const systemPrompt = SYSTEM_PROMPT
      + '\n\nCurrent OsBot state:\n' + context
      + (specificRelBlocks.length ? specificRelBlocks.join('\n') : '')
      + (userContextBlock ? '\n\n' + userContextBlock : '')

    try {
      const allTools = [
        SAVE_CONTEXT_TOOL,
        SEARCH_MY_POSTS_TOOL,
        SEARCH_PERSON_MEMORY_TOOL,
        ...(this.xTools ? X_TOOL_DEFINITIONS : []),
      ]

      // Claude tool-use loop — keeps running until Claude stops calling tools
      const allMessages: Anthropic.MessageParam[] = [...recentMsgs]
      let finalReply = ''

      while (true) {
        const response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          system: systemPrompt,
          tools: allTools,
          messages: allMessages,
        })

        // If Claude wants to call tools
        if (response.stop_reason === 'tool_use') {
          allMessages.push({ role: 'assistant', content: response.content })

          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const block of response.content) {
            if (block.type !== 'tool_use') continue

            if (block.name === 'save_context') {
              const inp = block.input as { fact: string; category: string; expires_days?: number }
              this.userContext.addFact(inp.fact, inp.category as any, inp.expires_days)
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'context saved' })
              continue
            }

            if (block.name === 'search_my_posts') {
              const inp = block.input as { query: string }
              const result = this.postIndex.search(inp.query)
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
              continue
            }

            if (block.name === 'search_person_memory') {
              const inp = block.input as { handle?: string; topic?: string }
              let result = ''

              if (inp.handle) {
                const h = inp.handle.replace(/^@/, '').toLowerCase()
                // Load full conversation history
                const deepCtx = this.personMemory.getContextForClaude(h, 999)
                if (deepCtx) {
                  // If topic filter, also annotate how many conversations match
                  if (inp.topic) {
                    const mem = this.personMemory.load(h)
                    if (mem) {
                      const kw = inp.topic.toLowerCase()
                      const matching = mem.conversations.filter(c =>
                        c.topic.toLowerCase().includes(kw) ||
                        c.messages.some(m => m.text.toLowerCase().includes(kw))
                      )
                      result = `@${h} — ${matching.length} conversation(s) about "${inp.topic}" out of ${mem.conversationCount} total\n\n`
                      result += matching.map(c => {
                        const date = new Date(c.startedAt).toDateString()
                        const msgs = c.messages.map(m => `  ${m.by === 'owner' ? 'You' : `@${h}`}: "${m.text.slice(0, 150)}"`)
                        return `[${date} — ${c.topic}]\n${msgs.join('\n')}`
                      }).join('\n\n')
                      if (matching.length === 0) result += deepCtx  // show all if nothing matches
                    } else {
                      result = deepCtx
                    }
                  } else {
                    result = deepCtx
                  }
                } else {
                  // Try relationship fallback
                  const rel = this.relationshipMemory.getRelationship(h)
                  result = rel
                    ? `No deep conversation history for @${h} yet.\nScore: ${rel.score} | Interactions: ${rel.totalInteractions}\n${rel.highlights.join('\n')}`
                    : `No data found for @${h}.`
                }
              } else if (inp.topic) {
                // Cross-person topic search
                const matches = this.personMemory.searchByTopic(inp.topic)
                if (matches.length === 0) {
                  result = `No one found who talked about "${inp.topic}".`
                } else {
                  result = `People who talked about "${inp.topic}" with you (${matches.length} found):\n\n` +
                    matches.slice(0, 20).map(e =>
                      `@${e.handle}: score=${e.score}, ${e.totalInteractions} interactions, topics=[${e.topics.join(', ')}], personality=${e.theirPersonality}`
                    ).join('\n')
                }
              } else {
                result = 'Provide a handle or topic to search.'
              }

              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
              continue
            }

            if (this.xTools) {
              console.log(`[WizardBrain] Tool call: ${block.name}`)
              const result = await this.xTools.execute(block.name, block.input as Record<string, any>)
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result })
            }
          }

          allMessages.push({ role: 'user', content: toolResults })
          continue
        }

        // Claude is done — get the text response
        const textBlock = response.content.find(b => b.type === 'text')
        finalReply = textBlock && textBlock.type === 'text' ? textBlock.text : 'done.'
        break
      }

      msgs.push({ role: 'assistant', content: finalReply })
      // Persist history after every exchange
      this.saveUserHistory(userId, msgs)

      await this.executeSimpleActions(text)

      return finalReply
    } catch (err) {
      console.error('[WizardBrain] Claude API error:', err)
      return 'something went wrong on my end. try again.'
    }
  }

  private buildContext(): string {
    const stats = this.memory.getDailyStats()
    const mood = this.moodEngine.getCurrentMood()
    const muted = this.memory.isMuted()

    const lines: string[] = [
      `mood: ${mood}`,
      `muted: ${muted}`,
      `replies today: ${stats.repliesToday}`,
      `monthly usage: ${stats.monthlyUsage}`,
    ]

    // Recent autonomous posts — what OsBot actually posted
    const autoPosts = (this.memory as any).store?.autonomousPosts ?? []
    if (autoPosts.length > 0) {
      lines.push('\n--- Recent autonomous posts (what OsBot posted on your behalf) ---')
      const recent = autoPosts.slice(-10).reverse()
      for (const p of recent) {
        const when = new Date(p.postedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })
        lines.push(`[${when}] topic: ${p.topic} | "${p.text.slice(0, 100)}${p.text.length > 100 ? '...' : ''}"`)
      }
    }

    // Recent replies OsBot sent — who it talked to and what it said
    const records = (this.memory as any).store?.records ?? []
    if (records.length > 0) {
      lines.push('\n--- Recent replies sent (last 10) ---')
      const recent = records.slice(-10).reverse()
      for (const r of recent) {
        const when = new Date(r.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' })
        lines.push(`[${when}] @${r.authorHandle}: "${r.replyText.slice(0, 80)}${r.replyText.length > 80 ? '...' : ''}"`)
      }
    }

    // Relationship summary — who's engaging, scores
    const topRels = this.relationshipMemory.getTopRelationships(8)
    if (topRels.length > 0) {
      lines.push('\n--- People who engage with you (by relationship score) ---')
      for (const rel of topRels) {
        lines.push(`@${rel.handle}: score=${rel.score}, ${rel.totalInteractions} interactions, ${rel.conversationCount} convs${rel.highlights.length ? `, note: ${rel.highlights.slice(-1)[0]}` : ''}`)
      }
    }
    const relStats = this.relationshipMemory.getStats()
    if (relStats.total > 0) {
      lines.push(`Total people tracked: ${relStats.total} (${relStats.positive} positive, ${relStats.negative} negative)`)
    }

    // Discord servers
    const guildCache = path.join(path.dirname(this.configPath), 'discord_guilds.json')
    if (fs.existsSync(guildCache)) {
      try {
        const cached = JSON.parse(fs.readFileSync(guildCache, 'utf-8'))
        const ids: string[] = cached.guildIds ?? []
        lines.push(`\ndiscord servers joined: ${ids.length}`)
      } catch {}
    }

    // Full biography — owner's complete history from archive
    const bioPath = path.join(path.dirname(this.configPath), '../memory-store/owner_biography.json')
    const bioContext = getBiographyContext(bioPath)
    if (bioContext) lines.push('\n' + bioContext)

    lines.push('\n[Person memory available. Use search_person_memory tool to load full conversation history for any @handle or to find everyone who talked about a topic.]')

    return lines.join('\n')
  }

  // --- History persistence ---

  private historyDir(): string {
    return path.join(path.dirname(path.resolve(this.configPath)), '../memory-store')
  }

  private historyPath(userId: string): string {
    return path.join(this.historyDir(), `telegram_history_${userId}.json`)
  }

  private loadUserHistory(userId: string): Message[] {
    try {
      const p = this.historyPath(userId)
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as Message[]
      }
    } catch {}
    return []
  }

  private saveUserHistory(userId: string, msgs: Message[]): void {
    try {
      fs.mkdirSync(this.historyDir(), { recursive: true })
      // Keep last 40 messages on disk — plenty of context
      const toSave = msgs.slice(-40)
      fs.writeFileSync(this.historyPath(userId), JSON.stringify(toSave, null, 2))
    } catch (err) {
      console.warn('[WizardBrain] Failed to save history:', err)
    }
  }

  private loadHistory(): void {
    // Pre-warm in-memory history from disk for any existing user files
    try {
      const dir = this.historyDir()
      if (!fs.existsSync(dir)) return
      const files = fs.readdirSync(dir).filter(f => f.startsWith('telegram_history_'))
      for (const file of files) {
        const userId = file.replace('telegram_history_', '').replace('.json', '')
        const msgs = this.loadUserHistory(userId)
        if (msgs.length > 0) this.history.set(userId, msgs)
      }
    } catch {}
  }

  private async executeSimpleActions(originalText: string): Promise<void> {
    const lower = originalText.toLowerCase()

    const muteMatch = lower.match(/mute.{0,20}?(\d+)\s*(hour|hr|h)/i)
    if (muteMatch) {
      const hours = parseInt(muteMatch[1])
      this.memory.setMutedUntil(new Date(Date.now() + hours * 3600 * 1000).toISOString())
      return
    }

    if (lower.includes('unmute') || lower.includes('un-mute')) {
      this.memory.setMutedUntil(null)
      return
    }

    const moods = ['chill', 'heated', 'snarky', 'defensive', 'distracted']
    for (const mood of moods) {
      if (lower.includes(mood) && (lower.includes('mood') || lower.includes('set') || lower.includes('go'))) {
        this.moodEngine.forceMood(mood as any)
        return
      }
    }
  }
}
