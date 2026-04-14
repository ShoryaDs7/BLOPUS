import fs from 'fs'
import path from 'path'

type ReplyType = 'explanatory' | 'pushback' | 'reactive' | 'question' | 'general'

// Topic tags inferred from reply content — used to match against incoming tweet topics.
// Generic — covers all major domains any user could have. NOT user-specific.
const TOPIC_SIGNALS: Record<string, string[]> = {
  crypto:        ['btc','eth','bitcoin','crypto','coin','token','defi','blockchain','wallet','liquidat','solana','pump','dump','hodl','altcoin','satoshi','nft','web3'],
  ai:            ['grok','chatgpt','claude','llm','agent','openai','anthropic','gemini','model','inference','neural','prompt','autonomous','copilot','perplexity'],
  startup:       ['founder','startup','saas','mvp','funding','vc','investor','revenue','arr','mrr','product','launch','ship','bootstrap','pitch','equity'],
  markets:       ['market','stock','trade','liquidat','inflation','fed','rate','nasdaq','sp500','hedge','portfolio','dividend','bull','bear','rally'],
  tech:          ['code','dev','engineer','software','api','framework','react','python','javascript','typescript','github','deploy','backend','frontend'],
  geopolitics:   ['war','ukraine','russia','china','israel','iran','nato','sanction','missile','president','senate','congress','election','policy','treaty'],
  social:        ['twitter','tweet','impressions','viral','followers','algorithm','reach','engagement','instagram','tiktok','youtube','content','creator'],
  music:         ['album','song','track','artist','rapper','singer','concert','tour','spotify','grammy','billboard','lyrics','beat','producer','drop'],
  sports:        ['nba','nfl','fifa','cricket','basketball','football','soccer','match','goal','champion','league','player','coach','season','transfer'],
  entertainment: ['movie','film','netflix','series','actor','actress','director','oscar','box office','trailer','celebrity','hollywood','show','episode'],
  gaming:        ['game','ps5','xbox','nintendo','steam','twitch','esports','fps','rpg','mmo','patch','update','release','fortnite','minecraft'],
  science:       ['nasa','space','climate','research','study','physics','biology','experiment','discovery','planet','rocket','launch','data','evidence'],
  health:        ['mental health','fitness','workout','diet','nutrition','sleep','anxiety','depression','gym','calories','protein','wellness','doctor'],
  politics:      ['democrat','republican','vote','poll','campaign','senate','congress','president','law','bill','supreme','court','protest','rights'],
  finance:       ['bank','loan','mortgage','tax','debt','budget','saving','retire','wealth','income','salary','invest','fund','interest','credit'],
  food:          ['recipe','restaurant','cook','chef','food','meal','eat','drink','coffee','pizza','sushi','vegan','diet','kitchen','taste'],
}

function inferTopicTokens(replyText: string): string[] {
  const lower = replyText.toLowerCase()
  const extra: string[] = []
  for (const [topic, signals] of Object.entries(TOPIC_SIGNALS)) {
    if (signals.some(s => lower.includes(s))) extra.push(topic)
  }
  return extra
}

interface RagPair {
  reply: string
  tokens: string[]
  type: ReplyType
  len: number  // reply character length — used for structural diversity in retrieval
}

interface RagIndex {
  pairs: RagPair[]
  built: string
  version: number
  filteredHandles: string[]
}

const INDEX_VERSION = 6  // bump when index schema changes — forces rebuild

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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
}

function classifyReply(text: string): ReplyType {
  const t = text.toLowerCase()
  if (/^nah|^no |^wrong|^disagree|^not true|^thats not|^thats wrong|^incorrect|^actually no/.test(t)) return 'pushback'
  if (t.endsWith('?') && text.length < 100) return 'question'
  if (text.length < 50) return 'reactive'
  return 'general'
}


// ─── Auto-detect non-social handles from the archive ─────────────────────────
// Any handle where the owner's average reply length > NON_SOCIAL_RATIO × median
// = tool/bot conversations (e.g. @grok, customer support, automated accounts).
// 100% generic — no names hardcoded. Works for any user's archive.
const NON_SOCIAL_RATIO = 1.8  // avg reply to this handle > 1.8× archive median = exclude

function detectNonSocialHandles(items: any[]): Set<string> {
  // Owner's own handle — always excluded from non-social detection.
  // Self-replies (threads) are long by nature but are genuine owner voice.
  // OWNER_HANDLE is set per-user in their .env — no hardcoding.
  const ownerHandle = (process.env.OWNER_HANDLE ?? '').toLowerCase()

  // Collect all replies and their lengths per handle
  const handleReplies = new Map<string, number[]>()
  for (const t of items) {
    if (!t.in_reply_to_status_id || !t.full_text || t.full_text.startsWith('RT ')) continue
    const handle = (t.in_reply_to_screen_name ?? '').toLowerCase()
    if (!handle) continue
    if (ownerHandle && handle === ownerHandle) continue  // skip self-replies
    const text = (t.full_text as string)
      .replace(/^@\w+\s*/, '')
      .replace(/https?:\/\/\S+/g, '')
      .trim()
    if (!handleReplies.has(handle)) handleReplies.set(handle, [])
    handleReplies.get(handle)!.push(text.length)
  }

  // Compute archive-wide median reply length
  const allLengths = [...handleReplies.values()].flat().sort((a, b) => a - b)
  const median = allLengths[Math.floor(allLengths.length / 2)] ?? 60

  // Flag handles where avg reply length > NON_SOCIAL_RATIO × median
  const nonSocial = new Set<string>()
  for (const [handle, lengths] of handleReplies) {
    if (lengths.length < 3) continue  // too few replies to judge
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length
    if (avg > median * NON_SOCIAL_RATIO) {
      nonSocial.add(handle)
    }
  }

  if (nonSocial.size > 0) {
    console.log(`[RAG] Auto-detected non-social handles (excluded): ${[...nonSocial].join(', ')}`)
  }
  return nonSocial
}

