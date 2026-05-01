#!/usr/bin/env npx tsx
/**
 * RAG auto-interview — builds rag_voice_profile.json from archive data.
 * Shows the user real examples from their archive, confirms domains, asks
 * minimal questions, then synthesizes a voice_profile.json with mode: 'rag-auto'.
 *
 * Run standalone: npx tsx scripts/setup-rag-interview.ts
 * Or via: npm run rag-interview
 */

import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import Anthropic from '@anthropic-ai/sdk'
import { config as dotenvConfig } from 'dotenv'

dotenvConfig({ path: path.join(process.cwd(), '.env') })
if (!process.env.ANTHROPIC_API_KEY) {
  const creatorsDir = path.join(process.cwd(), 'creators')
  if (fs.existsSync(creatorsDir)) {
    for (const d of fs.readdirSync(creatorsDir)) {
      const ep = path.join(creatorsDir, d, '.env')
      if (fs.existsSync(ep)) { dotenvConfig({ path: ep, override: false }); if (process.env.ANTHROPIC_API_KEY) break }
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
}

// ─── Pick a creator ──────────────────────────────────────────────────────────
async function pickCreator(): Promise<{ creatorDir: string; profilePath: string }> {
  const creatorsDir = path.join(process.cwd(), 'creators')
  const creators = fs.readdirSync(creatorsDir).filter(d =>
    fs.existsSync(path.join(creatorsDir, d, 'personality_profile.json'))
  )
  if (!creators.length) { console.log('No creator profiles found.'); process.exit(1) }

  let name = creators[0]
  if (creators.length > 1) {
    console.log('Multiple creators:')
    creators.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
    const pick = await ask('Pick number: ')
    name = creators[parseInt(pick) - 1] ?? creators[0]
  }

  return {
    creatorDir: path.join(creatorsDir, name),
    profilePath: path.join(creatorsDir, name, 'personality_profile.json'),
  }
}

// ─── Pick reply examples from rag_index by domain ────────────────────────────
interface RagPair { reply: string; tokens: string[]; type: string; len: number }

function pickRepliesForDomain(pairs: RagPair[], domainStr: string, count: number): string[] {
  // Tokenize the domain string to build a match set
  const domainTokens = new Set(
    domainStr.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 3)
  )

  const scored = pairs.map(p => ({
    reply: p.reply,
    score: p.tokens.filter(t => domainTokens.has(t)).length,
  })).filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)

  // If not enough topic matches, supplement with general short replies
  const picked = new Set<string>()
  for (const s of scored) {
    if (picked.size >= count * 3) break
    picked.add(s.reply)
  }
  if (picked.size < count) {
    // Fill with random short replies
    const shorts = pairs.filter(p => p.len < 80 && !picked.has(p.reply))
    for (const p of shorts.slice(0, count * 3)) picked.add(p.reply)
  }

  // Return a random sample from picked
  const pool = Array.from(picked)
  const result: string[] = []
  const used = new Set<string>()
  while (result.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length)
    const r = pool.splice(idx, 1)[0]
    if (!used.has(r)) { result.push(r); used.add(r) }
  }
  return result
}

// ─── LLM: generate the tweet that was most likely replied to ─────────────────
async function generateTriggerTweet(
  client: Anthropic,
  replyText: string,
  domain: string,
): Promise<string> {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{
        role: 'user',
        content: `Someone replied to a tweet with this reply:
"${replyText}"

The tweet was about: ${domain}

Write the original tweet they were most likely replying to. Make it realistic — the kind of thing that would actually be posted on X.
Under 30 words. Return ONLY the tweet text, nothing else.`,
      }],
    })
    const c = res.content[0]
    return c.type === 'text' ? c.text.trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return `Hot take about ${domain}`
  }
}

