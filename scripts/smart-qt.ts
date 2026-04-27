#!/usr/bin/env npx tsx
/**
 * smart-qt.ts — example-first quote tweet comment generator.
 *
 * Same structure as smart-reply. Examples first → synthesized → rules → tweet → done.
 * Only difference: final instruction is "write your quote tweet comment" not "reply".
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
    return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'voice_profile.json'))
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
  topicExamples: { tweet: string; reply: string }[],
  synthesized: string,
  caseStyle: string,
  replyLength: string,
  emojiRule: string,
): string {
  const examplesBlock = goldenExamples.length
    ? goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')
    : ''

  const topicBlock = topicExamples.length
    ? '\nFor these specific tweets you replied like this (most important — shows your stance per topic):\n' +
      topicExamples.map(e => `Tweet: "${e.tweet}"\nYour reply: "${e.reply}"`).join('\n\n')
    : ''

  return `These are your real replies on X. Study them — this is your entire guide:

${examplesBlock}
${topicBlock}

How you write: ${synthesized}

Rules: ${caseStyle || 'sentence case'}. ${replyLength || 'short, 1-2 lines max'}. ${emojiRule}. No hashtags.

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
    console.log('  No voice profiles found. Run npm run setup first.\n')
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

  const vpPath = path.join(creatorDir, 'voice_profile.json')
  const vp = JSON.parse(fs.readFileSync(vpPath, 'utf8'))

  const goldenExamples: string[]                          = vp.goldenExamples ?? []
  const topicExamples: { tweet: string; reply: string }[] = vp.topicExamples ?? []
  const synthesized: string                               = vp.synthesized ?? ''
  const caseStyle: string                                 = vp.caseStyle ?? ''
  const replyLength: string                               = vp.replyLength ?? ''

  const emojiUsage: string  = vp.emojiUsage ?? ''
  const emojiContext: string = vp.emojiContext ?? ''
  const emojiRule = emojiContext
    ? `emoji only in ${emojiContext}`
    : emojiUsage
    ? `emoji: ${emojiUsage}`
    : 'no emojis'

  const model: string = process.env.REPLY_MODEL ?? 'claude-haiku-4-5-20251001'
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  console.log(`  Model: ${model}`)
  console.log(`  Golden examples loaded: ${goldenExamples.length}`)
  console.log(`  Topic examples loaded:  ${topicExamples.length}`)
  console.log(`  Synthesized:            ${synthesized ? 'yes' : 'MISSING'}`)
  console.log()

  if (!goldenExamples.length) {
    console.log('  No golden examples in voice_profile.json.')
    console.log('  Run npm run setup to complete the voice interview first.\n')
    rl.close(); process.exit(1)
  }

  console.log('─'.repeat(58))
  console.log('  Paste a tweet to QT, get a comment. Type "exit" to quit.')
  console.log('─'.repeat(58) + '\n')

  while (true) {
    const tweet = await ask('  Tweet to QT: ')
    if (!tweet || /^exit$/i.test(tweet)) break

    const prompt = buildPrompt(tweet, goldenExamples, topicExamples, synthesized, caseStyle, replyLength, emojiRule)

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
