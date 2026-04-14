/**
 * ownerDefender.test.ts
 *
 * Tests OwnerDefender logic without hitting real X or Anthropic API.
 * Mocks: XAdapter (playwright.searchTweets, postReply), LLMReplyEngine, Anthropic
 *
 * Scenarios covered:
 *  - Skips check if cooldown not elapsed
 *  - Skips own handle and bot handle in replies
 *  - Calls isHostile and defends when hostile
 *  - Does NOT defend friendly replies
 *  - Daily cap of 5 — stops after that
 *  - Same tweet not defended twice (dedup)
 *  - Resets counter on new day
 */

import { OwnerDefender } from '../agent/OwnerDefender'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSearchTweets = jest.fn()
const mockPostReply = jest.fn()

const mockXAdapter = {
  playwright: {
    searchTweets: mockSearchTweets,
  },
  postReply: mockPostReply,
} as any

const mockGenerateViralReply = jest.fn()
const mockLLMEngine = {
  generateViralReply: mockGenerateViralReply,
} as any

// Mock Anthropic so isHostile() doesn't call real API
jest.mock('@anthropic-ai/sdk', () => {
  const mockCreate = jest.fn()
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    _mockCreate: mockCreate,
  }
})

function getAnthropicMock() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@anthropic-ai/sdk')
  return mod._mockCreate as jest.Mock
}

function makeTweet(id: string, handle: string, text: string) {
  return { tweetId: id, authorHandle: handle, text, likes: 0 }
}

function makeDefender() {
  return new OwnerDefender(mockXAdapter, mockLLMEngine, 'shoryaDs7', 'openocta', 'test-key')
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
})

describe('cooldown gate', () => {
  it('skips check if called twice within 20 minutes', async () => {
    const defender = makeDefender()
    // First call passes cooldown (lastCheckAt = 0)
    mockSearchTweets.mockResolvedValue([])
    await defender.maybeDefend('chill')
    expect(mockSearchTweets).toHaveBeenCalledTimes(1)

    // Second call immediately after — cooldown not elapsed
    await defender.maybeDefend('chill')
    expect(mockSearchTweets).toHaveBeenCalledTimes(1) // no additional calls
  })
})

describe('handle filtering', () => {
  it('skips reply from owner themselves', async () => {
    const defender = makeDefender()
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'my own tweet')])  // owner tweets
      .mockResolvedValueOnce([makeTweet('r1', 'shoryaDs7', 'i replied to myself')])  // replies
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })

    await defender.maybeDefend('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
  })

  it('skips reply from the bot itself', async () => {
    const defender = makeDefender()
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'owner tweet')])
      .mockResolvedValueOnce([makeTweet('r1', 'openocta', 'bot already replied')])
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })

    await defender.maybeDefend('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
  })
})

describe('hostile detection and defense', () => {
  it('defends against hostile reply', async () => {
    const defender = makeDefender()
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'my tweet')])
      .mockResolvedValueOnce([makeTweet('r1', 'hater123', 'you are a fraud @shoryaDs7')])
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })
    mockGenerateViralReply.mockResolvedValue('That claim has no basis.')

    await defender.maybeDefend('chill')

    expect(mockPostReply).toHaveBeenCalledTimes(1)
    expect(mockPostReply.mock.calls[0][0].text).toContain('@hater123')
    expect(mockPostReply.mock.calls[0][0].inReplyToTweetId).toBe('r1')
  })

  it('does NOT defend friendly reply', async () => {
    const defender = makeDefender()
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'my tweet')])
      .mockResolvedValueOnce([makeTweet('r1', 'fan123', 'great work man!')])
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'NO' }] })

    await defender.maybeDefend('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
  })

  it('skips defense if LLM generates no reply text', async () => {
    const defender = makeDefender()
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'my tweet')])
      .mockResolvedValueOnce([makeTweet('r1', 'hater123', 'you suck')])
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })
    mockGenerateViralReply.mockResolvedValue(null) // LLM returned nothing

    await defender.maybeDefend('chill')
    expect(mockPostReply).not.toHaveBeenCalled()
  })
})

