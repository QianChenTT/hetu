import { contextBridge, ipcRenderer } from 'electron'

// The shell's only way to the core: a message sent on the window's channel, and what comes back on it. Nothing else
// crosses the bridge. Only the top frame gets a preload, so a frame in the window has no bridge
contextBridge.exposeInMainWorld('hetu', {
  send: (message: unknown) => ipcRenderer.send('hetu:window', message),
  listen: (listener: (message: unknown) => void) => {
    ipcRenderer.on('hetu:window', (_event, message: unknown) => listener(message))
  },
})
