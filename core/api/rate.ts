import type { FloorConstant } from './floor.ts'

// One way in's messages against its rate and its flood cap, in fixed windows of a second and of floodMs. floodCap is
// the cap the flood window started with
export type Rate = { second: number, inSecond: number, floodStart: number, inFlood: number, floodCap: number, dropped: number, toldAt: number }

export function newRate(): Rate {
  return {
    second: Number.NEGATIVE_INFINITY,
    inSecond: 0,
    floodStart: Number.NEGATIVE_INFINITY,
    inFlood: 0,
    floodCap: 0,
    dropped: 0,
    toldAt: Number.NEGATIVE_INFINITY,
  }
}

// Every message counts, dropped ones too, since main has already read each one. One over the rate is a drop. A flood
// is more than floodFactor times the rate on average across a window of floodMs. A clock that went back starts the
// windows again. A lowered rate drops at once but reaches the flood cap only with the next window, so messages sent
// under the old rate never count as a flood under the new one
export function countMessage(rate: Rate, now: number, limit: (name: FloorConstant) => number): 'pass' | 'drop' | 'flood' {
  const perSecond = limit('messagesPerSecond')
  const floodMs = limit('floodMs')
  if (now - rate.second >= 1000 || now < rate.second) {
    rate.second = now
    rate.inSecond = 0
  }
  if (now - rate.floodStart >= floodMs || now < rate.floodStart) {
    rate.floodStart = now
    rate.inFlood = 0
    rate.floodCap = limit('floodFactor') * perSecond * floodMs / 1000
  }
  rate.inSecond++
  rate.inFlood++
  if (rate.inFlood > rate.floodCap) return 'flood'
  return rate.inSecond > perSecond ? 'drop' : 'pass'
}

// Room for the envelope around the largest result
export const ENVELOPE_ROOM = 64 * 1024

// The longest text a worker may send in one message: its largest result and the envelope around it. A string's length
// in UTF-16 units is never more than its UTF-8 bytes, so no message within the result cap is cut
export const textCap = (limit: (name: FloorConstant) => number): number => limit('resultBytes') + ENVELOPE_ROOM

// A bucket of characters, full at the start so one message of the cap goes through at once
export type Budget = { tokens: number, at: number }

export function newBudget(): Budget {
  return { tokens: Number.POSITIVE_INFINITY, at: Number.NEGATIVE_INFINITY }
}

// Takes size from a bucket that refills at perSecond and holds at most cap. False when it doesn't fit, and the
// message then takes nothing. A clock that went back refills from now on
export function spend(budget: Budget, now: number, size: number, perSecond: number, cap: number): boolean {
  if (now >= budget.at) budget.tokens = Math.min(cap, budget.tokens + (now - budget.at) * perSecond / 1000)
  budget.at = now
  if (size > budget.tokens) return false
  budget.tokens -= size
  return true
}
