// What the end-to-end tests and tier 0 both do to a running hetu from outside: a page's call through its bridge, the
// OS picker stood in for from main and the launch kept off the screen and out of the person's way
import type { ElectronApplication, Page } from 'playwright'

export type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }

// Ids well past the ones a page's own code counts from, so a reply to the page is never taken for one of these
let next = 9000

// A window's call to the core through its bridge, answered with the reply carrying its id
export const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

// Main's open dialog answers with picked, or as cancelled for null, since a test can't click an OS dialog. With
// focusTrusted the trusted window gets focus before the answer, as it does when a real picker closes over it
export const stubPicker = (app: ElectronApplication, picked: string | null, options: { focusTrusted?: boolean } = {}) =>
  app.evaluate(({ dialog, BrowserWindow }, [picked, focusTrusted]) => {
    dialog.showOpenDialog = (async () => {
      if (focusTrusted) {
        for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL() === 'hetu://trusted/') window.emit('focus')
      }
      return picked === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [picked] }
    }) as typeof dialog.showOpenDialog
  }, [picked, options.focusTrusted === true] as const)

// What quiet set, as a record reports it
export type Quieted = { activation: 'prohibited' | 'not set off macOS', mouse: 'ignored' }

// Keeps a hidden run out of the person's way, as the first call after the launch. macOS still brings hetu to the front
// on its own focus() of a hidden window, so the app may never become the active one there. Every window lets the mouse
// pass through, so a click on the spot a see-through window covers reaches what the person sees. Playwright's input
// goes through the pages, and its focus emulation answers focus questions there
export const quiet = (app: ElectronApplication): Promise<Quieted> => app.evaluate(({ app, BrowserWindow }) => {
  let activation: 'prohibited' | 'not set off macOS' = 'not set off macOS'
  if (process.platform === 'darwin') {
    app.setActivationPolicy('prohibited')
    activation = 'prohibited'
  }
  const passThrough = (window: InstanceType<typeof BrowserWindow>) => window.setIgnoreMouseEvents(true)
  for (const window of BrowserWindow.getAllWindows()) passThrough(window)
  app.on('browser-window-created', (_event, window) => passThrough(window))
  return { activation, mouse: 'ignored' as const }
})
