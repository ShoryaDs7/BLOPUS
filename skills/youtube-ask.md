---
name: youtube-ask
description: Use this skill when the user sends a YouTube URL and asks a question about the video — summarize it, get main points, explain what was said, etc.
---

# Ask About a YouTube Video

```python
import os, re
from dotenv import load_dotenv
load_dotenv("C:/Blopus/.env")
load_dotenv("C:/Blopus/creators/shoryaDs7/.env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

def extract_video_id(url):
    for pat in [r"v=([a-zA-Z0-9_-]{11})", r"youtu\.be/([a-zA-Z0-9_-]{11})", r"embed/([a-zA-Z0-9_-]{11})"]:
        m = re.search(pat, url)
        if m: return m.group(1)
    raise ValueError(f"Not a valid YouTube URL: {url}")

def ask_with_gemini(video_url, question):
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=GEMINI_API_KEY)
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[types.Part.from_uri(file_uri=video_url, mime_type="video/mp4"), question]
    )
    return response.text

def ask_with_claude_transcript(video_url, question):
    from youtube_transcript_api import YouTubeTranscriptApi
    import anthropic
    video_id = extract_video_id(video_url)
    ytt = YouTubeTranscriptApi()
    transcript_list = ytt.list(video_id)
    transcript = None
    for t in transcript_list:
        transcript = t.fetch()
        break
    if not transcript:
        return "No transcript available for this video."
    text = " ".join(entry.text for entry in transcript)
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": f"YouTube video transcript:\n\n{text[:12000]}\n\nQuestion: {question}"}]
    )
    return msg.content[0].text

def ask_about_video(video_url, question):
    if GEMINI_API_KEY:
        try:
            return ask_with_gemini(video_url, question)
        except Exception as e:
            pass  # fall through to transcript
    return ask_with_claude_transcript(video_url, question)

# Replace with the URL and question from the user's message
VIDEO_URL = "YOUTUBE_URL_HERE"
QUESTION = "USER_QUESTION_HERE"

result = ask_about_video(VIDEO_URL, QUESTION)
print(result)
```

Extract the YouTube URL and question from the user's message, replace `YOUTUBE_URL_HERE` and `USER_QUESTION_HERE`, run the code, and send the full result back to the user on Telegram. If the result is longer than 4000 characters, split it into multiple messages and send each part separately so nothing gets cut off.
