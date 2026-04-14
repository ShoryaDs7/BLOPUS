/**
 * test/real-tweet-test.ts
 *
 * Real ground truth test — user-provided real tweet+reply pairs.
 * No reconstruction noise. Real input tweet → bot reply → compare to real reply.
 *
 * This tests TWEET-SIDE retrieval (what actually happens in production)
 * vs REPLY-SIDE retrieval (v6 — cheating by using the real reply's tokens).
 *
 * Tests run in two modes:
 *   A) Tweet-side retrieval (realistic — uses input tweet tokens to find examples)
 *   B) SCL on top of tweet-side retrieval
 *
 * Run: npx ts-node test/real-tweet-test.ts
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

const EXCLUDE_REPLY_TO      = new Set(['grok','devoswald','aiblopus','oswald','dev_oswald','blopus'])
const EXCLUDE_TEXT_CONTAINS = ['@grok','@devoswald','@aiblopus','@oswald','oswald']

// ─── Real tweet+reply pairs (user-provided) ────────────────────────────────────
// NOTE: @grok pairs excluded — those are info-seeking queries, not social replies
const REAL_PAIRS = [
  {
    id: 'job-interviews',
    handle: 'ChadSlimeBased',
    tweet: 'Job interviews are just two people lying to each other',
    realReply: `Interviewer: We're a 'work hard, play hard' family\n\nWhat he actually wants to say : We expect 60 hours a week and there's a dusty ping-pong table in the breakroom.`,
  },
  {
    id: 'mrbeast-counting',
    handle: 'Dexerto',
    tweet: "A YouTuber is attempting to beat MrBeast's original 100,000 counting record live on YouTube. He's already streamed over 24 hours and just passed 40,000",
    realReply: `Imagine having so much free time that counting becomes a career move`,
  },
  {
    id: 'physics-tugofwar',
    handle: 'SciencePuzzle',
    tweet: 'A man pulls left with 20N. Two women pull right, each with 10N. What is the tension in the rope? A) 0N  B) 40N  C) 20N  D) None',
    realReply: `3 Simplest ways to understand this\n\nEQUAL EQUILIBRIUM: The man pulls left with 20 N, and the women pull right with a total of 20 N (10 + 10)\n\nTHE WALL RULE : If you tied the rope to a wall and pulled it with 20 N, the wall would pull back at 20 N. The tension is simply the force at one end, not the sum of both\n\nNET FORCE VS TENSION: While the net force is 0 N (so the rope doesn't move), the tension inside the rope is 20 N`,
  },
]

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

// ─── Tweet-side retrieval (REALISTIC — uses input tweet's tokens) ───────────────
// This is what actually happens in production.
function retrieveByTweet(pairs: RagPair[], inputTweet: string, k: number): string[] {
  const qt = new Set([...tokenize(inputTweet), ...inferTopicTokens(inputTweet)])

  if (qt.size === 0) {
    // fallback: random sample
    return pairs.slice(0, k).map(p => p.reply)
  }

  const scored = pairs
    .map(p => ({
      reply: p.reply,
      score: p.tokens.filter(t => qt.has(t)).length /
             Math.sqrt(qt.size * Math.max(p.tokens.length, 1))
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, k).map(s => s.reply)
}

// ─── Style Constraint Extractor ────────────────────────────────────────────────
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const SLANG_LIST = ['fr','tbh','ngl','tho','lol','lmao','bro','idk','nah','yep','yup','wtf','bruh','smh','imo','irl','rn','omg']

interface StyleConstraints {
  minLen: number; maxLen: number; targetLen: number
  startsLowercase: boolean; emojiAllowed: boolean; emojiPresent: string[]
  slangAllowed: string[]; dominantEnding: 'period'|'none'|'question'|'exclamation'
  structure: 'fragment'|'sentence'|'mixed'; avgWordCount: number
}

function extractConstraints(examples: string[]): StyleConstraints {
  if (examples.length === 0) {
    return { minLen:10, maxLen:120, targetLen:60, startsLowercase:true, emojiAllowed:false,
             emojiPresent:[], slangAllowed:[], dominantEnding:'none', structure:'fragment', avgWordCount:8 }
  }

  const lengths = examples.map(e => e.length).sort((a,b) => a - b)
  const targetLen = lengths[Math.floor(lengths.length / 2)]
  const p25 = lengths[Math.floor(lengths.length * 0.25)] ?? targetLen
  const p75 = lengths[Math.floor(lengths.length * 0.75)] ?? targetLen
  const minLen = Math.max(10, p25 - 10)
  const maxLen = Math.min(300, p75 + 30)

  const lowerCount = examples.filter(e => {
    const first = e.replace(/^@\w+\s*/, '').charAt(0)
    return first === first.toLowerCase() && first !== first.toUpperCase()
  }).length
  const startsLowercase = lowerCount / examples.length >= 0.5

  const emojiExamples = examples.filter(e => EMOJI_RE.test(e))
  const emojiAllowed = emojiExamples.length / examples.length >= 0.25
  const emojiChars: string[] = []
  for (const e of examples) for (const ch of [...e]) if (EMOJI_RE.test(ch) && !emojiChars.includes(ch)) emojiChars.push(ch)

  const allText = examples.join(' ').toLowerCase()
  const slangAllowed = SLANG_LIST.filter(s => new RegExp(`\\b${s}\\b`).test(allText))

  const endings = examples.map(e => {
    const last = e.trim().slice(-1)
    if (last === '?') return 'question'
    if (last === '!') return 'exclamation'
    if (last === '.') return 'period'
    return 'none'
  })
  const endCounts = { period:0, none:0, question:0, exclamation:0 }
  for (const end of endings) endCounts[end as keyof typeof endCounts]++
  const dominantEnding = Object.entries(endCounts).sort((a,b)=>b[1]-a[1])[0][0] as StyleConstraints['dominantEnding']

  const wordCounts = examples.map(e => e.split(/\s+/).length)
  const avgWordCount = Math.round(wordCounts.reduce((a,b)=>a+b,0)/wordCounts.length)
  const fragmentCount = examples.filter(e => e.split(/\s+/).length < 8 || !/[.?!]$/.test(e.trim())).length
  const structure: StyleConstraints['structure'] =
    fragmentCount/examples.length >= 0.6 ? 'fragment' :
    fragmentCount/examples.length <= 0.3 ? 'sentence' : 'mixed'

  return { minLen, maxLen, targetLen, startsLowercase, emojiAllowed, emojiPresent:emojiChars,
           slangAllowed, dominantEnding, structure, avgWordCount }
}

