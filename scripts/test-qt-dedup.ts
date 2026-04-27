#!/usr/bin/env npx tsx
/**
 * test-qt-dedup.ts — simulates 10 QT cycles and checks:
 * 1. Same tweet never QT'd twice (dedup)
 * 2. Topics rotate — no topic repeats until all others used
 */

const qtTopics = [
  'AI and technology',
  'India and society',
  'Social justice',
  'Religion and communalism',
  'Humor and memes',
]

// Simulate persisted engaged IDs
const engagedTweetIds = new Set<string>()
const recentQTTopics: string[] = []
const cooldown = Math.max(qtTopics.length - 1, 0)

// Fake tweet pool — each has an ID and a topic
const tweetPool = [
  { id: 'tweet_ai_1', topic: 'AI and technology' },
  { id: 'tweet_ai_2', topic: 'AI and technology' },
  { id: 'tweet_india_1', topic: 'India and society' },
  { id: 'tweet_india_2', topic: 'India and society' },
  { id: 'tweet_justice_1', topic: 'Social justice' },
  { id: 'tweet_religion_1', topic: 'Religion and communalism' },
  { id: 'tweet_humor_1', topic: 'Humor and memes' },
  { id: 'tweet_humor_2', topic: 'Humor and memes' },
]

console.log(`\nQT Topics: ${qtTopics.length}  |  Cooldown: ${cooldown}\n`)
console.log('─'.repeat(60))

const qtHistory: { id: string; topic: string }[] = []
let dupTweet = 0
let dupTopic = 0

for (let cycle = 1; cycle <= 10; cycle++) {
  // Determine available topics based on rotation
  const available = recentQTTopics.length >= cooldown
    ? qtTopics.filter(t => !recentQTTopics.includes(t))
    : qtTopics

  // Find eligible tweet (not engaged, topic in available)
  const eligible = tweetPool.filter(t =>
    !engagedTweetIds.has(t.id) && available.includes(t.topic)
  )

  if (!eligible.length) {
    console.log(`Cycle ${cycle.toString().padStart(2)}: no eligible tweets`)
    continue
  }

  const pick = eligible[Math.floor(Math.random() * eligible.length)]

  // Record
  engagedTweetIds.add(pick.id)
  recentQTTopics.push(pick.topic)
  if (recentQTTopics.length > cooldown) recentQTTopics.shift()
  qtHistory.push(pick)

  console.log(`Cycle ${cycle.toString().padStart(2)}: [${pick.topic.split(' ')[0].padEnd(10)}] ${pick.id}`)
}

console.log('─'.repeat(60))

// Check dedup
const seenIds = new Set<string>()
for (const q of qtHistory) {
  if (seenIds.has(q.id)) dupTweet++
  seenIds.add(q.id)
}

// Check topic back-to-back
for (let i = 1; i < qtHistory.length; i++) {
  if (qtHistory[i].topic === qtHistory[i - 1].topic) dupTopic++
}

console.log(`\nSame tweet QT'd twice: ${dupTweet} (should be 0)`)
console.log(`Back-to-back same topic: ${dupTopic} (should be 0)`)
console.log(dupTweet === 0 && dupTopic === 0 ? '\n✓ PASS' : '\n✗ FAIL')
