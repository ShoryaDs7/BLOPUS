import cron from 'node-cron'
import { Bot } from 'grammy'
import { MemoryEngine } from '../../core/memory/MemoryEngine'
import { MoodEngine } from '../../core/personality/MoodEngine'
import { Mood } from '../../core/memory/types'
import { SessionBrain } from '../control/SessionBrain'
import { PersonMemoryStore } from '../../core/memory/PersonMemoryStore'
import type { DmInboxPoller } from '../../agent/DmInboxPoller'

const VALID_MOODS: Mood[] = ['chill', 'heated', 'snarky', 'defensive', 'distracted']

/**
 * TelegramAdapter — owner control channel + new user setup wizard.
 *
 * Owner commands (only from TELEGRAM_OWNER_CHAT_ID):
 *   /status   — mood, replies today, monthly usage
 *   /mute [h] — mute OsBot for N hours (default 24)
 *   /unmute   — resume replies immediately
 *   /mood X   — force mood: chill | heated | snarky | defensive | distracted
 *
 * New users (anyone else):
 *   /setup    — start the OsBot setup wizard
 *   Any message while wizard is active → wizard handles it
 *
 * Env vars required: TELEGRAM_BOT_TOKEN
 * Config required:   controlChannel.telegram.ownerChatId
 */
export class TelegramAdapter {
  private bot: Bot
  private ownerChatId: string
  private memory: MemoryEngine
  private moodEngine: MoodEngine
  private brain: SessionBrain
  private personStore: PersonMemoryStore | null = null
  private dmPoller: DmInboxPoller | null = null

