import { newBudget, type RelayLimits, relayLimitsOf, spend, textCap } from '../api/rate.ts'
import { type Plugin, run } from './plugin.ts'
import type { Transport } from './transport.ts'

export type WorkerLimits = RelayLimits

// A worker's end of its channel, a DOM MessagePort in a worker
export type WorkerPort = {
  postMessage(text: string): void
  onmessage: ((event: { data: unknown }) => void) | null
}

// The worker's global as runInWorker uses it
export type WorkerScope = { onmessage: ((event: { data: unknown, ports: readonly unknown[] }) => void) | null }

// What the pacing keeps back from the text budget, as the Sender keeps back from the message rate
const SHARE = 0.9

// A worker's transport: JSON text both ways, since the relay in the page passes nothing else to main. Text past the cap
// throws, so a reply fails on its own rather than get the plugin cut off. Text is held back to 90% of the budget the
// relay counts, in order, so a burst of large messages waits rather than being dropped
export function portTransport(port: WorkerPort, limits: WorkerLimits, clock: () => number = () => performance.now()): Transport {
  const cap = textCap(name => limits[name as keyof WorkerLimits])
  const perSecond = limits.textPerSecond * SHARE
  const budget = newBudget()
  const held: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    while (held.length > 0) {
      const text = held[0]
      if (!spend(budget, clock(), text.length, perSecond, cap)) {
        timer = setTimeout(flush, Math.max(1, Math.ceil((text.length - budget.tokens) * 1000 / perSecond)))
        return
      }
      held.shift()
      port.postMessage(text)
    }
  }
  return {
    post(message) {
      const text = JSON.stringify(message)
      if (typeof text !== 'string' || text.length > cap) throw new Error('too-large: the message is past what the relay takes')
      held.push(text)
      if (timer === null) flush()
    },
    listen(listener) {
      port.onmessage = ({ data }) => {
        if (typeof data !== 'string') return
        let message: unknown
        try {
          message = JSON.parse(data)
        } catch {
          return
        }
        listener(message)
      }
    },
  }
}

// Runs a plugin in a worker. The worker host page sends one message, { v: 1, kind: 'port' } carrying the worker's end of
// its channel and the plugin's limits. Anything before it is ignored. The plugin build calls this for each worker entry
export function runInWorker(plugin: Plugin, scope: WorkerScope = globalThis as unknown as WorkerScope): void {
  scope.onmessage = event => {
    const data = event.data as { v?: unknown, kind?: unknown, limits?: unknown } | null
    const port = event.ports[0] as WorkerPort | undefined
    const limits = relayLimitsOf(data?.limits)
    if (data?.v !== 1 || data.kind !== 'port' || port === undefined || limits === null) return
    scope.onmessage = null
    run(plugin, portTransport(port, limits), { limits: { messagesPerSecond: limits.messagesPerSecond } })
  }
}
