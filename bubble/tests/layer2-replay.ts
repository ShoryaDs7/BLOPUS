/**
 * Layer 2 — behavioral replay tests.
 * Feeds fake WindowContext + browser events directly into the pipeline.
 * No server, no Electron, no real browser needed.
 * Run: npx tsx bubble/tests/layer2-replay.ts
 */

import { scoreAction }        from '../ActionRouter'
import { resetReputation, recordDismiss, recordAccept, isSilencedByReputation } from '../reputationStore'
import { classifyActivity, allowedProposalTypes } from '../ActivityContext'

let passed = 0
let failed = 0
const errors: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e: any) {
    console.error(`  ✗  ${name}: ${e.message}`)
    errors.push(`${name}: ${e.message}`)
    failed++
  }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg) }
function assertEqual<T>(a: T, b: T, msg = '') { if (a !== b) throw new Error(`${msg} expected=${String(b)} got=${String(a)}`) }

interface FakeBrowseEvent { windowTitle: string; url: string }

function simulateBrowseSession(events: FakeBrowseEvent[]) {
  const proposals: ReturnType<typeof scoreAction>[] = []
  const topicCounts: Record<string, number> = {}

  for (const ev of events) {
    const m     = ev.windowTitle.match(/^(.+?)\s*[-|]\s*(Google Search|YouTube|Reddit|Chrome)?$/i)
    const topic = (m ? m[1] : ev.windowTitle).toLowerCase().trim()
    const key   = topic.split(' ').filter(w => w.length >= 4)[0] ?? topic
    topicCounts[key] = (topicCounts[key] ?? 0) + 1

    const visitCount = topicCounts[key]
    const pattern    = visitCount >= 3 ? 'cross_site' : 'repeated'

    const p = scoreAction({ topic, gap: 'general', conf: 0.82, pattern, visitCount, pageUrl: ev.url })
    if (p) proposals.push(p)
  }
  return { proposals, finalTopicCount: Math.max(...Object.values(topicCounts), 0) }
}