// ─── Vocab stats ───────────────────────────────────────────────────────────────
interface VocabStats { medianChars: number; slangUsed: string[]; topStarters: string[] }

function extractVocabStats(pairs: RagPair[]): VocabStats {
  const SKIP = new Set(['the','a','an','and','or','but','so','in','on','at','to','for','of','it','its','gt','amp','https','http'])
  const lengths = pairs.map(p => p.reply.length).sort((a,b) => a - b)
  const allText = pairs.map(p => p.reply).join(' ').toLowerCase()
  const starterCounts = new Map<string, number>()
  for (const pair of pairs) {
    const words = pair.reply.toLowerCase().replace(/[^a-z0-9\s'@]/g,' ').split(/\s+/).filter(w => w.length > 0)
    const nonMention = words.filter(w => !w.startsWith('@'))
    if (nonMention.length >= 1) {
      const s = nonMention[0]
      if (!SKIP.has(s) && s.length > 1 && !/^\d+$/.test(s)) starterCounts.set(s, (starterCounts.get(s)??0)+1)
    }
  }
  return {
    medianChars: lengths[Math.floor(lengths.length/2)] ?? 60,
    slangUsed: SLANG_LIST.filter(s => new RegExp(`\\b${s}\\b`).test(allText)),
    topStarters: Array.from(starterCounts.entries()).filter(([,c])=>c>=3).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([s])=>s),
  }
}

// ─── Build prompts ─────────────────────────────────────────────────────────────

// Mode A: plain examples (v6 style but with tweet-side retrieval)
function buildPlainPrompt(profile: any, vocab: VocabStats, examples: string[]): string {
  const sorted = [...examples].sort((a,b) => a.length - b.length)
  const exBlock = sorted.length > 0
    ? `YOUR REAL REPLIES (from your archive — sorted shortest → longest):
${sorted.map((e,i) => `${i+1}. "${e}"  [${e.length}ch]`).join('\n')}

CRITICAL: Pick the STRUCTURAL PATTERN of the example that best fits the tweet's energy.
Adapt the structure — swap in relevant words — but don't invent a new format.`
    : `Keep it under ${vocab.medianChars} characters.`

  const sigs = (profile.signaturePatterns ?? []).slice(0, 3)
  return `You are @${OWNER_HANDLE} — a real human on X. NOT a bot.

FROM YOUR ARCHIVE:
- slang you actually use: ${vocab.slangUsed.join(', ')}
- how you start replies: ${vocab.topStarters.slice(0,7).join(', ')}
- case style: ${profile.writingStats?.caseStyle ?? 'mostly lowercase'}
- NEVER: hashtags, em dashes, bullet points, formal AI-sounding language
${sigs.length > 0 ? `- signature phrases: ${sigs.map((s:any) => `"${s.phrase}"`).join(', ')}` : ''}

${exBlock}

ONE short reply. Nothing else.`
}

// Mode B: Style Constraint Layer
function buildConstraintPrompt(profile: any, vocab: VocabStats, examples: string[]): string {
  const c = extractConstraints(examples)
  const sorted = [...examples].sort((a,b) => a.length - b.length)

  const lines: string[] = []
  lines.push(`HARD RULES — derived from your most similar archive replies:`)
  lines.push(`  LENGTH: ${c.minLen}–${c.maxLen} characters (aim for ~${c.targetLen})`)
  lines.push(`  CASE: ${c.startsLowercase ? 'start lowercase' : 'normal capitalization'}`)
  lines.push(c.emojiAllowed && c.emojiPresent.length > 0
    ? `  EMOJI: allowed — you use: ${c.emojiPresent.slice(0,5).join(' ')}`
    : `  EMOJI: none in similar replies — skip emoji`)
  if (c.slangAllowed.length > 0) lines.push(`  SLANG: you use these here: ${c.slangAllowed.join(', ')}`)
  lines.push(`  ENDING: ${{none:'no trailing punctuation',period:'end with period',question:'end as question',exclamation:'end with !'}[c.dominantEnding]}`)
  lines.push(`  STRUCTURE: ${{fragment:'short fragment — not a full sentence',sentence:'full sentence with verb',mixed:'sentence or fragment — either ok'}[c.structure]} (~${c.avgWordCount} words)`)
  lines.push(`  NEVER: hashtags, em dashes, bullet points, formal AI phrases`)

  const exBlock = sorted.length > 0
    ? `\nREFERENCE REPLIES (these are what the rules above were computed from):
${sorted.map((e,i) => `${i+1}. "${e}"  [${e.length}ch]`).join('\n')}`
    : ''

  const sigs = (profile.signaturePatterns ?? []).slice(0, 3)
  return `You are @${OWNER_HANDLE} — a real human on X. NOT a bot.

${lines.join('\n')}
${exBlock}
${sigs.length > 0 ? `\nYour signature phrases: ${sigs.map((s:any)=>`"${s.phrase}"`).join(', ')}` : ''}

Write ONE reply that STRICTLY follows the hard rules above.`
}

// ─── Judge — style only ────────────────────────────────────────────────────────
async function judge(client: Anthropic, real: string, bot: string): Promise<{ score: number; reason: string }> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0,
      messages: [{ role:'user', content:
        `Person A: "${real}"
Person B: "${bot}"

Could A and B be the SAME PERSON posting on Twitter?
Score ONLY on: writing style, tone, energy, emoji use, length, formality, punctuation, slang.
IGNORE completely whether they make the same point.

5=definitely same person  4=very likely  3=could be  2=probably different  1=definitely different

ONLY output: "SCORE: X | REASON: one sentence about style only"` }],
    })
    const text = (res.content[0] as any).text?.trim() ?? ''
    const s = text.match(/SCORE:\s*(\d)/i)
    const r = text.match(/REASON:\s*(.+)/i)
    return { score: s ? parseInt(s[1]) : 0, reason: r ? r[1].trim() : text }
  } catch { return { score:0, reason:'error' } }
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
  console.log(`[TEST] Top starters: ${vocab.topStarters.slice(0,8).join(', ')}`)
  console.log(`[TEST] ${REAL_PAIRS.length} real tweet+reply pairs — NO reconstruction noise`)
  console.log()

  const scoresA: number[] = []
  const scoresB: number[] = []

  console.log('═'.repeat(100))
  console.log('REAL TWEET TEST — Mode A: Plain examples (tweet-side retrieval)')
  console.log('               — Mode B: Style Constraint Layer (tweet-side retrieval)')
  console.log('═'.repeat(100))

  for (const pair of REAL_PAIRS) {
    console.log()
    console.log(`┌─ @${pair.handle} — "${pair.tweet.slice(0, 80)}${pair.tweet.length > 80 ? '...' : ''}"`)
    console.log(`│  REAL REPLY: "${pair.realReply.replace(/\n/g, ' | ').slice(0,100)}${pair.realReply.length > 100 ? '...' : ''}"  [${pair.realReply.length}ch]`)

    // Retrieve using input tweet (realistic)
    const examples = retrieveByTweet(ragPairs, pair.tweet, 5)
    console.log(`│  RAG EXAMPLES (tweet-side): ${examples.slice(0,3).map(e => `"${e.slice(0,35)}"[${e.length}ch]`).join(' | ')}`)

    // ── Mode A: plain examples ──
    const sysA = buildPlainPrompt(profile, vocab, examples)
    let botA = ''
    try {
      const res = await client.messages.create({
        model: GEN_MODEL, max_tokens: 200, temperature: 0.75,
        system: sysA,
        messages: [{ role:'user', content:`Tweet by @${pair.handle}: "${pair.tweet}"` }],
      })
      botA = (res.content[0] as any).text?.trim() ?? ''
    } catch (e) { botA = `[ERR]` }
    await new Promise(r => setTimeout(r, 400))

    const jA = await judge(client, pair.realReply, botA)
    scoresA.push(jA.score)
    await new Promise(r => setTimeout(r, 400))

    // ── Mode B: SCL ──
    const sysB = buildConstraintPrompt(profile, vocab, examples)
    let botB = ''
    try {
      const res = await client.messages.create({
        model: GEN_MODEL, max_tokens: 200, temperature: 0.75,
        system: sysB,
        messages: [{ role:'user', content:`Tweet by @${pair.handle}: "${pair.tweet}"` }],
      })
      botB = (res.content[0] as any).text?.trim() ?? ''
    } catch (e) { botB = `[ERR]` }
    await new Promise(r => setTimeout(r, 400))

    const jB = await judge(client, pair.realReply, botB)
    scoresB.push(jB.score)
    await new Promise(r => setTimeout(r, 400))

    const barA = '█'.repeat(jA.score) + '░'.repeat(5-jA.score)
    const barB = '█'.repeat(jB.score) + '░'.repeat(5-jB.score)

    console.log(`│`)
    console.log(`│  MODE A (plain): "${botA.replace(/\n/g,' | ').slice(0,90)}"  [${botA.length}ch]`)
    console.log(`│           SCORE: [${barA}] ${jA.score}/5 — ${jA.reason}`)
    console.log(`│`)
    console.log(`│  MODE B (SCL):   "${botB.replace(/\n/g,' | ').slice(0,90)}"  [${botB.length}ch]`)
    console.log(`│           SCORE: [${barB}] ${jB.score}/5 — ${jB.reason}`)
    console.log(`└${'─'.repeat(99)}`)
  }

  const avgA = scoresA.reduce((a,b)=>a+b,0) / (scoresA.length||1)
  const avgB = scoresB.reduce((a,b)=>a+b,0) / (scoresB.length||1)

  console.log()
  console.log('═'.repeat(100))
  console.log('SUMMARY (real tweets, no reconstruction noise)')
  console.log('═'.repeat(100))
  console.log(`Mode A (plain examples, tweet-side retrieval): ${avgA.toFixed(2)}/5`)
  console.log(`Mode B (SCL, tweet-side retrieval):            ${avgB.toFixed(2)}/5`)
  console.log()
  console.log(`For comparison — reconstruction-based:  v6 reply-side: 2.80/5  SCL: 2.56/5`)
  console.log()
  console.log('Per-pair breakdown:')
  for (let i = 0; i < REAL_PAIRS.length; i++) {
    console.log(`  ${REAL_PAIRS[i].id.padEnd(20)} A:${scoresA[i]}/5  B:${scoresB[i]}/5`)
  }
}

main().catch(console.error)
