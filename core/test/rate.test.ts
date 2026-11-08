import { describe, expect, it } from 'vitest'
import { floorConstants } from '../api/floor.ts'
import { ENVELOPE_ROOM, newBudget, spend, textCap } from '../api/rate.ts'

const Mi = 1024 * 1024

describe('the text budget', () => {
  it('is 4 Mi characters a second per port, which the human may change like any floor constant', () => {
    expect(floorConstants.textPerSecond).toBe(4 * Mi)
  })

  it('caps one message at the largest result and room for its envelope', () => {
    const limit = (name: keyof typeof floorConstants) => floorConstants[name]
    expect(textCap(limit)).toBe(16 * Mi + ENVELOPE_ROOM)
    expect(textCap(name => (name === 'resultBytes' ? 1000 : floorConstants[name]))).toBe(1000 + ENVELOPE_ROOM)
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