  constructor(
    token: string,
    ownerChatId: string,
    memory: MemoryEngine,
    moodEngine: MoodEngine,
    configPath: string = './config/blopus.config.json',
  ) {
    this.bot = new Bot(token)
    this.ownerChatId = ownerChatId
    this.memory = memory
    this.moodEngine = moodEngine
    this.brain = new SessionBrain()
    this.brain.setNotify(async (text) => {
      await this.bot.api.sendMessage(ownerChatId, text).catch(() => {})
    })
    this.setupHandlers()
    this.scheduleMorningSummary()
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  private setupHandlers(): void {
    // Photo messages — download and pass to brain as base64 image
    this.bot.on('message:photo', async (ctx) => {
      if (String(ctx.chat.id) !== this.ownerChatId) return
      try {
        // Get highest resolution photo
        const photos = ctx.message.photo
        const photo = photos[photos.length - 1]
        const caption = ctx.message.caption ?? ''

        // Download image from Telegram
        const file = await ctx.api.getFile(photo.file_id)
        const fileUrl = `https://api.telegram.org/file/bot${(this.bot as any).token}/${file.file_path}`
        const resp = await fetch(fileUrl)
        const buffer = Buffer.from(await resp.arrayBuffer())
        const base64 = buffer.toString('base64')
        const mimeType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg'

        // Pass image + caption to brain
        const prompt = caption
          ? `[IMAGE ATTACHED]\n${caption}`
          : '[IMAGE ATTACHED — describe what you see and help with any task related to it]'

        setImmediate(async () => {
          try {
            const reply = await this.brain.processWithImage(String(ctx.chat.id), prompt, base64, mimeType)
            const chunks = reply.match(/[\s\S]{1,4000}/g) ?? ['done.']
            for (const chunk of chunks) {
              await ctx.reply(chunk).catch(async () => {
                await ctx.reply(chunk.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&')).catch(() => {})
              })
            }
          } catch (e) {
            await ctx.reply('error processing image').catch(() => {})
          }
        })
      } catch (e) {
        await ctx.reply('could not download image').catch(() => {})
      }
    })

    // Document/file messages — download and let brain handle
    this.bot.on('message:document', async (ctx) => {
      if (String(ctx.chat.id) !== this.ownerChatId) return
      try {
        const doc = ctx.message.document
        const caption = ctx.message.caption ?? ''
        const fileName = doc.file_name ?? 'file'

        // Download file
        const file = await ctx.api.getFile(doc.file_id)
        const fileUrl = `https://api.telegram.org/file/bot${(this.bot as any).token}/${file.file_path}`
        const resp = await fetch(fileUrl)
        const buffer = Buffer.from(await resp.arrayBuffer())

        // Save to temp location
        const fs = await import('fs')
        const path = await import('path')
        const tmpDir = path.join(process.env.BLOPUS_DIR ?? '.', 'tmp')
        fs.mkdirSync(tmpDir, { recursive: true })
        const savePath = path.join(tmpDir, fileName)
        fs.writeFileSync(savePath, buffer)

        const prompt = caption
          ? `[FILE RECEIVED: ${fileName} — saved to ${savePath}]\n${caption}`
          : `[FILE RECEIVED: ${fileName} — saved to ${savePath}]\nThe user sent this file. Help them with it — move it, rename it, read it, or do whatever makes sense.`

        setImmediate(async () => {
          try {
            const reply = await this.brain.process(String(ctx.chat.id), prompt)
            const chunks = reply.match(/[\s\S]{1,4000}/g) ?? ['done.']
            for (const chunk of chunks) {
              await ctx.reply(chunk).catch(async () => {
                await ctx.reply(chunk.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&')).catch(() => {})
              })
            }
          } catch (e) {
            await ctx.reply('error processing file').catch(() => {})
          }
        })
      } catch (e) {
        await ctx.reply('could not download file').catch(() => {})
      }
    })

    // Text messages
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id
      const text = ctx.message.text


      // /ping — anyone can use
      if (text === '/ping') {
        await ctx.reply(`pong — ${new Date().toISOString()}`)
        return
      }

      // Owner commands
      if (String(chatId) === this.ownerChatId) {
        await this.handleOwnerCommand(ctx, text)
        return
      }

      // Non-owner: ignore silently — this is a private instance
    })
  }

  // ---------------------------------------------------------------------------
  // Owner control commands
  // ---------------------------------------------------------------------------

  async generateDailySummary(): Promise<string> {
    const today = new Date().toDateString()
    const allEvents = this.memory.getRecentPlatformEvents(200)
    const todayEvents = allEvents.filter(e => new Date(e.timestamp).toDateString() === today)

    const posted   = todayEvents.filter(e => e.type === 'post_published')
    const replied  = todayEvents.filter(e => e.type === 'reply_given')
    const mentioned = todayEvents.filter(e => e.type === 'notable_mention')

    const dmDraftsPath = require('path').resolve('./memory-store/dm_drafts.json')
    let dmDrafts: any[] = []
    try {
      if (require('fs').existsSync(dmDraftsPath))
        dmDrafts = JSON.parse(require('fs').readFileSync(dmDraftsPath, 'utf-8'))
    } catch {}

    if (todayEvents.length === 0) {
      return `📋 Daily Summary — ${today}\n\nNothing happened today yet — the bot hasn't posted or replied to anyone.\n\nAnything you want me to know about today?`
    }

    // Build raw data string for Claude to summarize
    const rawData = [
      `Date: ${today}`,
      `Posts published (${posted.length}): ${posted.map(p => p.summary).join(' | ')}`,
      `Replies given (${replied.length}): ${replied.map(r => r.summary).join(' | ')}`,
      `Notable mentions (${mentioned.length}): ${mentioned.map(m => m.summary).join(' | ')}`,
      `Pending DM drafts (${dmDrafts.length}): ${dmDrafts.map((d: any) => `@${d.handle}`).join(', ')}`,
    ].join('\n')

    try {
      const Anthropic = require('@anthropic-ai/sdk')
      const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `You are a personal AI assistant giving a brief daily recap to your owner on Telegram. Write a natural, friendly 3-5 sentence summary of what you did today. Be specific about what was posted/replied. End with one casual question about their day. Keep it conversational, not robotic.\n\nRaw activity data:\n${rawData}`
        }]
      })
      return `📋 Daily Summary — ${today}\n\n${msg.content[0].text}`
    } catch {
      // Fallback to plain format if Claude fails
      const lines = [`📋 Daily Summary — ${today}`, '']
      if (posted.length) lines.push(`🐦 ${posted.length} tweet${posted.length > 1 ? 's' : ''} posted`)
      if (replied.length) lines.push(`💬 ${replied.length} repl${replied.length > 1 ? 'ies' : 'y'} given`)
      if (mentioned.length) lines.push(`🔔 ${mentioned.length} notable mention${mentioned.length > 1 ? 's' : ''}`)
      if (dmDrafts.length) lines.push(`📨 ${dmDrafts.length} DM draft${dmDrafts.length > 1 ? 's' : ''} waiting`)
      lines.push('', 'anything you want me to know about today?')
      return lines.join('\n')
    }
  }

  private async handleOwnerCommand(ctx: any, text: string): Promise<void> {
    if (text === '/status') {
      const stats = this.memory.getDailyStats()
      const mood = this.moodEngine.getCurrentMood()
      const muted = this.memory.isMuted()
      await ctx.reply([
        `mood: ${mood}`,
        `replies today: ${stats.repliesToday}`,
        `monthly usage: ${stats.monthlyUsage}`,
        muted ? '⚠️ muted' : '✅ active',
        stats.lastReplyAt
          ? `last reply: ${new Date(stats.lastReplyAt).toLocaleTimeString()}`
          : 'no replies yet today',
      ].join('\n'))
      return
    }

    if (text.startsWith('/mute')) {
      const hours = parseInt(text.split(' ')[1] ?? '') || 24
      this.memory.setMutedUntil(new Date(Date.now() + hours * 3600 * 1000).toISOString())
      await ctx.reply(`muted for ${hours}h.`)
      return
    }

    if (text === '/unmute') {
      this.memory.setMutedUntil(null)
      await ctx.reply('unmuted. osbot is active.')
      return
    }

    if (text.startsWith('/mood')) {
      const requested = text.split(' ')[1]?.trim().toLowerCase() as Mood
      if (!VALID_MOODS.includes(requested)) {
        await ctx.reply(`valid moods: ${VALID_MOODS.join(', ')}`)
        return
      }
      this.moodEngine.forceMood(requested)
      await ctx.reply(`mood set to ${requested}.`)
      return
    }

    if (text === '/summary' || /^(what did you do|daily summary|summary|recap)/i.test(text)) {
      await ctx.reply('generating summary...')
      const summary = await this.generateDailySummary()
      await ctx.reply(summary)
      return
    }

    if (text === '/help') {
      await ctx.reply(
        '/status — mood, usage, last reply\n' +
        '/summary — what did OsBot do today (natural language recap)\n' +
        '/mute [hours] — pause replies (default 24h)\n' +
        '/unmute — resume replies\n' +
        '/mood [chill|heated|snarky|defensive|distracted] — force mood\n' +
        '/ping — check bot is alive\n' +
        '/setup — set up a new OsBot for someone\n\n' +
        'People commands:\n' +
        '"yes @handle" — confirm my classification\n' +
        '"no @handle: they\'re my [type]" — correct a classification\n' +
        '"set @handle as [type]" — force a relationship type\n' +
        '"note for @handle: [text]" — add a personal note\n' +
        '"rename user_ID to @handle" — resolve unknown numeric ID\n' +
        'Types: romantic, family, close_friend, professional, acquaintance, fan\n\n' +
        'DM approval commands:\n' +
        '"approve dm @handle" — send pending draft as-is\n' +
        '"send dm @handle [text]" — send with your own text\n' +
        '"answer @handle: [fact]" — clarify what bot didn\'t know, saves permanently + sends reply'
      )
      return
    }

    // ── People / classification commands ──────────────────────────────────────
    if (this.personStore) {
      const lower = text.toLowerCase().trim()

      // "yes @sarah" — confirm pending classification
      const yesMatch = lower.match(/^yes\s+@?(\w+)$/)
      if (yesMatch) {
        const handle = yesMatch[1]
        const mem = this.personStore.load(handle)
        if (mem?.pendingClassification && !mem.pendingClassification.confirmed) {
          mem.relationshipType = mem.pendingClassification.type
          mem.pendingClassification.confirmed = true
          this.personStore.save(mem)
          await ctx.reply(`✅ @${handle} saved as ${mem.relationshipType}.`)
        } else if (mem) {
          await ctx.reply(`@${handle} — nothing pending. Current type: ${mem.relationshipType}.`)
        } else {
          await ctx.reply(`@${handle} not found.`)
        }
        return
      }

      // "no @sarah: she's my colleague" or "no @sarah: they're my professional"
      const noMatch = text.match(/^no\s+@?(\w+)\s*[:\-–]\s*(.+)$/i)
      if (noMatch) {
        const handle = noMatch[1]
        const correction = noMatch[2].trim().toLowerCase()
        const mem = this.personStore.load(handle)
        if (mem) {
          const validTypes = ['romantic', 'family', 'close_friend', 'professional', 'acquaintance', 'fan', 'unknown']
          // Extract type from correction phrase — "they're my colleague" / "she's professional" / "close friend"
          const foundType = validTypes.find(t => correction.replace(/[_']/g, ' ').includes(t.replace('_', ' ')))
            ?? (correction.includes('friend') ? 'close_friend'
             : correction.includes('colleague') || correction.includes('coworker') ? 'professional'
             : correction.includes('partner') || correction.includes('girlfriend') || correction.includes('boyfriend') ? 'romantic'
             : null)

          if (foundType) {
            mem.relationshipType = foundType as any
            if (mem.pendingClassification) mem.pendingClassification.confirmed = true
            this.personStore.save(mem)
            await ctx.reply(`✅ @${handle} corrected to ${foundType}.`)
          } else {
            await ctx.reply(`Got it — but I didn't catch the type. Valid: romantic, family, close_friend, professional, acquaintance, fan, unknown`)
          }
        } else {
          await ctx.reply(`@${handle} not found.`)
        }
        return
      }

      // "set @sarah as romantic"
      const setMatch = text.match(/^set\s+@?(\w+)\s+as\s+(\w+)$/i)
      if (setMatch) {
        const handle = setMatch[1]
        const rawType = setMatch[2].toLowerCase()
        const validTypes = ['romantic', 'family', 'close_friend', 'professional', 'acquaintance', 'fan', 'unknown']
        if (!validTypes.includes(rawType)) {
          await ctx.reply(`Unknown type "${rawType}". Valid: ${validTypes.join(', ')}`)
          return
        }
        const mem = this.personStore.load(handle)
        if (!mem) { await ctx.reply(`@${handle} not found.`); return }
        mem.relationshipType = rawType as any
        if (mem.pendingClassification) mem.pendingClassification.confirmed = true
        this.personStore.save(mem)
        await ctx.reply(`✅ @${handle} set to ${rawType}.`)
        return
      }

      // "note for @raj: my investor, always keep it formal"
      const noteMatch = text.match(/^note\s+for\s+@?(\w+)\s*[:\-–]\s*(.+)$/i)
      if (noteMatch) {
        const handle = noteMatch[1]
        const note = noteMatch[2].trim()
        const mem = this.personStore.load(handle)
        if (!mem) { await ctx.reply(`@${handle} not found.`); return }
        mem.ownerNote = note
        this.personStore.save(mem)
        await ctx.reply(`✅ Note saved for @${handle}: "${note}"`)
        return
      }

      // "rename user_123456 to @actualhandle"
      const renameMatch = text.match(/^rename\s+(user_\d+)\s+to\s+@?(\w+)$/i)
      if (renameMatch) {
        const oldHandle = renameMatch[1]
        const newHandle = renameMatch[2].toLowerCase()
        const mem = this.personStore.load(oldHandle)
        if (!mem) { await ctx.reply(`${oldHandle} not found.`); return }
        this.personStore.handleRename(oldHandle, newHandle)
        await ctx.reply(`✅ Renamed ${oldHandle} → @${newHandle}.`)
        return
      }
    }

    // "answer @handle: [fact]" — clarify something the bot was uncertain about, saves forever
    const answerMatch2 = text.match(/^answer\s+@?(\w+)\s*[:\-–]\s*(.+)$/i)
    if (answerMatch2 && this.dmPoller) {
      const handle = answerMatch2[1]
      const fact = answerMatch2[2].trim()
      const sent = await this.dmPoller.answerUncertain(handle, fact)
      await ctx.reply(sent ? `✅ Fact saved + DM sent to @${handle}` : `❌ No uncertain draft for @${handle} (use "approve dm @${handle}" if it's a different draft type)`)
      return
    }

    // "approve dm @handle" — send the pending draft as-is
    const approveMatch = text.match(/^approve\s+dm\s+@?(\w+)$/i)
    if (approveMatch && this.dmPoller) {
      const handle = approveMatch[1]
      const sent = await this.dmPoller.approveDraft(handle)
      await ctx.reply(sent ? `✅ DM sent to @${handle}` : `❌ No pending draft for @${handle}`)
      return
    }

    // "send dm @handle some custom text" — send with edited text
    const sendMatch = text.match(/^send\s+dm\s+@?(\w+)\s+(.+)$/i)
    if (sendMatch && this.dmPoller) {
      const handle = sendMatch[1]
      const editedText = sendMatch[2].trim()
      const sent = await this.dmPoller.approveDraft(handle, editedText)
      await ctx.reply(sent ? `✅ DM sent to @${handle}: "${editedText}"` : `❌ No pending draft for @${handle}`)
      return
    }

    // Direct file send — intercept before brain if message contains a local file path
    const filePathMatch = text.match(/(?:[A-Za-z]:[\\/]|\/(?!\/))[\w\\/\-. ]+\.\w+/)
    if (filePathMatch) {
      const filePath = filePathMatch[0].replace(/\\/g, '/')
      const fsSync = await import('fs')
      if (fsSync.existsSync(filePath)) {
        await this.sendFile(filePath)
        return
      }
    }

    // Free-form message → AgentBrain (Claude Code SDK) handles everything
    // Run async so Telegram doesn't queue messages behind long-running tasks
    setImmediate(async () => {
      try {
        const reply = await this.brain.process(String(ctx.chat.id), text)

        // Intercept file delivery JSON — e.g. from NotebookLM skill
        // {"telegramFile": "/path/to/file.mp3", "fileType": "audio"}
        // Also check if reply itself contains a local file path to an existing file
        let textReply = reply

        const replyPathMatch = reply.match(/(?:[A-Za-z]:[\\/]|\/(?!\/))[\w\\/\-. ]+\.\w+/)
        if (replyPathMatch) {
          const rPath = replyPathMatch[0].replace(/\\/g, '/')
          const fsCheck = await import('fs')
          if (fsCheck.existsSync(rPath)) {
            await this.sendFile(rPath)
            textReply = textReply.replace(replyPathMatch[0], '').trim()
          }
        }

        const strippedReply = textReply.replace(/```(?:json)?\s*/g, '').replace(/```/g, '')
        const fileMatch = strippedReply.match(/\{[^{}]*"telegramFile"\s*:[^{}]*\}/)
        if (fileMatch) {
          try {
            const action = JSON.parse(fileMatch[0])
            const filePath: string = action.telegramFile
            const fs = await import('fs')
            if (fs.existsSync(filePath)) {
              await this.sendFile(filePath)
              textReply = textReply.replace(fileMatch[0], '').trim()
            } else {
              await ctx.reply(`file not found: ${filePath}`).catch(() => {})
              return
            }
          } catch {}
        }

        const chunks = (textReply || reply).match(/[\s\S]{1,4000}/g) ?? ['done.']
        for (const chunk of chunks) {
          await ctx.reply(chunk).catch(async () => {
            await ctx.reply(chunk.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&')).catch(() => {})
          })
        }
      } catch (err: any) {
        await ctx.reply(`error: ${err.message?.slice(0, 100) ?? 'unknown'}`).catch(() => {})
      }
    })
  }

  getBrain(): SessionBrain {
    return this.brain
  }

  setXClient(client: any): void {
    this.brain.setXClient(client)
  }

  /** Wire in PersonMemoryStore so owner can confirm/correct relationship classifications via Telegram */
  setPersonStore(store: PersonMemoryStore): void {
    this.personStore = store
  }

  /** Wire in DmInboxPoller so owner can approve/send DM drafts from Telegram */
  setDmPoller(poller: DmInboxPoller): void {
    this.dmPoller = poller
  }

  // ---------------------------------------------------------------------------
  // Outbound notifications
  // ---------------------------------------------------------------------------

  async sendNotification(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(this.ownerChatId, text)
    } catch (err) {
      console.warn('[TelegramAdapter] Failed to send notification:', err)
    }
  }

  /** Send a local file to the owner — used for NotebookLM outputs, PDFs, etc. */
  async sendFile(filePath: string, caption?: string): Promise<void> {
    try {
      const { InputFile } = await import('grammy')
      const isAudio = /\.(mp3|m4a|ogg|wav)$/i.test(filePath)
      if (isAudio) {
        await this.bot.api.sendAudio(this.ownerChatId, new InputFile(filePath), caption ? { caption } : {})
      } else {
        await this.bot.api.sendDocument(this.ownerChatId, new InputFile(filePath), caption ? { caption } : {})
      }
    } catch (err) {
      console.warn('[TelegramAdapter] Failed to send file:', err)
      // Fallback: just notify with path
      await this.sendNotification(`file ready: ${filePath}${caption ? '\n' + caption : ''}`)
    }
  }

  private scheduleMorningSummary(): void {
    cron.schedule('0 8 * * *', async () => {
      const stats = this.memory.getDailyStats()
      const mood = this.moodEngine.getCurrentMood()
      await this.sendNotification([
        'good morning.',
        '',
        `last 24h: ${stats.repliesToday} replies sent`,
        `mood: ${mood}`,
        `monthly usage: ${stats.monthlyUsage}`,
      ].join('\n'))
    })
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    this.startWithRetry(0)
  }

  private startWithRetry(attempt: number): void {
    this.bot.start({
      onStart: () => console.log('[TelegramAdapter] Bot polling started.'),
    }).catch(err => {
      const is409 = String(err).includes('409') || String(err).includes('Conflict')
      if (is409) {
        // Claude Code Telegram MCP plugin is polling the same token.
        // Wait 35s for its long-poll to expire, then grab the slot.
        console.log(`[TelegramAdapter] Waiting for Telegram slot (Claude Code session active)... retry in 35s`)
        setTimeout(() => this.startWithRetry(attempt + 1), 35000)
      } else {
        console.error('[TelegramAdapter] Fatal error:', err)
      }
    })
  }
}
