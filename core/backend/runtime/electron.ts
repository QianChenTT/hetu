import type { MessagePortMain } from 'electron'
import type { FloorConstant } from '../../api/floor.ts'
import { textCap } from '../../api/rate.ts'
import type { Port } from '../carrier/seams.ts'
import type { Runtime, WorkerStart } from '../loader/seams.ts'
import { type HostLoading, loadHost } from './hosts.ts'

// A MessagePortMain as the carrier reads a port. A worker's messages reach main only through the relay in the worker
// host page, which forwards nothing but text within the plugin's cap, so the port reads only that and parses it.
// Anything else is read as a message it can't read, its ports closed, so a half holds no channel but its own. What the
// carrier sends goes as text too
function asPort(port: MessagePortMain, cap: () => number): Port {
  const unreadable: ((value: unknown) => void)[] = []
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
          listener(value)
        })
      }
    },
  }
}

// The loader's runtime on Electron. Workers start and end in the hidden renderer. A host half loads from the bytes the
// loader hashed, the built-ins frozen once before the first one. limit is the carrier's: a floor constant as it applies
// to one plugin
export function electronRuntime(
  channel: () => { port1: MessagePortMain, port2: MessagePortMain },
  workers: Pick<Runtime, 'terminate'> & { start(start: WorkerStart): void },
  limit: (plugin: string, name: FloorConstant) => number,
  hosts: HostLoading,
): Runtime {
  let frozen = false
  const loading: HostLoading = {
    freeze() {
      if (frozen) return
      frozen = true
      hosts.freeze()
    },
    importer: hosts.importer,
  }
  return {
    channel(id) {
      const { port1, port2 } = channel()
      return { core: asPort(port1, () => textCap(name => limit(id, name))), plugin: port2 }
    },
    startWorker(start) {
      workers.start(start)
    },
    startHost(start) {
      return loadHost(start, loading)
    },
    terminate(id, incarnation) {
      workers.terminate(id, incarnation)
    },
  }
}
