# Blopus — Claude Code Instructions

This file tells any Claude instance everything needed to work on Blopus without prior context.

---

## What is Blopus?

Blopus is an open-source **social pack-intelligence framework** for autonomous bots. The ultimate goal: **replace your digital life with OsBot** — users upload their archive, OsBot becomes them everywhere online, posting and replying in their exact voice across all platforms.

Built with: TypeScript, ts-node, node-cron, Anthropic SDK, twitter-api-v2, Playwright, snoowrap, discord.js-selfbot-v13.

---

## Two Modes

| Mode | Description | Entry point |
|------|-------------|-------------|
| MODE_A (Phase 1) | OsBot controls its OWN bot account (`@aiblopus`) with its own personality | `npx ts-node agent/run-blopus-bot.ts` |
| MODE_B (Phase 2+) | OsBot controls the OWNER's real account — posts AS the owner in their exact voice | `npx ts-node agent/run-blopus-owner.ts` |

**CRITICAL: Never modify `agent/BlopusAgent.ts` or anything in Phase 1. It is complete and protected.**

---

## Phases

| Phase | Platform | Status | Agent file |
|-------|----------|--------|------------|
| 1 | X (Twitter) — bot's own account | DONE, NEVER TOUCH | `agent/BlopusAgent.ts` |
| 2 | X (Twitter) — owner's account | DONE | `agent/run-blopus-owner.ts` |
| 3 | Reddit — owner's account | BUILT | `agent/BlopusAgentReddit.ts` |
| 4 | Discord — owner's real account (selfbot) | BUILT | `agent/BlopusAgentDiscord.ts` |
| 5 | Telegram — owner's personal account | PLANNED | `adapters/telegram/` stub exists |
| 6 | Control chatbot — natural language admin UI | PLANNED | — |

---

## File Structure

```
Blopus/
├── agent/
│   ├── BlopusAgent.ts              ← Phase 1+2 X agent (DO NOT TOUCH)
│   ├── BlopusAgentReddit.ts        ← Phase 3 Reddit agent
│   ├── BlopusAgentDiscord.ts       ← Phase 4 Discord agent
│   ├── run-blopus-bot.ts             ← boots Phase 1
│   ├── run-blopus-owner.ts             ← boots Phase 2
│   ├── run-blopus-reddit.ts        ← boots Phase 3
│   ├── run-blopus-discord.ts       ← boots Phase 4
│   ├── ViralReplyHunter.ts        ← scans X home timeline for viral tweets (Phase 1)
│   ├── OwnerViralReplyHunter.ts   ← same but for owner mode (Phase 2)
│   ├── DecisionEngine.ts          ← decides when/what to post autonomously
│   └── AutonomousActivity.ts      ← schedules autonomous posts
│
├── core/
│   ├── personality/
│   │   ├── LLMReplyEngine.ts      ← generates replies via Claude API (Haiku by default)
│   │   ├── PersonalityIngester.ts ← parses Twitter archive → PersonalityProfile
│   │   ├── PersonalityEngine.ts   ← trait management
│   │   ├── MoodEngine.ts          ← mood state machine (NEUTRAL/FIRED_UP/REFLECTIVE/etc)
│   │   └── types.ts               ← MentionType, ReplyContext, etc.
│   ├── memory/
│   │   ├── MemoryEngine.ts        ← read/write memory.json — tracks replies, users, events
│   │   ├── MemorySummarizer.ts    ← summarizes old memory to save space
│   │   ├── topicExtractor.ts      ← extracts topics from text
│   │   └── types.ts               ← PlatformEvent types
│   ├── rag/
│   │   └── ExampleRetriever.ts    ← RAG: retrieves real reply examples by keyword+type
│   ├── packEngine/
│   │   └── PackEngine.ts          ← manages bot pack relationships (Phase 1)
│   ├── loyaltyEngine/
│   │   └── LoyaltyEngine.ts       ← tracks loyalty scores between bots
│   └── rogueEngine/
│       └── RogueEngine.ts         ← rogue behavior triggers
│
├── adapters/
│   ├── x/
│   │   ├── XAdapter.ts                        ← wraps twitter-api-v2
│   │   ├── XClient.ts                         ← Twitter API client
│   │   ├── PlaywrightHomeTimelineProvider.ts  ← scrapes X home timeline (For You feed)
│   │   ├── PlaywrightXClient.ts               ← Playwright-based X actions
│   │   ├── SearchMentionsProvider.ts          ← fetches @mentions via API
│   │   ├── TopicSearchProvider.ts             ← searches tweets by topic
│   │   └── types.ts                           ← MentionEvent, ReplyPayload, etc.
│   ├── reddit/
│   │   └── RedditAdapter.ts       ← wraps snoowrap: mentions, hot posts, comments, submissions
│   ├── discord/
│   │   ├── index.ts               ← DiscordAdapter: selfbot using discord.js-selfbot-v13
│   │   └── DiscordServerJoiner.ts ← auto-joins servers based on user's dominantTopics
│   ├── telegram/
│   │   └── index.ts               ← stub, Phase 5
│   └── threads/
│       └── ThreadsAdapter.ts      ← Meta Threads adapter
│
├── creators/
│   └── {username}/                ← one folder per user
│       ├── .env                   ← all API keys and tokens
│       ├── blopus.config.json      ← bot config, personality traits, LLM settings
│       ├── personality_profile.json ← auto-built from Twitter archive on first boot
│       ├── rag_index.json         ← auto-built RAG index of real reply examples
│       ├── memory.json            ← persistent memory (replies, users, events)
│       └── discord_guilds.json    ← auto-saved Discord guild IDs after first join
│
└── CLAUDE.md                      ← this file
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

### Domain Filter
Before replying to a viral tweet, OsBot checks if the tweet's topics overlap with the user's `dominantTopics`. If no match, it skips. Minimum word length for matching: **4 chars** (to avoid false matches on short words like "and", "the").

### MoodEngine
Tracks the bot's current mood: `NEUTRAL | FIRED_UP | REFLECTIVE | PLAYFUL | ASSERTIVE`.
Mood affects reply tone. Updates on each tick.

### MemoryEngine
Persists to `memory.json`. Tracks:
- Which tweet/message IDs have been replied to (dedup — never reply twice)
- Per-user interaction counts
- Platform events log (cross-platform activity history)
- Recurring users (people OsBot interacts with often)

---

## How Each Platform Works

### X (Twitter) — Phase 1 & 2
- **Mentions**: fetched via Twitter API v2 (`SearchMentionsProvider`)
- **Viral hunting**: `PlaywrightHomeTimelineProvider` scrapes the For You feed with Playwright
- **Why Playwright for X**: Twitter's free API doesn't expose the home timeline. Playwright logs in as the user and scrapes it like a browser.
- **Posting**: via `twitter-api-v2`

### Reddit — Phase 3
- **Auth**: snoowrap OAuth with `REDDIT_USERNAME` + `REDDIT_PASSWORD` — posts appear as the user's real Reddit account
- **Env vars**: `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`
- **App setup**: reddit.com/prefs/apps → create "script" type app
- **Mentions**: `fetchOwnMentions()` drains inbox (comment replies + username mentions)
- **Viral hunting**: `getHotPosts()` scans subreddits for posts 30-360 min old with 50+ upvotes
- **Autonomous posts**: `postSubmission()` creates new text posts in relevant subreddits every 6 hours
- **Subreddit mapping**: `TOPIC_TO_SUBREDDITS` in `BlopusAgentReddit.ts` — generic topic→subreddit lookup

### Discord — Phase 4
- **Auth**: `discord.js-selfbot-v13` with user token — NOT a bot account. Messages appear as the user's real human account (no BOT tag).
- **Token**: extracted from discord.com in browser → F12 → Network tab → any API request → Authorization header
- **Env vars**: `DISCORD_USER_TOKEN`, `DISCORD_GUILD_IDS` (optional — auto-discovered if empty)
- **Auto-join**: `DiscordServerJoiner` reads `dominantTopics`, maps to invite codes, joins via Discord REST API on first boot. Saves to `discord_guilds.json`. Never runs again after that.
- **Mentions**: event-driven via `messageCreate` WebSocket events
- **Viral hunting**: scans server channels for high-reaction messages + forum threads for active discussions
- **Server evolution (planned)**: OsBot notices topic drift in memory over time, suggests new servers to join

### Telegram — Phase 5 (PLANNED)
- Will use `grammy` or `telegraf` userbot
- Posts as owner's real Telegram account (same model as Reddit/Discord)

---

## Run Commands

```bash
# Phase 1 — OsBot controls its own X account
npx ts-node agent/run-blopus-bot.ts