describe('daily cap', () => {
  it('stops defending after 5 defenses per day', async () => {
    const defender = makeDefender()

    for (let i = 0; i < 7; i++) {
      // Reset cooldown hack — set lastCheckAt to 0 by creating fresh calls
      // Each call needs to pass cooldown — we do this by fast-forwarding time via Date mock
      jest.spyOn(Date, 'now').mockReturnValue(i * 25 * 60 * 1000) // 25 min apart
      mockSearchTweets
        .mockResolvedValueOnce([makeTweet(`t${i}`, 'shoryaDs7', 'my tweet')])
        .mockResolvedValueOnce([makeTweet(`r${i}`, `hater${i}`, 'attack!')])
      getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })
      mockGenerateViralReply.mockResolvedValue('Defense reply.')
      await defender.maybeDefend('chill')
    }

    jest.spyOn(Date, 'now').mockRestore()
    // Only 5 defenses max
    expect(mockPostReply).toHaveBeenCalledTimes(5)
  })
})

describe('deduplication', () => {
  it('does not defend the same tweet twice', async () => {
    const defender = makeDefender()

    // First call — defends r1
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'my tweet')])
      .mockResolvedValueOnce([makeTweet('r1', 'hater123', 'attack!')])
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })
    mockGenerateViralReply.mockResolvedValue('Defense.')
    await defender.maybeDefend('chill')

    // Second call (25 min later) — same reply r1 appears again
    jest.spyOn(Date, 'now').mockReturnValue(25 * 60 * 1000)
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t1', 'shoryaDs7', 'my tweet')])
      .mockResolvedValueOnce([makeTweet('r1', 'hater123', 'attack!')])  // same tweetId
    await defender.maybeDefend('chill')

    jest.spyOn(Date, 'now').mockRestore()
    expect(mockPostReply).toHaveBeenCalledTimes(1) // not twice
  })
})

describe('day reset', () => {
  it('resets defensesToday on new day', async () => {
    const defender = makeDefender()

    // Fill up today's cap
    for (let i = 0; i < 5; i++) {
      jest.spyOn(Date, 'now').mockReturnValue(i * 25 * 60 * 1000)
      jest.spyOn(Date.prototype, 'toDateString').mockReturnValue('Mon Jan 01 2026')
      mockSearchTweets
        .mockResolvedValueOnce([makeTweet(`t${i}`, 'shoryaDs7', 'tweet')])
        .mockResolvedValueOnce([makeTweet(`r${i}`, `h${i}`, 'attack')])
      getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })
      mockGenerateViralReply.mockResolvedValue('Defense.')
      await defender.maybeDefend('chill')
    }
    expect(mockPostReply).toHaveBeenCalledTimes(5)

    // New day — cap resets
    jest.spyOn(Date, 'now').mockReturnValue(6 * 25 * 60 * 1000)
    jest.spyOn(Date.prototype, 'toDateString').mockReturnValue('Tue Jan 02 2026')
    mockSearchTweets
      .mockResolvedValueOnce([makeTweet('t99', 'shoryaDs7', 'tweet')])
      .mockResolvedValueOnce([makeTweet('r99', 'newHater', 'attack')])
    getAnthropicMock().mockResolvedValue({ content: [{ text: 'YES' }] })
    mockGenerateViralReply.mockResolvedValue('Defense.')
    await defender.maybeDefend('chill')

    jest.spyOn(Date, 'now').mockRestore()
    jest.spyOn(Date.prototype, 'toDateString').mockRestore()
    expect(mockPostReply).toHaveBeenCalledTimes(6) // 6th defense went through
  })
})

describe('no playwright — graceful skip', () => {
  it('does nothing if playwright is null', async () => {
    const noPlaywright = { playwright: null, postReply: mockPostReply } as any
    const defender = new OwnerDefender(noPlaywright, mockLLMEngine, 'shoryaDs7', 'openocta', 'key')
    await expect(defender.maybeDefend('chill')).resolves.not.toThrow()
    expect(mockPostReply).not.toHaveBeenCalled()
  })
})
