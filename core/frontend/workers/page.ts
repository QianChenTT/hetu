import { type PortLike, WorkerHost } from './host.ts'

// The prelude's source, put in by the build
declare const PRELUDE: string

const toMain = (message: object) => window.postMessage({ ...message, hetu: 'to-main' }, location.origin)

// A DOM port has the shape the logic uses, with a wider event than it reads
const asPort = (port: MessagePort | undefined) => port as unknown as PortLike | undefined

const host = new WorkerHost({
  prelude: PRELUDE,
  spawn: (url, name) => new Worker(url, { name }),
  report: toMain,
  channel: () => {
    const channel = new MessageChannel()
    return { port1: asPort(channel.port1)!, port2: asPort(channel.port2)! }
  },
})

// Only the preload posts to this window: main's starts and ends, each start with main's end of the plugin's channel, and
// each worker's port to the editor page's drawer
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return
  const data = event.data as { hetu?: unknown, id?: unknown, incarnation?: unknown, limits?: unknown } | null
  if (data?.hetu === 'start') host.start(data, asPort(event.ports[0]))
  else if (data?.hetu === 'terminate') host.terminate(data.id, data.incarnation)
  else if (data?.hetu === 'limits') host.relimit(data.id, data.incarnation, data.limits)
  else if (data?.hetu === 'drawer') host.drawer(data.id, data.incarnation, asPort(event.ports[0]))
})

setInterval(() => host.flush(), 1000)
toMain({ kind: 'ready' })
