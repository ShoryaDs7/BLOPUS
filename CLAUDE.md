# Blopus — Claude Code Instructions

This file tells any Claude instance everything needed to work on Blopus without prior context.

---

## What is Blopus?

Blopus is an open-source **social pack-intelligence framework** for autonomous bots. The ultimate goal: **replace your digital life with OsBot** — users upload their archive, OsBot becomes them everywhere online, posting and replying in their exact voice across all platforms.

Built with: TypeScript, tsx, node-cron, Anthropic SDK, twitter-api-v2, Playwright, grammy (Telegram), snoowrap (Reddit), discord.js-selfbot-v13.

---

## Two Modes

| Mode | Description | Entry point |
|------|-------------|-------------|
| MODE_A (Phase 1) | OsBot controls its OWN bot account with its own personality | `agent/run-blopus-bot.ts` |
| MODE_B (Phase 2+) | OsBot controls the OWNER's real account — posts AS the owner in their exact voice | `agent/run-blopus-owner.ts` |

**CRITICAL: Never modify `agent/BlopusAgent.ts` or anything in Phase 1. It is complete and protected.**

---

## Phases

| Phase | Platform | Status | Entry point |
|-------|----------|--------|-------------|
| 1 | X (Twitter) — bot's own account | DONE, NEVER TOUCH | `agent/run-blopus-bot.ts` |
| 2 | X (Twitter) — owner's account | DONE | `agent/run-blopus-owner.ts` |
| 3 | Reddit — owner's account | BUILT (gitignored, not public yet) | `agent/run-blopus-reddit.ts` |
| 4 | Discord — owner's real account (selfbot) | BUILT (gitignored, not public yet) | `agent/run-blopus-discord.ts` |
| 5 | Telegram — owner's personal account | BUILT and working | `adapters/telegram/index.ts` |
| 6 | Control chatbot — natural language admin UI | PLANNED | — |

---

## File Structure

