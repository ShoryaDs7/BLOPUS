---
name: read-memory
description: Read person memory, conversation history, owner biography, post history for any X account
---

# Reading Memory

## Person memory (who has Blopus talked to)
Files: `{BLOPUS_DIR}/creators/memory-store/persons/<handle>.json`

Key fields:
- `firstSeenAt` — when Blopus first saw this person
- `totalInteractions` — how many times interacted
- `conversations[]` — full message history (both sides)
- `relationshipType` — romantic/family/close_friend/professional/fan/acquaintance
- `dominantTopics` — what they talk about
- `ownerToneWithThem` — how the owner usually talks to them
- `ownerNote` — the owner's manual notes about this person
- `theirPersonality` — inferred personality

## Owner biography
File: `{BLOPUS_DIR}/creators/memory-store/biography.json` (or similar)
Contains the owner's goals, interests, background.

## Post history (what the owner has tweeted)
Check: `{BLOPUS_DIR}/memory-store/` for OwnerPostIndex files

## All persons index
File: `{BLOPUS_DIR}/creators/memory-store/persons/_index.json`
Lists all known handles with userId mapping.

## Searching conversation history
Read the person's JSON file, look at `conversations[].messages[]`.
Each message: `{ by: 'owner'|'them', text, timestamp, platform }`
