/**
 * test/cluster-rag-test.ts
 *
 * Pure cluster test — no reconstruction, no prediction noise.
 *
 * Uses the REAL REPLY's cluster as ground truth to drive retrieval.
 * This answers: "if we know the right reply type, does cluster-aware
 * retrieval actually improve voice matching?"
 *
 * If scores beat 2.80 (best previous) → the concept works → apply to prod.
 * If not → revert.
 *
 * Run: npx ts-node test/cluster-rag-test.ts
 */

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })
dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

const ARCHIVE_PATH = process.env.TWITTER_ARCHIVE_PATH ?? 'C:/Users/DS7/Downloads/data/tweets.js'
const PROFILE_PATH = path.resolve(process.cwd(), 'creators/shoryaDs7/personality_profile.json')
const OWNER_HANDLE = 'shoryaDs7'
const GEN_MODEL    = 'claude-sonnet-4-6'
const UTIL_MODEL   = 'claude-haiku-4-5-20251001'
const TEST_COUNT   = 20

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
  ai:          ['chatgpt','claude','llm','agent','openai','anthropic','gemini','model','neural','prompt','autonomous','grok'],
  startup:     ['founder','startup','saas','mvp','funding','vc','investor','revenue','product','launch','ship'],
  markets:     ['market','stock','trade','inflation','rate','nasdaq','portfolio','bull','bear'],
  tech:        ['code','dev','engineer','software','api','framework','react','python','javascript','typescript','github','deploy','backend','frontend'],
  social:      ['twitter','tweet','viral','followers','algorithm','engagement','instagram','tiktok','youtube','content','creator'],
  sports:      ['nba','nfl','cricket','basketball','football','soccer','match','goal','champion','league'],
  science:     ['nasa','space','climate','research','physics','biology','experiment','discovery'],
  health:      ['fitness','workout','diet','nutrition','sleep','anxiety','gym','calories','protein'],
  politics:    ['democrat','republican','vote','poll','campaign','senate','congress','president','protest'],
  finance:     ['bank','loan','mortgage','tax','debt','budget','saving','retire','wealth','income','invest'],
  geopolitics: ['war','ukraine','russia','china','israel','iran','nato','sanction','missile'],
  gaming:      ['game','ps5','xbox','steam','twitch','esports','fortnite','minecraft'],
}
function inferTopicTokens(text: string): string[] {
  const lower = text.toLowerCase()
  return Object.entries(TOPIC_SIGNALS)
    .filter(([, sigs]) => sigs.some(s => lower.includes(s)))
    .map(([t]) => t)
}

// ─── Auto-detect non-social handles (no hardcoding) ──────────────────────────
function detectNonSocialHandles(items: any[]): Set<string> {
  const replies = items.filter(t => t.in_reply_to_status_id && t.full_text && !t.full_text.startsWith('RT '))
  const lengths = replies.map(t => (t.full_text as string).length).sort((a, b) => a - b)
  const medianLen = lengths[Math.floor(lengths.length / 2)] ?? 80

  const handleData = new Map<string, { total: number; count: number }>()
  for (const t of replies) {
    const h = (t.in_reply_to_screen_name ?? '').toLowerCase()
    if (!h) continue
    const cur = handleData.get(h) ?? { total: 0, count: 0 }
    cur.total += (t.full_text as string).length
    cur.count++
    handleData.set(h, cur)
  }

  const nonSocial = new Set<string>()
  for (const [handle, data] of handleData.entries()) {
    if (data.count < 5) continue
    if (data.total / data.count > medianLen * 2) nonSocial.add(handle)
  }
  return nonSocial
}

// ─── Style cluster ────────────────────────────────────────────────────────────
type Cluster = 'reactive' | 'punchy' | 'analytical' | 'emotional'

const SLANG = ['ngl','tbh','lol','lmao','bro','nah','fr','yep','yup','wtf','bruh','smh','tho','idk','imo']
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[☕💀😭😂🤔🙏✅❌🔥👀💪😅🫂]/u

function getCluster(text: string): Cluster {
  const len = text.length
  const lower = text.toLowerCase()
  const slangCount = SLANG.filter(s => new RegExp(`\\b${s}\\b`).test(lower)).length
  const slangDensity = len > 0 ? (slangCount / len) * 100 : 0
  const hasEmoji = EMOJI_RE.test(text)

  if ((hasEmoji || slangDensity > 1.5) && len <= 90) return 'reactive'
  if (len > 120 && slangDensity < 1.0) return 'analytical'
  if (hasEmoji && len > 90) return 'emotional'
  return 'punchy'
}