async function main() {

  console.log('\nScenario: YouTube research session')
  await test('YouTube research → find_video proposal fires', () => {
    const { proposals } = simulateBrowseSession([
      { windowTitle: 'attention mechanism explained - YouTube', url: 'https://youtube.com/watch?v=1' },
      { windowTitle: 'attention mechanism tutorial - YouTube', url: 'https://youtube.com/watch?v=2' },
      { windowTitle: 'attention mechanism transformer - YouTube', url: 'https://youtube.com/watch?v=3' },
    ])
    const yt = proposals.find(p => p?.actionType === 'find_video')
    assert(!!yt, `expected find_video, got: ${proposals.map(p=>p?.actionType).join(',')}`)
  })

  console.log('\nScenario: Cross-site comparison')
  await test('Vercel vs Railway cross-site → compare_options', () => {
    // All 3 titles share "vercel" as the key word → visitCount reaches 3 → pattern=cross_site
    // Topic contains "vs" + "pricing" → hasComparisonSignal=true → compare_options fires
    const { proposals } = simulateBrowseSession([
      { windowTitle: 'vercel vs railway pricing - Google Search', url: 'https://google.com/search?q=vercel+vs+railway' },
      { windowTitle: 'vercel vs railway discussion - Reddit',     url: 'https://reddit.com/r/webdev/comments/xyz' },
      { windowTitle: 'vercel vs railway comparison - Chrome',     url: 'https://railway.com/pricing' },
    ])
    const compare = proposals.find(p => p?.actionType === 'compare_options')
    assert(!!compare, `expected compare_options, got: ${proposals.map(p=>p?.actionType).join(',')}`)
    assertEqual(compare?.envelope.runner, 'session_brain')
  })

  await test('compare_options envelope has maxToolCalls scope cap', () => {
    const r = scoreAction({ topic: 'vercel vs railway', gap: 'general', conf: 0.82, pattern: 'cross_site', visitCount: 5 })
    assert((r?.envelope.maxToolCalls ?? 0) > 0, 'must have maxToolCalls')
    assert(r?.envelope.requireApproval === true, 'must require approval')
  })

  console.log('\nScenario: Deep research → synthesize')
  await test('7 pages on same topic → synthesize_research', () => {
    const pages = Array.from({ length: 7 }, (_, i) => ({
      windowTitle: `world models reinforcement learning article ${i} - Chrome`,
      url: `https://example.com/page${i}`,
    }))
    const { proposals } = simulateBrowseSession(pages)
    const synth = proposals.find(p => p?.actionType === 'synthesize_research')
    assert(!!synth, `expected synthesize_research, got: ${[...new Set(proposals.map(p=>p?.actionType))].join(',')}`)
  })

  console.log('\nScenario: VS Code coding friction')
  await test('implementation_gap + filePath → debug_code', () => {
    const p = scoreAction({ topic: 'typescript syntax error', gap: 'implementation_gap', conf: 0.85, pattern: 'repeated', filePath: '/src/TaskExecutor.ts' })
    assertEqual(p?.actionType, 'debug_code')
    assertEqual(p?.envelope.runner, 'session_brain')
    assert(p?.label.includes('TaskExecutor.ts'), `label should contain filename: ${p?.label}`)
  })

  await test('coding activity context allows debug_code', () => {
    const a = classifyActivity({ windowTitle: 'TaskExecutor.ts - Cursor', activeCodeFile: 'TaskExecutor.ts', vsCodeEventAge: 1000, browserTopicCount: 0, isOnComposeSurface: false })
    assertEqual(a.type, 'coding')
    assert(allowedProposalTypes(a).has('debug_code'), 'coding must allow debug_code')
  })

  console.log('\nScenario: Reputation — dismiss silences topic')
  await test('3 dismisses → silenced, 4th proposal suppressed', () => {
    resetReputation()
    recordDismiss('react'); recordDismiss('react'); recordDismiss('react')
    assert(isSilencedByReputation('react'), '3 dismisses should silence')
  })

  await test('dismiss on topic A does not silence topic B', () => {
    resetReputation()
    recordDismiss('react'); recordDismiss('react'); recordDismiss('react')
    assert(!isSilencedByReputation('nextjs'), 'nextjs should be unaffected')
  })

  await test('accept after 3 dismisses restores topic', () => {
    resetReputation()
    recordDismiss('svelte'); recordDismiss('svelte'); recordDismiss('svelte')
    assert(isSilencedByReputation('svelte'), 'should be silenced first')
    recordAccept('svelte')
    assert(!isSilencedByReputation('svelte'), 'accept should restore')
  })

  console.log('\nScenario: ActivityContext gating')
  await test('low topicCount on YouTube → watching → find_video blocked', () => {
    const a = classifyActivity({ windowTitle: 'Attention Explained - YouTube', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 1, isOnComposeSurface: false })
    const allowed = allowedProposalTypes(a)
    assert(!allowed.has('find_video'), `watching with low count should block find_video, type=${a.type}`)
  })

  await test('browserTopicCount=4 overrides watching → research → find_video allowed', () => {
    const a = classifyActivity({ windowTitle: 'Attention Explained - YouTube', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 4, isOnComposeSurface: false })
    assertEqual(a.type, 'research', 'confirmed research should override')
    assert(allowedProposalTypes(a).has('find_video'), 'research must allow find_video')
  })

  await test('communication surface blocks all proposals regardless of topicCount', () => {
    const a = classifyActivity({ windowTitle: 'Zoom Meeting', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 10, isOnComposeSurface: false })
    assertEqual(a.type, 'communication')
    assertEqual(allowedProposalTypes(a).size, 0, 'communication = 0 allowed proposals')
  })

  await test('research allows compare_options and synthesize_research', () => {
    const a = classifyActivity({ windowTitle: 'Some Article - Chrome', activeCodeFile: '', vsCodeEventAge: 0, browserTopicCount: 5, isOnComposeSurface: false })
    const allowed = allowedProposalTypes(a)
    assert(allowed.has('compare_options'),      'research must allow compare_options')
    assert(allowed.has('synthesize_research'),  'research must allow synthesize_research')
  })

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`)
  console.log(`  ${passed} passed  ${failed} failed`)
  if (errors.length) {
    console.error('\n  Failures:')
    errors.forEach(e => console.error(`    - ${e}`))
    process.exit(1)
  } else {
    console.log('\n  All tests passed.\n')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
