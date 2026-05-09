/**
 * Layer 1 — pure logic tests. No server, no UI, no Electron.
 * Run: npx tsx bubble/tests/layer1-logic.ts
 */

import { scoreAction }                       from '../ActionRouter'
import { classifyActivity, allowedProposalTypes } from '../ActivityContext'
import { recordDismiss, recordAccept, isSilencedByReputation, resetReputation } from '../reputationStore'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e: any) {
    console.error(`  ✗  ${name}`)
    console.error(`     ${e.message}`)
    failed++
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg)
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
  if (actual !== expected) throw new Error(`${msg ?? ''} expected=${String(expected)} got=${String(actual)}`)
}

// ── ActionRouter ─────────────────────────────────────────────────────────────
console.log('\nActionRouter')

test('YouTube URL → find_video', () => {
  const r = scoreAction({ topic: 'attention mechanism transformer', gap: 'intuition_gap', conf: 0.85, pattern: 'repeated', visitCount: 4, pageUrl: 'https://www.youtube.com/watch?v=abc' })
  assertEqual(r?.actionType, 'find_video')
})

test('Reddit URL → find_discussion', () => {
  const r = scoreAction({ topic: 'rust async runtime', gap: 'general', conf: 0.80, pattern: 'repeated', visitCount: 4, pageUrl: 'https://www.reddit.com/r/rust/comments/xyz' })
  assertEqual(r?.actionType, 'find_discussion')
})

test('implementation_gap + filePath → debug_code', () => {
  const r = scoreAction({ topic: 'typescript error', gap: 'implementation_gap', conf: 0.85, pattern: 'repeated', filePath: '/src/TaskExecutor.ts' })
  assertEqual(r?.actionType, 'debug_code')
})

test('knowledge gap + filePath → find_resource', () => {
  const r = scoreAction({ topic: 'prisma orm', gap: 'knowledge', conf: 0.80, pattern: 'repeated', filePath: '/src/db.ts' })
  assertEqual(r?.actionType, 'find_resource')
})

test('expression gap + long selectedText → draft_tweet', () => {
  const r = scoreAction({ topic: 'ai agents', gap: 'expression', conf: 0.80, pattern: 'repeated', selectedText: 'The thing nobody talks about with AI agents is that most of them are just glorified if-else chains wrapped in a for loop' })
  assertEqual(r?.actionType, 'draft_tweet')
})

test('comparison topic + cross_site → compare_options', () => {
  const r = scoreAction({ topic: 'vercel vs railway pricing', gap: 'general', conf: 0.82, pattern: 'cross_site', visitCount: 5 })
  assertEqual(r?.actionType, 'compare_options')
})

test('non-comparison topic + cross_site → NOT compare_options', () => {
  const r = scoreAction({ topic: 'transformer attention mechanism', gap: 'general', conf: 0.82, pattern: 'cross_site', visitCount: 5 })
  assert(r?.actionType !== 'compare_options', `should not be compare_options, got ${r?.actionType}`)
})

test('visitCount >= 6 + confusion_loop → synthesize_research', () => {
  const r = scoreAction({ topic: 'world models reinforcement learning', gap: 'general', conf: 0.80, pattern: 'confusion_loop', visitCount: 7 })
  assertEqual(r?.actionType, 'synthesize_research')
})

test('no topic → null', () => {
  const r = scoreAction({ topic: '', gap: 'general', conf: 0.80, pattern: 'repeated' })
  assert(r === null, 'empty topic should return null')
})

test('low visitCount + web surface → find_article', () => {
  const r = scoreAction({ topic: 'nextjs app router', gap: 'general', conf: 0.80, pattern: 'repeated', visitCount: 2 })
  assertEqual(r?.actionType, 'find_article')
})

test('debug_code label contains filename', () => {
  const r = scoreAction({ topic: 'bug fix', gap: 'implementation_gap', conf: 0.85, pattern: 'repeated', filePath: '/src/server.ts' })
  assert(r?.label.includes('server.ts'), `label should include filename, got: ${r?.label}`)
})

test('compare_options runner is session_brain', () => {
  const r = scoreAction({ topic: 'vercel vs railway', gap: 'general', conf: 0.82, pattern: 'cross_site', visitCount: 5 })
  assertEqual(r?.envelope.runner, 'session_brain')
})

