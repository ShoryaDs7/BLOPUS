/**
 * topicPerformance.test.ts
 *
 * Tests the engagement-driven topic loop:
 *  - updateTopicPerformance adds/increments topics
 *  - boostTopicEngagement raises engagement score
 *  - Sort: engagement*2 + count — high-engagement topic beats high-count topic
 *  - "builder gets more replies → rises to top" scenario
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { MemoryEngine } from '../core/memory/MemoryEngine'

function makeTempMemory(): { engine: MemoryEngine; filePath: string } {
  const filePath = path.join(os.tmpdir(), `oswald-test-${Date.now()}.json`)
  const engine = new MemoryEngine(filePath)
  return { engine, filePath }
}

afterEach(() => {
  // clean up temp files
  const tmp = os.tmpdir()
  fs.readdirSync(tmp)
    .filter(f => f.startsWith('oswald-test-'))
    .forEach(f => { try { fs.unlinkSync(path.join(tmp, f)) } catch {} })
})

const ACCT = 'x:bot-own'

describe('updateTopicPerformance', () => {
  it('creates a new TopicStat entry', () => {
    const { engine } = makeTempMemory()
    engine.updateTopicPerformance(ACCT, ['builder'])
    const ctx = engine.getSmartContext(ACCT)
    const stat = ctx.topTopics.find(t => t.topic === 'builder')
    expect(stat).toBeDefined()
    expect(stat!.count).toBe(1)
    expect(stat!.engagement).toBe(0)
  })

  it('increments count on repeated topic', () => {
    const { engine } = makeTempMemory()
    engine.updateTopicPerformance(ACCT, ['ai'])
    engine.updateTopicPerformance(ACCT, ['ai'])
    engine.updateTopicPerformance(ACCT, ['ai'])
    const ctx = engine.getSmartContext(ACCT)
    const stat = ctx.topTopics.find(t => t.topic === 'ai')
    expect(stat!.count).toBe(3)
  })

  it('does nothing when topics array is empty', () => {
    const { engine } = makeTempMemory()
    engine.updateTopicPerformance(ACCT, [])
    const ctx = engine.getSmartContext(ACCT)
    expect(ctx.topTopics).toHaveLength(0)
  })

  it('handles multiple topics in one call', () => {
    const { engine } = makeTempMemory()
    engine.updateTopicPerformance(ACCT, ['builder', 'ai', 'startups'])
    const ctx = engine.getSmartContext(ACCT)
    expect(ctx.topTopics).toHaveLength(3)
  })
})

describe('boostTopicEngagement', () => {
  it('boosts engagement on existing topic', () => {
    const { engine } = makeTempMemory()
    engine.updateTopicPerformance(ACCT, ['builder'])
    engine.boostTopicEngagement(ACCT, 'builder', 1)
    const ctx = engine.getSmartContext(ACCT)
    const stat = ctx.topTopics.find(t => t.topic === 'builder')
    expect(stat!.engagement).toBe(1)
  })

  it('does nothing for unknown topic — no crash', () => {
    const { engine } = makeTempMemory()
    expect(() => engine.boostTopicEngagement(ACCT, 'nonexistent', 1)).not.toThrow()
  })

  it('accumulates multiple boosts', () => {
    const { engine } = makeTempMemory()
    engine.updateTopicPerformance(ACCT, ['builder'])
    engine.boostTopicEngagement(ACCT, 'builder', 1)
    engine.boostTopicEngagement(ACCT, 'builder', 1)
    engine.boostTopicEngagement(ACCT, 'builder', 1)
    const ctx = engine.getSmartContext(ACCT)
    const stat = ctx.topTopics.find(t => t.topic === 'builder')
    expect(stat!.engagement).toBe(3)
  })
})

describe('sort: engagement*2 + count', () => {
  it('high-engagement topic beats high-count topic', () => {
    const { engine } = makeTempMemory()

    // 'ai' posted 10 times, 0 replies
    for (let i = 0; i < 10; i++) engine.updateTopicPerformance(ACCT, ['ai'])

    // 'builder' posted 3 times, 3 replies → score = 3*2 + 3 = 9 vs ai score = 0*2 + 10 = 10
    // With 4 boosts: builder score = 4*2 + 3 = 11 > 10 → builder wins
    for (let i = 0; i < 3; i++) engine.updateTopicPerformance(ACCT, ['builder'])
    for (let i = 0; i < 4; i++) engine.boostTopicEngagement(ACCT, 'builder', 1)

    const ctx = engine.getSmartContext(ACCT)
    expect(ctx.topTopics[0].topic).toBe('builder')
  })

  it('real IRL scenario: builder gets 3x more engagement → rises to top', () => {
    const { engine } = makeTempMemory()

    // Day 1: post about various topics equally
    engine.updateTopicPerformance(ACCT, ['ai'])
    engine.updateTopicPerformance(ACCT, ['ai'])
    engine.updateTopicPerformance(ACCT, ['startups'])
    engine.updateTopicPerformance(ACCT, ['startups'])
    engine.updateTopicPerformance(ACCT, ['builder'])
    engine.updateTopicPerformance(ACCT, ['builder'])

    // Day 2: only builder posts get replies
    engine.boostTopicEngagement(ACCT, 'builder', 1)
    engine.boostTopicEngagement(ACCT, 'builder', 1)
    engine.boostTopicEngagement(ACCT, 'builder', 1)

    const ctx = engine.getSmartContext(ACCT)
    // builder: 3*2 + 2 = 8, ai: 0*2 + 2 = 2, startups: 0*2 + 2 = 2
    expect(ctx.topTopics[0].topic).toBe('builder')
  })

  it('persists across engine restart (flush + reload)', () => {
    const filePath = path.join(os.tmpdir(), `oswald-persist-${Date.now()}.json`)
    const e1 = new MemoryEngine(filePath)
    e1.updateTopicPerformance(ACCT, ['builder'])
    e1.boostTopicEngagement(ACCT, 'builder', 5)

    // Reload from disk
    const e2 = new MemoryEngine(filePath)
    const ctx = e2.getSmartContext(ACCT)
    const stat = ctx.topTopics.find(t => t.topic === 'builder')
    expect(stat!.engagement).toBe(5)
    fs.unlinkSync(filePath)
  })
})
