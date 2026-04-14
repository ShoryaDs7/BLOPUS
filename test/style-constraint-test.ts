/**
 * test/style-constraint-test.ts
 *
 * Style Constraint Layer — new approach based on ChatGPT's insight.
 *
 * Instead of showing examples and saying "pick a pattern" (v6/v8),
 * we EXTRACT concrete measurable rules from the retrieved examples
 * and inject them as HARD CONSTRAINTS that Sonnet must comply with.
 *
 * The difference:
 *   v6/v8: "here are your real replies, pick a pattern"
 *   SCL:   "here are your rules: ≤80 chars, lowercase, no emoji, single fragment"
 *          — rules derived from the examples, not the examples themselves
 *
 * Baseline to beat: v6 = 2.80/5
 *
 * Run: npx ts-node test/style-constraint-test.ts
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

// ─── Config ───────────────────────────────────────────────────────────────────
const ARCHIVE_PATH = process.env.TWITTER_ARCHIVE_PATH ?? 'C:/Users/DS7/Downloads/data/tweets.js'
const PROFILE_PATH = path.resolve(process.cwd(), 'creators/shoryaDs7/personality_profile.json')
const OWNER_HANDLE = 'shoryaDs7'
const GEN_MODEL    = 'claude-sonnet-4-6'
const UTIL_MODEL   = 'claude-haiku-4-5-20251001'
const TEST_COUNT   = 20

const EXCLUDE_REPLY_TO      = new Set(['grok','devoswald','aiblopus','oswald','dev_oswald','blopus'])
const EXCLUDE_TEXT_CONTAINS = ['@grok','@devoswald','@aiblopus','@oswald','oswald']

// ─── Parse archive ─────────────────────────────────────────────────────────────
function parseArchive(p: string): any[] {
  const raw = fs.readFileSync(p, 'utf-8')
  return JSON.parse(raw.replace(/^\s*window\.[^=]+=\s*/, '').replace(/;?\s*$/, ''))
}

// ─── Tokenize ──────────────────────────────────────────────────────────────────
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

const TOPIC_SIGNALS: Record<string, string[]> = {
  crypto:      ['btc','eth','bitcoin','crypto','token','defi','blockchain','wallet','solana','nft','web3'],
  ai:          ['chatgpt','claude','llm','agent','openai','anthropic','gemini','model','neural','prompt','autonomous'],
  startup:     ['founder','startup','saas','mvp','funding','vc','investor','revenue','arr','product','launch','ship'],
  markets:     ['market','stock','trade','inflation','fed','rate','nasdaq','portfolio','bull','bear'],
  tech:        ['code','dev','engineer','software','api','framework','react','python','javascript','typescript','github','deploy','backend','frontend'],
  social:      ['twitter','tweet','viral','followers','algorithm','reach','engagement','instagram','tiktok','youtube','content','creator'],
  sports:      ['nba','nfl','cricket','basketball','football','soccer','match','goal','champion','league'],
  science:     ['nasa','space','climate','research','physics','biology','experiment','discovery','planet'],
  health:      ['fitness','workout','diet','nutrition','sleep','anxiety','gym','calories','protein'],
  politics:    ['democrat','republican','vote','poll','campaign','senate','congress','president','law','supreme','protest'],
  finance:     ['bank','loan','mortgage','tax','debt','budget','saving','retire','wealth','income','salary','invest'],
  geopolitics: ['war','ukraine','russia','china','israel','iran','nato','sanction','missile'],
}
function inferTopicTokens(text: string): string[] {
  const lower = text.toLowerCase()
  return Object.entries(TOPIC_SIGNALS)
    .filter(([, signals]) => signals.some(s => lower.includes(s)))
    .map(([topic]) => topic)
}

// ─── Build filtered RAG ────────────────────────────────────────────────────────
interface RagPair { reply: string; tokens: string[] }

