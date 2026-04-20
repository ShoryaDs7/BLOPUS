---
name: post-on-x
description: Post tweet, reply, or quote tweet on X as the bot or owner account
---

# Posting on X

## Tool to use
`npx tsx tools/x-cli.ts <command> <handle> [args]`

Run from: the Blopus project root (`$BLOPUS_DIR`)

## Posting a new tweet (x-cli — reliable)
```
npx tsx tools/x-cli.ts post <handle> "text"
```
- Bot account handle: value of `BOT_HANDLE` in `.env`
- Owner account handle: value of `OWNER_HANDLE` in `.env`
- **ALWAYS count characters before posting. If over 280, NEVER truncate — split into a thread instead.**

## Splitting into a thread (when content exceeds 280 chars)
1. Split the content into chunks, each under 260 chars (leave room for " 1/3" numbering)
2. Add " 1/3", " 2/3", " 3/3" at the end of each chunk
3. Post tweet 1 first, get its tweet ID from the response
4. Reply to tweet 1 with tweet 2, reply to tweet 2 with tweet 3, and so on
5. Never cut a sentence in the middle — break at natural sentence/bullet boundaries

## Replying to a tweet (browser only — x-cli reply is unreliable)
1. `browser_navigate("https://x.com/<authorHandle>/status/<tweetId>")`
2. `browser_snapshot()` — find the reply compose area, get its ref (e.g. `[ref=42]`)
3. `browser_click(ref=42)` — click it
4. `browser_snapshot()` — confirm it's active
5. `browser_type(ref=42, text="your reply")`
6. `browser_snapshot()` — find the Reply/Post button ref
7. `browser_click(ref=<button>)` — submit
8. `browser_snapshot()` — confirm posted

## Finding a tweet to reply to
1. `browser_navigate("https://x.com/search?q=<topic>+min_faves%3A500&f=live")`
2. `browser_take_screenshot()` — Claude reads the screenshot to see view counts, likes, timestamps visually (accessibility tree doesn't expose these)
3. Pick the tweet with highest engagement from what you see in the screenshot
4. `browser_snapshot()` — get the element refs for that tweet, click into it to get the tweetId from URL

## BEFORE posting — always confirm with the owner
"Found: @handle — '[tweet text]' → replying: '[your reply]' → posting now..."
