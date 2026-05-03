#!/usr/bin/env npx tsx
/**
 * Extracts formal writing rules from an existing voice profile.
 * Runs automatically after voice setup in any mode.
 * Saves voiceProfile.formalRules — used by SessionBrain + GoalRunner for emails, GitHub, HN, etc.
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

export async function extractFormalRules(
  profilePath: string,
  apiKey: string,
  askFn: (q: string) => Promise<string>
): Promise<void> {
  const client = new Anthropic({ apiKey })
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8'))
  const vp = profile.voiceProfile ?? {}
  const ws = profile.writingStats ?? {}

  // Build context from what we already know about this person's writing
  const context = {
    caseStyle:             ws.caseStyle ?? vp.caseStyle ?? '',
    avgReplyLength:        ws.medianReplyLength ?? ws.avgReplyLength ?? '',
    emojiUsage:            ws.emojiUsage ?? vp.emojiUsage ?? '',
    apostropheStyle:       vp.apostropheStyle ?? '',
    punctuationStyle:      ws.punctuationStyle ?? '',
    signaturePatterns:     (profile.signaturePatterns ?? []).slice(0, 6),
    openerPatterns: {
      onAgreement:         vp.behaviorPatterns?.onAgreement ?? '',
      onDisagreement:      vp.behaviorPatterns?.onDisagreement ?? '',
      onOwnTake:           vp.behaviorPatterns?.onOwnTake ?? '',
    },
    bannedPhrases:         vp.bannedPhrases ?? [],
    goldenExamples:        (vp.goldenExamples ?? []).slice(0, 6),
    synthesized:           vp.synthesized ?? '',
  }

  console.log('\n' + '─'.repeat(58))
  console.log('  Generating your writing rules from voice profile...')

  let rules: string[] = []
  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are extracting writing style rules from a person's voice profile.
These rules will be used when an AI writes emails, GitHub comments, HN posts, Slack messages, resumes on their behalf.

Here is what we know about how this person writes:
${JSON.stringify(context, null, 2)}

Extract 5-7 rules about mechanics that transfer to ANY written context.

Extract ONLY these 3-4 mechanical attributes — nothing else:
- apostrophe usage: do they write dont/isnt/wont or don't/isn't/won't
- capitalisation: sentence case, all lowercase, mixed — be specific with the pattern
- sign-off style: just first name alone, first name + closing phrase, nothing, etc.
- typical length: how many sentences per message

DO NOT include ANYTHING about:
- tone, attitude, bluntness, directness, confidence
- how they structure arguments or open messages
- punchlines, bursts, declarations
- emojis, CAPS, Twitter formatting
- anything a polite professional email would not naturally follow

These rules sit ON TOP of normal professional writing — they are personal formatting quirks only, not replacements for politeness or appropriate context.

Output: a JSON array of strings. Each rule one short line. Actionable.
Output ONLY the JSON array. Nothing else.`,
      }],
    })

    const raw = res.content[0].type === 'text' ? res.content[0].text.trim() : '[]'
    const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim()
    const start = cleaned.indexOf('[')
    const end = cleaned.lastIndexOf(']')
    if (start !== -1 && end !== -1) {
      rules = JSON.parse(cleaned.slice(start, end + 1))
    }
  } catch (e) {
    console.warn('  Could not extract rules:', e)
    return
  }

  if (!rules.length) {
    console.log('  Could not extract rules from profile — skipping.')
    return
  }

  // Always enforce em dash ban — Claude ignores it when buried in global voice section
  if (!rules.some(r => r.toLowerCase().includes('em dash') || r.includes('—'))) {
    rules.unshift('never use em dashes (—) anywhere — use a comma, period, or colon instead')
  }

  // Show the user what was found
  console.log('\n' + '═'.repeat(58))
  console.log('  YOUR WRITING RULES — derived from your voice profile')
  console.log('  (used for emails, GitHub, HN, any formal writing)\n')
  rules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`))
  console.log('═'.repeat(58))

  const answer = await askFn('\n  Correct? (yes / type what\'s wrong and I\'ll fix it): ')

  if (!/^yes|^y$|^yep|^yup|^yeah/i.test(answer.trim()) && answer.trim()) {
    // Apply correction via LLM
    try {
      const fixRes = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `Current rules:\n${JSON.stringify(rules)}\n\nUser correction: "${answer}"\n\nUpdate the rules to reflect the correction. Output ONLY the updated JSON array of strings. Nothing else.`,
        }],
      })
      const raw2 = fixRes.content[0].type === 'text' ? fixRes.content[0].text.trim() : ''
      const cleaned2 = raw2.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim()
      const s = cleaned2.indexOf('['), e2 = cleaned2.lastIndexOf(']')
      if (s !== -1 && e2 !== -1) rules = JSON.parse(cleaned2.slice(s, e2 + 1))
      console.log('\n  Updated rules:')
      rules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`))
    } catch {}
  }

  // Save to profile
  if (!profile.voiceProfile) profile.voiceProfile = {}
  profile.voiceProfile.formalRules = rules
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8')
  console.log('\n  ✓ Saved to personality_profile.json → voiceProfile.formalRules\n')
}

// ── Standalone runner ─────────────────────────────────────────
async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.log('ANTHROPIC_API_KEY not found'); process.exit(1) }

  const creatorsDir = path.join(process.cwd(), 'creators')
  const creators = fs.readdirSync(creatorsDir).filter(d =>
    fs.existsSync(path.join(creatorsDir, d, 'personality_profile.json'))
  )
  if (!creators.length) { console.log('No creator profiles found. Run npm run setup first.'); process.exit(1) }

  let creatorName = creators[0]
  if (creators.length > 1) {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask2 = (q: string) => new Promise<string>(r => rl2.question(q, a => r(a.trim())))
    console.log('Multiple creators:')
    creators.forEach((c, i) => console.log(`  ${i + 1}. ${c}`))
    const pick = await ask2('Pick number: ')
    creatorName = creators[parseInt(pick) - 1] ?? creators[0]
    rl2.close()
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>(r => rl.question(q, a => r(a.trim())))
  const profilePath = path.join(creatorsDir, creatorName, 'personality_profile.json')
  await extractFormalRules(profilePath, apiKey, ask)
  rl.close()
}

main().catch(e => { console.error(e); process.exit(1) })
