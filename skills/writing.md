---
name: writing
description: Write essays, academic papers, cover letters, LinkedIn posts, blog posts, reports. Also manage notes and deadlines via Google Calendar.
---

# Writing Skill

Use this skill when asked to write any long-form content: essays, reports, blog posts, cover letters, academic papers, LinkedIn posts, newsletters, scripts, briefs.

Also use for: saving notes, setting reminders, tracking deadlines via Google Calendar MCP.

## Essay / Long-form Writing

```python
# No code needed — pure LLM writing task.
# Steps:
# 1. Ask user for: topic, tone (academic/casual/professional), word count, audience
# 2. Generate outline first, confirm with user
# 3. Write full piece section by section
# 4. Save to file if requested using Write tool
```

### Tone guide
- **Academic**: formal, third person, citations style ("According to..."), no contractions
- **Professional**: first person ok, confident, concise, no fluff
- **Casual/blog**: conversational, short sentences, direct, can use "you"
- **LinkedIn**: hook first line, story-driven, end with question or CTA, 150-300 words ideal

### Word count targets
- Essay: 500-2000 words
- Blog post: 800-1500 words
- Cover letter: 250-400 words
- LinkedIn post: 150-300 words
- Report: structure with headers, as long as needed

## Notes — Save a Note

To save a note, write it to a timestamped file:

```python
import datetime, os

note = """[USER'S NOTE CONTENT HERE]"""
timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M")
path = f"C:/Blopus/notes/{timestamp}.md"
os.makedirs("C:/Blopus/notes", exist_ok=True)
with open(path, "w") as f:
    f.write(f"# Note — {datetime.datetime.now().strftime('%B %d %Y %H:%M')}\n\n{note}")
print(f"Saved to {path}")
```

## Deadlines / Calendar — Google Calendar MCP

If Google Calendar MCP is configured, use it directly to create events:

```
create_event(
  summary="[TASK NAME]",
  start="2026-04-15T10:00:00",
  end="2026-04-15T11:00:00",
  description="[DETAILS]"
)
```

If MCP is not configured, save deadline to notes file instead and remind owner to set up Google Calendar MCP by adding to `.claude/settings.json`:
```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-google-workspace"]
    }
  }
}
```

## Rules
1. Always confirm topic + tone before writing long pieces
2. Write section by section for anything over 500 words — don't dump a wall of text
3. Save output to file if user might want to edit it later
4. For deadlines, always confirm the date and time before creating calendar event
