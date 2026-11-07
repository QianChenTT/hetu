import type { MessagePortMain } from 'electron'
import type { Port } from '../carrier/seams.ts'
import type { Runtime } from '../loader/seams.ts'

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

// The loader's runtime on Electron. Workers need the worker host page and host halves need the host loader, neither
// built yet, so both refuse and the loader holds the plugin failed. The install list names none until they are
export function electronRuntime(channel: () => { port1: MessagePortMain, port2: MessagePortMain }): Runtime {
  return {
    channel() {
      const { port1, port2 } = channel()
      return { core: asPort(port1), plugin: port2 }
    },
    startWorker() {
      throw new Error('no worker host page to start a worker in yet')
    },
    startHost() {
      return Promise.reject(new Error('no host loader to start a host half with yet'))
    },
    // Nothing started, so nothing to end
    terminate() {},
  }
}
