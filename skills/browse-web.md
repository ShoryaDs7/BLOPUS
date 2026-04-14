---
name: browse-web
description: Browse any website, read content, interact with pages — X, news, stock prices, GitHub, anything
---

# Web Browsing

## The only correct workflow
1. `browser_navigate(url)` — go to page
2. `browser_snapshot()` — read page as accessibility tree with element refs like `[ref=12]`
3. `browser_click(ref=12)` — click that element
4. `browser_snapshot()` — see result
5. `browser_type(ref=5, text="your text")` — type into inputs
6. Repeat until done

## Why this works
You read semantic meaning ("Submit button [ref=12]"), not CSS classes. X can redesign their UI completely — you still find the button because you read its label.

## NEVER
- Write Playwright scripts
- Use curl/fetch/Bash to scrape
- Use hardcoded CSS selectors

## Finding tweets on X
- Trending: `browser_navigate("https://x.com/explore")` → snapshot → find tweet → grab tweetId from URL
- Profile: `browser_navigate("https://x.com/<handle>")` → snapshot → read tweets
- Specific tweet: `browser_navigate("https://x.com/<handle>/status/<tweetId>")`

## Handling popups/dialogs
If a popup appears in the next snapshot, you'll see it. Handle it before continuing.

## Login sessions
The browser profile at `memory-store/chrome-profiles/mcp-browser` keeps your cookies — you're already logged in.