```
Blopus/
├── agent/
│   ├── BlopusAgent.ts              ← Phase 1+2 X agent (DO NOT TOUCH)
│   ├── BlopusAgentReddit.ts        ← Phase 3 Reddit agent (gitignored)
│   ├── BlopusAgentDiscord.ts       ← Phase 4 Discord agent (gitignored)
│   ├── run-blopus-bot.ts           ← boots Phase 1
│   ├── run-blopus-owner.ts         ← boots Phase 2
│   ├── run-blopus-reddit.ts        ← boots Phase 3
│   ├── run-blopus-discord.ts       ← boots Phase 4
│   ├── ViralReplyHunter.ts         ← scans X home timeline for viral tweets (Phase 1)
│   ├── OwnerViralReplyHunter.ts    ← same but for owner mode (Phase 2)
│   ├── OwnerDefender.ts            ← detects hostile replies to owner's tweets, auto-defends
│   ├── DecisionEngine.ts           ← decides when/what to post autonomously
│   ├── AutonomousActivity.ts       ← schedules autonomous posts
│   ├── EngagementEngine.ts         ← tracks engagement signals, boosts top topics
│   ├── DmInboxPoller.ts            ← polls DM inbox, routes to voice-matched replies (disabled until dm-setup run)
│   ├── MCPBrowserDM.ts             ← sends/reads DMs via Playwright browser
│   ├── PackDiscovery.ts            ← discovers other OsBots on X via blopus: signature
│   ├── PackChatter.ts              ← bot-to-bot chatter between known pack members
│   └── types.ts
│
├── core/
│   ├── personality/
│   │   ├── LLMReplyEngine.ts       ← generates replies via Claude API (Haiku by default)
│   │   ├── PersonalityIngester.ts  ← parses Twitter archive → PersonalityProfile
│   │   ├── PersonalityEngine.ts    ← trait management
│   │   ├── MoodEngine.ts           ← mood state machine (NEUTRAL/FIRED_UP/REFLECTIVE/etc)
│   │   └── types.ts
│   ├── memory/
│   │   ├── MemoryEngine.ts         ← read/write memory.json — tracks replies, users, events, topic performance
│   │   ├── PersonMemoryStore.ts    ← per-person JSON files — relationship type, tone, DM voice profile, conversation history
│   │   ├── MemorySummarizer.ts     ← summarizes old memory to save space
│   │   ├── ArchiveContextIngestor.ts ← ingests Twitter archive into person memory
│   │   ├── ArchiveRelationshipSeeder.ts ← seeds relationship types from archive
│   │   ├── OwnerBiography.ts       ← builds owner bio from archive for context injection
│   │   ├── OwnerPostIndex.ts       ← indexes owner's posts for fast lookup
│   │   ├── RelationshipMemory.ts   ← tracks relationship evolution over time
│   │   ├── topicExtractor.ts       ← extracts topics from text
│   │   └── types.ts
│   ├── ingest/
│   │   └── FullArchiveIngestor.ts  ← full Twitter archive ingestion pipeline
│   ├── rag/
│   │   └── ExampleRetriever.ts     ← RAG: retrieves real reply examples by keyword+type
│   ├── packEngine/
│   │   └── PackEngine.ts           ← manages bot pack relationships (Phase 1)
│   ├── loyaltyEngine/
│   │   └── LoyaltyEngine.ts        ← tracks loyalty scores between bots
│   └── rogueEngine/
│       └── RogueEngine.ts          ← rogue behavior triggers
│
├── adapters/
│   ├── x/
│   │   ├── XAdapter.ts                          ← wraps twitter-api-v2
│   │   ├── XClient.ts                           ← Twitter API client
│   │   ├── PlaywrightXClient.ts                 ← Playwright-based X actions (login, post, DM, search)
│   │   ├── PlaywrightHomeTimelineProvider.ts    ← scrapes X home timeline (For You feed)
│   │   ├── PlaywrightTopicSearchProvider.ts     ← searches tweets by topic via Playwright
│   │   ├── PlaywrightDomainSearchProvider.ts    ← domain-filtered tweet search
│   │   ├── BranchContextProvider.ts             ← fetches full tweet thread context
│   │   ├── SearchMentionsProvider.ts            ← fetches @mentions via API
│   │   ├── TopicSearchProvider.ts               ← searches tweets by topic via API
│   │   ├── RateLimiter.ts                       ← rate limiting for X API calls
│   │   └── types.ts
│   ├── control/
│   │   ├── SessionBrain.ts         ← Telegram session brain — routes messages to Claude agent SDK
│   │   ├── BrowserAgent.ts         ← Playwright browser agent for MCP DM actions
│   │   ├── XTools.ts               ← X tool definitions for Claude tool use
│   │   ├── XToolsServer.ts         ← HTTP server exposing XTools to Claude
│   │   ├── XToolsMcpServer.ts      ← MCP stdio proxy for XTools
│   │   ├── FocusOverride.ts        ← reads focus override from disk (pause/resume bot)
│   │   ├── RuntimeConfig.ts        ← reads runtime config overrides from disk
│   │   └── UserContext.ts          ← loads user context (config, personality, memory paths)
│   ├── search/
│   │   └── TavilyClient.ts         ← Tavily web search API client
│   ├── telegram/
│   │   ├── index.ts                ← TelegramAdapter: full grammy-based Telegram bot, routes to SessionBrain
│   │   └── SetupWizard.ts          ← Telegram setup wizard stub
│   ├── web/
│   │   └── PlaywrightWebScraper.ts ← general Playwright web scraper (used by XTools)
│   ├── reddit/    ← gitignored, not public yet
│   ├── discord/   ← gitignored, not public yet
│   └── threads/   ← gitignored, not public yet
│
├── scripts/
│   ├── setup.ts                    ← main onboarding wizard (run: npm run setup)
│   ├── setup-voice.ts              ← step: interview owner's voice/writing style
│   ├── setup-reply.ts              ← step: configure reply behavior
│   ├── setup-reply-back.ts         ← step: configure reply-back behavior
│   ├── setup-reply-behavior.ts     ← step: configure reply tone and patterns
│   ├── setup-domain.ts             ← step: configure topic domains
│   ├── setup-original-posts.ts     ← step: configure original post behavior
│   ├── dm-interview.ts             ← DM voice profile builder per contact (run: npm run dm-setup)
│   ├── ingestPersonality.ts        ← ingest Twitter archive → personality profile
│   ├── ingestDMs.ts                ← ingest DM archive → person memory store
│   ├── buildRagIndex.ts            ← build RAG index from archive
│   ├── memoryReport.ts             ← print memory stats
│   ├── checkPersons.ts             ← inspect person memory store
│   ├── fetchBotUserId.ts           ← fetch bot's Twitter user ID
│   └── testRealIRL.ts              ← real IRL integration test (no mocks)
│
├── creators/
│   └── {username}/                 ← one folder per user (gitignored)
│       ├── .env                    ← all API keys and tokens
│       ├── config.json             ← bot config, personality traits, LLM settings
│       ├── personality_profile.json
│       ├── rag_index.json
│       ├── memory.json
│       └── memory-store/persons/   ← per-person JSON files (PersonMemoryStore)
│
└── CLAUDE.md                       ← this file
```

---

## Key Concepts

### PersonalityProfile
Built automatically from Twitter archive via `PersonalityIngester.ts`. Contains:
- `dominantTopics`: user's main interests (used for domain filtering, server/subreddit selection)
- `signaturePatterns`: user's recurring writing patterns (loaded into RAG)
- `writingStats`: avg tweet length, emoji usage, hashtag frequency, etc.

### RAG (Retrieval Augmented Generation)
`ExampleRetriever` indexes 2000+ real reply examples from the user's Twitter archive.
On each reply, retrieves the most relevant examples by keyword + context type matching.
These are injected into the LLM prompt so it mimics the user's real reply style.
Do NOT put static examples in the system prompt — RAG handles this dynamically.