// ─── Classify incoming tweet to match against similar reply types ─────────────
export function classifyTweetContext(text: string): ReplyType {
  const t = text.toLowerCase()
  if (/give.?away|sending \$|win \$|just say hi|turned notifications|follow me|retweet to win/.test(t)) return 'reactive'
  if (/\?/.test(t) && text.length < 120) return 'question'
  if (/wrong|disagree|unpopular opinion|hot take|controversial|change my mind/.test(t)) return 'pushback'
  if (/how to|what is|explain|understand|confused|help me/.test(t)) return 'explanatory'
  return 'general'
}

const MAX_PAIRS = 2000

function parseArchiveJs(filePath: string): any[] {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const jsonStr = raw.replace(/^\s*window\.[^=]+=\s*/, '').replace(/;?\s*$/, '')
  return JSON.parse(jsonStr)
}

export function buildRagIndex(archivePath: string, outPath: string): void {
  console.log('[RAG] Building index from Twitter archive...')
  const raw = parseArchiveJs(archivePath)
  const items: any[] = raw.map((r: any) => r.tweet ?? r)

  // Auto-detect non-social handles — no hardcoding, computed from archive math
  const nonSocialHandles = detectNonSocialHandles(items)

  // Only filter replies DIRECTED AT non-social handles (in_reply_to_screen_name).
  // Replies that merely MENTION them (e.g. "@grok is this real?") are kept —
  // that IS the owner's genuine behavior and the LLM must learn it.
  const replies = items.filter((t: any) => {
    if (!t.in_reply_to_status_id || !t.full_text || t.full_text.startsWith('RT ')) return false
    if (nonSocialHandles.has((t.in_reply_to_screen_name ?? '').toLowerCase())) return false
    return true
  })

  const rawPairs = replies
    .map((t: any) => {
      const text = (t.full_text as string)
        .replace(/^@\w+\s*/, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim()
      const baseTokens = tokenize(text)
      const topicTokens = inferTopicTokens(text)
      return {
        reply: text,
        tokens: [...baseTokens, ...topicTokens],
        type: classifyReply(text),
        len: text.length,
      }
    })
    .filter(p => p.tokens.length >= 2)

  // Compute p10 of reply lengths from the archive itself — filter below that.
  // This removes genuine fragments (single words, emoji-only, cut-off @grok questions)
  // without hardcoding any number. Works for any user's archive.
  const rawLens = rawPairs.map(p => p.len).sort((a, b) => a - b)
  const p10 = rawLens[Math.floor(rawLens.length * 0.10)] ?? 0
  console.log(`[RAG] Archive p10 reply length: ${p10}ch — filtering below this as fragments`)

  const pairs = rawPairs
    .filter(p => p.len > p10)
    .slice(0, MAX_PAIRS)

  const lengths = pairs.map(p => p.len).sort((a, b) => a - b)
  const medianLen = lengths[Math.floor(lengths.length / 2)] ?? 60
  console.log(`[RAG] Reply lengths: min=${lengths[0]} median=${medianLen} max=${lengths[lengths.length-1]} | count=${pairs.length}`)

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({
    pairs,
    built: new Date().toISOString(),
    version: INDEX_VERSION,
    count: pairs.length,
    filteredHandles: [...nonSocialHandles],
  }))
  console.log(`[RAG] Built index: ${pairs.length} reply examples saved (filtered ${[...nonSocialHandles].length} non-social handles)`)
}

export interface RetrievalResult {
  examples: string[]
  medianLength: number   // median length of retrieved examples — drives dynamic length constraint in prompt
  topicCoverage: number  // how many archive pairs had ANY token overlap with the query
  lowConfidence: boolean // true = owner has almost no archive evidence of engaging with this topic → caller should skip
}

export class ExampleRetriever {
  private pairs: RagPair[] = []
  private loaded = false
  private signaturePatterns: Array<{ phrase: string; usedFor: string }> = []

  constructor(private indexPath: string) {}

  setSignaturePatterns(patterns: Array<{ phrase: string; usedFor: string }>): void {
    this.signaturePatterns = patterns
  }

