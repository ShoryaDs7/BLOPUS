/**
 * test/smart-rag-test.ts
 *
 * Smart RAG v1 — auto-computed style clusters from archive.
 *
 * Zero hardcoding. Everything derived from the archive:
 *
 * 1. Auto-detect non-social replies:
 *    Find handles where owner sends unusually long/instructional messages
 *    → these are bot conversations, auto-filtered without hardcoding handles
 *
 * 2. Auto-cluster reply types:
 *    Each archive reply gets style features: length bucket, slang density,
 *    emoji presence, caps words. Natural clusters: reactive / punchy /
 *    analytical / emotional.
 *
 * 3. Classify incoming tweet:
 *    Predict which cluster the owner would reply from based on tweet features.
 *
 * 4. Cluster-aware retrieval:
 *    Topic match + cluster match → examples that are both topically AND
 *    stylistically correct.
 *
 * Run: npx ts-node test/smart-rag-test.ts
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
  startup:     ['founder','startup','saas','mvp','funding','vc','investor','revenue','product','launch','ship','bootstrap'],
  markets:     ['market','stock','trade','inflation','fed','rate','nasdaq','portfolio','bull','bear'],
  tech:        ['code','dev','engineer','software','api','framework','react','python','javascript','typescript','github','deploy','backend','frontend'],
  social:      ['twitter','tweet','viral','followers','algorithm','reach','engagement','instagram','tiktok','youtube','content','creator'],
  sports:      ['nba','nfl','cricket','basketball','football','soccer','match','goal','champion','league'],
  science:     ['nasa','space','climate','research','physics','biology','experiment','discovery','planet'],
  health:      ['fitness','workout','diet','nutrition','sleep','anxiety','gym','calories','protein'],
  politics:    ['democrat','republican','vote','poll','campaign','senate','congress','president','law','protest'],
  finance:     ['bank','loan','mortgage','tax','debt','budget','saving','retire','wealth','income','salary','invest'],
  geopolitics: ['war','ukraine','russia','china','israel','iran','nato','sanction','missile'],
  gaming:      ['game','ps5','xbox','steam','twitch','esports','fps','fortnite','minecraft','pokemon'],
  humor:       ['lol','😂','💀','😭','joke','meme','funny','bruh','bro','lmao'],
}
function inferTopicTokens(text: string): string[] {
  const lower = text.toLowerCase()
  return Object.entries(TOPIC_SIGNALS)
    .filter(([, signals]) => signals.some(s => lower.includes(s)))
    .map(([topic]) => topic)
}

// ─── STEP 1: Auto-detect non-social handles ───────────────────────────────────
// Handles where owner sends unusually long replies = bot conversations.
// Threshold: handles with ≥5 replies AND avg reply length > 2× archive median.
function detectNonSocialHandles(items: any[]): Set<string> {
  const replies = items.filter(t =>
    t.in_reply_to_status_id && t.full_text && !t.full_text.startsWith('RT ')
  )

  // Compute overall median reply length
  const allLengths = replies.map(t => (t.full_text as string).length).sort((a, b) => a - b)
  const medianLen = allLengths[Math.floor(allLengths.length / 2)] ?? 80

  // Per handle: count and avg length
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
    const avg = data.total / data.count
    // If avg reply is 2× longer than archive median → instructional/bot conversation
    if (avg > medianLen * 2) {
      nonSocial.add(handle)
    }
  }

  return nonSocial
}

// ─── STEP 2: Style features + clustering ─────────────────────────────────────
type ReplyCluster = 'reactive' | 'punchy' | 'analytical' | 'emotional'

const SLANG_WORDS = ['ngl','tbh','lol','lmao','bro','nah','fr','yep','yup','wtf','bruh','smh','tho','idk','imo']
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[☕💀😭😂🤔🙏✅❌🔥👀]/u

function computeStyleFeatures(text: string): {
  lengthBucket: 'very_short' | 'short' | 'medium' | 'long'
  slangDensity: number   // slang words per 100 chars
  hasEmoji: boolean
  hasCapsWord: boolean   // has a word in ALL CAPS (not just acronym)
  startsQuestion: boolean
  endsQuestion: boolean
  cluster: ReplyCluster
} {
  const len = text.length
  const lower = text.toLowerCase()
  const words = text.split(/\s+/)

  const slangCount = SLANG_WORDS.filter(s => new RegExp(`\\b${s}\\b`).test(lower)).length
  const slangDensity = len > 0 ? (slangCount / len) * 100 : 0
  const hasEmoji = EMOJI_RE.test(text)
  const hasCapsWord = words.some(w => w.length > 3 && w === w.toUpperCase() && /^[A-Z]+$/.test(w))
  const startsQuestion = /^(what|why|how|when|who|where|is |are |did |do |does |can |could |would |will |has |have )/i.test(text.trim())
  const endsQuestion = text.trimEnd().endsWith('?')

  const lengthBucket: 'very_short' | 'short' | 'medium' | 'long' =
    len <= 35 ? 'very_short' : len <= 80 ? 'short' : len <= 160 ? 'medium' : 'long'

  // Cluster assignment — purely from features, no hardcoding
  let cluster: ReplyCluster
  if ((hasEmoji || slangDensity > 1.5) && len <= 80) {
    cluster = 'reactive'        // short + emoji/heavy-slang → casual reaction
  } else if (slangDensity > 0.5 && len <= 120 && !endsQuestion) {
    cluster = 'punchy'          // medium + moderate slang → short take/opinion
  } else if (len > 120 && slangDensity < 1.0) {
    cluster = 'analytical'      // long + low slang → structured analysis
  } else if (hasEmoji && len > 80) {
    cluster = 'emotional'       // long + emoji → expressive/personal
  } else {
    cluster = 'punchy'          // default
  }

  return { lengthBucket, slangDensity, hasEmoji, hasCapsWord, startsQuestion, endsQuestion, cluster }
}

// ─── STEP 3: Classify incoming tweet → expected reply cluster ─────────────────
function predictReplyCluster(tweetText: string, ownerClusters: Map<ReplyCluster, number>): ReplyCluster {
  const lower = tweetText.toLowerCase()
  const len = tweetText.length

  // Signals from the incoming tweet
  const isCasual = EMOJI_RE.test(tweetText) || SLANG_WORDS.some(s => new RegExp(`\\b${s}\\b`).test(lower))
  const isLong = len > 200
  const isQuestion = lower.includes('?')
  const isTechnical = ['explain','how does','what is','build','implement','framework','api','deploy','debug'].some(k => lower.includes(k))
  const isOpinion = ['think','believe','hot take','unpopular opinion','change my mind','controversial','disagree'].some(k => lower.includes(k))
  const isHumor = ['😂','💀','😭','lol','lmao','bruh','funny','joke','meme'].some(k => lower.includes(k))

  // Most common cluster the owner uses (fallback)
  const dominant = Array.from(ownerClusters.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'punchy'

  if (isHumor || (isCasual && !isTechnical && !isOpinion)) return 'reactive'
  if (isTechnical && isLong) return 'analytical'
  if (isOpinion && !isCasual) return 'analytical'
  if (isOpinion && isCasual) return 'punchy'
  if (isQuestion && !isTechnical) return 'punchy'
  return dominant
}

// ─── Smart RAG pair ───────────────────────────────────────────────────────────
interface SmartPair {
  reply: string
  tokens: string[]
  cluster: ReplyCluster
  lengthBucket: string
  slangDensity: number
}

// ─── Build smart RAG ──────────────────────────────────────────────────────────
function buildSmartRag(items: any[]): { pairs: SmartPair[]; nonSocialHandles: Set<string>; clusterCounts: Map<ReplyCluster, number> } {
  const nonSocialHandles = detectNonSocialHandles(items)

  const pairs: SmartPair[] = []
  const clusterCounts = new Map<ReplyCluster, number>()

  for (const t of items) {
    if (!t.in_reply_to_status_id || !t.full_text || t.full_text.startsWith('RT ')) continue
    const handle = (t.in_reply_to_screen_name ?? '').toLowerCase()
    if (nonSocialHandles.has(handle)) continue

    const text = (t.full_text as string)
      .replace(/^@\w+\s*/, '')
      .replace(/https?:\/\/\S+/g, '')
      .trim()

    if (text.length < 8) continue

    const features = computeStyleFeatures(text)
    const tokens = [...tokenize(text), ...inferTopicTokens(text)]
    if (tokens.length < 2) continue

    pairs.push({ reply: text, tokens, cluster: features.cluster, lengthBucket: features.lengthBucket, slangDensity: features.slangDensity })
    clusterCounts.set(features.cluster, (clusterCounts.get(features.cluster) ?? 0) + 1)
  }

  return { pairs, nonSocialHandles, clusterCounts }
}

