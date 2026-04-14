# Blopus

Autonomous social AI agent that posts on X (Twitter) **as you** — in your exact voice, on your topics, at your pace. Controlled entirely from Telegram.

---

## What it does

- **Posts original tweets** on your real X account autonomously, matching your tone and topics
- **Replies to viral tweets** in your niche — sounds like you wrote it
- **Responds to @mentions** automatically
- **You stay in control via Telegram** — pause it, change mood, trigger posts, ask anything

---

## Requirements

- Node.js 18+
- Python 3.9+
- A Twitter/X account + [Twitter Developer App](https://developer.twitter.com) (free)
- An [Anthropic API key](https://console.anthropic.com) (~$1–5/month for normal usage)
- A Telegram account (for control)

---

## Quick start

```bash
git clone https://github.com/ShoryaDs7/BLOPUS.git
cd BLOPUS
npm install
npm run setup
```

The setup wizard walks you through everything — takes about 10 minutes.

Once done:

```bash
CREATOR=yourhandle npm run blopus:owner
```

Then open Telegram and message your bot — it's live.

---

## Setup walkthrough

`npm run setup` asks you for:

| Step | What | Where to get it |
|------|------|-----------------|
| 1 | Mode (owner / bot / both) | Your choice |
| 2 | Your X handle | Your X username |
| 3 | Twitter API keys (4 keys) | [developer.twitter.com](https://developer.twitter.com) → your app → Keys and Tokens |
| 4 | Anthropic API key | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| 5 | X email + password | Your X login |
| 6 | X session cookies (`auth_token` + `ct0`) | See below |
| 7 | Telegram bot token | [@BotFather](https://t.me/BotFather) → /newbot |
| 8 | Your Telegram chat ID | [@userinfobot](https://t.me/userinfobot) → /start |
| 9 | Twitter archive (optional but recommended) | x.com → Settings → Download archive → `data/tweets.js` |

### Getting your X session cookies

1. Open [x.com](https://x.com) in Chrome or Edge — make sure you are logged in
2. Press `F12` → click the **Application** tab
3. Left sidebar → **Storage** → **Cookies** → click `https://x.com`
4. Find `auth_token` → copy the **Value** column
5. Find `ct0` → copy the **Value** column
6. Paste both into the setup wizard

> These cookies let Blopus read your home timeline. They stay on your machine only.

---

## Telegram commands

Once the agent is running, send these to your Telegram bot:

| Command | What it does |
|---------|--------------|
| `/status` | Current mood, replies today, uptime |
| `/mute 4` | Pause Blopus for 4 hours |
| `/unmute` | Resume immediately |
| `/mood snarky` | Change reply tone (`chill` · `heated` · `snarky` · `defensive` · `distracted`) |
| `/post anything you want to say` | Post a tweet right now |
| Any message | Ask Blopus to do anything — write a tweet, search the web, check your calendar |

---

## Modes

| Mode | Description | Command |
|------|-------------|---------|
| Owner mode | Posts AS YOU on your real account | `CREATOR=handle npm run blopus:owner` |
| Bot mode | Runs a separate AI bot account with its own personality | `CREATOR=handle npm run blopus:bot` |

---

## Adding your voice (recommended)

Without your Twitter archive, Blopus uses a generic voice.
With it, Blopus learns exactly how you write — reply length, tone, phrases, topics, humor.

**To add it after setup:**

1. Go to x.com → your profile icon → Settings → **Your account** → **Download an archive of your data**
2. X emails you a download link (can take up to 24 hours)
3. Download → extract the zip → find `data/tweets.js`
4. Run:

```bash
CREATOR=yourhandle npm run ingest
```

---

## Optional integrations

Set these up during `npm run setup` or add them to `creators/yourhandle/.env` later:

| Key | Purpose |
|-----|---------|
| `TAVILY_API_KEY` | Real-time web search in replies — [tavily.com](https://tavily.com) (free tier) |
| `GEMINI_API_KEY` | YouTube video understanding — [aistudio.google.com](https://aistudio.google.com) (free) |
| `GITHUB_TOKEN` | GitHub control from Telegram — create/push repos, manage PRs |
| `RAILWAY_TOKEN` | Deploy to Railway from Telegram |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN` | Gmail, Calendar, Drive, YouTube, Docs, Sheets — full Google Workspace control |

---

## File structure

```
adapters/x/          — X posting, home timeline scraping, session management
adapters/telegram/   — Telegram control channel + commands
adapters/control/    — Agent brain that handles Telegram requests
agent/               — Bot loop, viral reply hunter, autonomous posting, decision engine
core/personality/    — Voice engine, LLM reply generation, mood system
core/rag/            — Retrieves real examples from your archive to match your style
core/memory/         — Tracks what was replied to, per-user history, events
scripts/             — setup, ingest, utilities
```

---

## How voice matching works

1. Your Twitter archive is indexed into 2000+ real reply examples (RAG)
2. When Blopus sees a viral tweet worth replying to, it retrieves the most relevant examples from your archive — same topic, similar context
3. These are injected into the Claude prompt so the reply sounds like you wrote it — not like a bot
4. Replies that sound too generic, too short, or AI-patterned are automatically discarded and retried

---

## Multi-user

Each user gets their own folder:

```
creators/
  yourhandle/
    .env                    — all your API keys
    blopus.config.json      — personality + settings
    personality_profile.json — computed from your archive
    rag_index.json          — your reply examples index
    memory.json             — what Blopus has replied to
```

Run multiple instances by setting `CREATOR=` to different handles.

---

## License

MIT
