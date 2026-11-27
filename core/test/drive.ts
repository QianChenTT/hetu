// What the end-to-end tests and tier 0 both do to a running hetu from outside
import type { ElectronApplication } from 'playwright'

// Keeps a hidden run out of the person's way, as the first call after the launch. macOS still brings hetu to the front
// on its own focus() of a hidden window, so the app may never become the active one there. Every window lets the mouse
// pass through, so a click on the spot a see-through window covers reaches what the person sees. Playwright's input
// goes through the pages, and its focus emulation answers focus questions there
export const quiet = (app: ElectronApplication) => app.evaluate(({ app, BrowserWindow }) => {
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  const passThrough = (window: InstanceType<typeof BrowserWindow>) => window.setIgnoreMouseEvents(true)
  for (const window of BrowserWindow.getAllWindows()) passThrough(window)
  app.on('browser-window-created', (_event, window) => passThrough(window))
})
