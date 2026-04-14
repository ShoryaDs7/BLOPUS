import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import cron from 'node-cron'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

import { MemoryEngine } from '../core/memory/MemoryEngine'
import { PersonalityEngine } from '../core/personality/PersonalityEngine'
import { MoodEngine } from '../core/personality/MoodEngine'
import { LLMReplyEngine, PersonalityProfile } from '../core/personality/LLMReplyEngine'
import { LoyaltyEngine } from '../core/loyalty/LoyaltyEngine'
import { XClient } from '../adapters/x/XClient'
import { XAdapter } from '../adapters/x/XAdapter'
import { BranchContextProvider } from '../adapters/x/BranchContextProvider'
import { RateLimiter } from '../adapters/x/RateLimiter'
import { TelegramAdapter } from '../adapters/telegram'
import { XTools } from '../adapters/control/XTools'
import { startXToolsServer } from '../adapters/control/XToolsServer'
import { ThreadsClient, ThreadsAdapter } from '../adapters/threads'
import { DecisionEngine } from './DecisionEngine'
import { AutonomousActivity } from './AutonomousActivity'
import { ViralReplyHunter } from './ViralReplyHunter'
import { OwnerViralReplyHunter } from './OwnerViralReplyHunter'
import { OwnerDefender } from './OwnerDefender'
import { PackDiscovery } from './PackDiscovery'
import { PackChatter } from './PackChatter'
import { MCPBrowserDM } from './MCPBrowserDM'
import { DmInboxPoller } from './DmInboxPoller'
import { PlaywrightTopicSearchProvider } from '../adapters/x/PlaywrightTopicSearchProvider'
import { PlaywrightHomeTimelineProvider } from '../adapters/x/PlaywrightHomeTimelineProvider'
import { TopicSearchProvider } from '../adapters/x/TopicSearchProvider'
import { ExampleRetriever } from '../core/rag/ExampleRetriever'
import { parseTweetsJsFull, analyzePersonalityFull } from '../core/personality/PersonalityIngester'
import { UserContext } from '../adapters/control/UserContext'
import { RelationshipMemory } from '../core/memory/RelationshipMemory'
import { PersonMemoryStore } from '../core/memory/PersonMemoryStore'
import { seedRelationshipsFromArchive } from '../core/memory/ArchiveRelationshipSeeder'
import { ingestContextFromArchive } from '../core/memory/ArchiveContextIngestor'
import { buildOwnerBiography } from '../core/memory/OwnerBiography'
import { OwnerPostIndex } from '../core/memory/OwnerPostIndex'
import { OsBotConfig } from './types'
import { MemorySummarizer } from '../core/memory/MemorySummarizer'
import { extractTopics } from '../core/memory/topicExtractor'

// ---------------------------------------------------------------------------
// Config Schema & Loading
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  blopus: z.object({
    handle: z.string(),
    userId: z.string(),
    displayName: z.string(),
  }),
  owner: z.object({
    handle: z.string(),
    displayName: z.string(),
  }),
  platform: z.object({
    primary: z.string(),
    pollIntervalMinutes: z.number().min(1),
    maxRepliesPerPollCycle: z.number(),
    maxRepliesPerDay: z.number(),
    replyDelayMinutes: z.object({ min: z.number(), max: z.number() }),
  }),
  personality: z.object({
    traits: z.object({
      aggression: z.number().min(0).max(1),
      warmth: z.number().min(0).max(1),
      humor: z.number().min(0).max(1),
      formality: z.number().min(0).max(1),
      verbosity: z.number().min(0).max(1),
    }),
    quirks: z.object({
      responseRate: z.number().min(0).max(1),
    }),
    replyTemplates: z.record(z.array(z.string())).optional(),
  }),
  llm: z.object({
    model: z.string(),
    autonomousModel: z.string().optional(),
    maxTokens: z.number(),
    temperature: z.number(),
    enabled: z.boolean(),
  }),
  summon: z.object({
    keywords: z.array(z.string()),
    requireOwnerHandle: z.boolean(),
  }),
  pack: z.object({
    knownOsBots: z.array(z.string()),
    tagProbability: z.number().min(0).max(1),
    maxTagsPerReply: z.number(),
  }),
  memory: z.object({
    storePath: z.string(),
    maxRecords: z.number(),
    pruneAfterDays: z.number(),
  }),
  rateLimits: z.object({
    monthlyPostBudget: z.number(),
    safetyBufferPercent: z.number(),
    minimumPollIntervalMinutes: z.number(),
    backoffOnErrorMs: z.number(),
    threadCooldownMinutes: z.number(),
  }),
  filters: z.object({
    ignoreRetweets: z.boolean().optional(),
    blocklist: z.array(z.string()).optional(),
    keywords: z.object({ mustNotContain: z.array(z.string()).optional() }).optional(),
  }).optional(),
  botDisclosure: z.object({
    appendToReplies: z.boolean().optional(),
    disclosureText: z.string().optional(),
  }).optional(),
  threads: z.object({
    enabled: z.boolean(),
    userId: z.string(),
  }).optional(),
}).passthrough()

