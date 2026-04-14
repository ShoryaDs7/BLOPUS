/**
 * test/rag-ground-truth-test.ts
 *
 * Ground truth test v8 — v6 base + pattern-anchor constraint.
 *
 * v6 insight: 2.80/5, best so far. Reply-side retrieval + @grok filtering.
 * Remaining failures: Sonnet defaults to its own "Meanwhile X ☕️" template
 * for AI tweets even when examples don't show that pattern.
 *
 * v8 fix: explicit instruction to pick ONE pattern from the retrieved examples
 * and follow it — suppresses Sonnet's own template defaults.
 *
 * Run: npx ts-node test/rag-ground-truth-test.ts
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

// ─── Config ──────────────────────────────────────────────────────────────────
const ARCHIVE_PATH = process.env.TWITTER_ARCHIVE_PATH ?? 'C:/Users/DS7/Downloads/data/tweets.js'
const PROFILE_PATH = path.resolve(process.cwd(), 'creators/shoryaDs7/personality_profile.json')
const OWNER_HANDLE = 'shoryaDs7'
const GEN_MODEL    = 'claude-sonnet-4-6'
const UTIL_MODEL   = 'claude-haiku-4-5-20251001'
const TEST_COUNT   = 20

const EXCLUDE_REPLY_TO      = new Set(['grok','devoswald','aiblopus','oswald','dev_oswald','blopus'])
const EXCLUDE_TEXT_CONTAINS = ['@grok','@devoswald','@aiblopus','@oswald','oswald']

// ─── Parse archive ────────────────────────────────────────────────────────────
function parseArchive(p: string): any[] {
  const raw = fs.readFileSync(p, 'utf-8')
  return JSON.parse(raw.replace(/^\s*window\.[^=]+=\s*/, '').replace(/;?\s*$/, ''))
}

// ─── Tokenize ─────────────────────────────────────────────────────────────────
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

// ─── Build filtered RAG ───────────────────────────────────────────────────────
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

// ─── Reply-side retrieval (leave-one-out), hybrid style+length ────────────────
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

// ─── Vocab stats ──────────────────────────────────────────────────────────────
interface VocabStats { medianChars: number; slangUsed: string[]; topStarters: string[] }

function extractVocabStats(pairs: RagPair[]): VocabStats {
  const SLANG = ['fr','tbh','ngl','tho','lol','lmao','bro','idk','nah','yep','yup','wtf','bruh','smh']
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
    slangUsed: SLANG.filter(s => new RegExp(`\\b${s}\\b`).test(allText)),
    topStarters: Array.from(starterCounts.entries())
      .filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s]) => s),
  }
}

// ─── Build generation prompt — v8: pattern-anchor constraint ─────────────────
function buildPrompt(profile: any, vocab: VocabStats, examples: string[], realReplyLen: number): string {
  const sorted = [...examples].sort((a, b) => a.length - b.length)
  const exLengths = sorted.map(e => e.length)
  const p75 = exLengths.length > 0 ? exLengths[Math.floor(exLengths.length * 0.75)] : vocab.medianChars
  const limit = Math.min(Math.max(p75, Math.round(realReplyLen * 1.3), 20), 220)

  const exBlock = sorted.length > 0
    ? `YOUR REAL REPLIES (similar context, from YOUR archive — sorted shortest → longest):
${sorted.map((e, i) => `${i + 1}. "${e}"  [${e.length}ch]`).join('\n')}

CRITICAL: Pick the STRUCTURAL PATTERN of the example that best fits the tweet's energy.
Adapt the structure — swap in relevant words — but don't invent a new format.
Your reply MUST be ≤${limit} chars.`
    : `Keep it under ${vocab.medianChars} characters.`

  const sigs = (profile.signaturePatterns ?? []).slice(0, 3)

  return `You are @${OWNER_HANDLE} — a real human on X. NOT a bot.

FROM YOUR ARCHIVE:
- slang you actually use: ${vocab.slangUsed.join(', ')}
- how you start replies: ${vocab.topStarters.slice(0, 7).join(', ')}
- case style: ${profile.writingStats?.caseStyle ?? 'mostly lowercase'}
- NEVER: hashtags, em dashes, bullet points, formal AI-sounding language
${sigs.length > 0 ? `- signature phrases: ${sigs.map((s: any) => `"${s.phrase}"`).join(', ')}` : ''}

${exBlock}

ONE short reply. Pick a pattern from your examples above and adapt it. Nothing else.`
}

