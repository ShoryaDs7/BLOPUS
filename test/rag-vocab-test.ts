/**
 * test/rag-vocab-test.ts
 *
 * Compares OLD RAG approach vs NEW (vocab-augmented) approach.
 * Runs 20 test tweets through both prompts using Haiku.
 * Does NOT touch live system — read-only from existing files.
 *
 * Run: npx ts-node test/rag-vocab-test.ts
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

// Load root .env first (has ANTHROPIC_API_KEY), then creator .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

// ─── Paths ──────────────────────────────────────────────────────────────────
const RAG_INDEX_PATH  = path.resolve(process.cwd(), 'creators/shoryaDs7/rag_index.json')
const PROFILE_PATH    = path.resolve(process.cwd(), 'creators/shoryaDs7/personality_profile.json')
const OWNER_HANDLE    = 'shoryaDs7'
const MODEL           = 'claude-haiku-4-5-20251001'

// ─── LLM default phrases Haiku uses when it lacks style signal ───────────────
const NEGATIVE_VOCAB = [
  'heavy lifting',
  'deep dive',
  'game changer',
  'game-changer',
  'circle back',
  'worth noting',
  'at the end of the day',
  'moving the needle',
  'paradigm shift',
  'boils down to',
  'the real question is',
  'on-chain flow',
  'price discovery',
  "it's clear that",
  'in the grand scheme',
  'key takeaway',
  'going forward',
  'at its core',
  'fundamentally',
  'unpacking',
  'nuanced',
  'fascinating',
  'delve',
  'commendable',
  'it is worth',
  'importantly',
  'notably',
  'significant',
  'in conclusion',
]

// ─── 20 test tweets — realistic mix across Shorya's domains ─────────────────
const TEST_TWEETS = [
  // Crypto
  { author: 'AshCrypto',        text: 'MASSIVE: Blackrock ETF has bought $612,000,000 worth of Bitcoin last week.' },
  { author: 'cryptorover',      text: 'Bitcoin just broke $100k. We are officially in price discovery now.' },
  { author: 'WatcherGuru',      text: 'JUST IN: Ethereum ETF sees $500M inflows in a single day. Institutional money is here.' },
  { author: 'TheCryptoSquire',  text: 'Coca-Cola just integrated crypto payments across their vending machines. Mass adoption is here.' },
  // Sports
  { author: 'SportsCenter',     text: 'The Cavaliers are up 3-1 in the series. Donovan Mitchell has been UNCONSCIOUS this playoffs.' },
  { author: 'HaterReport',      text: 'The Lakers are cooked. LeBron simply cannot do it alone at this age anymore.' },
  { author: 'SkySports',        text: 'Manchester City wins the Champions League for the fourth time in five years.' },
  // AI / Tech
  { author: 'elonmusk',         text: 'Grok 3 is now the smartest AI on earth by every benchmark that matters.' },
  { author: 'sama',             text: 'We are closer to AGI than most people think. Probably within 2 years.' },
  { author: 'levelsio',         text: 'Just hit $100k MRR with zero employees. Build in public actually works.' },
  { author: 'EricLDaugh',       text: 'The problem with most AI startups is they are just OpenAI wrappers with no real moat.' },
  // Geopolitics
  { author: 'jacksonhinklle',   text: 'NATO is actively pushing us toward direct conflict with Russia and nobody is talking about this.' },
  { author: 'PressSec',         text: 'The administration has officially declared a national emergency at the southern border.' },
  // Social commentary
  { author: 'TheFigen_',        text: 'Nobody talks about how being average is actually a perfectly comfortable way to live.' },
  { author: 'anishmoonka',      text: 'Reply guys get more followers than people posting original content. The algorithm rewards engagement over creativity.' },
  // X / Twitter platform
  { author: 'Vivek4real_',      text: 'X Premium is now required to appear in search results. This is pay-to-play, plain and simple.' },
  // Authenticity / Image checks
  { author: 'Antunes1',         text: 'LEAKED: Secret Pentagon document shows a UFO recovered in 1947 was actually functional. Thread incoming.' },
  { author: 'MarioNawfal',      text: 'BREAKING: AI-generated deepfake of world leader declaring war goes viral — millions sharing it as real.' },
  // Math / Science
  { author: '3orovik',          text: 'A snail could cross the observable universe 100 times before humans could count to a googolplex.' },
  // Startup / Founder
  { author: 'remarks',          text: 'Most founders fail not because of bad tech but because they built something nobody actually wants.' },
]

// ─── Stopwords — used only for bigram filtering, not for raw bigram extraction ─
const BIGRAM_SKIP_STARTERS = new Set([
  'the','a','an','and','or','but','so','in','on','at','to','for','of',
  'it','its','was','are','is','be','have','had','not','that','with',
  'by','from','as','they','their','you','your','he','she','we','just',
  'also','very','if','then','when','while','since','after','before',
  'because','though','although','like','even','still','already','really',
])

// ─── Extract top bigrams from RAG pairs (including function words) ──────────
function extractDistinctiveBigrams(pairs: Array<{ reply: string }>): string[] {
  const counts = new Map<string, number>()

  for (const pair of pairs) {
    const words = pair.reply
      .toLowerCase()
      .replace(/[^a-z0-9\s'@]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 0)

    for (let i = 0; i < words.length - 1; i++) {
      const bg = `${words[i]} ${words[i + 1]}`
      counts.set(bg, (counts.get(bg) ?? 0) + 1)
    }
  }

  return Array.from(counts.entries())
    .filter(([bg, cnt]) => {
      const first = bg.split(' ')[0]
      return cnt >= 4 && !BIGRAM_SKIP_STARTERS.has(first) && bg.length > 4
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 35)
    .map(([bg]) => bg)
}

// ─── Tokenize (same as ExampleRetriever) ────────────────────────────────────
const STOPWORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','can',
  'to','of','in','for','on','with','at','by','from','as','into','through',
  'and','but','or','nor','so','yet','not','only','own','same','than','very',
  'just','now','also','i','me','my','we','our','you','your','he','his','she',
  'her','it','its','they','their','this','that','these','those','what','which',
  'who','when','where','why','how','all','each','every','few','more','most',
  'other','some','such','no','rt','https','http','amp','via','up','down','out',
])

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
}

// ─── Retrieve top-K RAG examples by token overlap ───────────────────────────
function retrieve(pairs: Array<{ reply: string; tokens: string[] }>, query: string, k: number): string[] {
  const qTokens = new Set(tokenize(query))
  if (qTokens.size === 0) return []
  return pairs
    .map(p => {
      const overlap = p.tokens.filter(t => qTokens.has(t)).length
      const score = overlap / Math.sqrt(qTokens.size * Math.max(p.tokens.length, 1))
      return { reply: p.reply, score }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => s.reply)
}

// ─── Score a reply against known issues ─────────────────────────────────────
function score(reply: string): { pass: boolean; issues: string[] } {
  const issues: string[] = []
  const low = reply.toLowerCase()

  // 1. LLM default phrases
  for (const phrase of NEGATIVE_VOCAB) {
    if (low.includes(phrase)) issues.push(`LLM phrase: "${phrase}"`)
  }

  // 2. Apostrophes in contractions (Shorya omits them)
  const apostropheContractions = ["don't","isn't","won't","can't","didn't","doesn't","it's","that's","you're","they're","we're","I'm","I've","I'll"]
  for (const c of apostropheContractions) {
    if (low.includes(c.toLowerCase())) issues.push(`apostrophe in "${c}" (should be omitted)`)
  }

  // 3. Hashtags
  if (/#\w/.test(reply)) issues.push('hashtag used')

  // 4. Too long (median is "very short" — > 140 chars is off-brand)
  if (reply.length > 140) issues.push(`too long (${reply.length} chars)`)

  // 5. Starts with handle
  if (reply.startsWith('@')) issues.push('starts with handle')

  // 6. Corporate opener phrases
  const corporateOpeners = ['As a ', 'In this context', 'It\'s important', 'This is a', 'Let me ', 'I would say']
  for (const op of corporateOpeners) {
    if (reply.startsWith(op)) issues.push(`corporate opener: "${op}"`)
  }

  return { pass: issues.length === 0, issues }
}

// ─── Build OLD system prompt (current live system) ──────────────────────────
function buildOldSystemPrompt(profile: any): string {
  const p = profile
  const stats = p.writingStats ?? {}
  const sigPatterns = p.signaturePatterns ?? []
  return `You are @${OWNER_HANDLE} — a real human replying on X. NOT a bot. NOT an assistant.

Your voice extracted from your real reply archive:
${stats.medianReplyLength ? `- your replies are typically ${stats.medianReplyLength} — stay there. if in doubt, go shorter.` : '- keep replies short by default'}
${stats.caseStyle ? `- case style: ${stats.caseStyle}` : ''}
${stats.apostropheStyle ? `- ${stats.apostropheStyle}` : ''}
- you NEVER use hashtags. ever.
- how you reply: ${p.replyStyle}
- your opinions: ${p.opinionStyle}
- phrases you actually use: ${p.examplePhrases.slice(0, 5).join(' | ')}
- you avoid: ${p.avoids.join(', ')}
${sigPatterns.length ? `\nYour signature openers — use ONLY in the right context:\n${sigPatterns.map((sp: any) => `"${sp.phrase}": use for ${sp.usedFor}${sp.neverUsedFor ? `. NEVER for ${sp.neverUsedFor}` : ''}`).join('\n')}` : ''}

STRICT rules:
- no em dashes (—). banned.
- no bullet points, no structured formatting, no hashtags
- DO NOT start with the person's handle
- no AI reveal, no bot language
- when mentioning any account or tool by name (e.g. grok, chatgpt), always write it with @ if it's a Twitter account (e.g. @grok, not grok)
- only reply in your genuine domains: ${p.dominantTopics.join(', ')} — if tweet is completely outside these, give a short neutral take or skip`
}

// ─── Build NEW system prompt (vocab-augmented) ──────────────────────────────
function buildNewSystemPrompt(profile: any, distinctiveBigrams: string[]): string {
  const base = buildOldSystemPrompt(profile)
  const vocabBlock = distinctiveBigrams.length > 0
    ? `\n\nYour actual vocabulary from archive (use these naturally — they are YOUR words):\n${distinctiveBigrams.slice(0, 20).map(b => `"${b}"`).join(', ')}`
    : ''
  const negBlock = `\n\nNEVER say these phrases — they are LLM/corporate defaults, not you:\n${NEGATIVE_VOCAB.slice(0, 15).map(p => `"${p}"`).join(', ')}`
  return base + vocabBlock + negBlock
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Load RAG index
  if (!fs.existsSync(RAG_INDEX_PATH)) {
    console.error('[TEST] RAG index not found — run the bot once to build it.')
    process.exit(1)
  }
  const ragData = JSON.parse(fs.readFileSync(RAG_INDEX_PATH, 'utf-8'))
  const pairs: Array<{ reply: string; tokens: string[] }> = ragData.pairs
  console.log(`[TEST] Loaded ${pairs.length} RAG pairs`)

  // Extract bigrams
  const bigrams = extractDistinctiveBigrams(pairs)
  console.log(`[TEST] Top bigrams from archive: ${bigrams.slice(0, 15).join(' | ')}`)
  console.log()

  // Load personality profile
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'))

  const oldSystemPrompt = buildOldSystemPrompt(profile)
  const newSystemPrompt = buildNewSystemPrompt(profile, bigrams)

  // Results
  let oldPasses = 0
  let newPasses = 0
  const results: Array<{
    tweet: string
    oldReply: string
    newReply: string
    oldScore: { pass: boolean; issues: string[] }
    newScore: { pass: boolean; issues: string[] }
  }> = []

  console.log('═'.repeat(100))
  console.log('RUNNING 20 TWEET TEST — OLD vs NEW PROMPT')
  console.log('═'.repeat(100))
  console.log()

  for (let i = 0; i < TEST_TWEETS.length; i++) {
    const tweet = TEST_TWEETS[i]
    process.stdout.write(`[${i + 1}/20] @${tweet.author}: "${tweet.text.slice(0, 60)}..." `)

    // Get RAG examples
    const oldExamples = retrieve(pairs, tweet.text, 10)  // current: 10
    const newExamples = retrieve(pairs, tweet.text, 5)   // new: 5

    const oldRagAppend = oldExamples.length > 0
      ? `\n\nSTYLE EXAMPLES (HOW you write — tone, length, energy only. NEVER reply about topics from these unless the actual tweet is about those topics):\n` +
        oldExamples.map((r, i) => `${i + 1}. ${r}`).join('\n')
      : ''

    const newRagAppend = newExamples.length > 0
      ? `\n\nSTYLE EXAMPLES (top 5 most relevant from your real replies — use ONLY for tone and length, not topics):\n` +
        newExamples.map((r, i) => `${i + 1}. ${r}`).join('\n')
      : ''

    const userMsg = `Tweet by @${tweet.author}: "${tweet.text}"`

    // OLD reply
    let oldReply = ''
    let newReply = ''
    try {
      const oldRes = await client.messages.create({
        model: MODEL,
        max_tokens: 100,
        temperature: 0.9,
        system: oldSystemPrompt + oldRagAppend,
        messages: [{ role: 'user', content: userMsg }],
      })
      oldReply = (oldRes.content[0] as any).text?.trim() ?? ''
    } catch (e) {
      oldReply = `[ERROR: ${e}]`
    }

    // Small delay to avoid rate limit
    await new Promise(r => setTimeout(r, 800))

    // NEW reply
    try {
      const newRes = await client.messages.create({
        model: MODEL,
        max_tokens: 100,
        temperature: 0.9,
        system: newSystemPrompt + newRagAppend,
        messages: [{ role: 'user', content: userMsg }],
      })
      newReply = (newRes.content[0] as any).text?.trim() ?? ''
    } catch (e) {
      newReply = `[ERROR: ${e}]`
    }

    await new Promise(r => setTimeout(r, 800))

    const oldS = score(oldReply)
    const newS = score(newReply)
    if (oldS.pass) oldPasses++
    if (newS.pass) newPasses++

    results.push({ tweet: `@${tweet.author}: ${tweet.text}`, oldReply, newReply, oldScore: oldS, newScore: newS })

    const oldMark = oldS.pass ? '✅' : '❌'
    const newMark = newS.pass ? '✅' : '❌'
    console.log(`OLD ${oldMark}  NEW ${newMark}`)
  }

  // ─── Print full results ─────────────────────────────────────────────────
  console.log()
  console.log('═'.repeat(100))
  console.log('FULL RESULTS')
  console.log('═'.repeat(100))

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    console.log()
    console.log(`── [${i + 1}] ${r.tweet.slice(0, 90)}`)
    console.log(`   OLD [${r.oldScore.pass ? '✅ PASS' : '❌ FAIL'}]: "${r.oldReply}"`)
    if (!r.oldScore.pass) console.log(`          issues: ${r.oldScore.issues.join(' | ')}`)
    console.log(`   NEW [${r.newScore.pass ? '✅ PASS' : '❌ FAIL'}]: "${r.newReply}"`)
    if (!r.newScore.pass) console.log(`          issues: ${r.newScore.issues.join(' | ')}`)
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  console.log()
  console.log('═'.repeat(100))
  console.log('SUMMARY')
  console.log('═'.repeat(100))
  console.log(`OLD system: ${oldPasses}/20 pass  (${Math.round(oldPasses / 20 * 100)}%)`)
  console.log(`NEW system: ${newPasses}/20 pass  (${Math.round(newPasses / 20 * 100)}%)`)
  console.log()
  console.log(`Top bigrams extracted from archive:`)
  console.log(bigrams.map(b => `"${b}"`).join(', '))
}

main().catch(console.error)
