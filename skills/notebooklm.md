---
name: notebooklm
description: Use this skill when the user wants to generate AI content FROM source material (PDF, file, URL, YouTube video, or text). Outputs: podcast (MP3 audio), slide deck, quiz, flashcards, AI infographic, mind map, or research report. ALWAYS use this — not image-edit — when user says "infographic", "podcast", "quiz", "flashcards", "mindmap", or "report" and there is a source document, file, or URL involved. Examples: "create an infographic of this PDF", "make a podcast from this YouTube video", "generate slides from this article", "create a quiz on this".
---

# NotebookLM Skill

Generates AI content via Google NotebookLM. Supports: podcast (MP3), slide deck (PDF), quiz (JSON), flashcards (JSON), infographic (PNG), mind map (JSON), report (Markdown).

## CRITICAL RULES
- **ONLY** call `notebooklm_generate.py` via subprocess — never import notebooklm modules directly
- **NEVER** manually handle auth, cookies, storage_state, or session files
- **NEVER** call `from notebooklm import ...` or `from notebooklm.auth import ...`
- **NEVER retry** — run the script exactly once. If it takes long, wait. If it fails, report the error and stop.
- **NEVER create more than one notebook** — one run = one notebook = one output file
- If the script fails, report the exact error from `result.stderr` — do not try to fix auth yourself

## How to call

Write a temp JSON file then pipe it to the script — avoids quoting issues on Windows:

```python
import json, subprocess, sys, tempfile, os

payload = {
    "title": "TITLE_HERE",
    "sources": ["URL_OR_TEXT"],   # plain URL, "yt: url", or "text: content"
    "type": "TYPE_HERE",          # audio | slides | quiz | flashcards | infographic | mindmap | report
    "prompt": "OPTIONAL_INSTRUCTION",
    "outDir": "C:/Blopus/output/notebooklm"
}

result = subprocess.run(
    ["python", "C:/Blopus/scripts/notebooklm_generate.py"],
    input=json.dumps(payload),
    capture_output=True,
    text=True,
    cwd="C:/Blopus"
)
out = json.loads(result.stdout.strip())
print(out)
```

- `title`: short descriptive name
- `sources`: array of strings, each one of:
  - Plain URL → `"https://..."` — any website or article
  - YouTube → `"yt: https://youtube.com/watch?v=..."` 
  - PDF/Audio/Image file → `"file: C:/Blopus/tmp/filename.pdf"` — local file path (PDF, MP3, JPG, PNG etc.)
  - Pasted text → `"text: content here"`
- `type`: one of `audio` | `slides` | `quiz` | `flashcards` | `infographic` | `mindmap` | `report`
- `prompt`: optional instruction (e.g. "focus on use cases for developers", "make it beginner friendly")

## When user sends a file to Telegram
TelegramAdapter saves all received files to `C:/Blopus/tmp/<filename>`. Use that path as `"file: C:/Blopus/tmp/<filename>"` in sources. You can read the [FILE RECEIVED] message to get the exact path.

## Output

Script prints JSON to stdout: `{"ok": true, "url": "https://notebooklm.google.com/notebook/...", "notebookId": "..."}` on success, or `{"ok": false, "error": "..."}` on failure.

## After triggering — send the link immediately
Send the owner a short message with the link:
"Done! Your [type] is generating — ready in a few mins: https://notebooklm.google.com/notebook/..."
**Do NOT wait for generation. Do NOT download any file. Your job ends once the link is sent.**

## Examples

### Podcast from URLs
```python
import json, subprocess
payload = {"title": "AI Agents Deep Dive", "sources": ["https://example.com/ai-agents-article", "yt: https://youtube.com/watch?v=xyz"], "type": "audio", "prompt": "deep dive for builders", "outDir": "C:/Blopus/output/notebooklm"}
result = subprocess.run(["python", "C:/Blopus/scripts/notebooklm_generate.py"], input=json.dumps(payload), capture_output=True, text=True, cwd="C:/Blopus")
out = json.loads(result.stdout.strip())
print(out)
```
Then output: `{"telegramFile": "C:/Blopus/output/notebooklm/AI_Agents_Deep_Dive.mp3", "fileType": "audio"}`

### Report from text
```python
import json, subprocess
payload = {"title": "Crypto Market Report", "sources": ["text: Bitcoin hit 100k in December 2024. Ethereum ETF was approved. Layer 2 networks grew 10x."], "type": "report", "prompt": "executive summary with key insights", "outDir": "C:/Blopus/output/notebooklm"}
result = subprocess.run(["python", "C:/Blopus/scripts/notebooklm_generate.py"], input=json.dumps(payload), capture_output=True, text=True, cwd="C:/Blopus")
out = json.loads(result.stdout.strip())
print(out)
```
Then output: `{"telegramFile": "C:/Blopus/output/notebooklm/Crypto_Market_Report_report.md", "fileType": "document"}`

### Quiz from YouTube
```python
import json, subprocess
payload = {"title": "Blockchain Quiz", "sources": ["yt: https://youtube.com/watch?v=abc123"], "type": "quiz", "prompt": "10 questions, intermediate level", "outDir": "C:/Blopus/output/notebooklm"}
result = subprocess.run(["python", "C:/Blopus/scripts/notebooklm_generate.py"], input=json.dumps(payload), capture_output=True, text=True, cwd="C:/Blopus")
out = json.loads(result.stdout.strip())
print(out)
```
Then output: `{"telegramFile": "C:/Blopus/output/notebooklm/Blockchain_Quiz_quiz.json", "fileType": "document"}`

## Login status — SKIP ALL LOGIN CHECKS
**NEVER check login. NEVER run `python -m notebooklm list`. NEVER ask the owner to login or open a browser.**
The session is saved. Just run the generate script directly. If it fails, report the exact error text — do not ask for login.

## Note on generation time
- audio/podcast: 3-5 minutes
- slides/infographic: 2-4 minutes
- quiz/flashcards/mindmap/report: 1-2 minutes

Tell the owner it's generating and will arrive shortly — don't time out.
