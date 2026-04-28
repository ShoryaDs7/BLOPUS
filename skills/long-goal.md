---
name: long-goal
description: Create and manage a long-running autonomous goal that works on itself daily — for multi-day, multi-week, or month-long tasks
---

# Long-Running Goals

Use this skill when the user wants something done autonomously over multiple days, weeks, or a deadline.

## When to trigger
User says any of: "over a month", "autonomously for X days", "run this for a week", "build this over the next 30 days", "research this daily", "work on this until done", "run this for me every day"

## Before creating — keep asking until BOTH are clear

Do NOT create the goal until you have clear, specific answers to both:

**Q1 — Deadline:** "When do you need this done by? Give me a specific date or number of days."
- Vague answers like "soon" or "whenever" → push back: "I need a specific date or number of days so the system can pace itself."

**Q2 — Daily time:** "How much time should I work on this each day? (e.g. 15 min, 1 hour, 3 hours)"
- Vague answers like "as much as needed" → push back: "Give me a number — this controls how long each daily session runs."

**Sanity check — do this before creating:**
- Total available time = days_remaining × minutes_per_day
- If total < 30 min for a complex task, or the math obviously doesn't work → tell the user:
  "That's not enough time to make real progress. With X days and Y min/day you get Z total hours. Either extend the deadline or increase daily time — which would you prefer?"
- Keep the conversation going until the user gives a realistic combination.

**Only once both answers are clear and sane:** create the goal.

## Creating the goal

Write this file: `{BLOPUS_DIR}/goals/goal_{timestamp}/state.json`

Replace {timestamp} with Date.now(). Replace {TELEGRAM_OWNER_CHAT_ID} with the value of the TELEGRAM_OWNER_CHAT_ID env var.

```json
{
  "id": "goal_{timestamp}",
  "goal": "{the user's goal in their exact words}",
  "started": "{today YYYY-MM-DD}",
  "deadline": "{deadline as YYYY-MM-DD}",
  "current_focus": "{your best guess at what to start with}",
  "done": [],
  "blockers": [],
  "files": [],
  "status": "active",
  "timeout_minutes": {minutes_per_day the user specified},
  "notify_chat_id": "{TELEGRAM_OWNER_CHAT_ID}"
}
```

Also create the folder: `{BLOPUS_DIR}/goals/goal_{timestamp}/` (write a blank README.md inside so the folder exists)

## After creating — confirm back to user
Tell the user exactly what was set:
"Goal created. Here's what I've locked in:
- Task: [goal]
- Deadline: [date]
- Daily session: [X] minutes
- First session starts today.

You'll get a message here after each session with what was done and what's next. To pause, redirect, or cancel — just tell me anytime."

## Checking status
User asks "how's my [goal] going?" or "update on [goal]" →
Read `{BLOPUS_DIR}/goals/{id}/state.json` and report:
- Current focus
- Done list (last 3 entries)
- Any blockers

## Redirecting
User says "change focus to X" → update current_focus in state.json
User says "pause this goal" → set status to "paused" in state.json
User says "cancel this goal" → set status to "cancelled" in state.json
User says "resume goal" → set status to "active" in state.json

## Listing all goals
Read all `{BLOPUS_DIR}/goals/*/state.json` files and summarize active ones.
