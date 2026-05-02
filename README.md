# BLOPUS

<p align="center">
  <img src="assets/banner.png" alt="BLOPUS" width="100%"/>
</p>

**WHY USE A CLAW WHEN YOU HAVE 8 ARMS?**

[![GitHub Stars](https://img.shields.io/github/stars/ShoryaDs7/BLOPUS?style=flat&color=yellow)](https://github.com/ShoryaDs7/BLOPUS/stargazers)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

BLOPUS is an open-source AI version of you.

Not a chatbot. Not an assistant.

It thinks like you, writes like you, and acts on your behalf using your own history.

Runs entirely on your machine. Your data never leaves.

You stop. **BLOPUS continues.**

---

## Example

you told it once to watch your space.

Day 7:

- it already knows who matters and who doesn't
- it's been tracking moves, pricing shifts, and positioning quietly
- it stepped in where you would have, not everywhere, just where it counts
- it built what it needed to keep watching without you
- it's shaping conversations in your voice without forcing them

you didn't check in.

it kept going anyway.

This is not automation.

**This is continuity.**

---

## What it is

- **It sounds like you:** trained on 2000+ of your real replies, patterns, tone, writing style. Every output grounded in how you actually think.
- **It knows everyone you know. And how you are with each of them.** Before responding to anyone, it reads your full history with them. Your tone with them specifically. What you never say to them. Their patterns too.
- **It never forgets:** goals run for days or weeks. Every 30 minutes it wakes, reads everything it decided before, and continues. Day 30 still knows what it ruled out on Day 1.
- **It operates your real accounts:** posts, replies, quote-tweets, defends hostile replies on X. In your voice. While you're offline.
- **BLOPUS does what you would have done.** Writes, replies, builds, deploys, researches and anything else you'd do yourself. One Telegram message away.
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

```mermaid
flowchart TD
    A([You on Telegram]) --> B[TelegramAdapter]
    B --> C[SessionBrain]
    C --> D[Claude Agent SDK]
    D --> E{What does it need?}
    E -->|Post / reply on X| F[XToolsMcpServer\nPlaywright + API]
    E -->|Research / web| G[Tavily + Playwright\nWeb Scraper]
    E -->|Build / deploy / files| H[29 Skills\nGitHub · Railway · Gmail · Drive]
    E -->|Who is this person?| I[MemoryEngine\nPer-person history]
    F --> J[SecurityShield\nscan output]
    G --> J
    H --> J
    I --> J
    J --> K([Result back to you])
```

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
set a goal: repair and double down on my professional network

audit my last 2 years of DMs and emails to find 10 high-value
connections I've let go cold.

analyze why they went cold and draft a hyper-personalized
re-entry message in my current voice.

if they reply, handle the scheduling for a catch-up call
using my calendar.

find 5 new people in my space I should know, and start engaging
with their work on X the way I usually do — thoughtful pushback, no fluff.

don't stop until 10 cold connections are active again
with a confirmed response or scheduled meeting.
```

Every 30 minutes, `GoalRunner` wakes up, reads everything it knows, and does the next right thing.

Every future session reads everything before it.

**30 days in. BLOPUS still knows what it decided on day 1.**

Nothing resets.  
Nothing is forgotten.

After every session:

- what was permanently ruled out, never retried again
- decisions and findings that must carry forward
- the best open thread: where to push next

Dead ends stay dead. Progress compounds.

```mermaid
flowchart TD
    A([GoalRunner wakes\nevery 30 min]) --> B[Load goal state\nread all prior keypoints]
    B --> C[SessionBrain\nfull tools + your voice]
    C --> D{Acts across platforms}
    D -->|Posts / replies| E[X in your voice]
    D -->|Researches| F[Web search + scrape]
    D -->|Builds / sends| G[Code · emails · deploys]
    E --> H[Write keypoints\ndone_today.txt]
    F --> H
    G --> H
    H --> I{Goal complete?}
    I -->|No| J[Notify you on Telegram\nsleep 30 min]
    J --> A
    I -->|Yes| K([Goal completed\nYou are notified])
```

---

## Memory

Most AI has context. **BLOPUS has history.**

```mermaid
flowchart LR
    A([New interaction]) --> B{Who is this?}
    B --> C[Load person record\nfrom archive]
    C --> D[Relationship type\nfriend · investor · colleague]
    C --> E[Your tone with them\nhow warm · what you never say]
    C --> F[Their patterns\ntopics · response style · history]
    D --> G[BLOPUS responds\nin your exact voice\nwith full context]
    E --> G
    F --> G
    G --> H[Update record\nwith new interaction]
    H --> I([Memory grows\nnothing ever deleted])
```

### Per-person memory

Before BLOPUS responds to anyone, it reads everything it knows about them.

Every contact has a live record, seeded from your archive, updated on every interaction:

- your relationship with them (friend, investor, colleague, unknown)
- your tone with them: how formal, how warm, what you never say to them
- **their** patterns: what they care about, how they respond, their tone and interests derived from both sides of every DM and conversation in your archive
- full interaction history going back years, nothing ever deleted

BLOPUS doesn't just know how you talk to someone. It knows the other person too.

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

---

MIT © 2026 ShoryaDs7

---

**There is always a version of you online.  
And it doesn't stop when you do.**

*"Built because I wanted to be in two places at once." — @shoryads7*
