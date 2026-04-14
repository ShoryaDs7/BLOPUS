/**
 * checkPersons — inspect real PersonMemory files to verify what's built
 */
import fs from 'fs'
import path from 'path'

const dir = path.resolve('./memory-store/persons')
const files = fs.readdirSync(dir)

let withDmVoice = 0
let withBaseline = 0
let maxConvos = 0
let maxHandle = ''
const richPeople: string[] = []
const withDmVoiceHandles: string[] = []

for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
    if (d.dmVoiceProfile) { withDmVoice++; withDmVoiceHandles.push(d.handle) }
    if (d.toneBaseline) withBaseline++
    const c = d.conversations?.length ?? 0
    if (c > maxConvos) { maxConvos = c; maxHandle = d.handle }
    if (c > 3) richPeople.push(d.handle)
  } catch {}
}

console.log('═'.repeat(50))
console.log('Total person files:', files.length)
console.log('With dmVoiceProfile (real DM history):', withDmVoice)
console.log('With toneBaseline:', withBaseline)
console.log('Max conversations:', maxConvos, '→ @'+maxHandle)
console.log('People with 3+ convos:', richPeople.length)
console.log('Sample rich people:', richPeople.slice(0, 8).join(', '))
if (withDmVoiceHandles.length) {
  console.log('With DM voice:', withDmVoiceHandles.slice(0, 5).join(', '))
}
console.log('═'.repeat(50))

// Print richest person's file summary
if (maxHandle) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, maxHandle + '.json'), 'utf-8'))
  console.log('\nRichest person @' + maxHandle + ':')
  console.log('  relationshipType:', d.relationshipType)
  console.log('  totalInteractions:', d.totalInteractions)
  console.log('  dominantTopics:', d.dominantTopics?.join(', '))
  console.log('  ownerToneWithThem:', d.ownerToneWithThem)
  console.log('  theirPersonality:', d.theirPersonality?.slice(0, 80))
  console.log('  dmVoiceProfile:', d.dmVoiceProfile ? JSON.stringify(d.dmVoiceProfile).slice(0, 120) : 'null')
  console.log('  toneBaseline:', d.toneBaseline ? JSON.stringify(d.toneBaseline).slice(0, 120) : 'null')
  console.log('  conversations sample:')
  d.conversations.slice(-2).forEach((c: any) => {
    console.log('    [' + c.topic + ']', c.messages?.slice(-1)[0]?.text?.slice(0, 80))
  })
}