async function loadOrBuildPersonalityProfile(configPath: string, handle: string): Promise<PersonalityProfile | undefined> {
  // Check config dir first, then creators/<handle>/ (where ingestors write to)
  const configDirPath   = path.join(path.dirname(path.resolve(configPath)), 'personality_profile.json')
  const creatorDirPath  = path.resolve(`creators/${handle}/personality_profile.json`)
  const profilePath     = fs.existsSync(configDirPath) ? configDirPath : creatorDirPath

  // Already exists — load, and patch behaviorProfile if missing (migration for existing profiles)
  if (fs.existsSync(profilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as PersonalityProfile
      if (!raw.behaviorProfile) {
        const archivePath = process.env.TWITTER_ARCHIVE_PATH
        if (archivePath && fs.existsSync(archivePath)) {
          log('info', 'Existing profile missing behaviorProfile — computing from archive...')
          const { parseTweetsJsFull } = await import('../core/personality/PersonalityIngester')
          const content = fs.readFileSync(archivePath, 'utf-8')
          const parsed = parseTweetsJsFull(content)
          raw.behaviorProfile = parsed.behaviorProfile
          fs.writeFileSync(profilePath, JSON.stringify(raw, null, 2))
          log('info', `behaviorProfile: avgPostsPerDay=${raw.behaviorProfile.avgPostsPerDay}, avgRepliesPerDay=${raw.behaviorProfile.avgRepliesPerDay}, qtRatio=${raw.behaviorProfile.quoteTweetRatio}, avgInterval=${raw.behaviorProfile.avgIntervalHours}h`)
        }
      }
      log('info', `Personality profile loaded from ${profilePath}`)
      return raw
    } catch {
      log('warn', `Failed to parse personality_profile.json — will rebuild.`)
    }
  }

  // Auto-build from archive if available
  const archivePath = process.env.TWITTER_ARCHIVE_PATH
  if (!archivePath || !fs.existsSync(archivePath)) {
    log('warn', `No personality_profile.json and no TWITTER_ARCHIVE_PATH set — personality features disabled.`)
    return undefined
  }

  log('info', `No personality profile found — building from archive at ${archivePath}...`)
  try {
    const raw = fs.readFileSync(archivePath, 'utf-8')
    const tweets = parseTweetsJsFull(raw)
    const profile = await analyzePersonalityFull(tweets, handle)
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2))
    log('info', `Personality profile built and saved to ${profilePath}`)
    return profile
  } catch (err) {
    log('warn', `Failed to auto-build personality profile: ${err}`)
    return undefined
  }
}

