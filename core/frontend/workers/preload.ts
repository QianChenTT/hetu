import { ipcRenderer } from 'electron'

// The only way between the worker host page and main. A port can't cross the context bridge, so main's starts reach the
// page by window.postMessage, Electron's own pattern for ports with context isolation. What the page sends back is
// copied field by field
ipcRenderer.on('hetu:start', (event, start: object) => window.postMessage({ ...start, hetu: 'start' }, location.origin, event.ports))
ipcRenderer.on('hetu:terminate', (_event, end: object) => window.postMessage({ ...end, hetu: 'terminate' }, location.origin))

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return
  const data = event.data as Record<string, unknown> | null
  if (data?.hetu !== 'to-main') return
  ipcRenderer.send('hetu:page', { kind: data.kind, id: data.id, incarnation: data.incarnation, count: data.count, reason: data.reason })
})
