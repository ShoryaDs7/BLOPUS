#!/usr/bin/env npx tsx
/**
 * buildRagVoiceProfile.ts
 * Reads personality_profile.json + rag_index.json → writes voice_profile.json
 * No interview. No user interaction. 2 LLM calls. Done.
 *
 * Usage: npx tsx scripts/buildRagVoiceProfile.ts
 * Or:    npm run rag-build
 */

import * as fs from 'fs'
import * as path from 'path'
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

interface RagPair { reply: string; tokens: string[]; type: string; len: number }

function pickDiverseReplies(pairs: RagPair[], count: number): string[] {
  const seen = new Set<string>()
  const unique = pairs.filter(p => { if (seen.has(p.reply)) return false; seen.add(p.reply); return true })
  const candidates = unique.filter(p => p.len > 30 && p.tokens.length > 2)
  const sorted = [...candidates].sort((a, b) => b.len - a.len)

  const picked: string[] = []
  const usedTokens = new Set<string>()
  for (const p of sorted) {
    if (picked.length >= count) break
    const overlap = p.tokens.filter(t => usedTokens.has(t)).length
    if (overlap <= 2) {
      picked.push(p.reply)
      p.tokens.forEach(t => usedTokens.add(t))
    }
  }
  return picked
}

export async function buildRagVoiceProfile(creatorDir: string, mode: 'growth' | 'engagement' = 'growth'): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not found')
  const client = new Anthropic({ apiKey })

  const pp = JSON.parse(fs.readFileSync(path.join(creatorDir, 'personality_profile.json'), 'utf8'))
  const ragIndexPath = path.join(creatorDir, 'rag_index.json')
  const ragPairs: RagPair[] = fs.existsSync(ragIndexPath)
    ? (JSON.parse(fs.readFileSync(ragIndexPath, 'utf8')).pairs ?? [])
    : []

  const ws = pp.writingStats ?? {}
  const bp = pp.behaviorProfile ?? {}

  // Reply golden examples: only for growth mode
  const ragPicks = mode === 'growth' ? pickDiverseReplies(ragPairs, 6) : []
  const baseExamples: string[] = mode === 'growth' ? (pp.replyExamples ?? []) : []
  const goldenExamples = [
    ...baseExamples,
    ...ragPicks.filter(r => !baseExamples.includes(r)),
  ].slice(0, 10)

  // Post golden examples: sampleOriginals from archive
  const postGoldenExamples: string[] = (bp.sampleOriginals ?? []).slice(0, 10)

  // Synthesize reply style (growth only)
  let synthesized = pp.replyStyle ?? ''
  if (mode === 'growth' && goldenExamples.length) {
    process.stdout.write('  Synthesizing reply style...')
    const replyRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `You are setting up an AI bot to write replies on X AS this exact person.

Their real replies:
${goldenExamples.map((r, i) => `${i + 1}. "${r}"`).join('\n')}

Archive data:
- Writing style: ${pp.writingStyle}
- Reply style: ${pp.replyStyle}
- Signature phrases: ${pp.signaturePatterns?.map((s: any) => `"${s.phrase}" (${s.usedFor})`).join(', ') || 'none'}
- Avoids: ${pp.avoids?.join(', ') || 'none'}

Write 2 sentences describing HOW this person writes replies — style, tone, energy, length. No topics. Injected directly into every reply prompt.`,
      }],
    })
    synthesized = replyRes.content[0]?.type === 'text' ? replyRes.content[0].text.trim() : pp.replyStyle ?? ''
    console.log(' done')
  }

  // Synthesize post style
  process.stdout.write('  Synthesizing post style...')
  let postSynthesized = ''
  if (postGoldenExamples.length) {
    const postRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `You are setting up an AI bot to write original posts on X AS this exact person.

Their real posts:
${postGoldenExamples.map((p, i) => `${i + 1}. "${p}"`).join('\n')}

Write 2 sentences describing HOW this person writes original posts — structure, tone, length, energy. Injected directly into every post prompt.`,
      }],
    })
    postSynthesized = postRes.content[0]?.type === 'text' ? postRes.content[0].text.trim() : ''
  }
  console.log(' done')

  const voiceProfile: Record<string, any> = {
    mode: 'rag-auto',
    caseStyle: ws.caseStyle ?? '',
    apostropheStyle: ws.apostropheStyle ?? '',
    replyLength: ws.medianReplyLength ?? 'short',
    emojiUsage: ws.emojiUsage ?? '',
    goldenExamples,
    topicExamples: [],
    bannedPhrases: [],
    neverTopics: [],
    synthesized,
    confirmedAt: new Date().toISOString(),
    originalPostProfile: {
      topics: pp.postTopics ?? pp.dominantTopics ?? [],
      goldenExamples: postGoldenExamples,
      topicExamples: [],
      synthesized: postSynthesized,
      caseStyle: ws.caseStyle ?? '',
      postLength: '',
      emojiFrequency: 0,
      emojiContext: '',
      neverAbout: [],
      confirmedPostsPerDay: bp.avgPostsPerDay ?? 0,
    },
  }

  fs.writeFileSync(path.join(creatorDir, 'voice_profile.json'), JSON.stringify(voiceProfile, null, 2))
  fs.writeFileSync(path.join(creatorDir, 'rag_voice_profile.json'), JSON.stringify(voiceProfile, null, 2))

  if (!pp.voiceProfile) pp.voiceProfile = {}
  Object.assign(pp.voiceProfile, voiceProfile)
  fs.writeFileSync(path.join(creatorDir, 'personality_profile.json'), JSON.stringify(pp, null, 2))

  console.log(`  ✓ voice_profile.json — ${goldenExamples.length} reply examples, ${postGoldenExamples.length} post examples`)
}

// Standalone
async function main() {
  const creatorsDir = path.join(process.cwd(), 'creators')
  const creators = fs.readdirSync(creatorsDir).filter(d =>
    fs.existsSync(path.join(creatorsDir, d, 'personality_profile.json'))
  )
  if (!creators.length) { console.log('No creators found.'); process.exit(1) }

  const creatorDir = path.join(creatorsDir, creators[0])
  console.log(`\n  Building RAG voice profile for: ${creators[0]}\n`)
  await buildRagVoiceProfile(creatorDir)
  console.log()
}

main().catch(e => { console.error(e); process.exit(1) })
