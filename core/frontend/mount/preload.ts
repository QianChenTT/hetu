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
ipcRenderer.on('hetu:drawer-end', (_event, named: { plugin?: unknown, incarnation?: unknown }) => {
  window.postMessage({ hetu: 'drawer-end', plugin: named.plugin, incarnation: named.incarnation }, location.origin)
})
