import type { MessagePortMain } from 'electron'
import type { Port } from '../carrier/seams.ts'
import type { Runtime, WorkerStart } from '../loader/seams.ts'

// A MessagePortMain as the carrier reads a port: message hands over the data itself, as a Node port does. A message
// carrying ports is read as one that can't be read and its ports are closed, so a half holds no channel but its own
function asPort(port: MessagePortMain): Port {
  const unreadable: ((value: unknown) => void)[] = []
  return {
    postMessage: message => port.postMessage(message),
    start: () => port.start(),
    close: () => port.close(),
    on(event, listener) {
      if (event === 'messageerror') {
        unreadable.push(listener)
      } else if (event === 'close') {
        port.on('close', () => listener(undefined))
      } else {
        port.on('message', ({ data, ports }) => {
          if (ports.length === 0) return listener(data)
          for (const passed of ports) passed.close()
          for (const told of unreadable) told(undefined)
        })
      }
    },
  }
}

// The loader's runtime on Electron. Workers start and end in the hidden renderer. Host halves need the host loader, not
// built yet, so they refuse and the loader holds the plugin failed. The install list names none until they can load
export function electronRuntime(
  channel: () => { port1: MessagePortMain, port2: MessagePortMain },
  workers: Pick<Runtime, 'terminate'> & { start(start: WorkerStart): void },
): Runtime {
  return {
    channel() {
      const { port1, port2 } = channel()
      return { core: asPort(port1), plugin: port2 }
    },
    startWorker(start) {
      workers.start(start)
    },
    startHost() {
      return Promise.reject(new Error('no host loader to start a host half with yet'))
    },
    terminate(id, incarnation) {
      workers.terminate(id, incarnation)
    },
  }
}