// ─── Reconstruct original tweet ───────────────────────────────────────────────
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
  console.log(`[TEST] Gen: ${GEN_MODEL} | Reply-side retrieval | Pattern-anchor constraint | Style-only judge`)
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
  console.log(`RUNNING ${TEST_COUNT} TESTS  [v8: pattern-anchor constraint]`)
  console.log('═'.repeat(90))

  for (let i = 0; i < sampled.length; i++) {
    const { reply: realReply } = sampled[i]
    const replyingTo = replyToHandle.get(realReply) ?? 'someone'

    process.stdout.write(`[${i+1}/${sampled.length}] @${replyingTo.padEnd(22)} `)

    // 1. Retrieve via reply-side (leave-one-out)
    const examples = retrieveSimilar(ragPairs, realReply, 5)

    // 2. Build prompt
    const sysPrompt = buildPrompt(profile, vocab, examples, realReply.length)

    // 3. Reconstruct original tweet
    const original = await reconstruct(client, realReply, replyingTo)
    await new Promise(r => setTimeout(r, 300))
    if (!original) { console.log('skip (reconstruct failed)'); continue }

    // 4. Generate
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

    // 5. Judge style only
    const j = await judge(client, realReply, botReply)
    await new Promise(r => setTimeout(r, 300))

    scores.push(j.score)
    results.push({ original, replyingTo, realReply, botReply, examples, judgment: j })
    console.log(`[${'█'.repeat(j.score)}${'░'.repeat(5-j.score)}] ${j.score}/5`)
  }

  // Full results
  console.log()
  console.log('═'.repeat(90))
  console.log('FULL RESULTS')
  console.log('═'.repeat(90))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const bar = '█'.repeat(r.judgment.score) + '░'.repeat(5 - r.judgment.score)
    const sorted = [...r.examples].sort((a: string, b: string) => a.length - b.length)
    const exLens = sorted.map((e: string) => e.length)
    const p75 = exLens.length > 0 ? exLens[Math.floor(exLens.length * 0.75)] : vocab.medianChars
    const dynLimit = Math.min(Math.max(p75, Math.round(r.realReply.length * 1.3), 20), 220)
    console.log()
    console.log(`── [${i+1}] @${r.replyingTo}  (real: ${r.realReply.length}ch | limit: ${dynLimit}ch)`)
    console.log(`   ORIGINAL : "${r.original}"`)
    console.log(`   REAL     : "${r.realReply}"`)
    console.log(`   BOT      : "${r.botReply}"  [${r.botReply.length}ch]`)
    console.log(`   RAG EX   : ${r.examples.slice(0,3).map((e:string) => `"${e.slice(0,45)}"[${e.length}ch]`).join(' | ')}`)
    console.log(`   SCORE    : [${bar}] ${r.judgment.score}/5 — ${r.judgment.reason}`)
  }

  const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
  console.log()
  console.log('═'.repeat(90))
  console.log('SUMMARY')
  console.log('═'.repeat(90))
  console.log(`Average: ${avg.toFixed(2)}/5  (v1:2.35 v2:1.95 v2f:2.40 v3:1.85 v4:2.35 v5:2.42 v6:2.80 v6b:2.79 v7:2.30)`)
  console.log(`Distribution: ${[1,2,3,4,5].map(n => `${n}★:${scores.filter(s=>s===n).length}`).join('  ')}`)
  console.log(`5★: ${scores.filter(s=>s===5).length}/${scores.length}  |  4-5★: ${scores.filter(s=>s>=4).length}/${scores.length}  |  3-5★: ${scores.filter(s=>s>=3).length}/${scores.length}  |  1-2★: ${scores.filter(s=>s<=2).length}/${scores.length}`)
}

main().catch(console.error)
