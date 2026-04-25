#!/usr/bin/env npx tsx
/**
 * Standalone voice validation — run this to redo the sample-reply step only.
 * Detects your existing creator folder, loads voice profile, runs topic-by-topic
 * reply approval, then saves topicExamples back to disk.
 *
 * Usage: npx tsx scripts/validate-voice.ts
 */

import readline from 'readline'
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { config as dotenvConfig } from 'dotenv'

// ── Load env ─────────────────────────────────────────────────────────────────

dotenvConfig({ path: path.join(process.cwd(), '.env') })

const creatorsBase = path.resolve('./creators')

// Auto-find creator dir
function findCreators(): string[] {
  if (!fs.existsSync(creatorsBase)) return []
  return fs.readdirSync(creatorsBase).filter(d => {
    const p = path.join(creatorsBase, d)
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'voice_profile.json'))
  })
}

// Load env from creator dir if API key not in root .env
function loadCreatorEnv(creatorDir: string) {
  const ep = path.join(creatorDir, '.env')
  if (fs.existsSync(ep)) dotenvConfig({ path: ep, override: false })
}

// ── readline helper ───────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
}

// ── Prompt builder (same as setup.ts) ────────────────────────────────────────

function buildReplyPrompt(
  tweet: string,
  goldenExamples: string[],
  topicExamples: { tweet: string, reply: string }[],
  globalCorrections: string[],
  caseStyle: string,
  replyLength: string,
  bannedPhrases: string[],
  topicCorrection?: string
): string {
  const topicExamplesBlock = topicExamples.length
    ? `\nTOPIC-SPECIFIC EXAMPLES (tweet → approved reply, most important — shows stance + style):\n${topicExamples.map(e => `Tweet: "${e.tweet}"\nReply: "${e.reply}"`).join('\n\n')}\n`
    : ''
  const correctionBlock = globalCorrections.length
    ? `\nCORRECTIONS FROM USER (apply to all replies):\n${globalCorrections.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
    : ''
  return `You are this person on X (Twitter). Study their real replies below and match their exact voice, length, tone, and stance.

GENERAL STYLE EXAMPLES (shows HOW they write):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}
${topicExamplesBlock}
What to observe from these examples:
- Case: ${caseStyle || 'sentence case, capital first letter, apostrophes in contractions'}
- Length: ${replyLength || 'very short by default. 1-2 lines max for serious topics. Never more than 3 sentences.'}
- Openers like "Honestly", "I think", "I wonder" appear in SOME replies but NOT all — many jump straight to the point. Never repeat the same opener back to back.
- Emojis only in lighthearted replies — never on serious social/political tweets
- Never use: ${bannedPhrases.join(', ') || 'slurs, bad words'}
- Do NOT copy wording from the examples above — write a fresh reply in the same voice
${correctionBlock}
Now reply to this tweet in the exact same voice:
"${tweet}"
${topicCorrection ? `\nPrevious attempt was wrong — fix this: ${topicCorrection}` : ''}
Return ONLY the reply. No quotes around it.`
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.clear()
  console.log('\n' + '═'.repeat(58))
  console.log('  Blopus — Voice Validation')
  console.log('  Approves sample replies per topic and saves them.')
  console.log('═'.repeat(58) + '\n')

  // Detect creator
  const creators = findCreators()
  let creatorName = ''

  if (creators.length === 0) {
    console.log('  No voice profiles found in creators/.')
    console.log('  Run npm run setup first to complete the voice interview.\n')
    rl.close(); process.exit(1)
  } else if (creators.length === 1) {
    creatorName = creators[0]
    console.log(`  Found creator: ${creatorName}\n`)
  } else {
    console.log('  Multiple creators found:')
    creators.forEach((c, i) => console.log(`  [${i + 1}] ${c}`))
    let pick = ''
    while (!pick || isNaN(parseInt(pick)) || parseInt(pick) < 1 || parseInt(pick) > creators.length) {
      pick = await ask('\n  Which one? Enter number: ')
    }
    creatorName = creators[parseInt(pick) - 1]
  }

  const creatorDir = path.join(creatorsBase, creatorName)
  loadCreatorEnv(creatorDir)

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.log('  ANTHROPIC_API_KEY not found. Add it to your .env file.\n')
    rl.close(); process.exit(1)
  }

  // Load profiles
  const vpPath  = path.join(creatorDir, 'voice_profile.json')
  const ppPath  = path.join(creatorDir, 'personality_profile.json')

  const voiceProfile      = JSON.parse(fs.readFileSync(vpPath, 'utf8'))
  const personalityProfile = fs.existsSync(ppPath) ? JSON.parse(fs.readFileSync(ppPath, 'utf8')) : {}

  const replyModel: string = process.env.REPLY_MODEL ?? 'claude-haiku-4-5-20251001'
  const client = new Anthropic({ apiKey })

  // What we need from voice profile
  const goldenExamples: string[] = voiceProfile.goldenExamples ?? []
  const caseStyle:   string   = voiceProfile.caseStyle ?? ''
  const replyLength: string   = voiceProfile.replyLength ?? ''
  const bannedPhrases: string[] = voiceProfile.bannedPhrases ?? []

  const topics: string[] = personalityProfile?.dominantTopics ?? voiceProfile?.neverTopics?.length
    ? (personalityProfile?.dominantTopics ?? [])
    : (personalityProfile?.replyTopics ?? personalityProfile?.dominantTopics ?? [])

  if (!topics.length) {
    console.log('  No topics found in personality profile. Cannot generate sample tweets.\n')
    rl.close(); process.exit(1)
  }

  console.log('  Topics to validate:')
  topics.forEach((t: string, i: number) => console.log(`  ${i + 1}. ${t}`))
  console.log()

  // Existing topicExamples — keep them, we'll add/replace by topic
  const existingTopicExamples: { tweet: string, reply: string }[] = voiceProfile.topicExamples ?? []
  const topicExamples: { tweet: string, reply: string }[] = [...existingTopicExamples]
  const globalCorrections: string[] = []

  console.log('═'.repeat(58))
  console.log('  For each topic: a sample tweet is generated, then Blopus')
  console.log('  replies in your voice. Type "yes" to approve or tell it')
  console.log('  what\'s wrong. Approved replies are saved to your profile.')
  console.log('═'.repeat(58) + '\n')

  for (const topic of topics) {
    // Generate sample tweet
    let sampleTweet = ''
    try {
      const tweetRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 80,
        messages: [{ role: 'user', content: `Write one short realistic X tweet about "${topic}" — a hot take, opinion, or claim. Under 20 words. No quotes, no numbering.` }],
      })
      const c = tweetRes.content[0]
      if (c.type === 'text') sampleTweet = c.text.trim()
    } catch {}

    if (!sampleTweet) { console.log(`  [${topic}] Could not generate tweet — skipping.\n`); continue }

    console.log(`  [${topic}]`)
    console.log(`  Tweet: "${sampleTweet}"`)

    let topicCorrection = ''
    let approved = false
    let approvedReply = ''

    while (!approved) {
      try {
        const replyRes = await client.messages.create({
          model: replyModel, max_tokens: 120,
          messages: [{ role: 'user', content: buildReplyPrompt(sampleTweet, goldenExamples, topicExamples, globalCorrections, caseStyle, replyLength, bannedPhrases, topicCorrection || undefined) }],
        })
        const rc = replyRes.content[0]
        if (!rc || rc.type !== 'text') break
        approvedReply = rc.text.trim()
        console.log(`  Reply: "${approvedReply}"`)
      } catch { break }

      const fb = await ask('  Correct? (yes / tell me what\'s off): ')
      if (/^(yes|y|yeah|yep|correct|good|perfect|ok|okay)/i.test(fb.trim())) {
        approved = true
        // Remove any previous entry for this same tweet (allow re-run)
        const idx = topicExamples.findIndex(e => e.tweet === sampleTweet)
        if (idx !== -1) topicExamples.splice(idx, 1)
        topicExamples.push({ tweet: sampleTweet, reply: approvedReply })
        console.log('  ✓ Saved.\n')
      } else if (fb.trim()) {
        topicCorrection = fb.trim()
        globalCorrections.push(fb.trim())
        console.log('  Retrying...\n')
      } else {
        console.log('  Skipped.\n')
        break
      }
    }
  }

  if (!topicExamples.length) {
    console.log('  No approved replies — nothing saved.')
    rl.close(); return
  }

  // Save topicExamples back to voice_profile.json
  voiceProfile.topicExamples = topicExamples
  fs.writeFileSync(vpPath, JSON.stringify(voiceProfile, null, 2), 'utf8')

  // Also update inside personality_profile.json if it exists
  if (fs.existsSync(ppPath)) {
    if (!personalityProfile.voiceProfile) personalityProfile.voiceProfile = {}
    personalityProfile.voiceProfile.topicExamples = topicExamples
    fs.writeFileSync(ppPath, JSON.stringify(personalityProfile, null, 2), 'utf8')
  }

  console.log('─'.repeat(58))
  console.log(`  ✓ ${topicExamples.length} topic examples saved to voice_profile.json`)
  console.log(`  Bot will now use these as highest-priority context on matching topics.`)
  console.log('─'.repeat(58) + '\n')

  rl.close()
}

main().catch(err => {
  console.error('\nValidation failed:', err.message)
  rl.close()
  process.exit(1)
})
