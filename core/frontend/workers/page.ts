import { WorkerHost } from './host.ts'

// The prelude's source, put in by the build
declare const PRELUDE: string

const toMain = (message: object) => window.postMessage({ ...message, hetu: 'to-main' }, location.origin)

const host = new WorkerHost({
  prelude: PRELUDE,
  spawn: (url, name) => new Worker(url, { name }),
  report: toMain,
})

// Only the preload posts to this window: main's starts and ends, each start with the worker's port
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return
  const data = event.data as { hetu?: unknown, id?: unknown, incarnation?: unknown } | null
  if (data?.hetu === 'start') host.start(data, event.ports[0])
  else if (data?.hetu === 'terminate') host.terminate(data.id, data.incarnation)
})

setInterval(() => host.flush(), 1000)
toMain({ kind: 'ready' })