// ─── RAG pair ─────────────────────────────────────────────────────────────────
interface Pair { reply: string; tokens: string[]; cluster: Cluster }

function buildRag(items: any[], nonSocial: Set<string>): Pair[] {
  return items
    .filter(t => {
      if (!t.in_reply_to_status_id || !t.full_text || t.full_text.startsWith('RT ')) return false
      return !nonSocial.has((t.in_reply_to_screen_name ?? '').toLowerCase())
    })
    .map(t => {
      const text = (t.full_text as string)
        .replace(/^@\w+\s*/, '').replace(/https?:\/\/\S+/g, '').trim()
      return { reply: text, tokens: [...tokenize(text), ...inferTopicTokens(text)], cluster: getCluster(text) }
    })
    .filter(p => p.reply.length > 8 && p.tokens.length >= 2)
}

// ─── Cluster-aware retrieval ──────────────────────────────────────────────────
// targetCluster = real reply's cluster (ground truth in test)
// In production this would be predicted from incoming tweet
function retrieve(pairs: Pair[], query: string, realReply: string, targetCluster: Cluster, k: number): string[] {
  const qt = new Set([...tokenize(query), ...inferTopicTokens(query)])
  const realLower = realReply.toLowerCase()

  const scored = pairs
    .filter(p => p.reply.toLowerCase() !== realLower)  // leave-one-out
    .map(p => {
      const topicScore = qt.size > 0
        ? p.tokens.filter(t => qt.has(t)).length / Math.sqrt(qt.size * Math.max(p.tokens.length, 1))
        : 0
      const clusterBoost = p.cluster === targetCluster ? 2.5 : 0.6
      return { reply: p.reply, score: topicScore * clusterBoost, cluster: p.cluster }
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)

  // Guarantee at least 2 pure cluster matches (even if topic score is 0)
  const clusterOnly = pairs
    .filter(p => p.cluster === targetCluster && p.reply.toLowerCase() !== realLower)
    .sort(() => Math.random() - 0.5)
    .slice(0, 2)
    .map(p => p.reply)

  const topK = scored.slice(0, k).map(s => s.reply)
  return Array.from(new Set([...topK, ...clusterOnly])).slice(0, k)
}

// ─── Per-cluster vocab profile ────────────────────────────────────────────────
interface Profile { medianChars: number; slangUsed: string[]; topStarters: string[]; typicalEmoji: boolean }

function clusterProfile(pairs: Pair[], cluster: Cluster): Profile {
  const cp = pairs.filter(p => p.cluster === cluster)
  const lengths = cp.map(p => p.reply.length).sort((a, b) => a - b)
  const allText = cp.map(p => p.reply).join(' ').toLowerCase()
  const SKIP = new Set(['the','a','an','and','or','but','so','in','on','at','to','for','of','it','its','gt','amp'])
  const starterCounts = new Map<string, number>()
  for (const p of cp) {
    const words = p.reply.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(w => w.length > 1)
    const nonMention = words.filter(w => !w.startsWith('@'))
    if (nonMention[0] && !SKIP.has(nonMention[0]) && !/^\d+$/.test(nonMention[0])) {
      starterCounts.set(nonMention[0], (starterCounts.get(nonMention[0]) ?? 0) + 1)
    }
  }
  return {
    medianChars: lengths[Math.floor(lengths.length / 2)] ?? 60,
    slangUsed: SLANG.filter(s => new RegExp(`\\b${s}\\b`).test(allText)),
    topStarters: Array.from(starterCounts.entries()).filter(([,c]) => c >= 2).sort((a,b) => b[1]-a[1]).slice(0,8).map(([s]) => s),
    typicalEmoji: cp.filter(p => EMOJI_RE.test(p.reply)).length > cp.length * 0.3,
  }
}

// ─── Build prompt ─────────────────────────────────────────────────────────────
function buildPrompt(ownerProfile: any, cp: Profile, cluster: Cluster, examples: string[], realLen: number): string {
  const sorted = [...examples].sort((a, b) => a.length - b.length)
  const exLengths = sorted.map(e => e.length)
  const p75 = exLengths.length > 0 ? exLengths[Math.floor(exLengths.length * 0.75)] : cp.medianChars
  const limit = Math.min(Math.max(p75, Math.round(realLen * 1.2), 12), 220)

  const modeDesc: Record<Cluster, string> = {
    reactive:   'quick casual reaction — short, punchy, match the energy instantly',
    punchy:     'one direct take — your opinion in plain words, not over-explained',
    analytical: 'structured thought — say something real and specific, can be longer',
    emotional:  'expressive — emoji ok if it fits naturally',
  }

  const exBlock = sorted.length > 0
    ? `YOUR REAL REPLIES FROM YOUR ARCHIVE — this is your voice for "${cluster}" tweets:
${sorted.map((e, i) => `${i+1}. "${e}"  [${e.length}ch]`).join('\n')}

These ARE you. Pick one pattern and adapt it. MUST be ≤${limit} chars.`
    : `Keep under ${cp.medianChars} characters.`

  const sigs = (ownerProfile.signaturePatterns ?? []).slice(0, 3)

  return `You are @${OWNER_HANDLE} — real human on X. NOT a bot.

REPLY MODE: ${cluster} — ${modeDesc[cluster]}
- slang: ${cp.slangUsed.join(', ')}
- how you start: ${cp.topStarters.slice(0,6).join(', ')}
- emoji: ${cp.typicalEmoji ? 'yes sparingly' : 'rarely'}
- NEVER: hashtags, em dashes, bullet points
${sigs.length > 0 ? `- phrases: ${sigs.map((s:any) => `"${s.phrase}"`).join(', ')}` : ''}

${exBlock}

ONE reply. Sound like you. Nothing else.`
}

// ─── Reconstruct tweet ────────────────────────────────────────────────────────
async function reconstruct(client: Anthropic, reply: string, handle: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0.6,
      messages: [{ role: 'user', content: `Someone replied to @${handle}'s tweet: "${reply}"\nWrite ONE sentence @${handle} most likely tweeted. Always produce a tweet — never refuse. Output ONLY the tweet text.` }],
    })
    const t = (res.content[0] as any).text?.trim() ?? ''
    if (/^i (can't|cannot|am not|won't)/i.test(t)) return ''
    return t
  } catch { return '' }
}