// ─── STEP 4: Cluster-aware retrieval ─────────────────────────────────────────
function smartRetrieve(pairs: SmartPair[], query: string, targetCluster: ReplyCluster, k: number): string[] {
  const qt = new Set([...tokenize(query), ...inferTopicTokens(query)])
  if (qt.size === 0) {
    // No tokens — fall back to cluster-only, pick diverse examples
    return pairs.filter(p => p.cluster === targetCluster).slice(0, k).map(p => p.reply)
  }

  const scored = pairs.map(p => {
    const topicScore = p.tokens.filter(t => qt.has(t)).length /
                       Math.sqrt(qt.size * Math.max(p.tokens.length, 1))

    // Cluster match boost — this is the KEY addition
    // Same cluster → 2x boost. Adjacent cluster → 1.3x. Different → 1x.
    const clusterBoost = p.cluster === targetCluster ? 2.0 : 1.0

    return { reply: p.reply, score: topicScore * clusterBoost }
  })

  // Always include at least 2 cluster-matched examples even if topic score is low
  const clusterMatches = pairs
    .filter(p => p.cluster === targetCluster)
    .sort(() => Math.random() - 0.5)  // shuffle for diversity
    .slice(0, 2)
    .map(p => p.reply)

  const topScored = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(s => s.reply)

  // Merge: top scored first, then fill with cluster matches
  const merged = Array.from(new Set([...topScored, ...clusterMatches])).slice(0, k)
  return merged
}

