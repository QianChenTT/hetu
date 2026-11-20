import type { MessagePortMain } from 'electron'
import type { LimitName } from '../../api/limits.ts'
import { measurePlain } from '../../api/measure.ts'
import { messageCap, newBudget, spend } from '../../api/rate.ts'
import type { Port } from '../router/header.ts'
import type { Runtime, WorkerStart } from './header.ts'

// A MessagePortMain as the router reads a port. A worker's messages reach main only through the relay in the worker
// host page, which forwards nothing but text within the plugin's cap, so the port reads only that and parses it.
// Anything else is read as a message it can't read, its ports closed, so a half holds no channel but its own. What the
// router sends goes as text too. bytesPerSecond is for a utility half's port, which no relay stands in front of: each
// message is weighed as the relay weighs one, the larger of its length and what the router measures of it, and one
// over the budget is read as a message it can't read, which the router still counts against the rate and drops. The
// message has reached main whole by then, as every message does before it can be measured
function asPort(port: MessagePortMain, cap: () => number, bytesPerSecond: (() => number) | null = null): Port {
  const unreadable: ((value: unknown) => void)[] = []
  const budget = newBudget()
  const refuse = () => {
    for (const told of unreadable) told(undefined)
  }
  return {
    postMessage: message => port.postMessage(JSON.stringify(message)),
    start: () => port.start(),
    close: () => port.close(),
    on(event, listener) {
      if (event === 'messageerror') {
        unreadable.push(listener)
      } else if (event === 'close') {
        port.on('close', () => listener(undefined))
      } else {
        port.on('message', ({ data, ports }) => {
          for (const passed of ports) passed.close()
          if (ports.length > 0 || typeof data !== 'string' || data.length > cap()) return refuse()
          let value: unknown
          try {
            value = JSON.parse(data)
          } catch {
            return refuse()
          }
          if (bytesPerSecond !== null) {
            const measured = measurePlain(value, cap())
            if (!measured.ok) return refuse()
            if (!spend(budget, performance.now(), Math.max(measured.bytes, data.length), bytesPerSecond(), cap())) return refuse()
          }
          listener(value)
        })
      }
    },
  }
}

// The plugins manager's runtime on Electron. Workers start and end in the hidden renderer. A utility half forks through
// the utility runtime. limit is the router's: a limit as it applies to one plugin
export function electronRuntime(
  channel: () => { port1: MessagePortMain, port2: MessagePortMain },
  workers: Pick<Runtime, 'terminate'> & { start(start: WorkerStart): void },
  limit: (plugin: string, name: LimitName) => number,
  utility: Pick<Runtime, 'startUtility' | 'kill'>,
): Runtime {
  return {
    channel(id, counted = false) {
      const { port1, port2 } = channel()
      const bytes = counted ? () => limit(id, 'bytesPerSecond') : null
      return { core: asPort(port1, () => messageCap(name => limit(id, name)), bytes), plugin: port2 }
    },
    startWorker(start) {
      workers.start(start)
    },
    terminate(id, incarnation) {
      workers.terminate(id, incarnation)
    },
    startUtility(start) {
      utility.startUtility(start)
    },
    kill(id, incarnation) {
      utility.kill(id, incarnation)
    },
  }
}
