#!/usr/bin/env npx tsx
/**
 * smart-qt.ts — example-first quote tweet comment generator.
 *
 * Uses originalPostProfile (same as smart-post) — QT is publishing your own take, not replying.
 * Examples first → synthesized → rules → tweet → done.
 *
 * Usage: npx tsx scripts/smart-qt.ts
 */

import readline from 'readline'
import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { config as dotenvConfig } from 'dotenv'

dotenvConfig({ path: path.join(process.cwd(), '.env') })

const creatorsBase = path.resolve('./creators')

function findCreators(): string[] {
  if (!fs.existsSync(creatorsBase)) return []
  return fs.readdirSync(creatorsBase).filter(d => {
    const p = path.join(creatorsBase, d)
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'personality_profile.json'))
  })
}

function loadCreatorEnv(creatorDir: string) {
  const ep = path.join(creatorDir, '.env')
  if (fs.existsSync(ep)) dotenvConfig({ path: ep, override: false })
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
function ask(prompt: string): Promise<string> {
  return new Promise(resolve => rl.question(prompt, a => resolve(a.trim())))
}

function buildPrompt(
  tweet: string,
  goldenExamples: string[],
  topicExamples: { scenario: string; post: string }[],
  synthesized: string,
  caseStyle: string,
  postLength: string,
  emojiRule: string,
): string {
  const examplesBlock = goldenExamples.length
    ? goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')
    : ''

  const topicBlock = topicExamples.length
    ? '\nFor these specific situations you posted like this (most important — shows your exact stance):\n' +
      topicExamples.map(e => `Situation: "${e.scenario}"\nYour post: "${e.post}"`).join('\n\n')
    : ''

  return `These are your real posts on X. Study them — this is your entire guide:

${examplesBlock}
${topicBlock}

How you write posts: ${synthesized}

Rules: ${caseStyle || 'sentence case'}. ${postLength || 'short, 1-2 lines max'}. ${emojiRule}. No hashtags.

Now write your quote tweet comment on this exactly like the examples above:
"${tweet}"

Comment only. Nothing else.`
}

async function main() {
  console.clear()
  console.log('\n' + '═'.repeat(58))
  console.log('  smart-qt — example-first quote tweet generator')
  console.log('═'.repeat(58) + '\n')

  const creators = findCreators()
  let creatorName = ''

  if (!creators.length) {
    console.log('  No personality profiles found. Run npm run setup first.\n')
    rl.close(); process.exit(1)
  } else if (creators.length === 1) {
    creatorName = creators[0]
    console.log(`  Creator: ${creatorName}\n`)
  } else {
    creators.forEach((c, i) => console.log(`  [${i + 1}] ${c}`))
    let pick = ''
    while (!pick || isNaN(+pick) || +pick < 1 || +pick > creators.length) {
      pick = await ask('\n  Which creator? Enter number: ')
    }
    creatorName = creators[+pick - 1]
  }

  const creatorDir = path.join(creatorsBase, creatorName)
  loadCreatorEnv(creatorDir)

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  ANTHROPIC_API_KEY not set.\n')
    rl.close(); process.exit(1)
  }

  const ppPath = path.join(creatorDir, 'personality_profile.json')
  const pp = JSON.parse(fs.readFileSync(ppPath, 'utf8'))
  const opp = pp?.voiceProfile?.originalPostProfile

  if (!opp) {
    console.log('  No original post profile found.')
    console.log('  Run: npx tsx scripts/setup-original-posts.ts\n')
    rl.close(); process.exit(1)
  }

  const goldenExamples: string[]                              = opp.goldenExamples ?? []
  const topicExamples: { scenario: string; post: string }[]  = opp.topicExamples ?? []
  const synthesized: string                                   = opp.synthesized ?? ''
  const caseStyle: string                                     = opp.caseStyle ?? ''
  const postLength: string                                    = opp.postLength ?? opp.formatStyle ?? ''

  const emojiContext: string  = opp.emojiContext ?? ''
  const emojiFrequency: number = opp.emojiFrequency ?? 0
  const emojiRule = emojiContext
    ? `emoji: ${emojiContext}`
    : emojiFrequency > 0
    ? `emoji in ${emojiFrequency}% of posts`
    : 'no emojis'

  const model: string = process.env.REPLY_MODEL ?? 'claude-haiku-4-5-20251001'
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  console.log(`  Model: ${model}`)
  console.log(`  Golden examples loaded: ${goldenExamples.length}`)
  console.log(`  Topic examples loaded:  ${topicExamples.length}`)
  console.log(`  Synthesized:            ${synthesized ? 'yes' : 'MISSING'}`)
  console.log()

  if (!goldenExamples.length) {
    console.log('  No golden examples in originalPostProfile.')
    console.log('  Run: npx tsx scripts/setup-original-posts.ts\n')
    rl.close(); process.exit(1)
  }

  console.log('─'.repeat(58))
  console.log('  Paste a tweet to QT, get a comment. Type "exit" to quit.')
  console.log('─'.repeat(58) + '\n')

  while (true) {
    const tweet = await ask('  Tweet to QT: ')
    if (!tweet || /^exit$/i.test(tweet)) break

    const prompt = buildPrompt(tweet, goldenExamples, topicExamples, synthesized, caseStyle, postLength, emojiRule)

    try {
      const res = await client.messages.create({
        model,
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      })
      const raw = res.content[0]?.type === 'text' ? res.content[0].text.trim() : ''
      const comment = raw.replace(/^["']|["']$/g, '').replace(/—/g, ' ').trim()
      console.log(`\n  QT comment: "${comment}"\n`)
    } catch (err: any) {
      console.log(`\n  Error: ${err.message}\n`)
    }
  }

  rl.close()
}

main().catch(err => {
  console.error('\nFailed:', err.message)
  rl.close()
  process.exit(1)
})
