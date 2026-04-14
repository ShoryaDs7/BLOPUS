---
name: video-script
description: Use this skill when the user wants to write YouTube scripts, video hooks, titles, descriptions, shorts scripts, podcast outlines, or any video content writing.
---

# Video Script Writing Guide

## YouTube Long-Form Script Structure

```
HOOK (0-15 sec) — Why should they keep watching?
PROMISE (15-30 sec) — What will they learn/get?
INTRO (30-60 sec) — Briefly who you are, why you're credible
CONTENT (bulk) — The actual value
CTA (last 30 sec) — Subscribe, like, comment prompt
```

## Prompt Templates

### Full YouTube Script Prompt
When asked to write a YouTube script, use this structure:

```
Topic: [TOPIC]
Target audience: [WHO]
Video length: [5 min / 10 min / 15 min]
Tone: [Educational / Entertaining / Motivational / Tutorial]

Write:
1. 3 hook options (pattern interrupt, shocking stat, or question)
2. Promise statement
3. Full script with timestamps
4. B-roll suggestions in [brackets]
5. CTA at the end
6. 5 title options
7. SEO description (150 words) with keywords
8. 5 hashtags
```

### Hook Formulas
```python
hooks = {
    "shocking_stat": "X% of people don't know this...",
    "pattern_interrupt": "Stop. Before you do [common thing], watch this.",
    "question": "What if you could [desired outcome] without [pain point]?",
    "story": "6 months ago I was [bad situation]. Today [transformation].",
    "contrarian": "Everyone says [common advice]. They're wrong. Here's why.",
    "curiosity_gap": "There's a [thing] nobody talks about in [industry]. I'm going to show you."
}
```

### YouTube Shorts Script (60 seconds)
```
[0-3s] HOOK — Visual + voiceover: shocking statement or question
[3-10s] SETUP — Context in 1-2 sentences
[10-45s] CONTENT — The actual tip/story (3 points max)
[45-55s] PAYOFF — The result/punchline
[55-60s] CTA — "Follow for more" or "Comment X if this helped"

Keep sentences SHORT. One idea per line. No filler words.
```

### Podcast Episode Outline
```
COLD OPEN (2 min) — Most interesting moment teaser
INTRO (3 min) — Host intro + guest intro
SEGMENT 1 (15 min) — Background story
SEGMENT 2 (20 min) — Main topic / expertise
SEGMENT 3 (15 min) — Tactical advice / actionable tips  
RAPID FIRE (5 min) — Quick questions
OUTRO (5 min) — Where to find guest, CTA
```

## Write a Script Automatically

```python
import anthropic

client = anthropic.Anthropic(api_key="YOUR_KEY")

def write_youtube_script(topic: str, duration_mins: int = 10, tone: str = "educational") -> str:
    prompt = f"""Write a complete YouTube script about: {topic}

Target duration: {duration_mins} minutes
Tone: {tone}

Include:
1. 3 hook options
2. Full script with [timestamp] markers every 2 minutes
3. [B-ROLL: description] notes throughout
4. Engagement questions to ask viewers
5. Strong CTA at end

Format clearly with sections."""

    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}]
    )
    return msg.content[0].text

script = write_youtube_script("How AI agents will replace social media managers", 10)
print(script)

# Save to file
with open("script.txt", "w") as f:
    f.write(script)
print("Script saved to script.txt")
```

## Title Formula Generator
```python
title_formulas = [
    "How I [Result] in [Timeframe] (Without [Common Method])",
    "The [Adjective] Truth About [Topic] Nobody Tells You",
    "[Number] [Topic] Mistakes That Are Killing Your [Goal]",
    "I Tried [Thing] for [Duration]. Here's What Happened.",
    "Why [Common Belief] Is Wrong (And What Actually Works)",
    "The [Topic] Strategy That Got Me [Impressive Result]",
]
```

## SEO Description Template
```
First 2 lines (visible before "show more"):
[Hook sentence with main keyword] [What viewer will learn]

Full description:
In this video, I [explain/show/reveal] [TOPIC].

You'll learn:
• [Point 1]
• [Point 2]  
• [Point 3]

This works for [target audience] who want to [goal].

Timestamps:
0:00 Intro
1:30 [Section 1]
4:00 [Section 2]

#[keyword1] #[keyword2] #[keyword3]
```

## Quick Reference

| Format | Length | Key Elements |
|--------|--------|-------------|
| YouTube long | 8-20 min | Hook, promise, content, CTA |
| YouTube Shorts | 45-60 sec | Hook in 3s, one idea, follow CTA |
| Podcast | 30-60 min | Cold open, segments, rapid fire |
| Reel/TikTok | 15-30 sec | Visual hook, instant value |
