/**
 * BlopusAgentReddit — Phase 3
 * OsBot controlling the owner's Reddit account.
 * Same personality/RAG/LLM core as Phase 2 (X), different platform adapter.
 *
 * Usage: npx ts-node agent/run-blopus-reddit.ts
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import cron from 'node-cron'

import { MemoryEngine } from '../core/memory/MemoryEngine'
import { LLMReplyEngine, PersonalityProfile } from '../core/personality/LLMReplyEngine'
import { MoodEngine } from '../core/personality/MoodEngine'
import { ExampleRetriever } from '../core/rag/ExampleRetriever'
import { parseTweetsJsFull, analyzePersonalityFull } from '../core/personality/PersonalityIngester'
import { RedditAdapter } from '../adapters/reddit/RedditAdapter'
import { extractTopics } from '../core/memory/topicExtractor'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string): void {
  const ts = new Date().toISOString()
  console[level](`[${ts}] [OsBot/Reddit] [${level.toUpperCase()}] ${msg}`)
}

// ---------------------------------------------------------------------------
// Personality Profile loader (same as Phase 2)
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
// Subreddit discovery — searches Reddit directly for each topic
// No hardcoded lists — works for any user with any interests
// ---------------------------------------------------------------------------

async function discoverSubreddits(
  reddit: RedditAdapter,
  topics: string[],
  cacheFile: string,
): Promise<string[]> {
  // Load from cache if exists (refreshed once per day)
  if (fs.existsSync(cacheFile)) {
    const { subs, savedAt } = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    const ageHours = (Date.now() - savedAt) / 3600000
    if (ageHours < 24 && subs.length > 0) {
      return subs as string[]
    }
  }

  const subs = new Set<string>()
  // Search top 3 topics to keep API calls minimal
  for (const topic of topics.slice(0, 3)) {
    const found = await reddit.searchSubreddits(topic, 5)
    found.forEach(s => subs.add(s))
  }

  const result = Array.from(subs)
  fs.writeFileSync(cacheFile, JSON.stringify({ subs: result, savedAt: Date.now() }, null, 2))
  return result
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function bootReddit(): Promise<void> {
  log('info', 'Blopus booting OsBot Reddit agent (Phase 3)...')

  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  const configDir = path.dirname(path.resolve(configPath))
  const config = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8'))

  const ownerHandle: string = config.owner?.handle ?? 'owner'
  const memoryPath = process.env.BLOPUS_MEMORY_PATH ?? config.memory?.storePath ?? './memory.json'
  const pollMinutes: number = config.platform?.pollIntervalMinutes ?? 5
  const isDryRun = process.env.NODE_ENV === 'dry-run'

  if (isDryRun) log('warn', 'DRY-RUN mode — no Reddit posts will be made.')

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
    true, // isOwnerMode — Phase 3 is always owner mode
    ragRetriever,
  )

  // --- Reddit Adapter ---
  const redditClientId = process.env.REDDIT_CLIENT_ID
  const redditClientSecret = process.env.REDDIT_CLIENT_SECRET
  const redditUsername = process.env.REDDIT_USERNAME
  const redditPassword = process.env.REDDIT_PASSWORD

  if (!redditClientId || !redditClientSecret || !redditUsername || !redditPassword) {
    throw new Error(
      'Missing Reddit credentials. Set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, ' +
      'REDDIT_USERNAME, REDDIT_PASSWORD in your .env file.\n' +
      'Create a Reddit app at: https://www.reddit.com/prefs/apps'
    )
  }

  const reddit = new RedditAdapter(
    redditClientId,
    redditClientSecret,
    redditUsername,
    redditPassword,
    redditUsername, // owner = same account
  )

  const subCacheFile = path.join(configDir, 'reddit_subreddits.json')
  const subreddits = personalityProfile?.dominantTopics?.length
    ? await discoverSubreddits(reddit, personalityProfile.dominantTopics, subCacheFile)
    : await reddit.searchSubreddits('technology', 5)

  log('info', `Reddit agent ready. Polling every ${pollMinutes}min.`)
  log('info', `Monitoring subreddits: ${subreddits.join(', ')}`)
  log('info', `LLM: ${config.llm?.model ?? 'claude-haiku-4-5-20251001'}`)

  // --- Reply to mentions ---
  async function processMentions(): Promise<void> {
    const mentions = await reddit.fetchOwnMentions()
    if (mentions.length === 0) {
      log('debug', 'No new Reddit mentions.')
      return
    }

    log('info', `${mentions.length} new Reddit mention(s).`)

    for (const mention of mentions) {
      if (memory.hasReplied(mention.tweetId)) {
        log('info', `Already replied to ${mention.tweetId} — skipping.`)
        continue
      }

      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      let replyText: string
      try {
        replyText = await llmEngine.generateReply({
          mentionText: mention.text,
          authorHandle: mention.authorHandle,
          authorId: mention.authorId,
          mentionType: 'REPLY',
          previousInteractions: memory.getInteractionCount(mention.authorId),
          mood,
          traits: config.personality?.traits ?? {},
          threadContext: undefined,
          mediaUrls: [],
          isConversationCloser: false,
          quotedTweetText: undefined,
        })
      } catch (err) {
        log('error', `LLM failed for ${mention.tweetId}: ${err}`)
        continue
      }

      // Reddit comments can be longer — allow up to 500 chars
      replyText = replyText.slice(0, 500)

      log('info', `Replying to u/${mention.authorHandle}: "${replyText.slice(0, 80)}..."`)

      if (!isDryRun) {
        try {
          await reddit.postReply({ text: replyText, inReplyToTweetId: mention.tweetId })
        } catch (err) {
          log('error', `Failed to post reply: ${err}`)
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
        platform: 'reddit',
        type: 'reply_given',
        summary: `replied to u/${mention.authorHandle} on reddit: "${replyText.slice(0, 80)}"`,
      })

      const topics = extractTopics([mention.text, replyText])
      memory.updateRecurringUser('reddit:owner', mention.authorHandle, 'reddit', topics)
    }
  }

  // --- Viral hunting: comment on hot subreddit posts ---
  async function huntViralPosts(): Promise<void> {
    try {
      const hotPosts = await reddit.getHotPosts(subreddits, 5)
      if (hotPosts.length === 0) {
        log('debug', 'No hot Reddit posts found matching topics.')
        return
      }

      // Pick the top post we haven't commented on yet
      const candidate = hotPosts.find(p => !memory.hasReplied(p.id))
      if (!candidate) {
        log('debug', 'All hot posts already engaged with.')
        return
      }

      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      const promptText = `[r/${candidate.subreddit}] ${candidate.title}\n${candidate.text}`.slice(0, 500)

      let comment: string
      try {
        comment = await llmEngine.generateViralReply({
          tweetText: promptText,
          tweetAuthor: candidate.authorHandle,
          tweetId: candidate.id,
          likeCount: candidate.upvotes,
          mediaUrls: [],
        })
      } catch (err) {
        log('error', `LLM failed for viral post ${candidate.id}: ${err}`)
        return
      }

      comment = comment.slice(0, 500)

      log('info', `[ViralHunt] Commenting on r/${candidate.subreddit} post by u/${candidate.authorHandle}: "${comment.slice(0, 80)}..."`)

      if (!isDryRun) {
        try {
          await reddit.postComment(candidate.id, comment)
        } catch (err) {
          log('error', `Failed to post viral comment: ${err}`)
          return
        }
      }

      memory.recordReply({
        tweetId: candidate.id,
        replyTweetId: candidate.id,
        authorId: candidate.authorHandle,
        authorHandle: candidate.authorHandle,
        conversationId: candidate.id,
        mentionText: promptText.slice(0, 280),
        replyText: comment,
        timestamp: new Date().toISOString(),
        traitSnapshot: config.personality?.traits ?? {},
        mood,
      })

      memory.recordPlatformEvent({
        platform: 'reddit',
        type: 'viral_comment',
        summary: `commented on r/${candidate.subreddit} post: "${comment.slice(0, 80)}"`,
      })
    } catch (err) {
      log('error', `Viral hunt error: ${err}`)
    }
  }

  // --- Autonomous post submission (like posting a tweet) ---
  // Runs every 6 hours via cycle counter — not every poll
  let cycleCount = 0
  const SUBMIT_EVERY_N_CYCLES = Math.ceil(360 / pollMinutes) // ~every 6 hours

  async function maybeSubmitPost(): Promise<void> {
    cycleCount++
    if (cycleCount % SUBMIT_EVERY_N_CYCLES !== 0) return

    try {
      const mood = moodEngine.getCurrentMood()
      llmEngine.updateMood(mood)

      // Pick the highest-value subreddit for this post
      const targetSub = subreddits[0] ?? 'technology'

      // Generate a standalone post using the autonomous posting prompt
      const postText = await llmEngine.generateAutonomousPost({
        targetPlatform: 'reddit',
        mood,
        recentTopics: personalityProfile?.dominantTopics ?? [],
        mentionsToday: 0,
        repliesToday: 0,
        hoursSinceLastMention: 6,
        accountType: 'owner-own',
        ownerHandle,
      }).catch(() => '')

      if (!postText) return

      // Reddit posts need a title — extract first sentence as title, rest as body
      const sentences = postText.split(/[.!?]/).filter(s => s.trim().length > 0)
      const title = sentences[0]?.trim().slice(0, 100) ?? 'Thoughts'
      const body = sentences.slice(1).join('. ').trim() || postText

      log('info', `[AutoPost] Submitting to r/${targetSub}: "${title}"`)

      if (!isDryRun) {
        await reddit.postSubmission(targetSub, title, body)
      }

      memory.recordPlatformEvent({
        platform: 'reddit',
        type: 'autonomous_post',
        summary: `posted to r/${targetSub}: "${title}"`,
      })
    } catch (err) {
      log('error', `Auto-submit error: ${err}`)
    }
  }

  // --- Main cycle ---
  async function runCycle(): Promise<void> {
    log('debug', 'Poll cycle starting.')
    moodEngine.updateMood('TICK')

    await processMentions()
    await huntViralPosts()
    await maybeSubmitPost()
  }

  // Start cron
  cron.schedule(`*/${pollMinutes} * * * *`, () => {
    runCycle().catch(err => log('error', `Unhandled cycle error: ${err}`))
  })

  // Run immediately
  await runCycle()
}
