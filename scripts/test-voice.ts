#!/usr/bin/env npx tsx
/**
 * Voice quality test — uses hardcoded golden examples + approved validation answers
 * from a real setup session to check if LLM generates matching replies.
 * Run: npx tsx scripts/test-voice.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as path from 'path'
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

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

// ── Data from the test session ───────────────────────────────────────────────

const synthesized = `This person writes in short, punchy bursts with strong opinionated takes, favoring direct confrontation over nuance. They use sentence case with apostrophes in contractions, rarely elaborate unless explaining a point, and keep most replies to 1-2 words on casual topics while reserving substance for social/political issues. Their tone is aggressive when rejecting claims, sarcastic when disagreeing, and deliberately minimal on viral content—emoji usage is restrained except for casual humor (😂 for funny, 😭 for serious).`

const goldenExamples = [
  `Poor is not the issue, the habbit they have is. As soon as they get some money they expend it on useless things.`,
  `But let's see how much of children actually gets fed. Oh yeah, maybe we'll never know cuz of the corruption.`,
  `Here we have got a so called 'educated person'. Do you know people don't even get clean water to drink and you expect them to focus on cleanliness? Fix the govt, people will eventually change.`,
  `yepp that's right and i know i'll get alot of hate on the comment but religion is a weapon people use to destroy secularism.`,
  `Men should just "CLOSE" their eyes while they walk past girls, it's not that "COMPLICATED".`,
  `That's the point, why do men not understand this thing even in 2026?`,
  `i hope it does'nt replace doctors😭`,
  `People really laughing at this? Seriously?`,
  `People have lost their souls now.`,
  `But i like Biryani 😋`,
  `Taste Matters 😤.`,
]

// Interview answers
const style = {
  caseStyle: 'sentence case — always capitalize first letter, use apostrophes in contractions',
  replyLength: '1-2 words on funny/meme/AI/food topics. 1-2 lines on social/gender/religion topics. Longer only when explaining (~10% of replies).',
  openers: 'Occasionally (NOT always — ~70% of replies): "Honestly", "I think", "I wonder". 30% jump straight to point. Never use the same opener twice in a row.',
  onDisagreement: '50% counter directly, 25% ask a question, 25% sarcasm + point',
  onAgreement: '2-3 words only — "yep", "exactly", variations of these',
  emojiRule: 'emojis only for lighthearted reactions (😂 for funny memes, 🥱 for humor/taunting, 😭 for serious/absurd). NEVER on serious domain tweets (gender, religion, social issues).',
  allCaps: 'ALL CAPS only ~5% of the time — very strong rejection of what the tweet says. One-liner only.',
  neverUse: 'slurs, bad words',
}

// Test tweets + approved replies from validation session
const tests: { topic: string, tweet: string, approved: string }[] = [
  {
    topic: 'Indian social issues',
    tweet: `India's obsession with fair skin in matrimonial ads reveals how colonialism's damage still runs deeper than we're willing to admit.`,
    approved: `I wonder if we're even ready to acknowledge how deeply we've internalized these standards. fair skin = desirability is colonial propaganda we're still selling to our own kids.`,
  },
  {
    topic: 'Hygiene and civic sense',
    tweet: `People who don't flush public toilets aren't just unhygienic—they're telling everyone they don't care about shared spaces. Civic sense starts in the bathroom.`,
    approved: `Honestly, it's not just bathrooms—it's everywhere. People stopped caring about anything that isn't theirs. Civic sense died when we decided rules are for other people.`,
  },
  {
    topic: 'Religion and communalism',
    tweet: `Religious identity shouldn't determine citizenship rights or access to public resources. Communalism thrives when we forget our shared humanity matters more than doctrine.`,
    approved: `I think this is the bare minimum. Yet somehow we're still fighting for it in 2026. Communalism won't die till people stop treating religion like their only identity.`,
  },
  {
    topic: 'Gender, consent, women\'s rights',
    tweet: `Women's right to bodily autonomy isn't negotiable. Consent means enthusiastic yes, not the absence of no.`,
    approved: `I think the issue is men still don't get what consent actually means. It's not complicated—enthusiastic yes or nothing happens. Stop pretending it's ambiguous.`,
  },
  {
    topic: 'AI and technology',
    tweet: `The real AI revolution isn't the models getting smarter—it's how fast humans are learning to be dependent on them.`,
    approved: `I wonder if we're just training ourselves to think worse. Dependency's the real killer here—we're outsourcing our brains before we even know what we're capable of.`,
  },
  {
    topic: 'Viral content',
    tweet: `Hot take: most viral reactions are just people performing outrage for engagement, not actual authentic takes on anything`,
    approved: `I think most people are just chasing clout, not actual opinions anymore.`,
  },
  {
    topic: 'Food and lifestyle',
    tweet: `Meal prep culture is just anxiety in containers. Real people eat when they're hungry and move on with their lives.`,
    approved: `Some people have actual Dependency issues with food. Not everyone can just "eat when hungry."`,
  },
]

// ── Prompt builder ───────────────────────────────────────────────────────────

const topicExamples = tests.map(t => `Tweet: "${t.tweet}"\nReply: "${t.approved}"`).join('\n\n')

function buildPrompt(tweet: string): string {
  return `You are this person on X (Twitter). Study their real replies below — this is your entire guide. Match their exact voice, length, tone, and stance.

GENERAL STYLE EXAMPLES (shows HOW they write):
${goldenExamples.map((e, i) => `${i + 1}. "${e}"`).join('\n')}

TOPIC-SPECIFIC EXAMPLES (shows HOW they write AND what they think on each topic — most important):
${topicExamples}

What you can observe from these examples:
- Always starts with capital letter, uses apostrophes (don't, isn't, won't)
- Length: 1-2 words for casual/funny topics. 1-2 lines for social/political. Never more than 2-3 sentences.
- Openers like "Honestly", "I think", "I wonder" appear in SOME replies but NOT all — many jump straight to the point. Never use the same opener twice in a row.
- Emojis only in lighthearted replies — never on serious social/political tweets
- Sarcasm: sometimes mirrors the original tweet's logic to flip it
- ALL CAPS only for very strong rejection, one-liner only
- When agreeing: 2-3 words max
- Never uses slurs or bad words
- Do NOT copy wording from the examples above — write fresh replies in the same voice

Now reply to this tweet in the exact same voice:
"${tweet}"

Return ONLY the reply. No quotes around it.`
}

// ── Run tests ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(70))
  console.log('  VOICE QUALITY TEST')
  console.log('  Generated reply vs approved reply from validation session')
  console.log('═'.repeat(70) + '\n')

  for (const t of tests) {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      messages: [{ role: 'user', content: buildPrompt(t.tweet) }],
    })
    const generated = res.content[0]?.type === 'text' ? res.content[0].text.trim() : '(error)'

    console.log(`[${t.topic}]`)
    console.log(`Tweet:     "${t.tweet.slice(0, 80)}${t.tweet.length > 80 ? '...' : ''}"`)
    console.log(`Generated: "${generated}"`)
    console.log(`Approved:  "${t.approved}"`)
    console.log()
  }
}

main().catch(console.error)