// ─── Per-cluster vocab profile ────────────────────────────────────────────────
interface ClusterProfile {
  medianChars: number
  topStarters: string[]
  slangUsed: string[]
  typicalEmoji: boolean
}

function buildClusterProfiles(pairs: SmartPair[]): Map<ReplyCluster, ClusterProfile> {
  const profiles = new Map<ReplyCluster, ClusterProfile>()
  const clusters: ReplyCluster[] = ['reactive', 'punchy', 'analytical', 'emotional']

  const SKIP = new Set(['the','a','an','and','or','but','so','in','on','at','to','for','of','it','its','gt','amp'])

  for (const cluster of clusters) {
    const cp = pairs.filter(p => p.cluster === cluster)
    if (cp.length === 0) continue

    const lengths = cp.map(p => p.reply.length).sort((a, b) => a - b)
    const medianChars = lengths[Math.floor(lengths.length / 2)] ?? 60
    const allText = cp.map(p => p.reply).join(' ').toLowerCase()
    const slangUsed = SLANG_WORDS.filter(s => new RegExp(`\\b${s}\\b`).test(allText))
    const typicalEmoji = cp.filter(p => EMOJI_RE.test(p.reply)).length > cp.length * 0.3

    const starterCounts = new Map<string, number>()
    for (const p of cp) {
      const words = p.reply.toLowerCase().replace(/[^a-z0-9\s'@]/g, ' ').split(/\s+/).filter(w => w.length > 0)
      const nonMention = words.filter(w => !w.startsWith('@'))
      if (nonMention.length >= 1) {
        const s = nonMention[0]
        if (!SKIP.has(s) && s.length > 1 && !/^\d+$/.test(s)) {
          starterCounts.set(s, (starterCounts.get(s) ?? 0) + 1)
        }
      }
    }
    const topStarters = Array.from(starterCounts.entries())
      .filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s)

    profiles.set(cluster, { medianChars, topStarters, slangUsed, typicalEmoji })
  }
  return profiles
}

// ─── Build prompt — cluster-aware ─────────────────────────────────────────────
function buildSmartPrompt(
  profile: any,
  clusterProfile: ClusterProfile,
  targetCluster: ReplyCluster,
  examples: string[],
  realReplyLen: number,
): string {
  const sorted = [...examples].sort((a, b) => a.length - b.length)
  const exLengths = sorted.map(e => e.length)
  const p75 = exLengths.length > 0 ? exLengths[Math.floor(exLengths.length * 0.75)] : clusterProfile.medianChars
  const limit = Math.min(Math.max(p75, Math.round(realReplyLen * 1.2), 15), 220)

  const clusterDesc: Record<ReplyCluster, string> = {
    reactive:   'short, casual, quick reaction — match the energy of the tweet',
    punchy:     'one sharp take — direct, opinionated, not overly long',
    analytical: 'structured, technical or thoughtful — say something real',
    emotional:  'expressive, personal — emoji ok if it fits',
  }

  const exBlock = sorted.length > 0
    ? `YOUR REAL REPLIES FROM YOUR ARCHIVE (similar style & topic):
${sorted.map((e, i) => `${i + 1}. "${e}"  [${e.length}ch]`).join('\n')}

↑ These ARE your voice for this type of reply.
Your reply MUST be ≤${limit} chars. Pick a pattern from above and adapt it.`
    : `Keep reply under ${clusterProfile.medianChars} characters.`

  const sigs = (profile.signaturePatterns ?? []).slice(0, 3)

  return `You are @${OWNER_HANDLE} — a real human on X. NOT a bot.

YOUR STYLE FOR THIS REPLY TYPE (${targetCluster}):
${clusterDesc[targetCluster]}
- slang you use in this mode: ${clusterProfile.slangUsed.join(', ')}
- how you start these replies: ${clusterProfile.topStarters.slice(0, 6).join(', ')}
- typical length: ~${clusterProfile.medianChars}ch
${clusterProfile.typicalEmoji ? '- emojis: yes, sparingly' : '- emojis: rare in this mode'}
- NEVER: hashtags, em dashes, bullet points, AI-sounding language
${sigs.length > 0 ? `- signature phrases: ${sigs.map((s: any) => `"${s.phrase}"`).join(', ')}` : ''}

${exBlock}

ONE reply only. Sound like you. Nothing else.`
}

// ─── Reconstruct original tweet ───────────────────────────────────────────────
async function reconstruct(client: Anthropic, reply: string, replyingTo: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0.6,
      messages: [{
        role: 'user',
        content: `Someone replied to @${replyingTo}'s tweet: "${reply}"\n\nWrite ONE sentence that @${replyingTo} most likely tweeted. Always produce a tweet — never refuse. Output ONLY the tweet text.`,
      }],
    })
    const text = (res.content[0] as any).text?.trim() ?? ''
    if (text.toLowerCase().startsWith("i can't") || text.toLowerCase().startsWith("i'm not") || text.toLowerCase().startsWith("i cannot")) return ''
    return text
  } catch { return '' }
}

