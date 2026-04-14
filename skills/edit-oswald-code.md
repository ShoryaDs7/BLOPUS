---
name: edit-oswald-code
description: Read, edit, or add code to the Blopus project — fix bugs, add features, modify behavior
---

# Editing Blopus Code

## Project structure
```
C:/Blopus/
  agent/           — core agent loop, DmInboxPoller, OsBotAgent
  adapters/
    x/             — X/Twitter API + Playwright client
    telegram/      — Telegram control channel + SessionBrain
    control/       — AgentBrain, SessionBrain
  core/
    memory/        — PersonMemoryStore, MemoryEngine, LLMReplyEngine
    personality/   — MoodEngine
  creators/        — per-creator configs + memory stores
  skills/          — skill files (this directory)
  scripts/         — one-off utility scripts
  tools/           — x-cli.ts and other CLI tools
```

## Workflow
1. Read the file(s) to understand current code first
2. Make targeted edits using Edit tool (not Write — don't rewrite whole files)
3. Run `cd C:/Blopus && npx tsc --noEmit` to check for type errors
4. Tell Shorya what changed and what to restart

## Rules
- Never rewrite whole files unless it's a new file
- Fix the actual bug — don't add workarounds
- No extra error handling for impossible cases
- No new abstractions for one-time things

## Key files for common tasks
- DM behavior: `agent/DmInboxPoller.ts`
- Telegram commands: `adapters/telegram/index.ts`
- X posting: `adapters/x/PlaywrightXClient.ts`
- Person memory: `core/memory/PersonMemoryStore.ts`
- Autonomous posting: `agent/OsBotAgent.ts`
