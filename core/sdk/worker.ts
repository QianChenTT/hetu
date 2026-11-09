import { messageCap, newBudget, type RelayLimits, relayLimitsOf, spend, weigh } from '../api/rate.ts'
import { Editor } from './editor.ts'
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

// What the pacing keeps back from the relay's limits, as the Sender does from the carrier's rate
const SHARE = 0.9

type Held = { text: string, weight: number }

// A worker's transport, and its only pacer: JSON text both ways, since the relay in the page passes nothing else to
// main. A message is weighed as the relay weighs it, and one the relay would cut the plugin off for throws instead, so a
// reply fails on its own. Messages wait in one queue for 90% of both the message rate and the byte budget the relay
// counts, so a backlog never leaves in a burst the relay would drop. A pong goes out at once, ahead of what waits, from
// the 10% kept back, so a busy plugin never reads as unresponsive. Lower limits the page sends down apply from then on
export function portTransport(port: WorkerPort, given: WorkerLimits, clock: () => number = () => performance.now()): Transport {
  let limits = given
  const capOf = () => messageCap(name => limits[name as keyof WorkerLimits])
  const budget = newBudget()
  const times: number[] = []
  const held: Held[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const later = (ms: number) => {
    timer = setTimeout(flush, Math.max(1, Math.ceil(ms)))
  }
  const flush = () => {
    timer = null
    while (held.length > 0) {
      const now = clock()
      while (times.length > 0 && now - times[0] >= 1000) times.shift()
      const most = Math.max(1, Math.floor(limits.messagesPerSecond * SHARE))
      if (times.length >= most) return later(times[0] + 1000 - now)
      const next = held[0]
      const perSecond = limits.bytesPerSecond * SHARE
      if (!spend(budget, now, next.weight, perSecond, capOf())) return later((next.weight - budget.tokens) * 1000 / perSecond)
      held.shift()
      times.push(now)
      port.postMessage(next.text)
    }
  }
  return {
    paces: true,
    post(message) {
      const text = JSON.stringify(message)
      if (typeof text !== 'string') throw new Error('invalid: the message is not JSON')
      const weighed = weigh(text, capOf())
      if (!weighed.ok) throw new Error('too-large: the relay would refuse the message')
      if ((message as { kind?: unknown }).kind === 'pong') {
        port.postMessage(text)
        return
      }
      held.push({ text, weight: weighed.weight })
      if (timer === null) flush()
    },
    listen(listener) {
      port.onmessage = ({ data }) => {
        if (typeof data !== 'string') {
          // The page's only message of its own: the plugin's limits, lowered
          const sent = data as { v?: unknown, kind?: unknown, limits?: unknown } | null
          const lowered = relayLimitsOf(sent?.limits)
          if (sent?.v === 1 && sent.kind === 'limits' && lowered !== null) limits = lowered
          return
        }
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

// Runs a plugin in a worker. The worker host page sends { v: 1, kind: 'port' } carrying the worker's end of its channel
// and the plugin's limits, once. Anything before it is ignored. After it, each { v: 1, kind: 'drawer' } carries a port to
// an editor page's drawer, which the editor bridge takes in place of the last. The plugin build calls this for each
// worker entry
export function runInWorker(plugin: Plugin, scope: WorkerScope = globalThis as unknown as WorkerScope): void {
  let held: WorkerLimits | null = null
  const editor = new Editor()
  scope.onmessage = event => {
    const data = event.data as { v?: unknown, kind?: unknown, limits?: unknown } | null
    const port = event.ports[0] as WorkerPort | undefined
    if (data?.v !== 1 || port === undefined) return
    if (held === null) {
      const limits = relayLimitsOf(data.limits)
      if (data.kind !== 'port' || limits === null) return
      held = limits
      run(plugin, portTransport(port, limits), { limits: { messagesPerSecond: limits.messagesPerSecond }, editor })
      return
    }
    if (data.kind === 'drawer') editor.connect(portTransport(port, held))
  }
}
