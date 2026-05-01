# 🐙 BLOPUS

<p align="center">
  <img src="assets/banner.png" alt="BLOPUS" width="100%"/>
</p>

**WHY USE A CLAW WHEN YOU HAVE 8 ARMS?**

[![GitHub Stars](https://img.shields.io/github/stars/ShoryaDs7/BLOPUS?style=flat&color=yellow)](https://github.com/ShoryaDs7/BLOPUS/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

BLOPUS is an open-source AI clone of yourself, trained on your history, working as you while you're offline. Runs on your machine. Your data never leaves.

You stop. **BLOPUS continues.**

---

## What it is

- **It sounds like you:** trained on 2000+ of your real replies from your Twitter archive. Writing stats, patterns, tone. Every output grounded in how you actually write.
- **It knows everyone you know. And how you are with each of them.** Before responding to anyone, it reads your full history with them. Your tone with them specifically. What you never say to them. Their patterns too.
- **It never forgets:** goals run for days or weeks. Every 30 minutes it wakes, reads everything it decided before, and continues. Day 30 still knows what it ruled out on Day 1.
- **It controls your real accounts:** posts, replies, quote-tweets, defends hostile replies on X. In your voice. While you're offline.
- **BLOPUS does what you do.** Writes, replies, builds, deploys, researches and anything else you'd do yourself. One Telegram message away.
- **Multi-platform:** X (live), Telegram control (live), Reddit and Discord next.
- **Per-creator isolation:** multiple identities on one machine, each with its own keys, archive, voice, and memory.

---

## Quick start

Requires [Node.js](https://nodejs.org) 18+ and [Python](https://python.org) 3.8+.

**npm run setup** walks you through everything: API keys, archive upload, voice modeling, behavior config.

```bash
git clone https://github.com/ShoryaDs7/BLOPUS.git
cd BLOPUS
npm install          # handles all 29 skill dependencies
npm run setup
npm run blopus:owner
```

Open Telegram. Search for your bot and start talking.

---

## API Keys

**npm run setup** handles all of this interactively. Expand only if you want to know what's needed upfront.

<details>
<summary>Required keys — nothing works without these</summary>

| Key | What |
|-----|------|
| `ANTHROPIC_API_KEY` | core intelligence |
| `TWITTER_API_KEY/SECRET` + `ACCESS_TOKEN/SECRET` | X API (free tier works) |
| `X_AUTH_TOKEN` + `X_CT0` | X session cookies for home timeline |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` | control interface |

</details>

<details>
<summary>Optional keys — unlocks more capabilities</summary>

| Key | What it unlocks |
|-----|---------|
| `TAVILY_API_KEY` | Real-time web search (free tier) |
| `GITHUB_TOKEN` | Repos, commits, PRs, issues from Telegram |
| `RAILWAY_TOKEN` | Deploy to Railway from Telegram |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | Gmail, Calendar, Drive, Docs, Sheets, Tasks, Contacts, Meet |

</details>

---

## Control via Telegram

One conversation. It controls everything.

### Social Memory

```
give me the full history with @naval —
who reached out first, what we talked about, who goes quiet more

→ you reached out first, march 2023.
  last exchange: you pushed back on his leverage take, he didn't reply.
  you initiate 3x more than he does.
```

### Autonomous Goals

```
track what my competitors are shipping every day and post my take

→ goal running. posting in your voice every day.
```

### Development

```
respond to every PR comment on my repo today

→ 14 comments. replied to all in your voice. 2 PRs merged.
```

### Build

```
build something that watches my competitor's pricing page,
alerts me the moment anything changes, and logs every version

→ built. deployed. watching 4 pages.
  logs in your drive. you'll know before their team announces it.
```

---

## Long-running goals

**Every AI agent forgets everything the moment a session ends. BLOPUS doesn't.**

Set a goal:

```
set a goal: take full control of my digital life and reputation

search my entire history across posts, emails, DMs and conversations
find every rude, hostile or misrepresenting interaction I've ever had
analyze patterns and craft strong, in-character responses and strategies
defend my name where it matters and build real relationships with the right people
turn past noise into positioning and momentum

don't stop until my online presence reflects exactly who I am and what I stand for
```

Every 30 minutes, `GoalRunner` wakes up, reads everything it knows, and does the next right thing.

Every future session reads everything before it.

**30 days in. BLOPUS still knows what it decided on day 1.**

Nothing resets.  
Nothing is forgotten.

---

## Memory

Most AI has context. **BLOPUS has history.**

### Per-person memory

Before BLOPUS responds to anyone, it reads everything it knows about them.

Every contact has a live record, seeded from your archive, updated on every interaction:

- your relationship with them (friend, investor, colleague, unknown)
- your tone with them: how formal, how warm, what you never say to them
- **their** patterns: what they care about, how they respond, their tone and interests derived from both sides of every DM and conversation in your archive
- full interaction history going back years, nothing ever deleted

BLOPUS doesn't just know how you talk to someone. It knows the other person too.

### Goal memory

Every AI agent forgets the moment a session ends. BLOPUS doesn't.

After every GoalRunner session:

- what was permanently ruled out, never retried again
- decisions and findings that must carry forward
- the best open thread: where to push next

Day 30 still knows what it decided on day 1. Dead ends stay dead. Progress compounds. Nothing resets.

### Telegram session memory

Your conversation context is always live within a session. Critical decisions, ongoing tasks, and open threads carry forward. BLOPUS picks up exactly where you left off, even weeks later.

### Global memory

Tracks every action taken, never acts on the same thing twice. Logs topic performance over time: what gets engagement, what gets ignored, when to stop pushing a topic.

---

## Autonomous presence

BLOPUS stays active while you're offline, posting, replying, defending, engaging, all in your voice, derived from your real behavior. X is live today. Reddit and Discord are next.

```bash
npm run blopus:owner
```

---

## Skills

29 built-in capabilities.

| Category             | Skills |
|----------------------|--------|
| **BLOPUS-native**    | Post on X, browse web, read memory, long-running goals, edit BLOPUS's own code, security shield |
| **Development**      | Website builder, backend APIs, MCP tools, GitHub, deploy (Vercel / Railway / Netlify / Render) |
| **Web & Data**       | Web scraping, data analysis, SQLite, SEO |
| **Google Workspace** | Gmail, Calendar, Drive, Docs, Sheets, Tasks, Contacts, Meet |
| **Documents**        | PDF, Word, Excel, PowerPoint |
| **Media & Content**  | YouTube, image editing, video scripts, writing, resume, clinical notes |

**Custom Skills:** drop a `.md` file into `/skills` to teach BLOPUS something new.

---

## Security

BLOPUS acts as you. A hostile message that hijacks its behavior, or a credential leaked in something it sends, has real consequences.

Every incoming message is scanned before Claude sees it. Every outgoing action is scanned before it sends. Nothing leaks. Nothing gets hijacked. If anything trips, the action is dropped and you're notified on Telegram. Zero config.

```bash
npx tsx scripts/testSecurity.ts   # 50 adversarial tests — all must pass
```

---

## Multi-user

Every person who runs BLOPUS gets their own isolated folder:

```
creators/alice/   ← Alice's keys, archive, voice, memory
creators/bob/     ← Bob's keys, archive, voice, memory
```

> **Privacy-first isolation: nothing is shared between identities.**

**npm run setup** saves your name to `.env` automatically. Multiple identities, pass it per instance:

```bash
CREATOR=alice npm run blopus:owner
CREATOR=bob npm run blopus:owner
```

---

## Architecture

| Folder | What lives here |
|--------|----------------|
| [`agent/`](agent/) | The always-on loop: autonomous posting, reply hunting, engagement, defense, GoalRunner |
| [`core/`](core/) | Intelligence: voice engine, memory, per-person profiles, RAG index |
| [`adapters/`](adapters/) | Platform connectors: X (Playwright + API), Telegram, SessionBrain, MCP tools |
| [`skills/`](skills/) | 29 markdown files, each one teaches BLOPUS a new capability |

**How a request flows:**

```mermaid
flowchart LR
    A[You on Telegram] --> B[BLOPUS parses<br/>your intent] --> C[Core Engine<br/>29 Skills] --> D[Posts / Emails<br/>Codes / Deploys] --> E[Result back<br/>to you]
```

**How the autonomous loop runs:**

```mermaid
flowchart LR
    A[Every 30 min<br/>GoalRunner wakes] --> B[Continues from<br/>last session] --> C[Acts in<br/>your voice] --> D[Sends you<br/>an update] -- 30 min --> A
```

---

MIT © 2026 ShoryaDs7

---

**There is always a version of you online.**

*"Built because I wanted to be in two places at once." — @shoryads7*