// ─── LLM: synthesize writing style paragraph ─────────────────────────────────
async function synthesize(
  client: Anthropic,
  writingStats: Record<string, string>,
  goldenExamples: string[],
  topicExamples: { tweet: string; reply: string }[],
): Promise<string> {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are setting up an autonomous X bot that writes AS this exact person.

Archive writing stats:
- Case style: ${writingStats.caseStyle ?? 'unknown'}
- Apostrophes: ${writingStats.apostropheStyle ?? 'unknown'}
- Reply length: ${writingStats.medianReplyLength ?? 'unknown'}
- Emoji usage: ${writingStats.emojiUsage ?? 'unknown'}

Their real replies from archive:
${goldenExamples.slice(0, 8).map((r, i) => `${i + 1}. "${r}"`).join('\n')}

Write 2-3 sentences describing ONLY how this person writes (style, tone, structure, length). No behaviors, no topics. This gets injected into every LLM prompt.`,
      }],
    })
    const c = res.content[0]
    return c.type === 'text' ? c.text.trim().split('\n').filter(l => !l.startsWith('#')).join('\n').trim() : ''
  } catch {
    return `Writes in ${writingStats.caseStyle ?? 'mixed case'}. Replies are ${writingStats.medianReplyLength ?? 'short'}.`
  }
}

// ─── LLM: synthesize post style paragraph ────────────────────────────────────
async function synthesizePostStyle(
  client: Anthropic,
  postGoldenExamples: string[],
  topics: string[],
): Promise<string> {
  if (!postGoldenExamples.length) return ''
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `You are setting up an autonomous X bot that posts AS this exact person.

Their confirmed topics: ${topics.join(', ')}

Their real original posts from archive:
${postGoldenExamples.slice(0, 8).map((p, i) => `${i + 1}. "${p}"`).join('\n')}

Write 2-3 sentences describing ONLY how this person writes original posts (structure, tone, length, style). Not replies. This gets injected into every post-generation prompt.`,
      }],
    })
    const c = res.content[0]
    return c.type === 'text' ? c.text.trim() : ''
  } catch {
    return ''
  }
}

// ─── LLM: guess which domain a post belongs to ───────────────────────────────
async function guessDomain(
  client: Anthropic,
  postText: string,
  domains: string[],
): Promise<string> {
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{
        role: 'user',
        content: `Which of these domains best fits this post?
Post: "${postText.slice(0, 200)}"
Domains: ${domains.map((d, i) => `${i + 1}. ${d}`).join(' | ')}
Reply ONLY with the exact domain text, nothing else.`,
      }],
    })
    const c = res.content[0]
    const text = c.type === 'text' ? c.text.trim() : ''
    return domains.find(d => d.toLowerCase() === text.toLowerCase()) ?? domains[0]
  } catch {
    return domains[0]
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.log('ANTHROPIC_API_KEY not found in .env'); process.exit(1) }
  const client = new Anthropic({ apiKey })

  const { creatorDir, profilePath } = await pickCreator()
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))

  const ws: Record<string, string> = profile.writingStats ?? {}
  const bp = profile.behaviorProfile ?? {}
  const replyTopics: string[] = profile.replyTopics ?? profile.dominantTopics ?? []
  const postTopics: string[] = profile.postTopics ?? profile.dominantTopics ?? []
  const sampleOriginals: string[] = bp.sampleOriginals ?? []

  // Load rag_index for real reply examples
  const ragIndexPath = path.join(creatorDir, 'rag_index.json')
  let ragPairs: RagPair[] = []
  if (fs.existsSync(ragIndexPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ragIndexPath, 'utf8'))
      ragPairs = raw.pairs ?? []
    } catch {}
  }
  const hasRag = ragPairs.length > 0

  console.log('\n' + '═'.repeat(60))
  console.log('  RAG AUTO-INTERVIEW')
  console.log('  Builds your voice profile from archive data.')
  console.log('  You confirm examples, correct domains, answer 3 questions.')
  console.log('═'.repeat(60) + '\n')

  // ── Section 1: Writing stats confirmation ───────────────────────────────────
  console.log('  ─ Writing style (from your archive) ─\n')
  console.log(`  Case style:    ${ws.caseStyle ?? 'not detected'}`)
  console.log(`  Apostrophes:   ${ws.apostropheStyle ?? 'not detected'}`)
  console.log(`  Reply length:  ${ws.medianReplyLength ?? 'not detected'}`)
  console.log(`  Emoji usage:   ${ws.emojiUsage ?? 'not detected'}`)
  console.log()

  const wsConfirm = await ask('  Does this match how you write? (yes / correct anything wrong): ')
  const wsNote = /^yes|^y$|^yep|^yeah/i.test(wsConfirm) ? '' : wsConfirm.trim()
  if (wsNote) console.log(`  Got it — noted: ${wsNote}\n`)
  else console.log('  Confirmed.\n')

  const caseStyle       = ws.caseStyle       ?? 'mixed case'
  const apostropheStyle = ws.apostropheStyle  ?? ''
  const replyLength     = ws.medianReplyLength ?? 'short'
  const emojiUsage      = ws.emojiUsage       ?? 'moderate'

  // ── Section 2: Reply golden examples ────────────────────────────────────────
  console.log('\n  ─ Your real replies — confirm or correct the domain ─\n')
  const skipReplies = process.env.RAG_SKIP_REPLIES === 'true' ||
    (await ask('  Skip this section? (Enter to continue, "skip" to skip): ')).toLowerCase() === 'skip'
  if (process.env.RAG_SKIP_REPLIES === 'true') console.log('  Skipped (engagement mode — reply hunting not needed).\n')
  else console.log()

  const perDomain = Math.max(2, Math.round(8 / replyTopics.length))
  const goldenExamples: string[] = []
  const topicExamples: { tweet: string; reply: string }[] = []
  const neverReplyTypes: string[] = []

  if (!skipReplies) console.log('  (type "skip" to skip one, "na" if you wouldn\'t reply to this type)\n')

  let exampleCount = 0
  const totalReplyExamples = replyTopics.length * perDomain

  for (const domain of skipReplies ? [] : replyTopics) {
    const domainReplies = hasRag
      ? pickRepliesForDomain(ragPairs, domain, perDomain)
      : (profile.replyExamples ?? []).slice(0, perDomain)

    for (let i = 0; i < Math.min(perDomain, domainReplies.length); i++) {
      const replyText = domainReplies[i]
      exampleCount++

      // Generate the tweet that was likely replied to
      process.stdout.write('  Generating...\r')
      let tweetText = await generateTriggerTweet(client, replyText, domain)
      console.log(`  [${exampleCount}/${totalReplyExamples}] Domain: ${domain}`)
      console.log(`  Tweet:  "${tweetText}"`)
      console.log(`  Reply:  "${replyText}"`)

      const domainAnswer = await ask('  Domain correct? (yes / correct domain / skip / na): ')
      console.log()

      if (/^skip$/i.test(domainAnswer)) continue
      if (/^na$/i.test(domainAnswer)) {
        neverReplyTypes.push(tweetText)
        console.log('  Got it — skipping this type.\n')
        continue
      }

      let finalDomain = domain
      if (!/^yes|^y$|^yep|^yeah/i.test(domainAnswer) && domainAnswer.trim()) {
        finalDomain = domainAnswer.trim()
        // Regenerate tweet for the corrected domain
        process.stdout.write('  Regenerating for corrected domain...\r')
        tweetText = await generateTriggerTweet(client, replyText, finalDomain)
        console.log(`  Updated → Domain: ${finalDomain}`)
        console.log(`  Tweet:   "${tweetText}"`)
        console.log(`  Reply:   "${replyText}"\n`)
      } else {
        console.log('  Confirmed.\n')
      }

      goldenExamples.push(replyText)
      topicExamples.push({ tweet: tweetText, reply: replyText })
    }
  }

  console.log(`  ${goldenExamples.length} reply examples captured.\n`)

  // ── Section 3: Post examples (2 per domain from archive) ────────────────────
  console.log('  ─ Your real posts — confirm or correct the domain ─\n')
  const skipPosts = (await ask('  Skip this section? (Enter to continue, "skip" to skip): ')).toLowerCase() === 'skip'
  console.log()

  const postsPerDomain = 2
  const postGoldenExamples: string[] = []
  const postTopicExamples: { scenario: string; post: string }[] = []
  const usedPosts = new Set<string>()
  let postCount = 0

  // Build domain → posts mapping: LLM guesses domain for each sampleOriginal
  // We show 2 per domain, taking from archive pool
  const postPool = sampleOriginals.filter(p => p && p.length > 20)

  if (skipPosts || postPool.length === 0) {
    if (postPool.length === 0) console.log('  No sample originals in archive — skipping.\n')
  } else {
    // Group posts by domain using LLM guessing
    console.log('  Matching posts to domains...')
    const domainPostMap: Map<string, string[]> = new Map()
    for (const domain of postTopics) domainPostMap.set(domain, [])

    for (const post of postPool) {
      const guessedDomain = await guessDomain(client, post, postTopics)
      domainPostMap.get(guessedDomain)?.push(post)
    }

    const totalPostExamples = postTopics.reduce((sum, d) => {
      const available = Math.min(postsPerDomain, domainPostMap.get(d)?.length ?? 0)
      return sum + available
    }, 0)

    console.log(`  ${totalPostExamples} post examples to review.\n`)
    console.log('  (type "skip" to skip, or correct the domain)\n')

    for (const domain of postTopics) {
      const posts = domainPostMap.get(domain) ?? []
      const take = posts.slice(0, postsPerDomain)

      for (const post of take) {
        if (usedPosts.has(post)) continue
        postCount++
        const short = post.length > 120 ? post.slice(0, 120) + '...' : post

        console.log(`  [${postCount}/${totalPostExamples}] Domain: ${domain}`)
        console.log(`  Post:   "${short}"`)

        const domainAnswer = await ask('  Domain correct? (yes / correct domain / skip): ')
        console.log()

        if (/^skip$/i.test(domainAnswer)) continue

        let finalDomain = domain
        if (!/^yes|^y$|^yep|^yeah/i.test(domainAnswer) && domainAnswer.trim()) {
          finalDomain = domainAnswer.trim()
          console.log(`  Updated → Domain: ${finalDomain}\n`)
        } else {
          console.log('  Confirmed.\n')
        }

        usedPosts.add(post)
        postGoldenExamples.push(post)
        postTopicExamples.push({ scenario: finalDomain, post })
      }
    }

    console.log(`  ${postGoldenExamples.length} post examples captured.\n`)
  }

  // ── Section 4: QT behavior ───────────────────────────────────────────────────
  console.log('  ─ Quote tweet behavior (from your archive) ─\n')

  const existingQT = profile.quoteTweetBehavior ?? {}
  let quoteTweetBehavior = {
    whenToQuote:     existingQT.whenToQuote     ?? 'when you have a strong take or reaction to add',
    quoteTweetStyle: existingQT.quoteTweetStyle ?? 'short punchy comment, matching tweet energy',
    neverQuote:      existingQT.neverQuote      ?? [],
  }

  const skipQT = (await ask('  Skip this section? (Enter to continue, "skip" to skip): ')).toLowerCase() === 'skip'
  console.log()

  if (!skipQT) {
    console.log(`  When you QT: ${quoteTweetBehavior.whenToQuote}`)
    console.log(`  Style:       ${quoteTweetBehavior.quoteTweetStyle}`)
    if (quoteTweetBehavior.neverQuote.length) {
      console.log(`  Never QT:    ${quoteTweetBehavior.neverQuote.join(', ')}`)
    }
    console.log()

    const qtAnswer = await ask('  Does this sound right? (yes / correct it / Enter to skip): ')
    if (!/^yes|^y$|^yep|^yeah/i.test(qtAnswer) && qtAnswer.trim()) {
      quoteTweetBehavior.whenToQuote = qtAnswer.trim()
      console.log('  Updated.\n')
    } else if (qtAnswer.trim()) {
      console.log('  Confirmed.\n')
    }
  }

  // ── Section 5: Likes ─────────────────────────────────────────────────────────
  console.log('  ─ What you like on X ─\n')
  console.log('  (Archive has no like data — one quick question)\n')

  const existingLike = profile.likeBehavior ?? {}
  let likeBehavior = {
    likesWhat:   existingLike.likesWhat  ?? '',
    alwaysLike:  existingLike.alwaysLike ?? [],
    neverLike:   existingLike.neverLike  ?? [],
    likeOnReply: existingLike.likeOnReply ?? '',
  }

  if (!likeBehavior.likesWhat) {
    const likeAnswer = await ask('  What do you like on X? (e.g. "good insights, funny posts, supporter replies"): ')
    if (likeAnswer.trim()) {
      likeBehavior.likesWhat = likeAnswer.trim()
      console.log('  Got it.\n')
    }
  } else {
    console.log(`  Archive setting: ${likeBehavior.likesWhat}`)
    const likeConfirm = await ask('  Still accurate? (yes / update it): ')
    if (!/^yes|^y$|^yep|^yeah/i.test(likeConfirm) && likeConfirm.trim()) {
      likeBehavior.likesWhat = likeConfirm.trim()
      console.log('  Updated.\n')
    } else {
      console.log('  Confirmed.\n')
    }
  }

  // ── Section 6: Banned phrases + never topics ─────────────────────────────────
  console.log('  ─ What to never say / never engage with ─\n')

  const bannedRaw = await ask('  Any words or phrases Blopus should NEVER use? (comma-separated, or Enter to skip): ')
  const bannedPhrases = bannedRaw.trim()
    ? bannedRaw.split(',').map(p => p.trim()).filter(Boolean)
    : []
  if (bannedPhrases.length) console.log(`  Never say: ${bannedPhrases.join(', ')}\n`)
  else console.log('  Skipped.\n')

  const neverRaw = await ask('  Any topics Blopus should NEVER engage with? (comma-separated, or Enter to skip): ')
  const neverTopics = neverRaw.trim()
    ? neverRaw.split(',').map(p => p.trim()).filter(Boolean)
    : []
  if (neverTopics.length) console.log(`  Never engage: ${neverTopics.join(', ')}\n`)
  else console.log('  Skipped.\n')

  // ── Section 7: Synthesize ────────────────────────────────────────────────────
  console.log('  Synthesizing voice profile...\n')

  const synthesized = await synthesize(client, ws, goldenExamples, topicExamples)
  const postSynthesized = await synthesizePostStyle(client, postGoldenExamples, postTopics)

  // Apply user writing stats note as correction if they gave one
  const finalSynthesized = wsNote ? `${synthesized} CORRECTION: ${wsNote}` : synthesized

  // ── Build the profile ────────────────────────────────────────────────────────
  const ragVoiceProfile: Record<string, any> = {
    mode: 'rag-auto',
    caseStyle,
    apostropheStyle,
    replyLength,
    emojiUsage,
    behaviorPatterns: {
      onNewsWithTake:  '',
      onFactualClaim:  '',
      onAgreement:     '',
      onDisagreement:  '',
      onFunny:         '',
      onControversial: '',
    },
    goldenExamples,
    topicExamples,
    neverReplyTypes,
    bannedPhrases,
    neverTopics,
    synthesized: finalSynthesized,
    confirmedAt: new Date().toISOString(),
    quoteTweetBehavior,
    likeBehavior,
    originalPostProfile: {
      topics:        postTopics,
      goldenExamples: postGoldenExamples,
      topicExamples: postTopicExamples,
      synthesized:   postSynthesized,
      caseStyle:     ws.caseStyle ?? caseStyle,
      postLength:    '',
      emojiFrequency: 0,
      emojiContext:  '',
      neverAbout:    neverTopics,
      confirmedPostsPerDay: bp.avgPostsPerDay ?? 0,
    },
  }

  // Keep existing originalPostProfile if it had a full interview (richer data)
  const existingOPP = profile.voiceProfile?.originalPostProfile
  if (existingOPP?.postLength || existingOPP?.confirmedPostsPerDay) {
    ragVoiceProfile.originalPostProfile = {
      ...ragVoiceProfile.originalPostProfile,
      postLength:          existingOPP.postLength ?? '',
      emojiFrequency:      existingOPP.emojiFrequency ?? 0,
      emojiContext:        existingOPP.emojiContext ?? '',
      confirmedPostsPerDay: existingOPP.confirmedPostsPerDay ?? bp.avgPostsPerDay ?? 0,
      synthesized:         existingOPP.synthesized ?? postSynthesized,
      // Merge golden examples — keep interview ones, prepend archive ones
      goldenExamples: [
        ...postGoldenExamples,
        ...(existingOPP.goldenExamples ?? []).filter((e: string) => !postGoldenExamples.includes(e)),
      ],
      topicExamples: [
        ...postTopicExamples,
        ...(existingOPP.topicExamples ?? []),
      ],
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  // 1. rag_voice_profile.json — dedicated file
  const ragVPPath = path.join(creatorDir, 'rag_voice_profile.json')
  fs.writeFileSync(ragVPPath, JSON.stringify(ragVoiceProfile, null, 2), 'utf8')

  // 2. voice_profile.json — what agents actually load (no downstream changes needed)
  const vpPath = path.join(creatorDir, 'voice_profile.json')
  fs.writeFileSync(vpPath, JSON.stringify(ragVoiceProfile, null, 2), 'utf8')

  // 3. personality_profile.json — update voiceProfile field
  if (!profile.voiceProfile) profile.voiceProfile = {}
  Object.assign(profile.voiceProfile, ragVoiceProfile)
  if (bannedPhrases.length) {
    profile.avoids = [...(profile.avoids ?? []), ...bannedPhrases.filter((p: string) => !(profile.avoids ?? []).includes(p))]
  }
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf8')

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60))
  console.log('  RAG voice profile saved.')
  console.log('═'.repeat(60))
  console.log(`  · Reply examples:  ${goldenExamples.length} captured (${topicExamples.length} with tweet context)`)
  console.log(`  · Post examples:   ${postGoldenExamples.length} captured`)
  console.log(`  · Banned phrases:  ${bannedPhrases.length ? bannedPhrases.join(', ') : 'none'}`)
  console.log(`  · Never topics:    ${neverTopics.length ? neverTopics.join(', ') : 'none'}`)
  console.log(`  · Saved to:        voice_profile.json (+ rag_voice_profile.json)`)
  console.log('═'.repeat(60) + '\n')

  rl.close()
}

main().catch(e => { console.error(e); rl.close(); process.exit(1) })