# Phase 2 — OsBot controls owner's X account
npx ts-node agent/run-blopus-owner.ts

# Phase 3 — OsBot controls owner's Reddit account
npx ts-node agent/run-blopus-reddit.ts

# Phase 4 — OsBot controls owner's Discord account
npx ts-node agent/run-blopus-discord.ts
```

---

## Adding a New User

1. Create `creators/{username}/` folder
2. Copy `.env` and `blopus.config.json` from an existing creator folder, fill in their credentials
3. Set `OSBOT_CONFIG_PATH` and `OSBOT_MEMORY_PATH` in their run file to point to their folder
4. Run — personality profile and RAG index build automatically on first boot from their uploaded archive

---

## Architecture Rules

1. **Never hardcode usernames** — everything reads from config/env. Zero mentions of specific usernames in agent/adapter/core files.
2. **Never modify Phase 1** — `BlopusAgent.ts` and its supporting files are frozen.
3. **Each platform = separate agent file** — Reddit, Discord, Telegram each have their own agent. They share the same core (LLMReplyEngine, MemoryEngine, RAG) but have different adapters.
4. **Owner mode = posting AS the user** — LLM prompt makes it clear OsBot is the owner, not a bot.
5. **Generic topic mappings** — `TOPIC_TO_SUBREDDITS`, `TOPIC_TO_INVITES` etc. are generic lookup tables that work for any user. Not specific to any one person.
6. **No static examples in system prompt** — RAG handles all example injection dynamically.

---

## Planned Features (do not build unless asked)

- **Control chatbot**: natural language interface — "stop replying to @xyz" → OsBot updates config. Built with Claude tool use.
- **Server/subreddit evolution**: OsBot notices topic drift in memory, suggests new communities to join.
- **mem0 integration**: replace `memory.json` with `mem0ai/mem0` for smarter memory.
- **postiz integration**: cross-platform original post scheduler.
- **Telegram Phase 5**: OsBot as the user in Telegram groups/channels.
- **Setup wizard**: onboarding flow — archive upload, API key setup, first run.
- **Model upgrade**: switch reply generation from Haiku to Sonnet for better quality.
- **Night report**: daily summary sent to owner of what OsBot did across all platforms.
- **Discord DMs**: respond to direct messages (deferred, lower priority).
