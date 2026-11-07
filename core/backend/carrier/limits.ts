import { floorConstants, type FloorConstant } from '../../api/floor.ts'
import type { HumanLimits } from './seams.ts'

// A value the state gave, read only when the table holds it as its own and it is a positive whole number
function own(values: unknown, name: string): unknown {
  if (typeof values !== 'object' || values === null || !Object.hasOwn(values, name)) return undefined
  return (values as Record<string, unknown>)[name]
}

function positive(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined
}

// The floor constants as they apply to one plugin: the human's value for that plugin, else the human's value for all,
// else core/api's. The watchdog may only lower what that gives, never past it
export class Limits {
  private readonly human: () => HumanLimits
  private readonly lowered = new Map<string, Map<FloorConstant, number>>()

  constructor(human: () => HumanLimits) {
    this.human = human
  }

  // plugin null for a window, which only the human's values for all reach
  of(plugin: string | null, name: FloorConstant): number {
    let human: HumanLimits | null = null
    try {
      human = this.human()
    } catch {}
    const mine = plugin === null ? undefined : positive(own(own(human?.plugins, plugin), name))
    const set = mine ?? positive(own(human?.all, name)) ?? floorConstants[name]
    const lowered = plugin === null ? undefined : this.lowered.get(plugin)?.get(name)
    return lowered === undefined ? set : Math.min(set, lowered)
  }

  // The watchdog's newest value for one plugin replaces its last one. Above the human's or the floor's value it has no
  // effect, so the watchdog can take back a lowering but never raise
  lower(plugin: string, name: FloorConstant, value: number): void {
    let mine = this.lowered.get(plugin)
    if (mine === undefined) {
      mine = new Map()
      this.lowered.set(plugin, mine)
    }
    mine.set(name, value)
  }
}

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
