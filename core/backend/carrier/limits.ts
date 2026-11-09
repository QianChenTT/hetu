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
