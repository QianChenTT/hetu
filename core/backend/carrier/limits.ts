import { defaultLimits, type LimitName } from '../../api/limits.ts'
import type { HumanLimits } from './header.ts'

// A value the state gave, read only when the table holds it as its own and it is a positive whole number
function own(values: unknown, name: string): unknown {
  if (typeof values !== 'object' || values === null || !Object.hasOwn(values, name)) return undefined
  return (values as Record<string, unknown>)[name]
}

function positive(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined
}

// The limits as they apply to one plugin: the human's value for that plugin, else the human's value for all,
// else core/api's. A window's own way never runs below the fixed value, so a value for all lowered by mistake can't lock
// the trusted window out. The core-wide constants, the audit queue, the core record backlog and logFailMs, follow the
// human either way
const coreWide: ReadonlySet<LimitName> = new Set(['auditQueue', 'floorBacklog', 'logFailMs'])

export class Limits {
  private readonly human: () => HumanLimits

  constructor(human: () => HumanLimits) {
    this.human = human
  }

  // plugin null for a window, which only the human's values for all reach
  of(plugin: string | null, name: LimitName): number {
    let human: HumanLimits | null = null
    try {
      human = this.human()
    } catch {}
    const mine = plugin === null ? undefined : positive(own(own(human?.plugins, plugin), name))
    const all = positive(own(human?.all, name))
    if (plugin === null && !coreWide.has(name)) return Math.max(all ?? 0, defaultLimits[name])
    return mine ?? all ?? defaultLimits[name]
  }
}