test('find_article runner is task_executor', () => {
  const r = scoreAction({ topic: 'react server components', gap: 'general', conf: 0.80, pattern: 'repeated', visitCount: 2 })
  assertEqual(r?.envelope.runner, 'task_executor')
})

test('session_brain envelope has maxRuntimeMs', () => {
  const r = scoreAction({ topic: 'vercel vs railway', gap: 'general', conf: 0.82, pattern: 'cross_site', visitCount: 5 })
  assert((r?.envelope.maxRuntimeMs ?? 0) > 0, 'session_brain envelope must have maxRuntimeMs')
})

test('session_brain envelope has requireApproval=true', () => {
  const r = scoreAction({ topic: 'vercel vs railway', gap: 'general', conf: 0.82, pattern: 'cross_site', visitCount: 5 })
  assert(r?.envelope.requireApproval === true, 'session_brain envelope must require approval')
})

// ── ActivityContext ───────────────────────────────────────────────────────────
console.log('\nActivityContext')

test('browserTopicCount >= 3 → research (overrides watching)', () => {
  const a = classifyActivity({ windowTitle: 'Some Article - Google Chrome', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 4, isOnComposeSurface: false })
  assertEqual(a.type, 'research')
})

test('VS Code active → coding', () => {
  const a = classifyActivity({ windowTitle: 'server.ts - Visual Studio Code', activeCodeFile: 'server.ts', vsCodeEventAge: 0, browserTopicCount: 1, isOnComposeSurface: false })
  assertEqual(a.type, 'coding')
})

test('Zoom active → communication', () => {
  const a = classifyActivity({ windowTitle: 'Zoom Meeting', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 0, isOnComposeSurface: false })
  assertEqual(a.type, 'communication')
})

test('research allows compare_options', () => {
  const a = classifyActivity({ windowTitle: 'Some Article - Chrome', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 4, isOnComposeSurface: false })
  const allowed = allowedProposalTypes(a)
  assert(allowed.has('compare_options'), 'research should allow compare_options')
})

test('coding allows debug_code', () => {
  const a = classifyActivity({ windowTitle: 'file.ts - Cursor', activeCodeFile: 'file.ts', vsCodeEventAge: 0, browserTopicCount: 0, isOnComposeSurface: false })
  const allowed = allowedProposalTypes(a)
  assert(allowed.has('debug_code'), 'coding should allow debug_code')
})

test('communication allows nothing', () => {
  const a = classifyActivity({ windowTitle: 'Google Meet', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 0, isOnComposeSurface: false })
  const allowed = allowedProposalTypes(a)
  assert(allowed.size === 0, 'communication should allow nothing')
})

// ── Reputation scoring ────────────────────────────────────────────────────────
console.log('\nReputation scoring')

test('0 dismisses → not silenced', () => {
  resetReputation()
  assert(!isSilencedByReputation('react'), 'fresh topic should not be silenced')
})

test('2 dismisses → not silenced', () => {
  resetReputation()
  recordDismiss('react'); recordDismiss('react')
  assert(!isSilencedByReputation('react'), '2 dismisses should not silence')
})

test('3 dismisses → silenced', () => {
  resetReputation()
  recordDismiss('react'); recordDismiss('react'); recordDismiss('react')
  assert(isSilencedByReputation('react'), '3 dismisses should silence')
})

test('3 dismisses + 1 accept → no longer silenced', () => {
  resetReputation()
  recordDismiss('react'); recordDismiss('react'); recordDismiss('react')
  recordAccept('react')
  assert(!isSilencedByReputation('react'), 'accept should partially unsilence')
})

test('dismisses on different topics are independent', () => {
  resetReputation()
  recordDismiss('react'); recordDismiss('react'); recordDismiss('react')
  assert(!isSilencedByReputation('vue'), 'vue should not be affected by react dismisses')
})

test('reset clears all reputation', () => {
  resetReputation()
  recordDismiss('react'); recordDismiss('react'); recordDismiss('react')
  resetReputation()
  assert(!isSilencedByReputation('react'), 'after reset, topic should not be silenced')
})

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`)
console.log(`  ${passed} passed  ${failed} failed`)
if (failed > 0) { console.error(`\n  ${failed} test(s) failed`); process.exit(1) }
else console.log('\n  All tests passed.\n')
