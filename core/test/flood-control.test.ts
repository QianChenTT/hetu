import { describe, expect, it } from 'vitest'
import { defaultLimits, type LimitName } from '../api/limits.ts'
import { createFloodControl, pacedLimit } from '../backend/flood-control/flood-control.ts'

// Flood control on its own: a way in counted against its rate and its flood cap, a caller's calls and bytes in flight
// against its ceiling, with the limits it is handed
function made(values: Partial<Record<LimitName, number>> = {}, perPlugin: Record<string, Partial<Record<LimitName, number>>> = {}) {
  let now = 1_000_000
  const flood = createFloodControl({
    limit: (plugin, name) => (plugin === null ? undefined : perPlugin[plugin]?.[name]) ?? values[name] ?? defaultLimits[name],
    clock: () => now,
  })
  return { flood, at: (ms: number) => { now = ms } }
}

const caller = (principal: string, plugin: string | null = principal) => ({ principal, plugin })

describe('flood control\'s message count', () => {
  it('passes a way\'s rate, drops one over it and starts again each second', () => {
    const { flood, at } = made({ messagesPerSecond: 3 })
    const way = { plugin: 'search' }
    expect([0, 1, 2, 3].map(() => flood.admit(way))).toEqual(['pass', 'pass', 'pass', 'drop'])
    at(1_001_000)
    expect(flood.admit(way)).toBe('pass')
  })

  it('counts each way on its own, by the way and not by its plugin', () => {
    const { flood } = made({ messagesPerSecond: 1 })
    const one = { plugin: 'search' }
    const other = { plugin: 'search' }
    expect([flood.admit(one), flood.admit(one), flood.admit(other)]).toEqual(['pass', 'drop', 'pass'])
  })

  it('calls more than the flood factor times the rate across the flood window a flood', () => {
    const { flood } = made({ messagesPerSecond: 2, floodMs: 1000, floodFactor: 10 })
    const way = { plugin: 'search' }
    const verdicts = Array.from({ length: 21 }, () => flood.admit(way))
    expect(verdicts.slice(0, 20).includes('flood')).toBe(false)
    expect(verdicts[20]).toBe('flood')
  })

  it('counts a window by the values for windows', () => {
    const { flood } = made({}, { search: { messagesPerSecond: 1 } })
    const window = { plugin: null }
    expect(Array.from({ length: 5 }, () => flood.admit(window))).toEqual(Array(5).fill('pass'))
  })
})

describe('flood control\'s ceiling', () => {
  it('charges the caller and the root of its chain and says no past either one\'s calls in flight', () => {
    const { flood } = made({}, { search: { callsInFlight: 2 }, http: { callsInFlight: 1 } })
    expect(flood.acquire(caller('search'), caller('search'), 10)).not.toBe(null)
    const sub = flood.acquire(caller('scribe'), caller('http'), 10)
    expect(sub).not.toBe(null)
    expect(flood.acquire(caller('scribe'), caller('http'), 10)).toBe(null)
    expect(flood.acquire(caller('search'), caller('search'), 10)).not.toBe(null)
    expect(flood.acquire(caller('search'), caller('search'), 10)).toBe(null)
    flood.release(sub!)
    expect(flood.acquire(caller('scribe'), caller('http'), 10)).not.toBe(null)
  })

  it('says no past the bytes in flight and frees them once released', () => {
    const { flood } = made({ bytesInFlight: 1000 })
    const first = flood.acquire(caller('search'), caller('search'), 600)
    expect(flood.acquire(caller('search'), caller('search'), 600)).toBe(null)
    flood.release(first!)
    expect(flood.acquire(caller('search'), caller('search'), 600)).not.toBe(null)
  })

  it('takes a release once, so a second one frees nothing more', () => {
    const { flood } = made({}, { search: { callsInFlight: 1 } })
    const first = flood.acquire(caller('search'), caller('search'), 0)!
    flood.release(first)
    const second = flood.acquire(caller('search'), caller('search'), 0)
    flood.release(first)
    expect(second).not.toBe(null)
    expect(flood.acquire(caller('search'), caller('search'), 0)).toBe(null)
  })

  it('keeps a window\'s ceiling apart from each plugin\'s', () => {
    const { flood } = made({ callsInFlight: 1 })
    expect(flood.acquire(caller('window:editor:1', null), caller('window:editor:1', null), 0)).not.toBe(null)
    expect(flood.acquire(caller('search'), caller('search'), 0)).not.toBe(null)
  })
})

describe('the pacing of a plugin\'s messages before main reads them', () => {
  it('follows the limits while flood control is on and paces nothing while it is off', () => {
    let off = false
    const paced = pacedLimit((_plugin, name) => defaultLimits[name], () => off)
    expect(paced('search', 'messagesPerSecond')).toBe(defaultLimits.messagesPerSecond)
    off = true
    expect(paced('search', 'messagesPerSecond')).toBe(Number.MAX_SAFE_INTEGER)
    expect(paced('search', 'bytesPerSecond')).toBe(Number.MAX_SAFE_INTEGER)
    // The numbers of one call are no part of flood control
    expect(paced('search', 'resultBytes')).toBe(defaultLimits.resultBytes)
  })
})