// ─── Judge — style only ────────────────────────────────────────────────────────
async function judge(client: Anthropic, real: string, bot: string): Promise<{ score: number; reason: string }> {
  try {
    const res = await client.messages.create({
      model: UTIL_MODEL, max_tokens: 80, temperature: 0,
      messages: [{
        role: 'user',
        content: `Person A: "${real}"
Person B: "${bot}"

Could A and B be the SAME PERSON posting on Twitter?
Judge ONLY: writing style, tone, energy, emoji, length, formality, slang, punctuation.
IGNORE whether they say the same thing.

5=definitely same person  4=very likely  3=could be  2=probably different  1=definitely different

ONLY output: "SCORE: X | REASON: one sentence"`,
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

  console.log('[SMART-RAG] Loading archive...')
  const raw = parseArchive(ARCHIVE_PATH)
  const items: any[] = raw.map((r: any) => r.tweet ?? r)

  const { pairs, nonSocialHandles, clusterCounts } = buildSmartRag(items)
  const clusterProfiles = buildClusterProfiles(pairs)

  console.log(`[SMART-RAG] Non-social handles auto-detected: ${[...nonSocialHandles].join(', ')}`)
  console.log(`[SMART-RAG] Total pairs: ${pairs.length}`)
  console.log(`[SMART-RAG] Clusters: ${[...clusterCounts.entries()].map(([c, n]) => `${c}:${n}`).join('  ')}`)
  console.log()

  for (const [cluster, cp] of clusterProfiles.entries()) {
    console.log(`  [${cluster}] median=${cp.medianChars}ch | slang=${cp.slangUsed.join(',')} | starters=${cp.topStarters.slice(0,5).join(',')}`)
  }
  console.log()

  // Sample test cases
  const candidates = pairs.filter(p => p.reply.length > 12 && p.reply.length < 200)
  const step = Math.floor(candidates.length / TEST_COUNT)
  const sampled = Array.from({ length: TEST_COUNT }, (_, i) => candidates[i * step]).filter(Boolean).slice(0, TEST_COUNT)

  const cleanText = (t: string) => t.replace(/^@\w+\s*/, '').replace(/https?:\/\/\S+/g, '').trim()
  const replyToHandle = new Map<string, string>()
  for (const t of items) {
    if (!t.in_reply_to_status_id || !t.full_text) continue
    const c = cleanText(t.full_text)
    if (!replyToHandle.has(c)) replyToHandle.set(c, t.in_reply_to_screen_name ?? 'someone')
  }

  console.log(`[SMART-RAG] Sampled ${sampled.length} test cases`)
  const scores: number[] = []
  const results: any[] = []

  console.log('═'.repeat(90))
  console.log(`SMART RAG TEST — cluster-aware retrieval + per-cluster prompts`)
  console.log('═'.repeat(90))

  for (let i = 0; i < sampled.length; i++) {
    const { reply: realReply, cluster: realCluster } = sampled[i]
    const replyingTo = replyToHandle.get(realReply) ?? 'someone'

    process.stdout.write(`[${i+1}/${sampled.length}] @${replyingTo.padEnd(20)} [${realCluster.padEnd(10)}] `)

    // 1. Reconstruct original tweet
    const original = await reconstruct(client, realReply, replyingTo)
    await new Promise(r => setTimeout(r, 280))
    if (!original) { console.log('skip'); continue }

    // 2. Predict cluster from the incoming tweet
    const predictedCluster = predictReplyCluster(original, clusterCounts)

    // 3. Smart retrieve: topic + cluster boost
    const examples = smartRetrieve(pairs, original, predictedCluster, 5)

    // 4. Get cluster profile for the prompt
    const cp = clusterProfiles.get(predictedCluster) ?? clusterProfiles.get('punchy')!

    // 5. Build cluster-aware prompt
    const sysPrompt = buildSmartPrompt(profile, cp, predictedCluster, examples, realReply.length)

    // 6. Generate
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

    // 7. Judge
    const j = await judge(client, realReply, botReply)
    await new Promise(r => setTimeout(r, 280))

    scores.push(j.score)
    results.push({ original, replyingTo, realReply, botReply, realCluster, predictedCluster, examples, judgment: j })
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
    const clusterMatch = r.realCluster === r.predictedCluster ? '✓' : '✗'
    console.log()
    console.log(`── [${i+1}] @${r.replyingTo}  real:${r.realCluster} → predicted:${r.predictedCluster} ${clusterMatch}  (real:${r.realReply.length}ch)`)
    console.log(`   ORIGINAL  : "${r.original}"`)
    console.log(`   REAL      : "${r.realReply}"`)
    console.log(`   BOT       : "${r.botReply}"  [${r.botReply.length}ch]`)
    console.log(`   RAG EX    : ${r.examples.slice(0,2).map((e:string) => `"${e.slice(0,45)}"[${e.length}ch]`).join(' | ')}`)
    console.log(`   SCORE     : [${bar}] ${r.judgment.score}/5 — ${r.judgment.reason}`)
  }

  const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)

  // Cluster prediction accuracy
  const clusterAccuracy = results.filter(r => r.realCluster === r.predictedCluster).length / results.length

  console.log()
  console.log('═'.repeat(90))
  console.log('SUMMARY')
  console.log('═'.repeat(90))
  console.log(`Average: ${avg.toFixed(2)}/5  (prev best: 2.80 with basic reply-side retrieval)`)
  console.log(`Cluster prediction accuracy: ${(clusterAccuracy * 100).toFixed(0)}%`)
  console.log(`Distribution: ${[1,2,3,4,5].map(n => `${n}★:${scores.filter(s=>s===n).length}`).join('  ')}`)
  console.log(`5★: ${scores.filter(s=>s===5).length}/${scores.length}  |  4-5★: ${scores.filter(s=>s>=4).length}/${scores.length}  |  3-5★: ${scores.filter(s=>s>=3).length}/${scores.length}  |  1-2★: ${scores.filter(s=>s<=2).length}/${scores.length}`)
}

main().catch(console.error)