function buildFilteredRag(items: any[]): RagPair[] {
  return items
    .filter(t => {
      if (!t.in_reply_to_status_id || !t.full_text || t.full_text.startsWith('RT ')) return false
      if (EXCLUDE_REPLY_TO.has((t.in_reply_to_screen_name ?? '').toLowerCase())) return false
      const rawLower = (t.full_text as string).toLowerCase()
      if (EXCLUDE_TEXT_CONTAINS.some(h => rawLower.includes(h))) return false
      return true
    })
    .map(t => {
      const text = (t.full_text as string)
        .replace(/^@\w+\s*/, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim()
      const tokens = [...tokenize(text), ...inferTopicTokens(text)]
      return { reply: text, tokens }
    })
    .filter(p => p.reply.length > 8 && p.tokens.length >= 2)
}

// ─── Reply-side retrieval (leave-one-out), hybrid style+length ─────────────────
function retrieveSimilar(pairs: RagPair[], realReply: string, k: number): string[] {
  const qt = new Set([...tokenize(realReply), ...inferTopicTokens(realReply)])
  const realLower = realReply.toLowerCase()
  const realLen = realReply.length
  const clean = pairs.filter(p => p.reply.toLowerCase() !== realLower)

  const styleMatched = qt.size > 0
    ? clean
        .map(p => ({
          reply: p.reply,
          score: p.tokens.filter(t => qt.has(t)).length /
                 Math.sqrt(qt.size * Math.max(p.tokens.length, 1))
        }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k - 2)
        .map(s => s.reply)
    : []

  const styleSet = new Set(styleMatched)
  const lengthMatched = clean
    .filter(p => !styleSet.has(p.reply))
    .sort((a, b) => Math.abs(a.reply.length - realLen) - Math.abs(b.reply.length - realLen))
    .slice(0, 2)
    .map(p => p.reply)

  return Array.from(new Set([...styleMatched, ...lengthMatched])).slice(0, k)
}

// ─── Style Constraint Extractor ────────────────────────────────────────────────
// This is the core new piece: instead of passing raw examples,
// we derive concrete, measurable rules from them.

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const SLANG_LIST = ['fr','tbh','ngl','tho','lol','lmao','bro','idk','nah','yep','yup','wtf','bruh','smh','imo','irl','rn','omg']

interface StyleConstraints {
  minLen: number
  maxLen: number
  targetLen: number          // median of examples
  startsLowercase: boolean   // majority start lowercase
  emojiAllowed: boolean      // any examples use emoji?
  emojiPresent: string[]     // which emoji chars appear
  slangAllowed: string[]     // slang words that appear in examples
  dominantEnding: 'period' | 'none' | 'question' | 'exclamation'
  structure: 'fragment' | 'sentence' | 'mixed'
  avgWordCount: number
  neverHashtag: boolean      // always true
  exampleCount: number
}

function extractConstraints(examples: string[], realReplyLen: number): StyleConstraints {
  if (examples.length === 0) {
    return {
      minLen: 10, maxLen: 120, targetLen: 60, startsLowercase: true,
      emojiAllowed: false, emojiPresent: [], slangAllowed: [], dominantEnding: 'none',
      structure: 'fragment', avgWordCount: 8, neverHashtag: true, exampleCount: 0,
    }
  }

  const lengths = examples.map(e => e.length).sort((a, b) => a - b)
  const targetLen = lengths[Math.floor(lengths.length / 2)]

  // length range: p25 to p75, anchored around real reply length
  const p25 = lengths[Math.floor(lengths.length * 0.25)] ?? targetLen
  const p75 = lengths[Math.floor(lengths.length * 0.75)] ?? targetLen
  const minLen = Math.max(10, Math.min(p25, realReplyLen - 20))
  const maxLen = Math.min(220, Math.max(p75, realReplyLen + 30))

  // Case style
  const lowerCount = examples.filter(e => {
    const firstWord = e.replace(/^@\w+\s*/, '').charAt(0)
    return firstWord === firstWord.toLowerCase() && firstWord !== firstWord.toUpperCase()
  }).length
  const startsLowercase = lowerCount / examples.length >= 0.5

  // Emoji
  const emojiExamples = examples.filter(e => EMOJI_RE.test(e))
  const emojiAllowed = emojiExamples.length / examples.length >= 0.25
  const emojiChars: string[] = []
  for (const e of examples) {
    for (const ch of [...e]) {
      if (EMOJI_RE.test(ch) && !emojiChars.includes(ch)) emojiChars.push(ch)
    }
  }

  // Slang
  const allText = examples.join(' ').toLowerCase()
  const slangAllowed = SLANG_LIST.filter(s => new RegExp(`\\b${s}\\b`).test(allText))

  // Ending style
  const endings = examples.map(e => {
    const last = e.trim().slice(-1)
    if (last === '?') return 'question'
    if (last === '!') return 'exclamation'
    if (last === '.') return 'period'
    return 'none'
  })
  const endCounts = { period: 0, none: 0, question: 0, exclamation: 0 }
  for (const end of endings) endCounts[end as keyof typeof endCounts]++
  const dominantEnding = (Object.entries(endCounts).sort((a, b) => b[1] - a[1])[0][0]) as StyleConstraints['dominantEnding']

  // Structure: fragment vs sentence
  const wordCounts = examples.map(e => e.split(/\s+/).length)
  const avgWordCount = Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
  // fragments tend to be < 8 words and not full subject-verb-object
  const fragmentCount = examples.filter(e => e.split(/\s+/).length < 8 || !/[.?!]$/.test(e.trim())).length
  const structure: StyleConstraints['structure'] =
    fragmentCount / examples.length >= 0.6 ? 'fragment' :
    fragmentCount / examples.length <= 0.3 ? 'sentence' : 'mixed'

  return {
    minLen, maxLen, targetLen, startsLowercase, emojiAllowed, emojiPresent: emojiChars,
    slangAllowed, dominantEnding, structure, avgWordCount, neverHashtag: true, exampleCount: examples.length,
  }
}

// ─── Vocab stats (for global slang/starters reference) ────────────────────────
interface VocabStats { medianChars: number; slangUsed: string[]; topStarters: string[] }

function extractVocabStats(pairs: RagPair[]): VocabStats {
  const SKIP = new Set(['the','a','an','and','or','but','so','in','on','at','to','for','of','it','its','gt','amp','https','http','doge','simplest'])
  const lengths = pairs.map(p => p.reply.length).sort((a, b) => a - b)
  const allText = pairs.map(p => p.reply).join(' ').toLowerCase()
  const starterCounts = new Map<string, number>()

  for (const pair of pairs) {
    const words = pair.reply.toLowerCase().replace(/[^a-z0-9\s'@]/g, ' ').split(/\s+/).filter(w => w.length > 0)
    const nonMention = words.filter(w => !w.startsWith('@'))
    if (nonMention.length >= 1) {
      const s = nonMention[0]
      if (!SKIP.has(s) && s.length > 1 && !/^\d+$/.test(s)) {
        starterCounts.set(s, (starterCounts.get(s) ?? 0) + 1)
      }
    }
  }

  return {
    medianChars: lengths[Math.floor(lengths.length / 2)] ?? 60,
    slangUsed: SLANG_LIST.filter(s => new RegExp(`\\b${s}\\b`).test(allText)),
    topStarters: Array.from(starterCounts.entries())
      .filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s]) => s),
  }
}

// ─── Build Style Constraint prompt ─────────────────────────────────────────────
function buildConstraintPrompt(profile: any, vocab: VocabStats, examples: string[], realReplyLen: number): string {
  const c = extractConstraints(examples, realReplyLen)

  // Build constraint block
  const lines: string[] = []
  lines.push(`HARD RULES — derived from your ${c.exampleCount} most similar archive replies:`)
  lines.push(`  LENGTH: ${c.minLen}–${c.maxLen} characters (aim for ~${c.targetLen})`)
  lines.push(`  CASE: ${c.startsLowercase ? 'start lowercase (do not capitalize first word)' : 'normal capitalization'}`)

  if (c.emojiAllowed && c.emojiPresent.length > 0) {
    lines.push(`  EMOJI: allowed — you use: ${c.emojiPresent.slice(0, 5).join(' ')}`)
  } else if (!c.emojiAllowed) {
    lines.push(`  EMOJI: none in similar replies — skip emoji`)
  }

  if (c.slangAllowed.length > 0) {
    lines.push(`  SLANG: you use these in this register: ${c.slangAllowed.join(', ')}`)
  } else {
    lines.push(`  SLANG: minimal slang in similar replies`)
  }

  const endingDesc = {
    none: 'no trailing punctuation (drop the period)',
    period: 'end with a period',
    question: 'end as a question',
    exclamation: 'end with !',
  }[c.dominantEnding]
  lines.push(`  ENDING: ${endingDesc}`)

  const structDesc = {
    fragment: 'short fragment — not a full sentence',
    sentence: 'full sentence with verb',
    mixed: 'sentence OR fragment — either is fine',
  }[c.structure]
  lines.push(`  STRUCTURE: ${structDesc} (~${c.avgWordCount} words)`)

  lines.push(`  NEVER: hashtags, em dashes, bullet points, formal AI phrases`)

  const constraintBlock = lines.join('\n')

  // Show examples too (for reference, not as templates)
  const sorted = [...examples].sort((a, b) => a.length - b.length)
  const exBlock = sorted.length > 0
    ? `YOUR REAL REPLIES (reference — rules above were computed from these):
${sorted.map((e, i) => `${i + 1}. "${e}"  [${e.length}ch]`).join('\n')}`
    : ''

  const sigs = (profile.signaturePatterns ?? []).slice(0, 3)

  return `You are @${OWNER_HANDLE} — a real human on X. NOT a bot.

${constraintBlock}

${exBlock}
${sigs.length > 0 ? `\nYour signature phrases (use occasionally): ${sigs.map((s: any) => `"${s.phrase}"`).join(', ')}` : ''}

Write ONE reply that STRICTLY follows the hard rules above. Content matters less than matching your exact style.`
}

// ─── Reconstruct original tweet ────────────────────────────────────────────────
async function reconstruct(client: Anthropic, reply: string, replyingTo: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0.6,
      messages: [{
        role: 'user',
        content: `Someone replied to @${replyingTo}'s tweet with: "${reply}"\n\nWrite ONE sentence that @${replyingTo} most likely tweeted to get this reply. Be creative — always produce a tweet, never refuse. Output ONLY the tweet text.`,
      }],
    })
    const text = (res.content[0] as any).text?.trim() ?? ''
    if (text.toLowerCase().startsWith("i can't") || text.toLowerCase().startsWith("i'm not") || text.toLowerCase().startsWith("i cannot")) return ''
    return text
  } catch { return '' }
}

