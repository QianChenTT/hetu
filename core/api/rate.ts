import type { FloorConstant } from './floor.ts'
import { measurePlain } from './measure.ts'

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

// The most a worker's message may weigh: its largest result and the envelope around it. JSON text can run longer than
// the value it holds, six characters for each control character, so a result within resultBytes whose JSON doesn't fit
// fails in the SDK before it is sent
export const messageCap = (limit: (name: FloorConstant) => number): number => limit('resultBytes') + ENVELOPE_ROOM

// What a message costs main to read: the larger of its text's length and what the carrier measures of the value, 8 a
// value and slot and the bytes of each key and string. The measure bounds how many values main builds and the length
// how much text it scans, so a message can't be cheap on one and costly on the other. Not JSON, not plain data, nested
// past MAX_DEPTH or past the cap is refused, none of which the SDK sends. The text is parsed here, in the worker host
// page, so the plugin's own process pays for a message main never reads
export function weigh(text: string, cap: number): { ok: true, weight: number } | { ok: false } {
  if (text.length > cap) return { ok: false }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  const measured = measurePlain(value, cap)
  if (!measured.ok) return { ok: false }
  return { ok: true, weight: Math.max(measured.bytes, text.length) }
}

// A bucket of weight, full at the start so one message of the cap goes through at once
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

// The limits the worker host page's relay applies to a worker's messages, which the page and the SDK in the worker both
// get with the plugin's start
export const RELAY_LIMITS = Object.freeze(['messagesPerSecond', 'floodFactor', 'floodMs', 'bytesPerSecond', 'resultBytes'] as const)
export type RelayLimits = Record<typeof RELAY_LIMITS[number], number>

// Each relay limit as a whole positive number, or null
export function relayLimitsOf(value: unknown): RelayLimits | null {
  if (typeof value !== 'object' || value === null) return null
  const given = value as Record<string, unknown>
  const out: Partial<RelayLimits> = {}
  for (const name of RELAY_LIMITS) {
    const limit = given[name]
    if (!Number.isSafeInteger(limit) || (limit as number) <= 0) return null
    out[name] = limit as number
  }
  return out as RelayLimits
}
