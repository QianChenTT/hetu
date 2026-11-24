import { contextBridge, ipcRenderer } from 'electron'

// The shell's only way to the core: a message sent on the window's channel, and what comes back on it. Nothing else
// crosses the bridge. Only the top frame gets a preload, so a frame in the window has no bridge
contextBridge.exposeInMainWorld('hetu', {
  send: (message: unknown) => ipcRenderer.send('hetu:window', message),
  listen: (listener: (message: unknown) => void) => {
    ipcRenderer.on('hetu:window', (_event, message: unknown) => listener(message))
  },
})

// A plugin worker's port to the drawer and its end, from main only, named with the plugin and its incarnation. A port
// can't cross the context bridge, so it reaches the page by window.postMessage, as in the worker host page
ipcRenderer.on('hetu:drawer', (event, named: { plugin?: unknown, incarnation?: unknown }) => {
  window.postMessage({ hetu: 'drawer', plugin: named.plugin, incarnation: named.incarnation }, location.origin, event.ports)
})
// A core key main took from the window's input before it reached any frame
ipcRenderer.on('hetu:key', (_event, key: unknown) => {
  window.postMessage({ hetu: 'key', key }, location.origin)
})
// A key a plugin's views bound that main took while focus was in one of that plugin's frames, with the frame's URL
ipcRenderer.on('hetu:view-key', (_event, pressed: { url?: unknown, key?: unknown }) => {
  window.postMessage({ hetu: 'view-key', url: pressed.url, key: pressed.key }, location.origin)
})
// Main moving focus into the frame served from that URL
ipcRenderer.on('hetu:focus-frame', (_event, asked: { url?: unknown }) => {
  window.postMessage({ hetu: 'focus-frame', url: asked.url }, location.origin)
})
// Each press and release in the window, a frame's included, at its point on the page, as main saw it
ipcRenderer.on('hetu:press', (_event, press: unknown) => {
  window.postMessage({ hetu: 'press', press }, location.origin)
})
// The page's word to main of the frame it let focus into, null for none, so main drops keys headed for any other frame.
// Only the page's own message, never a frame's
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return
  const data = event.data as { hetu?: unknown, url?: unknown } | null
  if (data?.hetu !== 'focus-let-in') return
  ipcRenderer.send('hetu:focus-let-in', { url: typeof data.url === 'string' ? data.url : null })
})
ipcRenderer.on('hetu:drawer-end', (_event, named: { plugin?: unknown, incarnation?: unknown }) => {
  window.postMessage({ hetu: 'drawer-end', plugin: named.plugin, incarnation: named.incarnation }, location.origin)
})
