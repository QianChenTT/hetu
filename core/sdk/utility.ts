import { type Plugin, run } from './plugin.ts'
import type { Transport } from './transport.ts'
import { pacedTransport, type WorkerLimits, type WorkerPort } from './worker.ts'

// A utility half's end of its channel: Electron's MessagePortMain inside the utility process, whose message event hands
// over the data and which delivers nothing before start
export type UtilityPort = {
  postMessage(text: string): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  start(): void
}

export type UtilityTransport = Transport & { limit(limits: WorkerLimits): void }

// A utility half's transport: the worker's, JSON text both ways and paced to 90% of the message rate and the byte
// budget, since main counts this port's bytes itself with no relay in front of it. Only text is read from the channel.
// New limits come through limit alone, which the bootstrap calls for what main sends on the process's parent port
export function utilityTransport(port: UtilityPort, limits: WorkerLimits, clock: () => number = () => performance.now()): UtilityTransport {
  const adapted: WorkerPort = { postMessage: text => port.postMessage(text), onmessage: null }
  port.on('message', event => adapted.onmessage?.({ data: event.data }))
  port.start()
  return pacedTransport(adapted, limits, clock, false)
}

// Runs a plugin's host entry in a utility process on the port and at the limits the runtime handed over with its bytes.
// What it gives back takes the limits main sends later
export function runInUtility(plugin: Plugin, port: UtilityPort, limits: WorkerLimits): (limits: WorkerLimits) => void {
  const transport = utilityTransport(port, limits)
  run(plugin, transport, { limits: { messagesPerSecond: limits.messagesPerSecond } })
  return next => transport.limit(next)
}