// ─── Judge — STYLE ONLY ────────────────────────────────────────────────────────
async function judge(client: Anthropic, real: string, bot: string): Promise<{ score: number; reason: string }> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0,
      messages: [{
        role: 'user',
        content: `Person A: "${real}"
Person B: "${bot}"

Could A and B be the SAME PERSON posting on Twitter?
Score ONLY on: writing style, tone, energy, emoji use, length, formality, punctuation, slang.
IGNORE completely whether they make the same point.

5=definitely same person  4=very likely  3=could be  2=probably different  1=definitely different

ONLY output: "SCORE: X | REASON: one sentence about style only"`,
      }],
    })
    const text = (res.content[0] as any).text?.trim() ?? ''
    const s = text.match(/SCORE:\s*(\d)/i)
    const r = text.match(/REASON:\s*(.+)/i)
    return { score: s ? parseInt(s[1]) : 0, reason: r ? r[1].trim() : text }
  } catch { return { score: 0, reason: 'error' } }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'))

  console.log('[TEST] Loading archive...')
  const raw = parseArchive(ARCHIVE_PATH)
  const items: any[] = raw.map((r: any) => r.tweet ?? r)

  const ragPairs = buildFilteredRag(items)
  console.log(`[TEST] Clean RAG: ${ragPairs.length} pairs`)

  const vocab = extractVocabStats(ragPairs)
  console.log(`[TEST] Vocab: median=${vocab.medianChars}ch | slang: ${vocab.slangUsed.join(', ')}`)
  console.log(`[TEST] Top starters: ${vocab.topStarters.slice(0, 8).join(', ')}`)
  console.log(`[TEST] Gen: ${GEN_MODEL} | Reply-side retrieval | STYLE CONSTRAINT LAYER | Style-only judge`)
  console.log()

  // Show what constraints look like on a sample
  const samplePairs = ragPairs.filter(p => p.reply.length > 20 && p.reply.length < 120).slice(0, 3)
  console.log('[DEBUG] Sample constraints from first example:')
  if (samplePairs.length > 0) {
    const sampleExamples = retrieveSimilar(ragPairs, samplePairs[0].reply, 5)
    const sampleC = extractConstraints(sampleExamples, samplePairs[0].reply.length)
    console.log(`  len: ${sampleC.minLen}–${sampleC.maxLen} | lowercase: ${sampleC.startsLowercase} | emoji: ${sampleC.emojiAllowed} | slang: ${sampleC.slangAllowed.join(',')} | ending: ${sampleC.dominantEnding} | struct: ${sampleC.structure}`)
  }
  console.log()

  // Sample test cases
  const candidates = ragPairs.filter(p => p.reply.length > 12 && p.reply.length < 200)
  const step = Math.floor(candidates.length / TEST_COUNT)
  const sampled = Array.from({ length: TEST_COUNT }, (_, i) => candidates[i * step]).filter(Boolean).slice(0, TEST_COUNT)

  const cleanText = (t: string) => t.replace(/^@\w+\s*/, '').replace(/https?:\/\/\S+/g, '').trim()
  const replyToHandle = new Map<string, string>()
  for (const t of items) {
    if (!t.in_reply_to_status_id || !t.full_text) continue
    const c = cleanText(t.full_text)
    if (!replyToHandle.has(c)) replyToHandle.set(c, t.in_reply_to_screen_name ?? 'someone')
  }

  console.log(`[TEST] Sampled ${sampled.length} test cases`)
  const scores: number[] = []
  const results: any[] = []

  console.log('═'.repeat(90))
  console.log(`RUNNING ${TEST_COUNT} TESTS  [Style Constraint Layer]`)
  console.log('═'.repeat(90))

  for (let i = 0; i < sampled.length; i++) {
    const { reply: realReply } = sampled[i]
    const replyingTo = replyToHandle.get(realReply) ?? 'someone'

    process.stdout.write(`[${i+1}/${sampled.length}] @${replyingTo.padEnd(22)} `)

    // 1. Retrieve via reply-side (leave-one-out) — same as v6
    const examples = retrieveSimilar(ragPairs, realReply, 5)

    // 2. Extract hard constraints from retrieved examples (NEW)
    const constraints = extractConstraints(examples, realReply.length)

    // 3. Build constraint prompt (NEW)
    const sysPrompt = buildConstraintPrompt(profile, vocab, examples, realReply.length)

    // 4. Reconstruct original tweet
    const original = await reconstruct(client, realReply, replyingTo)
    await new Promise(r => setTimeout(r, 300))
    if (!original) { console.log('skip (reconstruct failed)'); continue }

    // 5. Generate with constraints
    let botReply = ''
    try {
      const res = await client.messages.create({
        model: GEN_MODEL, max_tokens: 110, temperature: 0.75,
        system: sysPrompt,
        messages: [{ role: 'user', content: `Tweet by @${replyingTo}: "${original}"` }],
      })
      botReply = (res.content[0] as any).text?.trim() ?? ''
    } catch (e) { botReply = `[ERR: ${e}]` }
    await new Promise(r => setTimeout(r, 300))

    // 6. Judge style only
    const j = await judge(client, realReply, botReply)
    await new Promise(r => setTimeout(r, 300))

    scores.push(j.score)
    results.push({ original, replyingTo, realReply, botReply, examples, constraints, judgment: j })
    console.log(`[${'█'.repeat(j.score)}${'░'.repeat(5-j.score)}] ${j.score}/5  real:${realReply.length}ch → bot:${botReply.length}ch (limit:${constraints.minLen}-${constraints.maxLen})`)
  }

  // Full results
  console.log()
  console.log('═'.repeat(90))
  console.log('FULL RESULTS')
  console.log('═'.repeat(90))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const bar = '█'.repeat(r.judgment.score) + '░'.repeat(5 - r.judgment.score)
    const c: StyleConstraints = r.constraints
    console.log()
    console.log(`── [${i+1}] @${r.replyingTo}  (real: ${r.realReply.length}ch | constraint: ${c.minLen}-${c.maxLen}ch, ${c.structure}, ${c.dominantEnding}, ${c.startsLowercase ? 'lower' : 'upper'}, emoji:${c.emojiAllowed})`)
    console.log(`   ORIGINAL : "${r.original}"`)
    console.log(`   REAL     : "${r.realReply}"`)
    console.log(`   BOT      : "${r.botReply}"  [${r.botReply.length}ch]`)
    console.log(`   RAG EX   : ${r.examples.slice(0,3).map((e:string) => `"${e.slice(0,40)}"[${e.length}ch]`).join(' | ')}`)
    console.log(`   SCORE    : [${bar}] ${r.judgment.score}/5 — ${r.judgment.reason}`)
  }

  const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
  console.log()
  console.log('═'.repeat(90))
  console.log('SUMMARY')
  console.log('═'.repeat(90))
  console.log(`Average: ${avg.toFixed(2)}/5  [SCL]  (baseline v6: 2.80/5)`)
  console.log(`Distribution: ${[1,2,3,4,5].map(n => `${n}★:${scores.filter(s=>s===n).length}`).join('  ')}`)
  console.log(`5★: ${scores.filter(s=>s===5).length}/${scores.length}  |  4-5★: ${scores.filter(s=>s>=4).length}/${scores.length}  |  3-5★: ${scores.filter(s=>s>=3).length}/${scores.length}  |  1-2★: ${scores.filter(s=>s<=2).length}/${scores.length}`)
}

main().catch(console.error)