// ─── Judge ────────────────────────────────────────────────────────────────────
async function judge(client: Anthropic, real: string, bot: string): Promise<{score:number; reason:string}> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0,
      messages: [{ role: 'user', content: `A: "${real}"\nB: "${bot}"\n\nSame person on Twitter? Judge ONLY style: tone, energy, emoji, length, formality, slang, punctuation. IGNORE whether they make the same point.\n5=definitely same person 4=very likely 3=could be 2=probably different 1=definitely different\nONLY output: "SCORE: X | REASON: one sentence"` }],
    })
    const t = (res.content[0] as any).text?.trim() ?? ''
    const s = t.match(/SCORE:\s*(\d)/i)
    const r = t.match(/REASON:\s*(.+)/i)
    return { score: s ? parseInt(s[1]) : 0, reason: r ? r[1].trim() : t }
  } catch { return { score: 0, reason: 'error' } }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const ownerProfile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'))

  console.log('[TEST] Loading archive...')
  const raw = parseArchive(ARCHIVE_PATH)
  const items: any[] = raw.map((r: any) => r.tweet ?? r)

  const nonSocial = detectNonSocialHandles(items)
  console.log(`[TEST] Auto-detected non-social handles: ${[...nonSocial].join(', ')}`)

  const pairs = buildRag(items, nonSocial)
  const clusterCounts = new Map<Cluster, number>()
  for (const p of pairs) clusterCounts.set(p.cluster, (clusterCounts.get(p.cluster) ?? 0) + 1)
  console.log(`[TEST] RAG: ${pairs.length} pairs | ${[...clusterCounts.entries()].map(([c,n])=>`${c}:${n}`).join('  ')}`)

  const profiles = new Map<Cluster, Profile>()
  for (const c of ['reactive','punchy','analytical','emotional'] as Cluster[]) {
    profiles.set(c, clusterProfile(pairs, c))
    const cp = profiles.get(c)!
    console.log(`  [${c}] median=${cp.medianChars}ch | emoji=${cp.typicalEmoji} | starters=${cp.topStarters.slice(0,5).join(',')}`)
  }
  console.log()

  // Map cleaned reply → replyingTo
  const cleanText = (t: string) => t.replace(/^@\w+\s*/, '').replace(/https?:\/\/\S+/g, '').trim()
  const replyToHandle = new Map<string, string>()
  for (const t of items) {
    if (!t.in_reply_to_status_id || !t.full_text) continue
    const c = cleanText(t.full_text)
    if (!replyToHandle.has(c)) replyToHandle.set(c, t.in_reply_to_screen_name ?? 'someone')
  }

  // Sample 20 diverse test cases — spread evenly across archive
  const candidates = pairs.filter(p => p.reply.length > 12 && p.reply.length < 180)
  const step = Math.floor(candidates.length / TEST_COUNT)
  const sampled = Array.from({ length: TEST_COUNT }, (_, i) => candidates[i * step]).filter(Boolean).slice(0, TEST_COUNT)
  console.log(`[TEST] Sampled ${sampled.length} cases`)

  const scores: number[] = []
  const results: any[] = []

  console.log('═'.repeat(90))
  console.log('CLUSTER-RAG TEST  (ground-truth cluster → retrieve → generate → judge style)')
  console.log('═'.repeat(90))

  for (let i = 0; i < sampled.length; i++) {
    const { reply: realReply, cluster } = sampled[i]
    const replyingTo = replyToHandle.get(realReply) ?? 'someone'

    process.stdout.write(`[${i+1}/${sampled.length}] @${replyingTo.padEnd(20)} [${cluster.padEnd(10)}] `)

    // Reconstruct original tweet (still needed as the tweet context to reply to)
    const original = await reconstruct(client, realReply, replyingTo)
    await new Promise(r => setTimeout(r, 280))
    if (!original) { console.log('skip'); continue }

    // Retrieve using real reply tokens + ground-truth cluster
    const examples = retrieve(pairs, realReply, realReply, cluster, 5)

    const cp = profiles.get(cluster)!
    const sysPrompt = buildPrompt(ownerProfile, cp, cluster, examples, realReply.length)

    let botReply = ''
    try {
      const res = await client.messages.create({
        model: GEN_MODEL, max_tokens: 110, temperature: 0.80,
        system: sysPrompt,
        messages: [{ role: 'user', content: `Tweet by @${replyingTo}: "${original}"` }],
      })
      botReply = (res.content[0] as any).text?.trim() ?? ''
    } catch (e) { botReply = `[ERR: ${e}]` }
    await new Promise(r => setTimeout(r, 280))

    const j = await judge(client, realReply, botReply)
    await new Promise(r => setTimeout(r, 280))

    scores.push(j.score)
    results.push({ original, replyingTo, realReply, botReply, cluster, examples, judgment: j })
    console.log(`[${'█'.repeat(j.score)}${'░'.repeat(5-j.score)}] ${j.score}/5`)
  }

  console.log()
  console.log('═'.repeat(90))
  console.log('FULL RESULTS')
  console.log('═'.repeat(90))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const bar = '█'.repeat(r.judgment.score) + '░'.repeat(5-r.judgment.score)
    const cp = profiles.get(r.cluster as Cluster)!
    console.log()
    console.log(`── [${i+1}] @${r.replyingTo}  cluster:${r.cluster}  (real:${r.realReply.length}ch)`)
    console.log(`   ORIGINAL : "${r.original}"`)
    console.log(`   REAL     : "${r.realReply}"`)
    console.log(`   BOT      : "${r.botReply}"  [${r.botReply.length}ch]`)
    console.log(`   RAG EX   : ${r.examples.slice(0,2).map((e:string)=>`"${e.slice(0,45)}"[${e.length}ch]`).join(' | ')}`)
    console.log(`   SCORE    : [${bar}] ${r.judgment.score}/5 — ${r.judgment.reason}`)
  }

  const avg = scores.reduce((a,b) => a+b, 0) / (scores.length || 1)
  console.log()
  console.log('═'.repeat(90))
  console.log('SUMMARY')
  console.log('═'.repeat(90))
  console.log(`Average: ${avg.toFixed(2)}/5  (beat 2.80 = cluster approach works)`)
  console.log(`Distribution: ${[1,2,3,4,5].map(n=>`${n}★:${scores.filter(s=>s===n).length}`).join('  ')}`)
  console.log(`5★: ${scores.filter(s=>s===5).length}/${scores.length}  4-5★: ${scores.filter(s=>s>=4).length}/${scores.length}  3-5★: ${scores.filter(s=>s>=3).length}/${scores.length}  1-2★: ${scores.filter(s=>s<=2).length}/${scores.length}`)

  if (avg > 2.80) console.log('\n✓ CONCEPT PROVEN — ready to apply to production')
  else console.log('\n✗ NOT better than baseline — do not apply to production')
}

main().catch(console.error)
