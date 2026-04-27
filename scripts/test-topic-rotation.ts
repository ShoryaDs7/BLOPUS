#!/usr/bin/env npx tsx
/**
 * test-topic-rotation.ts — simulates 10 autonomous post topic picks
 * and verifies no topic repeats until all others have been used.
 */

const postTopics = [
  'Hindu-Muslim tensions and communal politics',
  'Indian civic issues and social problems',
  'Philosophy and existential reflection',
  'Environmental responsibility and religious practices',
  'Justice and world cruelty',
]

const recentTopicsQueue: string[] = []
const cooldown = postTopics.length - 1
const results: string[] = []

console.log(`\nTopics: ${postTopics.length}  |  Cooldown: ${cooldown} (full rotation before repeat)\n`)
console.log('─'.repeat(60))

for (let i = 1; i <= 10; i++) {
  const available = postTopics.filter(t => !recentTopicsQueue.includes(t))
  const pool = available.length ? available : postTopics
  const picked = pool[Math.floor(Math.random() * pool.length)]

  recentTopicsQueue.push(picked)
  if (recentTopicsQueue.length > cooldown) recentTopicsQueue.shift()

  results.push(picked)
  const shortName = picked.split(' ').slice(0, 3).join(' ')
  console.log(`Post ${i.toString().padStart(2)}: ${shortName}`)
}

console.log('─'.repeat(60))

// Check for back-to-back repeats
let backToBack = 0
for (let i = 1; i < results.length; i++) {
  if (results[i] === results[i - 1]) backToBack++
}

// Check for repeats within cooldown window
let withinWindow = 0
for (let i = cooldown; i < results.length; i++) {
  const window = results.slice(i - cooldown, i)
  if (window.includes(results[i])) withinWindow++
}

console.log(`\nBack-to-back repeats: ${backToBack} (should be 0)`)
console.log(`Repeats within cooldown window: ${withinWindow} (should be 0)`)
console.log(backToBack === 0 && withinWindow === 0 ? '\n✓ PASS — full rotation working' : '\n✗ FAIL')
