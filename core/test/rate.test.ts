import { describe, expect, it } from 'vitest'
import { defaultLimits } from '../api/limits.ts'
import { countMessage, ENVELOPE_ROOM, messageCap, newBudget, newRate, spend, weigh } from '../api/rate.ts'

const Mi = 1024 * 1024

describe('the text budget', () => {
  it('is 4 MiB a second per port, as the carrier measures a value, which the human may change like any limit', () => {
    expect(defaultLimits.bytesPerSecond).toBe(4 * Mi)
  })

  it('caps one message at the largest result and room for its envelope', () => {
    const limit = (name: keyof typeof defaultLimits) => defaultLimits[name]
    expect(messageCap(limit)).toBe(16 * Mi + ENVELOPE_ROOM)
    expect(messageCap(name => (name === 'resultBytes' ? 1000 : defaultLimits[name]))).toBe(1000 + ENVELOPE_ROOM)
  })

  it('lets one message of the cap through at once, then refills at its rate', () => {
    const budget = newBudget()
    const cap = 16 * Mi
    const rate = 4 * Mi
    expect(spend(budget, 0, cap, rate, cap)).toBe(true)
    expect(spend(budget, 0, 1, rate, cap)).toBe(false)
    expect(spend(budget, 500, 2 * Mi + 1, rate, cap)).toBe(false)
    expect(spend(budget, 500, 2 * Mi, rate, cap)).toBe(true)
    expect(spend(budget, 500, 1, rate, cap)).toBe(false)
  })

  it('never holds more than the cap, however long it rested', () => {
    const budget = newBudget()
    expect(spend(budget, 0, 10, 100, 50)).toBe(true)
    expect(spend(budget, 1_000_000, 51, 100, 50)).toBe(false)
    expect(spend(budget, 1_000_000, 50, 100, 50)).toBe(true)
  })

  it('takes nothing for a message it refuses', () => {
    const budget = newBudget()
    expect(spend(budget, 0, 60, 100, 50)).toBe(false)
    expect(spend(budget, 0, 50, 100, 50)).toBe(true)
  })

  it('starts again from now when the clock went back', () => {
    const budget = newBudget()
    expect(spend(budget, 1000, 50, 100, 50)).toBe(true)
    expect(spend(budget, 400, 10, 100, 50)).toBe(false)
    expect(spend(budget, 500, 10, 100, 50)).toBe(true)
  })
})

describe('weighing a message', () => {
  it('weighs JSON text by the larger of what the carrier measures and its length', () => {
    // A string the carrier measures at 8 and its 3 bytes, 5 characters long
    expect(weigh('"abc"', 1000)).toEqual({ ok: true, weight: 11 })
    // Two empty objects: the array's 8, its two slots' 16, its keys 0 and 1 and the objects' 16, against 7 characters
    expect(weigh('[{},{}]', 1000)).toEqual({ ok: true, weight: 42 })
    // Ten control characters: measured 18, but escaped to 62 characters
    expect(weigh(JSON.stringify('\u0001'.repeat(10)), 1000)).toEqual({ ok: true, weight: 62 })
  })

  it('refuses text that isn\'t JSON, isn\'t plain data, nests past the carrier\'s depth or weighs past the cap', () => {
    const nested = (depth: number) => '['.repeat(depth) + ']'.repeat(depth)
    expect(weigh(nested(64), 10_000).ok).toBe(true)
    expect(weigh(nested(65), 10_000).ok).toBe(false)
    for (const text of ['x', '{"__proto__":1}', '{"constructor":1}', nested(65), JSON.stringify('x'.repeat(100)), 'x'.repeat(101)]) {
      expect(weigh(text, 100).ok, text.slice(0, 20)).toBe(false)
    }
  })
})

describe('the message count', () => {
  const at = (perSecond: number, floodMs = 5000, floodFactor = 10) =>
    (name: string) => ({ messagesPerSecond: perSecond, floodMs, floodFactor } as Record<string, number>)[name]

  it('passes the rate, drops one over it and starts again each second', () => {
    const rate = newRate()
    const limit = at(3)
    expect([0, 1, 2, 3].map(() => countMessage(rate, 1000, limit))).toEqual(['pass', 'pass', 'pass', 'drop'])
    expect(countMessage(rate, 1999, limit)).toBe('drop')
    expect(countMessage(rate, 2000, limit)).toBe('pass')
  })

  it('calls more than the flood factor times the rate across the flood window a flood', () => {
    const rate = newRate()
    const limit = at(2, 1000, 10)
    const verdicts = Array.from({ length: 21 }, () => countMessage(rate, 5000, limit))
    expect(verdicts.slice(0, 20).includes('flood')).toBe(false)
    expect(verdicts[20]).toBe('flood')
  })

  it('starts both windows again when the clock goes back', () => {
    const rate = newRate()
    const limit = at(1)
    expect(countMessage(rate, 5000, limit)).toBe('pass')
    expect(countMessage(rate, 4000, limit)).toBe('pass')
  })

  // A flood cap of 2 in the cases below, so only the flood window decides
  it('starts the flood window again when the clock goes back', () => {
    const rate = newRate()
    const limit = at(2, 1000, 1)
    expect([5000, 5000, 4999].map(now => countMessage(rate, now, limit))).toEqual(['pass', 'pass', 'pass'])
  })

  it('ends the flood window after exactly floodMs', () => {
    const rate = newRate()
    const limit = at(2, 1000, 1)
    expect([5000, 5000, 6000].map(now => countMessage(rate, now, limit))).toEqual(['pass', 'pass', 'pass'])
  })

  it('judges a flood window against the cap it started with, so a lowered rate drops at once and floods only from the next window', () => {
    const rate = newRate()
    const limits: Record<string, number> = { messagesPerSecond: 200, floodMs: 5000, floodFactor: 10 }
    const limit = (name: string) => limits[name]
    // 600 messages over 3 s, under every rate in force when each was sent
    for (const now of [0, 1000, 2000]) {
      for (let i = 0; i < 200; i++) expect(countMessage(rate, now, limit)).toBe('pass')
    }
    limits.messagesPerSecond = 10
    expect(countMessage(rate, 2500, limit)).toBe('drop')
    expect(countMessage(rate, 3000, limit)).toBe('pass')
    // The next window takes the cap of 10 times 10 a second for 5 s
    const verdicts = Array.from({ length: 501 }, () => countMessage(rate, 5000, limit))
    expect(verdicts.slice(0, 500).includes('flood')).toBe(false)
    expect(verdicts[500]).toBe('flood')
  })
})
