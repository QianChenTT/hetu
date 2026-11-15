import { type Plugin, run } from './plugin.ts'
import type { Transport } from './transport.ts'
import { portTransport, type WorkerLimits, type WorkerPort } from './worker.ts'

// A utility half's end of its channel: Electron's MessagePortMain inside the utility process, whose message event hands
// over the data and which delivers nothing before start
export type UtilityPort = {
  postMessage(text: string): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
}

// A utility half's transport: the worker's, JSON text both ways and paced to 90% of the message rate and the byte
// budget, since main counts this port's bytes itself with no relay in front of it
export function utilityTransport(port: UtilityPort, limits: WorkerLimits, clock: () => number = () => performance.now()): Transport {
  const adapted: WorkerPort = { postMessage: text => port.postMessage(text), onmessage: null }
  port.on('message', event => adapted.onmessage?.({ data: event.data }))
  port.start()
  return portTransport(adapted, limits, clock)
}

// Runs a plugin's host entry in a utility process on the port and at the limits the runtime handed over with its bytes
export function runInUtility(plugin: Plugin, port: UtilityPort, limits: WorkerLimits): void {
  run(plugin, utilityTransport(port, limits), { limits: { messagesPerSecond: limits.messagesPerSecond } })
}
