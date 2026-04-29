---
name: post-on-x
description: Post tweet, reply, or quote tweet on X as the bot or owner account
---

# Posting on X

**Always use mcp__xtools__ tools. Never use x-cli or Bash for X actions.**

## Post a new tweet
```
mcp__xtools__post_tweet(topic="what to tweet about", angle="optional tone")
```
- `topic` = what to tweet about (a few words or a sentence)
- `angle` = optional tone/angle (e.g. "hot take", "builder perspective")
- The tool generates the tweet in the owner's exact voice from their profile.

## Reply to a tweet
```
mcp__xtools__reply_to_tweet(tweet_url="https://x.com/...", text="optional — omit to auto-generate")
```

## Quote tweet
```
mcp__xtools__quote_tweet(tweet_url="https://x.com/...", text="your comment")
```

## Find viral tweets and act
```
mcp__xtools__find_viral_and_act(topic="AI", count=3, action="reply", min_views=1000)
```

## NEVER
- Never use Bash or x-cli for X actions
- Never write the tweet text yourself and post it — always pass a topic to post_tweet so the voice profile generates it