function loadConfig(): OsBotConfig {
  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  const resolved = path.resolve(configPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config file not found: ${resolved}\n` +
      'Copy config/blopus.config.json and fill in your details.'
    )
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'))
  const parsed = ConfigSchema.parse(raw)

  if (parsed.platform.pollIntervalMinutes < parsed.rateLimits.minimumPollIntervalMinutes) {
    throw new Error(
      `pollIntervalMinutes (${parsed.platform.pollIntervalMinutes}) must be >= ` +
      `minimumPollIntervalMinutes (${parsed.rateLimits.minimumPollIntervalMinutes})`
    )
  }

  return parsed as OsBotConfig
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function computeHumanDelay(config: OsBotConfig, moodMultiplier: number): number {
  const { min, max } = config.platform.replyDelayMinutes
  const baseMs = (min + Math.random() * (max - min)) * 60 * 1000
  return Math.round(baseMs * moodMultiplier)
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error'
const LOG_LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  if (LOG_LEVELS[level] >= (LOG_LEVELS[LOG_LEVEL] ?? 1)) {
    const ts = new Date().toISOString()
    console[level](`[${ts}] [OsBot] [${level.toUpperCase()}] ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// BlopusAgent
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PID lockfile — prevents duplicate instances from spamming replies
// ---------------------------------------------------------------------------

const LOCK_FILE = path.resolve(__dirname, '../osbot.lock')

function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = fs.readFileSync(LOCK_FILE, 'utf8').trim()
    // Check if that process is actually still running
    try {
      process.kill(Number(oldPid), 0)  // signal 0 = existence check, no kill
      // Reached here → process is alive
      console.error(`[OsBot] ERROR: Another instance is already running (PID ${oldPid}). Kill it first:\n  taskkill /F /PID ${oldPid}\nExiting.`)
      process.exit(1)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM') {
        // Windows: EPERM means process IS running but can't be signalled — still alive
        console.error(`[OsBot] ERROR: Another instance is already running (PID ${oldPid}). Kill it first:\n  taskkill /F /PID ${oldPid}\nExiting.`)
        process.exit(1)
      }
      // ESRCH = no such process = stale lock, safe to remove
      fs.unlinkSync(LOCK_FILE)
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
}

function releaseLock(): void {
  try { fs.unlinkSync(LOCK_FILE) } catch { /* already gone */ }
}

async function boot(): Promise<void> {
  acquireLock()
  process.on('exit', releaseLock)
  process.on('SIGINT', () => { releaseLock(); process.exit(0) })
  process.on('SIGTERM', () => { releaseLock(); process.exit(0) })
  process.on('uncaughtException', (err) => { releaseLock(); console.error(err); process.exit(1) })

  log('info', 'OsWald framework booting OsBot agent...')

  const configPath = process.env.BLOPUS_CONFIG_PATH ?? './config/blopus.config.json'
  const config = loadConfig()
  const isDryRun = process.env.NODE_ENV === 'dry-run'
  const personalityProfile = await loadOrBuildPersonalityProfile(configPath, config.blopus.handle)

  if (isDryRun) {
    log('warn', 'DRY-RUN mode — no tweets will be posted.')
  }

  const memoryPath = process.env.BLOPUS_MEMORY_PATH ?? config.memory.storePath
  const memory = new MemoryEngine(memoryPath, config.memory.maxRecords, config.memory.pruneAfterDays)
  const moodEngine = new MoodEngine(memory)
  const loyalty = new LoyaltyEngine(
    config.owner.handle,
    config.summon.keywords,
    config.summon.requireOwnerHandle,
  )

  const personality = new PersonalityEngine(config.personality.quirks)

  const isOwnerMode = (config as any).mode === 'MODE_B'

  // RAG: load (or auto-build) reply examples for owner mode (Phase 2 only)
  let ragRetriever: ExampleRetriever | undefined
  if (isOwnerMode) {
    const ragIndexPath = path.resolve(path.dirname(path.resolve(configPath)), 'rag_index.json')
    const archivePath = process.env.TWITTER_ARCHIVE_PATH ?? path.resolve(path.dirname(path.resolve(configPath)), 'tweets.js')
    ragRetriever = new ExampleRetriever(ragIndexPath)
    ragRetriever.load(archivePath)
    if (personalityProfile?.signaturePatterns?.length) {
      ragRetriever.setSignaturePatterns(personalityProfile.signaturePatterns)
    }
  }

  const fallbackTemplates = config.personality.replyTemplates ?? {
    defense: ["nah {author}. {owner}'s right.", 'interesting take {author}. wrong though.'],
    generic: ['noted {author}', '👀', 'interesting.'],
  }

  const llmEngine = new LLMReplyEngine(
    config.owner.handle,
    memory.getMood(),
    fallbackTemplates,
    config.llm,
    personalityProfile,
    isOwnerMode,
    ragRetriever,
  )

  const xClient = new XClient(config.blopus.userId)
  const xAdapter = new XAdapter(xClient, config.blopus.handle)
  const branchProvider = new BranchContextProvider()

  // Threads adapter (optional — only if THREADS_ACCESS_TOKEN is set and threads.enabled)
  const threadsToken = process.env.THREADS_ACCESS_TOKEN
  const threadsAdapter = (threadsToken && config.threads?.enabled && config.threads.userId)
    ? new ThreadsAdapter(new ThreadsClient(threadsToken, config.threads.userId, config.blopus.handle))
    : null

  if (threadsAdapter) {
    log('info', `Threads adapter active for user ID ${config.threads!.userId}`)
  }

  const xAccountKey = 'x:bot-own'
  const threadsAccountKey = 'threads:owner-own'

  // Shared user context — persists what owner says via Telegram across restarts
  const userContext = new UserContext(configPath)

  // Social graph — tracks every person OsBot replies to with quality scores
  const relationshipMemory = new RelationshipMemory(configPath)

  // Per-person deep memory — full conversation history, both sides, per person file
  const memoryStoreDir = path.resolve(path.dirname(path.resolve(configPath)), '../memory-store')
  const personMemory = new PersonMemoryStore(memoryStoreDir)

  // Owner post index — every post ever made, searchable by date/keyword via Telegram
  const postIndex = new OwnerPostIndex(memoryStoreDir)

  // Seed from Twitter archive (runs once per archive version, skips if already seeded)
  const archivePathForSeed = process.env.TWITTER_ARCHIVE_PATH ?? ''
  if (archivePathForSeed) {
    const relPath = path.join(memoryStoreDir, 'relationships.json')
    const seedResult = seedRelationshipsFromArchive(archivePathForSeed, relPath)
    if (seedResult.added > 0 || seedResult.merged > 0) {
      log('info', `[Archive] Relationship history seeded — ${seedResult.added} new handles, ${seedResult.merged} merged. Total: ${seedResult.total} people tracked.`)
    }
    personMemory.seedFromArchive(archivePathForSeed)
    const postSeedResult = postIndex.seedFromArchive(archivePathForSeed)
    if (!postSeedResult.skipped) {
      log('info', `[Archive] Owner post index seeded — ${postSeedResult.seeded} posts. Total tracked: ${postIndex.totalCount}`)
    }
  }

  const autonomousActivity = new AutonomousActivity(
    memory, llmEngine, xAdapter,
    xAccountKey,
    threadsAdapter,
    threadsAccountKey,
    config.owner.handle,
    personalityProfile,
    userContext,
    postIndex,
  )

  // Fetch owner's X userId once at startup for ViralReplyHunter
  const ownerUserId = await xClient.fetchUserIdByHandle(config.owner.handle).catch((err: unknown) => {
    log('warn', `Could not fetch owner userId (API may be unavailable): ${err}`)
    return null
  })
  const viralReplyHunter = new OwnerViralReplyHunter(
    llmEngine, xAdapter,
    new PlaywrightHomeTimelineProvider(),
    personalityProfile,
    config.blopus.handle,
    true,
  )

  // Auto-generate packId if not in config — bot account only
  const configPathResolved = path.resolve(configPath)
  const rawConfig = JSON.parse(fs.readFileSync(configPathResolved, 'utf-8'))
  let myPackId: string | null = null
  const isOwnerAccountEarly = config.blopus.handle.toLowerCase() === config.owner.handle.toLowerCase()
  if (!isOwnerAccountEarly) {
    if (!rawConfig.pack?.id) {
      if (!rawConfig.pack) rawConfig.pack = {}
      rawConfig.pack.id = PackDiscovery.generatePackId()
      fs.writeFileSync(configPathResolved, JSON.stringify(rawConfig, null, 2))
      log('info', `[Pack] Generated packId: ${rawConfig.pack.id} — auto-updating X bio`)
      // Auto-inject packId into bio so other OsBots can find this instance
      if (xAdapter.playwright) {
        const ok = await xAdapter.playwright.updateBio(` | ${rawConfig.pack.id}`, 'append')
        if (ok) log('info', `[Pack] Bio updated with ${rawConfig.pack.id}`)
        else log('warn', '[Pack] Bio update failed — add packId to bio manually')
      }
    }
    myPackId = rawConfig.pack.id as string
  }

  // OsBot automatically defends the owner when attacked — no summon needed
  const ownerDefender = new OwnerDefender(
    xAdapter, llmEngine,
    config.owner.handle,
    config.blopus.handle,
    process.env.ANTHROPIC_API_KEY!,
  )

  // OsBots automatically discover each other across X
  const packDiscovery = new PackDiscovery(
    xAdapter, llmEngine,
    myPackId ?? '',
    config.blopus.handle,
    configPathResolved,
    personMemory,
    config.owner.handle,
  )

  // Vision-based DM — uses Claude to read page, no hardcoded selectors, never breaks on X UI changes
  const mcpDm = xAdapter.playwright ? new MCPBrowserDM(xAdapter.playwright) : null

  // OsBots autonomously chat with known pack members — memory-aware, no human trigger
  const packChatter = new PackChatter(xAdapter, llmEngine, config.blopus.handle, personMemory, mcpDm ?? undefined)

  // Polls inbox every 20min — replies autonomously (OsBot) or drafts to Telegram (owner)
  // Owner account: config.blopus.handle === config.owner.handle (running as themselves)
  const isOwnerAccount = config.blopus.handle.toLowerCase() === config.owner.handle.toLowerCase()
  const dmPoller = mcpDm ? new DmInboxPoller(
    mcpDm,
    personMemory,
    llmEngine,
    config.blopus.handle,
    isOwnerAccount,                            // owner needs Telegram approval gate
    () => moodEngine.getCurrentMood(),
    async (draft) => {
      if (!telegram) return
      const reasonLabel = draft.reason === 'first_contact' ? '👤 First contact' : draft.reason === 'uncertain' ? '❓ Bot unsure' : '⚠️ Tone anomaly'
      const mem = personMemory.load(draft.handle)
      const memLines: string[] = []
      if (mem && mem.totalInteractions > 0) {
        memLines.push(`Known: ${mem.totalInteractions} interactions across ${mem.conversations?.length ?? 0} convos`)
        if (mem.relationshipType && mem.relationshipType !== 'unknown') memLines.push(`Relationship: ${mem.relationshipType}`)
        if (mem.ownerToneWithThem) memLines.push(`Your usual tone: ${mem.ownerToneWithThem}`)
        if (mem.dominantTopics?.length) memLines.push(`Topics: ${mem.dominantTopics.slice(0, 3).join(', ')}`)
        if (typeof mem.score === 'number') memLines.push(`Rep score: ${mem.score}`)
        if (mem.notableEvents?.length) {
          const renames = mem.notableEvents.filter(e => e.includes('renamed'))
          if (renames.length) memLines.push(renames[renames.length - 1])
          const first = mem.notableEvents.find(e => e.includes('first interaction'))
          if (first) memLines.push(first)
        }
      } else {
        memLines.push('Never interacted before — genuinely new contact')
      }
      const threadLines = draft.thread?.slice(-8)
        .map(m => `${m.by === 'me' ? 'you' : '@' + draft.handle}: ${m.text}`)
        .join('\n')
      await telegram.sendNotification(
        `${reasonLabel} — DM from @${draft.handle}\n\n` +
        (threadLines ? `Thread:\n${threadLines}\n\n` : `Their message: "${draft.theirMessage}"\n\n`) +
        (memLines.length ? `Context:\n${memLines.map(l => `• ${l}`).join('\n')}\n\n` : '') +
        (draft.reason === 'uncertain' && draft.uncertainAbout
          ? `Bot doesn't know: ${draft.uncertainAbout}\n\n`
          : '') +
        `My draft:\n"${draft.draft}"\n\n` +
        (draft.reason === 'uncertain'
          ? `Say: answer @${draft.handle}: [the fact]  — saves permanently + sends reply\nOr override: send dm @${draft.handle} [your text]`
          : `Say: approve dm @${draft.handle}  — or edit and say: send dm @${draft.handle} [your text]`)
      ).catch(() => {})
    },
    isOwnerAccount ? undefined : config.owner.handle,   // OsBot knows its owner; owner account doesn't need this
  ) : null

  const rateLimiter = new RateLimiter(
    {
      monthlyPostBudget: config.rateLimits.monthlyPostBudget,
      safetyBufferPercent: config.rateLimits.safetyBufferPercent,
      maxRepliesPerDay: config.platform.maxRepliesPerDay,
      maxRepliesPerPollCycle: config.platform.maxRepliesPerPollCycle,
      backoffOnErrorMs: config.rateLimits.backoffOnErrorMs,
      threadCooldownMinutes: config.rateLimits.threadCooldownMinutes,
    },
    memory,
  )

  const decisionEngine = new DecisionEngine(
    loyalty,
    config.pack.knownOsBots,
    config.blopus.handle,
    config.filters?.blocklist ?? [],
    config.filters?.keywords?.mustNotContain ?? [],
    config.filters?.ignoreRetweets ?? true,
  )

  const disclosureText = config.botDisclosure?.appendToReplies
    ? (config.botDisclosure.disclosureText ?? '^🤖 auto')
    : null

  // XToolsServer — HTTP server on port 7821, shares the same PlaywrightXClient as the autonomous system.
  // XToolsMcpServer (child process) proxies all tool calls here — no second browser, always authenticated.
  if (xAdapter.playwright) {
    const xtoolsRagPath = path.resolve(path.dirname(path.resolve(configPath)), 'rag_index.json')
    const xtoolsArchivePath = process.env.TWITTER_ARCHIVE_PATH ?? path.resolve(path.dirname(path.resolve(configPath)), 'tweets.js')
    const xtoolsShared = new XTools({
      xAdapter,
      playwrightClient: xAdapter.playwright,
      profile: personalityProfile ?? ({} as any),
      configPath,
      ragIndexPath: xtoolsRagPath,
      archivePath: xtoolsArchivePath,
      mcpDm: mcpDm ?? undefined,
    })
    startXToolsServer(xtoolsShared)
    log('info', 'XToolsServer started on port 7821 — Telegram X tools wired to shared Playwright.')
  } else {
    log('warn', 'XToolsServer not started — X_PASSWORD not set, Playwright unavailable.')
  }

  // Telegram control channel (optional — only if TELEGRAM_BOT_TOKEN is set)
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN
  const telegramChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  const telegram = telegramToken && telegramChatId
    ? new TelegramAdapter(telegramToken, telegramChatId, memory, moodEngine, configPath)
    : null

  if (telegram) {
    telegram.setPersonStore(personMemory)
    if (dmPoller) telegram.setDmPoller(dmPoller)
    telegram.start()
    log('info', 'Telegram control channel active.')
  }

  // --- Startup: auto-ingest user context from archive (what they're working on, goals) ---
  if (archivePathForSeed) {
    const flagDir = path.resolve(path.dirname(path.resolve(configPath)), '../memory-store')
    const wasFirstRun = userContext.getAll().length === 0
    const seeded = await ingestContextFromArchive(archivePathForSeed, userContext, config.owner.handle, flagDir)

    // Build full biography from entire archive — all months, full evolution
    const bioPath = path.join(flagDir, 'owner_biography.json')
    buildOwnerBiography(archivePathForSeed, config.owner.handle, bioPath).catch(err =>
      console.warn('[OwnerBiography] Failed:', err)
    )

    if (seeded) {
      log('info', '[Archive] User context seeded from recent tweets — OsBot now knows what you\'re working on')
      if (telegram) {
        const facts = userContext.getAll()
        const factList = facts.map(f => `• ${f.text.replace('[from archive] ', '')}`).join('\n')
        await telegram.sendNotification(
          `I read your tweet history. Here's what I figured out about you:\n\n${factList}\n\nIs this still accurate? Anything changed or missing? I'll use this when people ask you personal questions on X — so the more precise you are, the better I answer.\n\nJust reply here to correct or add anything.`
        ).catch(() => {})
      }
    } else if (wasFirstRun && userContext.getAll().length === 0 && telegram) {
      await telegram.sendNotification(
        `hey — I'm running but I don't have enough context about you yet.\n\nTell me:\n• What are you currently building or working on?\n• Any goals I should know about?\n• Anything specific you want me to say (or avoid) when people ask about your life/work?\n\nI'll save this and use it when replying to personal questions on your behalf.`
      ).catch(() => {})
    }
  }

  // --- Startup: send pending DM ingest report to Telegram ---
  if (telegram) {
    const reportPath = path.resolve('./memory-store/dm_ingest_report.txt')
    if (fs.existsSync(reportPath)) {
      try {
        const report = fs.readFileSync(reportPath, 'utf-8')
        // Send in chunks — Telegram has 4096 char limit per message
        const CHUNK = 3800
        if (report.length <= CHUNK) {
          await telegram.sendNotification(report).catch(() => {})
        } else {
          for (let i = 0; i < report.length; i += CHUNK) {
            await telegram.sendNotification(report.slice(i, i + CHUNK)).catch(() => {})
            await new Promise(r => setTimeout(r, 300))
          }
        }
        fs.unlinkSync(reportPath)  // consumed — don't send again on next restart
      } catch {}
    }
  }

  // --- Daily summary — every evening at 9 PM (only if bot is running) ---
  if (telegram) {
    cron.schedule('0 21 * * *', async () => {
      try {
        const summary = await telegram.generateDailySummary()
        await telegram.sendNotification(summary).catch(() => {})
      } catch (err) {
        log('warn', `Daily summary failed: ${err}`)
      }
    })
  }

  // --- Startup: summarize past weeks if needed ---
  try {
    const summarizer = new MemorySummarizer(memory, config.llm.model)
    await summarizer.summarizeIfNeeded()
  } catch (err) {
    log('warn', `MemorySummarizer failed: ${err}`)
  }

  // --- Startup: recover overdue pending replies ---
  log('info', 'Checking for overdue pending replies from previous session...')
  const overdue = memory.getOverduePendingReplies()
  for (const pending of overdue) {
    log('info', `Recovering pending reply ${pending.id} (due: ${pending.fireAt})`)
    try {
      if (!isDryRun) {
        await xAdapter.postReply({ text: pending.replyText, inReplyToTweetId: pending.inReplyToTweetId })
      }
      memory.markPendingSent(pending.id)
      rateLimiter.recordPost()
      log('info', `Recovered reply ${pending.id}`)
    } catch (err) {
      const msg = String(err)
      // 403 = tweet gone/deleted/rate-limited — will never succeed, mark sent to stop retrying
      if (msg.includes('403') || msg.includes('404')) {
        memory.markPendingSent(pending.id)
        log('warn', `Pending reply ${pending.id} permanently failed (${msg.includes('403') ? '403' : '404'}) — cleared`)
      } else {
        log('error', `Failed to recover pending reply ${pending.id}: ${err}`)
      }
    }
  }

  log('info', `OsBot @${config.blopus.handle} ready. Polling every ${config.platform.pollIntervalMinutes}min.`)
  log('info', `Monthly usage: ${rateLimiter.getMonthlyUsage()}/${rateLimiter.getEffectiveBudget()}`)
  log('info', `LLM: ${config.llm.enabled ? config.llm.model : 'disabled (template fallback)'}`)
  if (personalityProfile?.behaviorProfile) {
    const bp = personalityProfile.behaviorProfile
    log('info', `[Archive behavior] posts/day=${bp.avgPostsPerDay} | interval=${bp.avgIntervalHours}h | replies/day=${bp.avgRepliesPerDay} | cooldown=${Math.round((24*60)/bp.avgRepliesPerDay)}min | typical hours (UTC)=[${bp.typicalPostingHours.join(',')}]`)
  }
  if (personalityProfile?.dominantTopics?.length) {
    const configPath = process.env.BLOPUS_CONFIG_PATH ?? './creators/shoryaDs7/config.json'
    let replyMode = 'domain'
    try { replyMode = JSON.parse(fs.readFileSync(path.resolve(configPath), 'utf-8')).replyMode ?? 'domain' } catch {}
    if (replyMode === 'domain') {
      if (personalityProfile.postTopics?.length) {
        log('info', `[Post topics — what you post about]:`)
        personalityProfile.postTopics.forEach(t => log('info', `  · ${t}`))
      }
      log('info', `[Reply topics — what bot will hunt & reply to]:`)
      personalityProfile.dominantTopics.forEach(t => log('info', `  · ${t}`))
    }
  }

  // --- Main poll function ---
  async function runCycle(): Promise<void> {
    log('debug', 'Poll cycle starting.')

    moodEngine.updateMood('TICK')

    if (memory.isMuted()) {
      log('info', 'OsBot is muted — skipping cycle.')
      return
    }

    if (!rateLimiter.canRunCycle()) {
      log('info', 'Cycle skipped by rate limiter.')
      return
    }

    let mentions
    try {
      const xMentions = await xAdapter.fetchOwnMentions(memory.getLastSinceId())
      const threadsMentions = threadsAdapter ? await threadsAdapter.fetchOwnMentions() : []
      mentions = [...xMentions, ...threadsMentions]
    } catch (err: unknown) {
      const e = err as { statusCode?: number }
      rateLimiter.recordError(e?.statusCode ?? 500)
      log('error', `Failed to fetch mentions: ${err}`)
      return
    }

    // Autonomous posting — run every cycle regardless of mention activity
    await autonomousActivity.maybePost(moodEngine.getCurrentMood())
    await viralReplyHunter.maybeReply(moodEngine.getCurrentMood())

    // Bot account only (aiblopus) — defend owner, discover pack, chat with pack
    if (!isOwnerAccount) {
      await ownerDefender.maybeDefend(moodEngine.getCurrentMood())
      await packDiscovery.maybeDiscover(moodEngine.getCurrentMood())
      await packChatter.maybeChat(config.pack.knownOsBots, moodEngine.getCurrentMood())
    }

    // DM inbox polling — both accounts (OsBot auto-replies, owner drafts to Telegram)
    if (dmPoller) await dmPoller.maybePoll()

    if (mentions.length === 0) {
      log('debug', 'No new mentions.')
      return
    }

    // Persist sinceId — use explicit MAX(tweetId) across all returned mentions
    const maxId = mentions.reduce(
      (max, m) => (m.tweetId > max ? m.tweetId : max),
      mentions[0].tweetId,
    )
    memory.updateSinceId(maxId)

    const decisions = mentions
      .map(m => {
        const d = decisionEngine.classify(m)
        log('info', `Mention ${m.tweetId} @${m.authorHandle} → classified as ${d.type}`)
        return d
      })
      .filter(d => {
        if (d.type === 'IGNORE') {
          log('info', `Skipping ${d.mention.tweetId}: IGNORE (not a trigger)`)
          return false
        }
        if (memory.hasReplied(d.mention.tweetId)) {
          log('info', `Skipping ${d.mention.tweetId}: already replied`)
          return false
        }
        // MODE_B (owner account): only reply if the ROOT tweet was posted by the owner
        // This ensures we only engage in threads that @shoryaDs7 started, not threads
        // where they replied to someone else and a third party replied to that reply
        if (isOwnerMode) {
          const root = d.mention.threadContext?.rootTweet
          if (!root || root.authorHandle?.toLowerCase() !== config.blopus.handle.toLowerCase()) {
            log('info', `Skipping ${d.mention.tweetId}: MODE_B — thread not started by owner`)
            return false
          }
        }
        return true
      })

    if (decisions.length === 0) {
      log('debug', 'All mentions filtered out.')
      return
    }

    const prioritized = decisionEngine.prioritize(decisions).slice(0, rateLimiter.getCycleLimit())

    // Guard against same tweetId being queued twice in one cycle
    // (Twitter API sometimes returns duplicate mentions; recordReply is async so hasReplied won't catch it mid-loop)
    const queuedThisCycle = new Set<string>()

    for (const decision of prioritized) {
      if (queuedThisCycle.has(decision.mention.tweetId)) {
        log('info', `Skipping ${decision.mention.tweetId}: duplicate in this cycle`)
        continue
      }

      if (!rateLimiter.canPostNow()) {
        log('warn', 'Rate limit reached mid-cycle. Stopping.')
        break
      }

      // Human-like ignore (responseRate check)
      if (!personality.shouldReply()) {
        log('info', `Ignoring @${decision.mention.authorHandle} (responseRate roll)`)
        continue
      }

      // Empty mention (image-only or no text at all) — skip LLM, fire a confused response
      const strippedText = decision.mention.text.replace(/@\w+/g, '').trim()
      if (!strippedText) {
        const EMPTY_MENTION_REPLIES = [
          'huh?',
          'what?',
          'why u called? i have things to do',
          'say what happened',
          'u good?',
          'yeah?',
          '...what',
          'ok but say something',
          'u pinged me for this?',
          'hello??? words???',
          'i was busy. what do u want',
          'summoned me and said nothing. bold.',
        ]
        const emptyReply = EMPTY_MENTION_REPLIES[Math.floor(Math.random() * EMPTY_MENTION_REPLIES.length)]
        log('info', `Empty mention from @${decision.mention.authorHandle} — firing confused response`)
        log('debug', `Empty reply text: "${emptyReply}"`)
        queuedThisCycle.add(decision.mention.tweetId)
        if (!isDryRun) {
          await xAdapter.postReply({ text: emptyReply, inReplyToTweetId: decision.mention.tweetId })
          rateLimiter.recordPost()
          memory.recordReply({
            tweetId: decision.mention.tweetId,
            replyTweetId: decision.mention.tweetId,
            authorId: decision.mention.authorId,
            authorHandle: decision.mention.authorHandle,
            conversationId: decision.mention.conversationId,
            mentionText: decision.mention.text.slice(0, 280),
            replyText: emptyReply,
            timestamp: new Date().toISOString(),
            traitSnapshot: config.personality.traits,
            mood: moodEngine.getCurrentMood(),
          })
        }
        continue
      }

      const mood = moodEngine.getCurrentMood()
      const interactionCount = memory.getInteractionCount(decision.mention.authorId)

      if (decision.type === 'SUMMON') moodEngine.updateMood('SUMMONED')
      if (decision.type === 'PACK_SIGNAL') moodEngine.updateMood('PACK_TAGGED_IN')

      // Sync mood to LLM engine
      llmEngine.updateMood(mood)

      // Phase 2.5: fetch sibling replies for atmosphere on summon
      if (decision.type === 'SUMMON' && decision.mention.inReplyToTweetId) {
        const siblings = await branchProvider.fetchSiblingReplies(decision.mention.inReplyToTweetId)
        if (siblings.length > 0) {
          if (!decision.mention.threadContext) decision.mention.threadContext = {}
          decision.mention.threadContext.atmosphereTweets = siblings
          log('debug', `[Atmosphere] ${siblings.length} sibling replies attached for conv ${decision.mention.conversationId}`)
        }
      }

      // Conversation reply cap — prevent infinite bot loops
      // Owner is never capped. Known bots (Grok, AI agents, spam pattern) get cap of 2.
      // Everyone else: 3. RelationshipMemory detects spam pattern over time.
      const isOwner = decision.mention.authorHandle.toLowerCase() === config.owner.handle.toLowerCase()
      const handleLower = decision.mention.authorHandle.toLowerCase()
      const BOT_HANDLE_PATTERNS = ['grok', 'bot', '_ai', 'ai_', 'gpt', 'claude', 'agent', 'llm', 'assistant']
      const looksLikeBot = BOT_HANDLE_PATTERNS.some(p => handleLower.includes(p))
      const isKnownSpammer = relationshipMemory.isBotLike(decision.mention.authorHandle)
      const isBot = looksLikeBot || isKnownSpammer
      const MAX_REPLIES_PER_CONVERSATION = isOwner ? Infinity : isBot ? 2 : 3
      const convReplyCount = memory.getConversationReplyCount(decision.mention.conversationId)
      if (convReplyCount >= MAX_REPLIES_PER_CONVERSATION) {
        log('info', `Skipping @${decision.mention.authorHandle} — conv cap reached (${convReplyCount}/${MAX_REPLIES_PER_CONVERSATION})${isBot ? ' [bot]' : ''} in conv ${decision.mention.conversationId}`)
        // Still record this as a negative interaction — spamming after cap = bad signal
        // This makes the reputation score go negative even without OsBot replying
        relationshipMemory.recordInteraction(decision.mention.authorHandle, -1, false)
        continue
      }

      // On the final reply: bots get a canned exit line, humans get a context-aware LLM closer
      const BOT_EXIT_LINES = [
        'ok fine. you win. i have 100 other things going on.',
        'alright alright. you outlasted me. respect.',
        'ok i\'m actually done here. you win this one.',
        'fine. i\'m tired. you got it.',
        'this could go forever but i genuinely have places to be. you win.',
        'ok you clearly have more time than me. noted. i\'m out.',
      ]
      const isLastReply = convReplyCount === MAX_REPLIES_PER_CONVERSATION - 1

      // Load full per-person memory — every conversation, both sides, tone patterns
      const personContext = personMemory.getContextForClaude(decision.mention.authorHandle)

      // Fall back to shallow relationship context if no deep memory yet
      const relationshipContext = personContext || relationshipMemory.getRelationshipContext(decision.mention.authorHandle)

      // Check if this mention is a reply to one of OsBot's own autonomous posts
      // If yes, inject the original post text so OsBot knows what it said and why
      const originalPost = decision.mention.inReplyToTweetId
        ? memory.getAutonomousPost(decision.mention.inReplyToTweetId)
        : null
      if (originalPost?.topic) {
        // Someone replied to our post — this topic is engaging. Boost it so future posts favour it.
        const acctKey = `x:${(originalPost as any).accountType ?? 'bot-own'}`
        memory.boostTopicEngagement(acctKey, originalPost.topic, 1)
      }
      const ownPostContext = originalPost
        ? `This person is replying to YOUR tweet that you posted autonomously about "${originalPost.topic}". Your original tweet was: "${originalPost.text}". Respond knowing what you said and why.`
        : undefined

      // Inject what the owner has told OsBot about themselves (via Telegram)
      // This ensures personal questions are answered from real facts, not hallucination
      const ownerContextBlock = userContext.toPromptBlock() || undefined

      // Detect personal questions — things only the owner can answer accurately
      const PERSONAL_QUESTION_PATTERNS = [
        /what (are you|r u) (working|building|making|shipping|doing)/i,
        /do you have a (startup|company|product|project|business)/i,
        /what('?s| is) your (startup|company|project|product|business)/i,
        /tell me about (your|urself|yourself)/i,
        /what do you do\b/i,
        /are you (building|working on|shipping)/i,
        /what have you been (working|building|shipping)/i,
        /your (current )?project/i,
        /what('?s| is) (oswald|osbot|your (thing|app|tool|product))/i,
      ]
      const isPersonalQuestion = PERSONAL_QUESTION_PATTERNS.some(p => p.test(decision.mention.text))

      // If personal question and no owner context at all → alert Telegram and hold the reply
      // OsBot should not guess about the owner's life when it has zero facts
      if (isPersonalQuestion && !ownerContextBlock) {
        log('info', `Personal question from @${decision.mention.authorHandle} — no context available, alerting owner`)
        if (telegram) {
          await telegram.sendNotification(
            `someone asked you something personal:\n@${decision.mention.authorHandle}: "${decision.mention.text.slice(0, 200)}"\n\nI checked my memory and archive — I don't have clear enough facts to answer this. What should I say? Reply here and I'll handle it.`
          ).catch(() => {})
        }
        continue
      }

      // Generate reply via LLM (or fallback)
      let replyText = isLastReply && isBot
        ? BOT_EXIT_LINES[Math.floor(Math.random() * BOT_EXIT_LINES.length)]
        : await llmEngine.generateReply({
        mentionText: decision.mention.text,
        authorHandle: decision.mention.authorHandle,
        authorId: decision.mention.authorId,
        mentionType: decision.type,
        previousInteractions: interactionCount,
        mood,
        traits: config.personality.traits,
        threadContext: decision.mention.threadContext,
        mediaUrls: decision.mention.mediaUrls,
        isConversationCloser: isLastReply && !isBot,
        quotedTweetText: decision.mention.quotedTweetText,
        relationshipContext: relationshipContext || undefined,
        ownPostContext,
        ownerContext: ownerContextBlock,
      })

      // Post-processing: bot disclosure
      if (disclosureText) {
        replyText = (replyText + '\n' + disclosureText).slice(0, 280)
      } else {
        replyText = replyText.slice(0, 280)
      }

      // Schedule with human delay
      const delayMs = computeHumanDelay(config, moodEngine.getDelayMultiplier())
      const fireAt = new Date(Date.now() + delayMs).toISOString()
      const pendingId = uuidv4()

      log('info', `Scheduling reply to @${decision.mention.authorHandle} (${decision.type}) in ${Math.round(delayMs / 60000)}min`)
      log('debug', `Reply text: "${replyText}"`)

      // Mark as queued so duplicates in this same cycle are skipped
      queuedThisCycle.add(decision.mention.tweetId)

      // Persist pending reply BEFORE timer (crash-safe)
      memory.addPendingReply({
        id: pendingId,
        replyText,
        inReplyToTweetId: decision.mention.tweetId,
        fireAt,
        sent: false,
      })

      setTimeout(async () => {
        try {
          // Guard: skip if already sent (e.g. recovered by overdue handler on restart)
          if (memory.isPendingSent(pendingId)) {
            log('info', `Pending reply ${pendingId} already sent — skipping duplicate fire`)
            return
          }

          let replyTweetId = 'dry-run'

          if (!isDryRun) {
            const replyPayload = { text: replyText, inReplyToTweetId: decision.mention.tweetId }
            if (decision.mention.platform === 'threads' && threadsAdapter) {
              replyTweetId = await threadsAdapter.postReply(replyPayload)
            } else {
              replyTweetId = await xAdapter.postReply(replyPayload)
            }
          } else {
            log('warn', `[DRY-RUN] Would post: "${replyText}"`)
          }

          memory.recordReply({
            tweetId: decision.mention.tweetId,
            replyTweetId,
            authorId: decision.mention.authorId,
            authorHandle: decision.mention.authorHandle,
            conversationId: decision.mention.conversationId,
            mentionText: decision.mention.text.slice(0, 280),
            replyText,
            timestamp: new Date().toISOString(),
            traitSnapshot: config.personality.traits,
            mood,
          })

          memory.markPendingSent(pendingId)
          rateLimiter.recordPost()

          // Update social graph — score this interaction and record context
          const intScore = relationshipMemory.scoreInteraction(decision.mention.text, convReplyCount)
          const isNewConv = convReplyCount === 0
          const topicWords = extractTopics([decision.mention.text])
          const highlight = isNewConv && topicWords.length > 0
            ? `first met in thread ${decision.mention.conversationId} — topic: ${topicWords.slice(0, 3).join(', ')}`
            : undefined
          relationshipMemory.recordInteraction(decision.mention.authorHandle, intScore, isNewConv, highlight)

          // Save full exchange to per-person deep memory (both sides — what they said + what OsBot replied)
          personMemory.recordExchange(
            decision.mention.authorHandle,
            decision.mention.text,
            replyText,
            decision.mention.tweetId,
            'x',
          )

          // Append to owner post index — grows the searchable history going forward
          postIndex.append({
            text: replyText,
            date: new Date().toISOString(),
            type: 'reply',
            replyTo: decision.mention.authorHandle,
          })

          if (telegram) {
            await telegram.sendNotification(
              `replied to @${decision.mention.authorHandle}:\n"${replyText}"`
            ).catch(() => {})
          }

          const replyPlatform = decision.mention.platform ?? 'x'
          const replyAccountKey = replyPlatform === 'threads' ? threadsAccountKey : xAccountKey
          memory.recordPlatformEvent({
            platform: replyPlatform,
            type: 'reply_given',
            summary: `replied to @${decision.mention.authorHandle} on ${replyPlatform}: "${replyText.slice(0, 80)}"`,
          })
          const replyTopics = extractTopics([decision.mention.text, replyText])
          memory.updateRecurringUser(replyAccountKey, decision.mention.authorHandle, replyPlatform, replyTopics)
          memory.updateTopicPerformance(replyAccountKey, replyTopics)

          log('info', `Reply sent to @${decision.mention.authorHandle} → tweet ${replyTweetId}`)
        } catch (err: unknown) {
          const e = err as { statusCode?: number }
          rateLimiter.recordError(e?.statusCode ?? 500)
          log('error', `Failed to post reply: ${err}`)
        }
      }, delayMs)
    }

  }

  const cronExpr = `*/${config.platform.pollIntervalMinutes} * * * *`
  cron.schedule(cronExpr, () => {
    runCycle().catch(err => log('error', `Unhandled error in cycle: ${err}`))
  })


  // Run immediately on startup
  await runCycle()
}

boot().catch(err => {
  console.error('[OsBot] [FATAL]', err)
  process.exit(1)
})
