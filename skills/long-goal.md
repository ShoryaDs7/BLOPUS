---
name: long-goal
description: Create and manage a long-running autonomous goal that works on itself daily — for multi-day, multi-week, or month-long tasks
---

# Long-Running Goals

Use this skill when the user wants something done autonomously over multiple days, weeks, or a deadline.

## When to trigger
User says any of: "over a month", "autonomously for X days", "run this for a week", "build this over the next 30 days", "research this daily", "work on this until done", "run this for me every day", "do this twice a day"

## Before creating — keep asking until everything is clear

**Step 1 — Deadline:**
Ask: "When do you need this done by? Give me a specific date."
- Vague answer → push back: "I need a specific date so I can pace the work correctly."

**Step 2 — Recommend time per day and runs per day, then confirm:**
Once you have the deadline, calculate days remaining. Based on task complexity, recommend:
- Deep work (research, coding, math, writing): 45–60 min/day
- Medium tasks (planning, analysis, outreach): 30 min/day  
- Light tasks (monitoring, summaries, social): 15 min/day

Say: "You have X days until [deadline]. For this kind of work I'd recommend [Y] min/day — that gives you [X×Y] total hours. Does that work, or do you want more/less time per day?"

Also ask: "How many sessions per day? Once a day is standard, but you can do twice if you want faster progress."

**Step 3 — Sanity check:**
- days_remaining × minutes_per_day < 30 min total → "That's not enough time. Either push the deadline or increase daily time — which would you prefer?"
- Keep asking until the combination makes sense for the task.

**Only once deadline, minutes_per_day, and runs_per_day are all confirmed:** create the goal.

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
  "timeout_minutes": {minutes_per_day confirmed by user},
  "runs_per_day": {1 or 2 as confirmed by user},
  "last_run_timestamps": [],
  "notify_chat_id": "{TELEGRAM_OWNER_CHAT_ID}"
}
```

Also create the folder: `{BLOPUS_DIR}/goals/goal_{timestamp}/` (write a blank README.md inside so the folder exists)

## After creating — confirm back to user
"Goal created. Here's what I've locked in:
- Task: [goal]
- Deadline: [date] ([X] days from now)
- Daily session: [Y] minutes × [Z] times/day
- Total work budget: [X×Y×Z] minutes

The bot will work on this automatically every time it's running and a session is due. You'll get a message after each session with what was done and what's next. To pause, redirect, or cancel — just tell me anytime."

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
- Days remaining until deadline
- Any blockers

## Redirecting
User says "change focus to X" → update current_focus in state.json
User says "pause this goal" → set status to "paused" in state.json
User says "cancel this goal" → set status to "cancelled" in state.json
User says "resume goal" → set status to "active" in state.json
User says "run this twice a day now" → update runs_per_day to 2 in state.json

## Listing all goals
Read all `{BLOPUS_DIR}/goals/*/state.json` files and summarize active ones with days remaining.