### PersonMemoryStore
Per-person memory in `memory-store/persons/{handle}.json`. Tracks:
- `relationshipType`: friend, investor, family, colleague, unknown
- `dominantTopics`, `ownerToneWithThem`, `totalInteractions`
- `conversations`: full message history split by DM vs X/comment
- `dmVoiceProfile`: formalityLevel, typicalReplyLength, emojiUsage, endearments, toneDescriptor
- `toneBaseline`: statistical baseline for tone anomaly detection

### Domain Filter
Before replying to a viral tweet, OsBot checks if the tweet's topics overlap with the user's `dominantTopics`. If no match, it skips. Minimum word length for matching: **4 chars**.

### MoodEngine
Tracks the bot's current mood: `NEUTRAL | FIRED_UP | REFLECTIVE | PLAYFUL | ASSERTIVE`.
Mood affects reply tone. Updates on each tick.

### MemoryEngine
Persists to `memory.json`. Tracks:
- Which tweet/message IDs have been replied to (dedup — never reply twice)
- Per-user interaction counts
- Platform events log (cross-platform activity history)
- Topic performance stats (engagement*2 + count scoring)

### SessionBrain (Telegram)
Telegram messages route through `TelegramAdapter` → `SessionBrain` → Claude Agent SDK (`query()`).
SessionBrain spawns `XToolsMcpServer` as a child process so Claude can take X actions directly from Telegram chat.

---

## How Each Platform Works

### X (Twitter) — Phase 1 & 2
- **Mentions**: fetched via Twitter API v2 (`SearchMentionsProvider`)
- **Viral hunting**: `PlaywrightHomeTimelineProvider` scrapes the For You feed with Playwright
- **Why Playwright for X**: Twitter's free API doesn't expose the home timeline. Playwright logs in as the user and scrapes it like a browser.
- **Posting**: via `twitter-api-v2`
- **DMs**: `MCPBrowserDM` + `DmInboxPoller` — disabled until `npm run dm-setup` is run

### Telegram — Phase 5 (BUILT)
- **Auth**: grammy bot token + owner's chat ID
- **Brain**: `SessionBrain` routes free-form messages to Claude Agent SDK with full tool use
- **X control**: `XToolsMcpServer` spawned as child process — Claude can post, search, reply on X from Telegram
- **Env vars**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`

### Reddit — Phase 3 (built, not public yet)
- **Auth**: snoowrap OAuth — posts as user's real Reddit account
- **Env vars**: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`

### Discord — Phase 4 (built, not public yet)
- **Auth**: `discord.js-selfbot-v13` with user token — posts as user's real human account (no BOT tag)
- **Env vars**: `DISCORD_USER_TOKEN`

---

## Run Commands

```bash
# Onboarding
npm run setup               # full setup wizard
npm run dm-setup            # DM voice profile builder (run after setup)

# Phase 1 — OsBot controls its own X account
npx tsx agent/run-blopus-bot.ts

# Phase 2 — OsBot controls owner's X account
npx tsx agent/run-blopus-owner.ts

# Phase 3 — Reddit (not public yet)
npx tsx agent/run-blopus-reddit.ts

# Phase 4 — Discord (not public yet)
npx tsx agent/run-blopus-discord.ts
```

---

## Adding a New User

1. Create `creators/{username}/` folder
2. Copy `.env` and `config.json` from an existing creator folder, fill in credentials
3. Upload Twitter archive → run `npm run setup` → personality profile and RAG index build automatically
4. Run the bot

---

## Architecture Rules

1. **Never hardcode usernames** — everything reads from config/env. Zero mentions of specific usernames in agent/adapter/core files.
2. **Never modify Phase 1** — `BlopusAgent.ts` and its supporting files are frozen.
3. **Each platform = separate agent file** — Reddit, Discord, Telegram each have their own agent. They share the same core (LLMReplyEngine, MemoryEngine, RAG) but have different adapters.
4. **Owner mode = posting AS the user** — LLM prompt makes it clear OsBot is the owner, not a bot.
5. **Generic topic mappings** — `TOPIC_TO_SUBREDDITS`, `TOPIC_TO_INVITES` etc. are generic lookup tables that work for any user.
6. **No static examples in system prompt** — RAG handles all example injection dynamically.
7. **DM replies are opt-in** — `DmInboxPoller` is disabled in `BlopusAgent.ts` until user runs `npm run dm-setup` to build voice profiles.

---

## Planned Features (do not build unless asked)

- **Control chatbot Phase 6**: natural language interface — "stop replying to @xyz" → OsBot updates config.
- **Server/subreddit evolution**: OsBot notices topic drift in memory, suggests new communities to join.
- **mem0 integration**: replace `memory.json` with `mem0ai/mem0` for smarter memory.
- **Night report**: daily summary sent to owner via Telegram of what OsBot did across all platforms.
- **Discord DMs**: respond to direct messages (deferred, lower priority).
- **Model upgrade**: switch reply generation from Haiku to Sonnet for better quality.