  load(archivePath?: string): void {
    if (this.loaded) return
    if (!fs.existsSync(this.indexPath)) {
      if (archivePath && fs.existsSync(archivePath)) {
        buildRagIndex(archivePath, this.indexPath)
      } else {
        console.warn(`[RAG] No index and no archive found — skipping RAG`)
        return
      }
    }

    const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as RagIndex

    // Version check — rebuild if schema changed
    if ((raw as any).version !== INDEX_VERSION) {
      console.log(`[RAG] Index version mismatch (got ${(raw as any).version ?? 'none'}, need ${INDEX_VERSION}) — rebuilding...`)
      if (archivePath && fs.existsSync(archivePath)) {
        buildRagIndex(archivePath, this.indexPath)
        const rebuilt = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8')) as RagIndex
        this.pairs = rebuilt.pairs
      } else {
        console.warn('[RAG] Cannot rebuild — no archive path provided. Using stale index.')
        this.pairs = raw.pairs
      }
    } else {
      this.pairs = raw.pairs
    }

    this.loaded = true
    console.log(`[RAG] Loaded ${this.pairs.length} reply examples`)
  }

  // ─── Standard retrieve (backward-compatible) ──────────────────────────────
  retrieve(queryText: string, topK: number = 5): string[] {
    return this.retrieveWithFormat(queryText, topK).examples
  }

  // ─── Retrieve with structural diversity ──────────────────────────────────
  // Two-pool approach:
  //   Pool A: top topic-matched examples (sorted by token overlap)
  //   Pool B: length-diverse examples from archive not in pool A
  //           (ensures LLM sees the owner's short AND long AND structured replies,
  //            not just one style — computed from the archive, no hardcoded labels)
  // When topic overlap is zero (e.g. tweet vocabulary doesn't match reply vocabulary),
  // pool B guarantees the LLM still gets real examples to calibrate from.
  retrieveWithFormat(queryText: string, topK: number = 5): RetrievalResult {
    if (!this.loaded || this.pairs.length === 0) {
      return { examples: [], medianLength: 60, topicCoverage: 0, lowConfidence: true }
    }

    const queryTokens = new Set([...tokenize(queryText), ...inferTopicTokens(queryText)])
    const incomingType = classifyTweetContext(queryText)

    const appropriatePatterns = this.signaturePatterns
      .filter(sp => {
        const usedFor = sp.usedFor.toLowerCase()
        if (incomingType === 'explanatory') return usedFor.includes('explain') || usedFor.includes('concept') || usedFor.includes('teach')
        if (incomingType === 'pushback') return usedFor.includes('disagree') || usedFor.includes('pushback') || usedFor.includes('challenge')
        return false
      })
      .map(sp => sp.phrase.toLowerCase())

    // Pool A: topic-matched, sorted by score
    const poolASize = Math.ceil(topK * 0.6)
    const scored = this.pairs.map(p => {
      const overlap = queryTokens.size > 0
        ? p.tokens.filter(t => queryTokens.has(t)).length / Math.sqrt(queryTokens.size * Math.max(p.tokens.length, 1))
        : 0
      let score = overlap
      if (p.type === incomingType) score *= 1.4
      const replyLower = p.reply.toLowerCase()
      if (appropriatePatterns.some(pat => replyLower.startsWith(pat))) score *= 1.3
      return { reply: p.reply, len: p.len, score }
    })
    const topicCoverage = scored.filter(s => s.score > 0).length  // how many archive pairs match this topic at all
    // Skip threshold: 1% of archive size, floor 3. Scales with any archive size — no hardcoding.
    const skipThreshold = Math.max(3, Math.floor(this.pairs.length * 0.01))
    const lowConfidence = topicCoverage < skipThreshold
    const poolA = scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, poolASize)

    // Pool B: length-diverse picks from the rest — short / medium / long buckets
    // This is how the archive tells us what structures the owner uses,
    // without us naming those structures ourselves.
    const poolASet = new Set(poolA.map(p => p.reply))
    const remaining = this.pairs.filter(p => !poolASet.has(p.reply))

    const allLens = this.pairs.map(p => p.len).sort((a, b) => a - b)
    const p33 = allLens[Math.floor(allLens.length * 0.33)] ?? 40
    const p66 = allLens[Math.floor(allLens.length * 0.66)] ?? 120

    const short  = remaining.filter(p => p.len <= p33)
    const medium = remaining.filter(p => p.len > p33 && p.len <= p66)
    const long   = remaining.filter(p => p.len > p66)

    const pickRandom = (arr: RagPair[]) =>
      arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)].reply : null

    const poolB: string[] = []
    const slotsLeft = topK - poolA.length
    // Distribute slots across buckets to show structural diversity
    for (let i = 0; i < slotsLeft; i++) {
      const bucket = i % 3 === 0 ? short : i % 3 === 1 ? medium : long
      const pick = pickRandom(bucket)
      if (pick && !poolASet.has(pick) && !poolB.includes(pick)) poolB.push(pick)
    }

    const examples = [...poolA.map(p => p.reply), ...poolB]

    const lengths = examples.map(e => e.length).sort((a, b) => a - b)
    const medianLength = lengths[Math.floor(lengths.length / 2)] ?? 60

    return { examples, medianLength, topicCoverage, lowConfidence }
  }
}
