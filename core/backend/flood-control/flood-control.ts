import type { LimitName } from '../../api/limits.ts'
import { countMessage, newRate, type Rate } from '../../api/rate.ts'
import type { Charged, Counted, FloodControl, FloodControlOptions, Held } from './header.ts'

// Flood control: each way's messages against its rate and its flood cap before the carrier reads them, and each caller's
// calls and bytes in flight, charged to the caller and to the root of its chain, once a call parsed. A count lives as
// long as its way or its calls do
export function createFloodControl(options: FloodControlOptions): FloodControl {
  const rates = new WeakMap<Counted, Rate>()
  const inflight = new Map<string, { calls: number, bytes: number }>()
  const released = new WeakSet<Held>()
  return {
    admit(way) {
      let rate = rates.get(way)
      if (rate === undefined) {
        rate = newRate()
        rates.set(way, rate)
      }
      return countMessage(rate, options.clock(), name => options.limit(way.plugin, name))
    },

    acquire(caller: Charged, root: Charged, bytes: number): Held | null {
      const charged = root.principal === caller.principal ? [caller] : [caller, root]
      for (const { principal, plugin } of charged) {
        const load = inflight.get(principal) ?? { calls: 0, bytes: 0 }
        if (load.calls + 1 > options.limit(plugin, 'callsInFlight')) return null
        if (load.bytes + bytes > options.limit(plugin, 'bytesInFlight')) return null
      }
      for (const { principal } of charged) {
        const load = inflight.get(principal) ?? { calls: 0, bytes: 0 }
        load.calls++
        load.bytes += bytes
        inflight.set(principal, load)
      }
      return Object.freeze({ principals: Object.freeze(charged.map(one => one.principal)), bytes })
    },

    // Once per acquire, so a call that ends twice frees its room once
    release(held) {
      if (released.has(held)) return
      released.add(held)
      for (const principal of held.principals) {
        const load = inflight.get(principal)
        if (load === undefined) continue
        load.calls--
        load.bytes -= held.bytes
        if (load.calls <= 0) inflight.delete(principal)
      }
    },
  }
}

// The limits that pace a plugin's messages before main reads them, in the relay of the worker host page, in a utility
// half's own transport and on main's end of a utility half's port
const pacing: ReadonlySet<LimitName> = new Set(['messagesPerSecond', 'bytesPerSecond'])

// A limit as the pacing of a plugin's messages takes it: the limit while flood control runs, no bound while the human
// has it off. The numbers of one call, the cap of a message among them, stay
export function pacedLimit(limit: (plugin: string, name: LimitName) => number, off: () => boolean): (plugin: string, name: LimitName) => number {
  return (plugin, name) => (pacing.has(name) && off() ? Number.MAX_SAFE_INTEGER : limit(plugin, name))
}
