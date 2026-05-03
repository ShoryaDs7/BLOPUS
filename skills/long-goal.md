---
name: long-goal
description: Create and manage a long-running autonomous goal that works on itself daily — for multi-day, multi-week, or month-long tasks
---

# Long-Running Goals

Use this skill when the user wants something done autonomously over multiple days, weeks, or a deadline.

## When to trigger
User says any of: "over a month", "autonomously for X days", "run this for a week", "build this over the next 30 days", "research this daily", "work on this until done", "run this for me every day", "do this twice a day", "until I have X", "until I reach X"

## Two goal types — detect before asking anything

**Condition-based** — user says "until X", "until I have Y", "until I reach Z", "keep going until":
- Skip the deadline question entirely
- Save the condition as `completion_condition` in state.json (e.g. "10k GitHub stars", "100 signups booked")
- No `deadline` field needed

**Date-based** — everything else:
- Ask for a specific deadline date as normal

## Before creating — keep asking until everything is clear

**Step 1 — Deadline (date-based only):**
Ask: "When do you need this done by? Give me a specific date."
- Vague answer → push back: "I need a specific date so I can pace the work correctly."

**Step 2 — Recommend time per session and runs per day, then confirm:**
Once you have the deadline (or for condition-based, just the task), recommend based on complexity:
- Deep work (research, coding, math, writing): 45–60 min/session
- Medium tasks (planning, analysis, outreach): 30 min/session
- Light tasks (monitoring, summaries, social): 15 min/session

Say: "For this kind of work I'd recommend [Y] min/session. How many times per day should I run?"

User can say any number — once, twice, every hour, 5 times a day. Map to runs_per_day accordingly.

**Step 3 — Sanity check (date-based only):**
- days_remaining × minutes_per_day < 30 min total → "That's not enough time. Either push the deadline or increase daily time — which would you prefer?"

**Only once all required info is confirmed:** create the goal.

## Creating the goal

Write this file: `{BLOPUS_DIR}/goals/goal_{timestamp}/state.json`

Replace {timestamp} with Date.now(). Replace {TELEGRAM_OWNER_CHAT_ID} with the value of the TELEGRAM_OWNER_CHAT_ID env var.

**Date-based goal:**
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
  "timeout_minutes": {minutes_per_session confirmed by user},
  "runs_per_day": {runs per day confirmed by user},
  "last_run_timestamps": [],
  "notify_chat_id": "{TELEGRAM_OWNER_CHAT_ID}"
}
```

**Condition-based goal:**
```json
{
  "id": "goal_{timestamp}",
  "goal": "{the user's goal in their exact words}",
  "started": "{today YYYY-MM-DD}",
  "completion_condition": "{the condition in plain English, e.g. '10k GitHub stars', '100 paid signups'}",
  "current_focus": "{your best guess at what to start with}",
  "done": [],
  "blockers": [],
  "files": [],
  "status": "active",
  "timeout_minutes": {minutes_per_session confirmed by user},
  "runs_per_day": {runs per day confirmed by user},
  "last_run_timestamps": [],
  "notify_chat_id": "{TELEGRAM_OWNER_CHAT_ID}"
}
```

Also create the folder: `{BLOPUS_DIR}/goals/goal_{timestamp}/` (write a blank README.md inside so the folder exists)

## After creating — confirm back to user

**Date-based:**
"Goal created. Here's what I've locked in:
- Task: [goal]
- Deadline: [date] ([X] days from now)
- Daily session: [Y] minutes × [Z] times/day
- Total work budget: [X×Y×Z] minutes

The bot will work on this automatically every time it's running and a session is due. You'll get a message after each session with what was done and what's next. To pause, redirect, or cancel — just tell me anytime."

**Condition-based:**
"Goal created. Here's what I've locked in:
- Task: [goal]
- Runs until: [completion_condition]
- Daily session: [Y] minutes × [Z] times/day

The bot will check the condition each session and stop automatically when it's met. You'll get a message after each session with what was done. To pause, redirect, or cancel — just tell me anytime."

## If user sends files or a folder path
If the user attaches files or mentions a folder path like "here are my notes: C:/Users/me/research/":
- Copy or read all files from that path into the goal folder before creating the goal
- Set `files` in state.json to list those paths
- Set `current_focus` to reflect that prior work exists and Claude should continue from it

## Checking status
User asks "how's my [goal] going?" or "update on [goal]" →
Read `{BLOPUS_DIR}/goals/{id}/state.json` and report:
- Current focus
- Done list (last 3 entries)
- Days remaining until deadline (or completion condition if condition-based)
- Any blockers

## Redirecting
User says "change focus to X" → update current_focus in state.json
User says "pause this goal" → set status to "paused" in state.json
User says "cancel this goal" → set status to "cancelled" in state.json
User says "resume goal" or "done" or "fixed it" or "unblocked" or "continue" → set status to "active" in state.json, clear blockers array to []
User says "run this twice a day now" → update runs_per_day to 2 in state.json

When a goal has status "blocked" and user says any resume trigger above:
- Set status to "active", set blockers to []
- Reply: "Goal resumed. It'll run on its next scheduled session."

## Listing all goals
Read all `{BLOPUS_DIR}/goals/*/state.json` files and summarize active ones with days remaining or completion condition.
