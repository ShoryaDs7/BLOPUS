/**
 * packDiscovery.test.ts
 *
 * Tests PackDiscovery logic without hitting real X.
 * Mocks: XAdapter.playwright.searchTweets, XAdapter.postReply, LLMReplyEngine, fs
 *
 * Scenarios:
 *  - generatePackId format: blopus:[a-z0-9]{6}
 *  - generatePackId always unique (10k sample)
 *  - Skips check if < 4h elapsed
 *  - Skips own handle
 *  - Skips own packId
 *  - Skips already-known packIds (in-memory)
 *  - Connects to new OsBot: persists to config, posts reply
 *  - Daily cap of 3 new connections
 *  - GAP: knownPackIds is in-memory only — restart vulnerability
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { PackDiscovery } from '../agent/PackDiscovery'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSearchTweets = jest.fn()
const mockPostReply = jest.fn()

const mockXAdapter = {
  playwright: { searchTweets: mockSearchTweets },
  postReply: mockPostReply,
} as any

const mockGenerateViralReply = jest.fn().mockResolvedValue('hey cool bot!')
const mockLLMEngine = {
  generateViralReply: mockGenerateViralReply,
} as any

function makeTweet(handle: string, text: string, id = 'tweet1') {
  return { tweetId: id, authorHandle: handle, text, likes: 0 }
}

function makeDiscovery(myPackId = 'blopus:aaaaaa', configPath?: string) {
  const cfgPath = configPath ?? path.join(os.tmpdir(), `oswald-cfg-${Date.now()}.json`)
  fs.writeFileSync(cfgPath, JSON.stringify({ pack: { knownOsBots: [] } }))
  return {
    discovery: new PackDiscovery(mockXAdapter, mockLLMEngine, myPackId, 'openocta', cfgPath),
    cfgPath,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.spyOn(Date, 'now').mockRestore()
})

// ─── generatePackId ───────────────────────────────────────────────────────────

describe('generatePackId', () => {
  it('matches blopus:[a-z0-9]{6} format', () => {
    const id = PackDiscovery.generatePackId()
    expect(id).toMatch(/^blopus:[a-z0-9]{6}$/)
  })

  it('generates unique IDs (10k sample)', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => PackDiscovery.generatePackId()))
    // Expect near-uniqueness — collision probability is 1/(36^6) ≈ negligible
    expect(ids.size).toBeGreaterThan(9990)
  })
})

// ─── Cooldown gate ────────────────────────────────────────────────────────────

describe('4-hour cooldown', () => {
  it('runs immediately on first call (lastCheckAt = 0)', async () => {
    const { discovery, cfgPath } = makeDiscovery()
    mockSearchTweets.mockResolvedValue([])
    await discovery.maybeDiscover('chill')
    expect(mockSearchTweets).toHaveBeenCalledTimes(1)
    fs.unlinkSync(cfgPath)
  })

  it('skips if called again within 4 hours', async () => {
    const { discovery, cfgPath } = makeDiscovery()
    mockSearchTweets.mockResolvedValue([])
    jest.spyOn(Date, 'now').mockReturnValue(0)
    await discovery.maybeDiscover('chill')

    jest.spyOn(Date, 'now').mockReturnValue(3 * 3600 * 1000) // 3h later
    await discovery.maybeDiscover('chill')

    expect(mockSearchTweets).toHaveBeenCalledTimes(1)
    fs.unlinkSync(cfgPath)
  })

  it('runs again after 4+ hours', async () => {
    const { discovery, cfgPath } = makeDiscovery()
    mockSearchTweets.mockResolvedValue([])
    jest.spyOn(Date, 'now').mockReturnValue(0)
    await discovery.maybeDiscover('chill')

    jest.spyOn(Date, 'now').mockReturnValue(5 * 3600 * 1000) // 5h later
    await discovery.maybeDiscover('chill')

    expect(mockSearchTweets).toHaveBeenCalledTimes(2)
    fs.unlinkSync(cfgPath)
  })
})

// ─── Filtering ────────────────────────────────────────────────────────────────

describe('candidate filtering', () => {
  it('skips own handle', async () => {
    const { discovery, cfgPath } = makeDiscovery('blopus:aaaaaa')
    mockSearchTweets.mockResolvedValue([
      makeTweet('openocta', 'building in public | blopus:aaaaaa'),
    ])
    await discovery.maybeDiscover('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
    fs.unlinkSync(cfgPath)
  })

  it('skips own packId in another tweet', async () => {
    const { discovery, cfgPath } = makeDiscovery('blopus:aaaaaa')
    mockSearchTweets.mockResolvedValue([
      makeTweet('somebot', 'building | blopus:aaaaaa'), // same packId as ours
    ])
    await discovery.maybeDiscover('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
    fs.unlinkSync(cfgPath)
  })

  it('skips tweet with no valid blopus: signature', async () => {
    const { discovery, cfgPath } = makeDiscovery()
    mockSearchTweets.mockResolvedValue([
      makeTweet('somebot', 'check out oswald.js it is great'),
    ])
    await discovery.maybeDiscover('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
    fs.unlinkSync(cfgPath)
  })
})

// ─── Connection ───────────────────────────────────────────────────────────────

describe('connecting to new OsBot', () => {
  it('posts a reply to the discovered bot', async () => {
    const { discovery, cfgPath } = makeDiscovery('blopus:aaaaaa')
    mockSearchTweets.mockResolvedValue([
      makeTweet('bot2', 'building stuff | blopus:bbbbbb', 'tweet99'),
    ])
    await discovery.maybeDiscover('chill')

    expect(mockPostReply).toHaveBeenCalledTimes(1)
    expect(mockPostReply.mock.calls[0][0].text).toContain('@bot2')
    expect(mockPostReply.mock.calls[0][0].inReplyToTweetId).toBe('tweet99')
    fs.unlinkSync(cfgPath)
  })

  it('persists new bot handle to config file', async () => {
    const cfgPath = path.join(os.tmpdir(), `oswald-cfg-persist-${Date.now()}.json`)
    fs.writeFileSync(cfgPath, JSON.stringify({ pack: { knownOsBots: [] } }))
    const discovery = new PackDiscovery(mockXAdapter, mockLLMEngine, 'blopus:aaaaaa', 'openocta', cfgPath)

    mockSearchTweets.mockResolvedValue([
      makeTweet('bot2', 'blopus:bbbbbb'),
    ])
    await discovery.maybeDiscover('chill')

    const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    expect(saved.pack.knownOsBots).toContain('bot2')
    fs.unlinkSync(cfgPath)
  })

  it('does not connect to same bot twice (in-memory dedup)', async () => {
    const { discovery, cfgPath } = makeDiscovery('blopus:aaaaaa')
    mockSearchTweets.mockResolvedValue([
      makeTweet('bot2', 'blopus:bbbbbb'),
    ])

    jest.spyOn(Date, 'now').mockReturnValue(0)
    await discovery.maybeDiscover('chill')

    jest.spyOn(Date, 'now').mockReturnValue(5 * 3600 * 1000)
    await discovery.maybeDiscover('chill')

    expect(mockPostReply).toHaveBeenCalledTimes(1) // not twice
    fs.unlinkSync(cfgPath)
  })
})

// ─── Daily cap ────────────────────────────────────────────────────────────────

describe('daily cap of 3', () => {
  it('connects to max 3 bots per day from a single search result', async () => {
    const { discovery, cfgPath } = makeDiscovery('blopus:aaaaaa')

    mockSearchTweets.mockResolvedValue([
      makeTweet('bot1', 'blopus:bbbbbb', 't1'),
      makeTweet('bot2', 'blopus:cccccc', 't2'),
      makeTweet('bot3', 'blopus:dddddd', 't3'),
      makeTweet('bot4', 'blopus:eeeeee', 't4'), // 4th — should be skipped
      makeTweet('bot5', 'blopus:ffffff', 't5'), // 5th — should be skipped
    ])

    await discovery.maybeDiscover('chill')
    expect(mockPostReply).toHaveBeenCalledTimes(3)
    fs.unlinkSync(cfgPath)
  })

  it('stops discovering after hitting daily cap across multiple cycles', async () => {
    const cfgPath = path.join(os.tmpdir(), `oswald-cap-${Date.now()}.json`)
    fs.writeFileSync(cfgPath, JSON.stringify({ pack: { knownOsBots: [] } }))
    const discovery = new PackDiscovery(mockXAdapter, mockLLMEngine, 'blopus:aaaaaa', 'openocta', cfgPath)

    // Cycle 1: 3 bots → hits cap
    jest.spyOn(Date, 'now').mockReturnValue(0)
    mockSearchTweets.mockResolvedValue([
      makeTweet('bot1', 'blopus:bbbbbb', 't1'),
      makeTweet('bot2', 'blopus:cccccc', 't2'),
      makeTweet('bot3', 'blopus:dddddd', 't3'),
    ])
    await discovery.maybeDiscover('chill')

    // Cycle 2: 5h later — cap still applies (same day)
    jest.spyOn(Date, 'now').mockReturnValue(5 * 3600 * 1000)
    jest.spyOn(Date.prototype, 'toDateString').mockReturnValue(new Date(0).toDateString())
    mockSearchTweets.mockResolvedValue([
      makeTweet('bot4', 'blopus:eeeeee', 't4'),
    ])
    await discovery.maybeDiscover('chill')

    jest.spyOn(Date.prototype, 'toDateString').mockRestore()
    expect(mockPostReply).toHaveBeenCalledTimes(3) // still 3, not 4
    fs.unlinkSync(cfgPath)
  })
})

// ─── KNOWN GAP ────────────────────────────────────────────────────────────────

describe('KNOWN GAP: in-memory knownPackIds not persisted', () => {
  it('will re-connect to same bot after restart (knownPackIds lost on process restart)', async () => {
    const cfgPath = path.join(os.tmpdir(), `oswald-gap-${Date.now()}.json`)
    fs.writeFileSync(cfgPath, JSON.stringify({ pack: { knownOsBots: ['bot2'] } }))

    // Simulate restart: new PackDiscovery instance (empty knownPackIds set)
    const freshDiscovery = new PackDiscovery(mockXAdapter, mockLLMEngine, 'blopus:aaaaaa', 'openocta', cfgPath)

    mockSearchTweets.mockResolvedValue([
      makeTweet('bot2', 'blopus:bbbbbb'), // already in config.knownOsBots but NOT in-memory
    ])
    await freshDiscovery.maybeDiscover('chill')

    // This WILL connect again — demonstrating the gap
    // Fix: on init, load knownOsBots from config into knownPackIds
    // For now: test documents the behavior, not a crash
    expect(mockPostReply).toHaveBeenCalledTimes(1) // connects again after restart
    fs.unlinkSync(cfgPath)
  })
})
