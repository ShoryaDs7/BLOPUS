/**
 * BlopusAgentDiscord — Phase 4
 * OsBot listens in the owner's Discord servers and replies in owner's voice.
 * Same personality/RAG/LLM core as Phase 2 (X), Discord adapter instead of X.
 *
 * Usage: npx ts-node agent/run-blopus-discord.ts
 *
 * Setup:
 * 1. Create a Discord bot at https://discord.com/developers/applications
 * 2. Enable "Message Content Intent" under Bot > Privileged Gateway Intents
 * 3. Invite bot to your servers with permissions: Read Messages, Send Messages, Read Message History
 * 4. Set DISCORD_BOT_TOKEN and DISCORD_GUILD_IDS in .env
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'

import { MemoryEngine } from '../core/memory/MemoryEngine'
import { LLMReplyEngine, PersonalityProfile } from '../core/personality/LLMReplyEngine'
import { MoodEngine } from '../core/personality/MoodEngine'
import { ExampleRetriever } from '../core/rag/ExampleRetriever'
import { parseTweetsJsFull, analyzePersonalityFull } from '../core/personality/PersonalityIngester'
import { DiscordAdapter } from '../adapters/discord'
import { autoJoinServers } from '../adapters/discord/DiscordServerJoiner'
import { extractTopics } from '../core/memory/topicExtractor'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
  const ts = new Date().toISOString()
  console[level](`[${ts}] [OsBot/Discord] [${level.toUpperCase()}] ${msg}`)
}

// ---------------------------------------------------------------------------
// Personality Profile loader
// ---------------------------------------------------------------------------

async function loadOrBuildPersonalityProfile(
  configDir: string,
  handle: string,
): Promise<PersonalityProfile | undefined> {
  const configDirPath  = path.join(configDir, 'personality_profile.json')
  const creatorDirPath = path.resolve(`creators/${handle}/personality_profile.json`)
  const profilePath    = fs.existsSync(configDirPath) ? configDirPath : creatorDirPath

  if (fs.existsSync(profilePath)) {
    try {
      return JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as PersonalityProfile
    } catch {
      log('warn', 'Failed to parse personality_profile.json — will rebuild.')
    }
  }

  const archivePath = process.env.TWITTER_ARCHIVE_PATH
  if (!archivePath || !fs.existsSync(archivePath)) {
    log('warn', 'No personality profile and no TWITTER_ARCHIVE_PATH — personality disabled.')
    return undefined
  }

  log('info', `Building personality profile from archive at ${archivePath}...`)
  const raw = fs.readFileSync(archivePath, 'utf-8')
  const tweets = parseTweetsJsFull(raw)
  const profile = await analyzePersonalityFull(tweets, handle)
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2))
  log('info', `Personality profile saved to ${profilePath}`)
  return profile
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function bootDiscord(): Promise<void> {
  log('info', 'Blopus booting OsBot Discord agent (Phase 4)...')

  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  const configDir = path.dirname(path.resolve(configPath))
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8'))

  const ownerHandle: string = config.owner?.handle ?? 'owner'
  const botHandle: string = config.blopus?.handle ?? 'blopus'
  const memoryPath = process.env.BLOPUS_MEMORY_PATH ?? config.memory?.storePath ?? './memory.json'
  const isDryRun = process.env.NODE_ENV === 'dry-run'

  if (isDryRun) log('warn', 'DRY-RUN mode — no Discord messages will be sent.')

  // --- Personality + RAG (same as Phase 2) ---
  const personalityProfile = await loadOrBuildPersonalityProfile(configDir, ownerHandle)

  const ragIndexPath = path.join(configDir, 'rag_index.json')
  const archivePath = process.env.TWITTER_ARCHIVE_PATH ?? ''
  const ragRetriever = new ExampleRetriever(ragIndexPath)
  ragRetriever.load(archivePath)
  if (personalityProfile?.signaturePatterns?.length) {
    ragRetriever.setSignaturePatterns(personalityProfile.signaturePatterns)
  }

  const memory = new MemoryEngine(memoryPath, config.memory?.maxRecords ?? 2000, config.memory?.pruneAfterDays ?? 30)
  const moodEngine = new MoodEngine(memory)

  const llmEngine = new LLMReplyEngine(
    ownerHandle,
    moodEngine.getCurrentMood(),
    config.personality?.replyTemplates ?? {},
    config.llm ?? { model: 'claude-haiku-4-5-20251001', maxTokens: 150, temperature: 0.8, enabled: true },
    personalityProfile,
    true, // isOwnerMode
    ragRetriever,
  )

  // --- Discord Adapter (Playwright-based) ---
  if (!process.env.DISCORD_EMAIL || !process.env.DISCORD_PASSWORD) {
    throw new Error(
      'Missing Discord credentials.\n' +
      'Set DISCORD_EMAIL and DISCORD_PASSWORD in your .env file.'
    )
  }

  const discord = new DiscordAdapter(botHandle)
  await discord.connect()

  // Guild IDs — from env, or auto-discovered by joining servers matching user's topics
  let guildIds = (process.env.DISCORD_GUILD_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  if (guildIds.length === 0) {
    log('info', 'No DISCORD_GUILD_IDS set — auto-joining servers based on personality topics...')
    const topics = personalityProfile?.dominantTopics ?? []
    guildIds = await autoJoinServers(discord, topics, configDir)
    if (guildIds.length === 0) {
      log('warn', 'Could not auto-join any servers. Set DISCORD_GUILD_IDS manually in .env.')
    }
  }

  log('info', `Discord agent ready. Monitoring ${guildIds.length} server(s).`)
  log('info', `LLM: ${config.llm?.model ?? 'claude-haiku-4-5-20251001'}`)

  const repliedThisCycle = new Set<string>()

  // --- Process @mentions (Discord is event-driven, we drain the queue each cycle) ---
  async function processMentions(): Promise<void> {
    const mentions = await discord.fetchOwnMentions()
    if (mentions.length === 0) {
      log('debug', 'No new Discord mentions.')
      return
    }

    log('info', `${mentions.length} new Discord mention(s).`)

    for (const mention of mentions) {
      if (memory.hasReplied(mention.tweetId)) continue
      if (repliedThisCycle.has(mention.tweetId)) continue

      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      let replyText: string
      try {
        replyText = await llmEngine.generateReply({
          mentionText: mention.text,
          authorHandle: mention.authorHandle,
          authorId: mention.authorId,
          mentionType: 'GENERIC',
          previousInteractions: memory.getInteractionCount(mention.authorId),
          mood,
          traits: config.personality?.traits ?? {},
          threadContext: undefined,
          mediaUrls: [],
          isConversationCloser: false,
          quotedTweetText: undefined,
        })
      } catch (err) {
        log('error', `LLM failed for message ${mention.tweetId}: ${err}`)
        continue
      }

      // Discord messages can be up to 2000 chars — keep concise per personality
      replyText = replyText.slice(0, 500)

      log('info', `Replying to @${mention.authorHandle} in Discord: "${replyText.slice(0, 80)}..."`)
      repliedThisCycle.add(mention.tweetId)

      if (!isDryRun) {
        try {
          await discord.postReply({ text: replyText, inReplyToTweetId: mention.tweetId })
        } catch (err) {
          log('error', `Failed to send Discord reply: ${err}`)
          continue
        }
      }

      memory.recordReply({
        tweetId: mention.tweetId,
        replyTweetId: mention.tweetId,
        authorId: mention.authorId,
        authorHandle: mention.authorHandle,
        conversationId: mention.conversationId,
        mentionText: mention.text.slice(0, 280),
        replyText,
        timestamp: new Date().toISOString(),
        traitSnapshot: config.personality?.traits ?? {},
        mood,
      })

      memory.recordPlatformEvent({
        platform: 'discord',
        type: 'reply_given',
        summary: `replied to @${mention.authorHandle} on discord: "${replyText.slice(0, 80)}"`,
      })

      const topics = extractTopics([mention.text, replyText])
      memory.updateRecurringUser('discord:owner', mention.authorHandle, 'discord', topics)
    }
  }

  // --- Forum thread hunting: reply inside hot forum threads ---
  async function huntHotForumThreads(): Promise<void> {
    if (guildIds.length === 0) return

    try {
      const hotThreads = await discord.getHotForumThreads(guildIds)
      if (hotThreads.length === 0) {
        log('debug', 'No hot Discord forum threads found.')
        return
      }

      const candidate = hotThreads.find(t => !memory.hasReplied(t.threadId) && !repliedThisCycle.has(t.threadId))
      if (!candidate) {
        log('debug', 'All hot forum threads already engaged with.')
        return
      }

      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      const promptText = `[#${candidate.forumName}] ${candidate.title}`.slice(0, 500)

      let comment: string
      try {
        comment = await llmEngine.generateViralReply(
          { text: promptText, authorHandle: 'forum' },
          mood,
          false,
        )
      } catch (err) {
        log('error', `LLM failed for forum thread ${candidate.threadId}: ${err}`)
        return
      }

      comment = comment.slice(0, 500)

      log('info', `[ForumHunt] Replying in #${candidate.forumName} thread "${candidate.title}" (${candidate.guildName}): "${comment.slice(0, 80)}..."`)
      repliedThisCycle.add(candidate.threadId)

      if (!isDryRun) {
        try {
          await discord.replyInThread(candidate.threadId, comment)
        } catch (err) {
          log('error', `Failed to reply in forum thread: ${err}`)
          return
        }
      }

      memory.recordReply({
        tweetId: candidate.threadId,
        replyTweetId: candidate.threadId,
        authorId: 'forum:' + candidate.forumChannelId,
        authorHandle: candidate.forumName,
        conversationId: candidate.threadId,
        mentionText: promptText.slice(0, 280),
        replyText: comment,
        timestamp: new Date().toISOString(),
        traitSnapshot: config.personality?.traits ?? {},
        mood,
      })

      memory.recordPlatformEvent({
        platform: 'discord',
        type: 'custom',
        summary: `replied in forum #${candidate.forumName} thread "${candidate.title}": "${comment.slice(0, 80)}"`,
      })
    } catch (err) {
      log('error', `Forum thread hunt error: ${err}`)
    }
  }

  // --- Autonomous forum post (every ~6 hours) ---
  let cycleCount = 0
  const POST_EVERY_N_CYCLES = Math.ceil(360 / 2) // 2-min interval → every 6 hours

  // Forum channel IDs to post to — comma-separated env var, falls back to none
  const forumChannelIds = (process.env.DISCORD_FORUM_CHANNEL_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  async function maybePostForumThread(): Promise<void> {
    cycleCount++
    if (cycleCount % POST_EVERY_N_CYCLES !== 0) return
    if (forumChannelIds.length === 0) return

    try {
      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      const postText = await llmEngine.generateAutonomousPost({
        targetPlatform: 'discord',
        mood,
        recentTopics: personalityProfile?.dominantTopics ?? [],
        mentionsToday: 0,
        repliesToday: 0,
        hoursSinceLastMention: 6,
        accountType: 'owner-own',
        ownerHandle,
      }).catch(() => '')

      if (!postText) return

      // First sentence → title, rest → body
      const sentences = postText.split(/[.!?]/).filter(s => s.trim().length > 0)
      const title = sentences[0]?.trim().slice(0, 100) ?? 'Thoughts'
      const body = sentences.slice(1).join('. ').trim() || postText

      const targetChannel = forumChannelIds[0]
      log('info', `[AutoPost] Creating forum thread "${title}" in channel ${targetChannel}`)

      if (!isDryRun) {
        await discord.postForumThread(targetChannel, title, body)
      }

      memory.recordPlatformEvent({
        platform: 'discord',
        type: 'custom',
        summary: `posted forum thread "${title}"`,
      })
    } catch (err) {
      log('error', `Auto forum post error: ${err}`)
    }
  }

  // --- Hot message hunting: comment on high-reaction messages ---
  async function huntHotMessages(): Promise<void> {
    if (guildIds.length === 0) return

    try {
      const hotMessages = await discord.getHotMessages(guildIds, 20)
      if (hotMessages.length === 0) {
        log('debug', 'No hot Discord messages found.')
        return
      }

      // Pick top message not yet engaged with
      const candidate = hotMessages.find(m => !memory.hasReplied(m.id) && !repliedThisCycle.has(m.id))
      if (!candidate) {
        log('debug', 'All hot Discord messages already engaged with.')
        return
      }

      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      let comment: string
      try {
        comment = await llmEngine.generateViralReply(
          { text: candidate.text, authorHandle: candidate.authorHandle },
          mood,
          false,
        )
      } catch (err) {
        log('error', `LLM failed for hot message ${candidate.id}: ${err}`)
        return
      }

      comment = comment.slice(0, 500)

      log('info', `[HotHunt] Replying in #${candidate.channelName} (${candidate.guildName}): "${comment.slice(0, 80)}..."`)
      repliedThisCycle.add(candidate.id)

      if (!isDryRun) {
        try {
          // Fetch the message and reply to it
          await discord.postMessage(candidate.channelId, comment)
        } catch (err) {
          log('error', `Failed to post hot message reply: ${err}`)
          return
        }
      }

      memory.recordReply({
        tweetId: candidate.id,
        replyTweetId: candidate.id,
        authorId: candidate.authorHandle,
        authorHandle: candidate.authorHandle,
        conversationId: candidate.channelId,
        mentionText: candidate.text.slice(0, 280),
        replyText: comment,
        timestamp: new Date().toISOString(),
        traitSnapshot: config.personality?.traits ?? {},
        mood,
      })

      memory.recordPlatformEvent({
        platform: 'discord',
        type: 'custom',
        summary: `commented in #${candidate.channelName} (${candidate.guildName}): "${comment.slice(0, 80)}"`,
      })
    } catch (err) {
      log('error', `Hot message hunt error: ${err}`)
    }
  }

  // --- Main cycle (runs every 2 minutes — Discord is near real-time) ---
  const POLL_MS = 2 * 60 * 1000

  async function runCycle(): Promise<void> {
    log('debug', 'Discord cycle starting.')
    repliedThisCycle.clear()
    moodEngine.updateMood('TICK')
    await processMentions()
    await huntHotMessages()
    await huntHotForumThreads()
    await maybePostForumThread()
  }

  // Discord is event-driven — use setInterval instead of cron
  setInterval(() => {
    runCycle().catch(err => log('error', `Unhandled cycle error: ${err}`))
  }, POLL_MS)

  // Run immediately
  await runCycle()
}
