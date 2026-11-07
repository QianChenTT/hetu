import path from 'node:path'
import { app, BrowserWindow, dialog, MessageChannelMain, protocol, session, type Session } from 'electron'
import { boot, type Booted } from './boot/boot.ts'
import { beforeReady } from './runtime/before-ready.ts'
import { electronRuntime } from './runtime/electron.ts'
import { quitInOrder, type QuitParts } from './runtime/quit.ts'
import { lockDown, partition, ROLES, type Role } from './runtime/sessions.ts'
import { guardContents, openEditor } from './runtime/windows.ts'
import { wireCore } from './wire.ts'

// The bundle sits in core/dist with the install list the build wrote beside it, and the pages are in core/frontend. A
// packaged build keeps its install plugins beside app.asar
const here = import.meta.dirname
const pages = path.join(here, '..', 'frontend')

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Before ready the dialog prints to stderr on Linux and shows on Windows and macOS
function tell(err: unknown): void {
  console.error(`hetu could not start: ${reason(err)}`)
  dialog.showErrorBox('hetu could not start', reason(err))
}

async function start(): Promise<void> {
  const installDir = app.isPackaged ? process.resourcesPath : here
  let booted: Booted
  try {
    booted = await boot({ packaged: app.isPackaged, installDir, env: process.env, platform: process.platform })
  } catch (err) {
    tell(err)
    return app.exit(1)
  }

  // Windows close first, then the core stops in its order and the process exits. Before the core is wired there is
  // only boot's lock to give back
  let parts: QuitParts | null = null
  let quitting: Promise<void> | null = null
  let code = 0
  app.on('will-quit', event => {
    event.preventDefault()
    const order = parts === null ? booted.release().then(() => []) : quitInOrder(parts)
    quitting ??= order.then(missed => {
      for (const line of missed) console.error(`quit: ${line}`)
    }, (err: unknown) => console.error(`quit: ${reason(err)}`)).finally(() => app.exit(code))
  })
  app.on('window-all-closed', () => app.quit())

  try {
    await app.whenReady()
    app.on('web-contents-created', (_event, contents) => guardContents(contents))
    lockDown(session.defaultSession, null, pages)
    const sessions = {} as Record<Role, Session>
    for (const role of Object.keys(ROLES) as Role[]) {
      sessions[role] = session.fromPartition(partition(role))
      lockDown(sessions[role], role, pages)
    }

    const { loader, carrier } = wireCore({ booted, installDir, runtime: electronRuntime(() => new MessageChannelMain()) })
    parts = { loader, carrier, release: booted.release }
    let editor: BrowserWindow | null = null
    // A second hetu on the same data folder quits before ready and this one comes to the front
    app.on('second-instance', () => {
      if (quitting !== null) return
      if (editor === null || editor.isDestroyed()) {
        editor = openEditor(BrowserWindow, sessions.editor, app.isPackaged)
        return
      }
      if (editor.isMinimized()) editor.restore()
      editor.focus()
    })

    await loader.start()
    if (quitting === null) editor = openEditor(BrowserWindow, sessions.editor, app.isPackaged)
  } catch (err) {
    tell(err)
    code = 1
    app.quit()
  }
}

// Synchronous up to here, so all of it runs before ready
let early: ReturnType<typeof beforeReady> = null
try {
  early = beforeReady(app, protocol, { env: process.env, platform: process.platform })
} catch (err) {
  tell(err)
  app.exit(1)
}
if (early !== null) void start()
