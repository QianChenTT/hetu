import path from 'node:path'
import { app, BrowserWindow, dialog, MessageChannelMain, protocol, session, type Session } from 'electron'
import { boot, type Booted } from './boot/boot.ts'
import { floorConstants, type FloorConstant } from '../api/floor.ts'
import type { Carrier } from './carrier/carrier.ts'
import type { Loader } from './loader/loader.ts'
import { beforeReady } from './runtime/before-ready.ts'
import { electronRuntime } from './runtime/electron.ts'
import { quitInOrder, type QuitParts } from './runtime/quit.ts'
import { lockDown, partition, ROLES, type Role } from './runtime/sessions.ts'
import { guardContents, openEditor } from './runtime/windows.ts'
import { openWorkersRenderer, WorkerRenderer } from './runtime/workers.ts'
import { wireCore } from './wire.ts'

// The bundle sits in core/dist with the install list, the built pages and the workers preload beside it. A packaged
// build keeps its install plugins beside app.asar
const here = import.meta.dirname
const pages = path.join(here, 'frontend')
const workersPreload = path.join(here, 'workers-preload.js')
// How long the core waits for the worker host page before it starts plugins anyway
const RENDERER_READY_MS = 10_000
// The limits the page's relay applies before a worker's message reaches main
const RELAY_LIMITS: readonly FloorConstant[] = ['messagesPerSecond', 'floodFactor', 'floodMs', 'textPerSecond', 'resultBytes']

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

  // Quit runs once, in order: the windows a human sees close, the core stops its plugins while the hidden renderer still
  // holds their workers, then the renderer ends and the process exits. Before the core is wired there is only boot's
  // lock to give back. Electron closes no window itself, since the renderer must outlive the core's shutdown
  let parts: QuitParts | null = null
  let workers: WorkerRenderer | null = null
  let quitting: Promise<void> | null = null
  let code = 0
  const seen = new Set<BrowserWindow>()
  app.on('before-quit', event => {
    event.preventDefault()
    quitting ??= (async () => {
      for (const window of seen) if (!window.isDestroyed()) window.close()
      const missed = parts === null ? (await booted.release(), []) : await quitInOrder(parts)
      for (const line of missed) console.error(`quit: ${line}`)
      workers?.close()
    })().catch((err: unknown) => console.error(`quit: ${reason(err)}`)).finally(() => app.exit(code))
  })
  // The hidden renderer never closes, so hetu quits when the last window a human sees does
  const show = (window: BrowserWindow) => {
    seen.add(window)
    window.on('closed', () => {
      seen.delete(window)
      if (seen.size === 0) app.quit()
    })
    return window
  }
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

    // The carrier and the loader exist once the core is wired, before any worker starts
    let carrier: Carrier | null = null
    let loader: Loader | null = null
    const limit = (plugin: string, name: FloorConstant) => carrier?.limit(plugin, name) ?? floorConstants[name]
    const renderer = new WorkerRenderer({
      open: () => openWorkersRenderer(BrowserWindow, sessions.workers, workersPreload, app.isPackaged),
      record: (event, fields) => carrier?.floor(event, fields),
      limits: id => Object.fromEntries(RELAY_LIMITS.map(name => [name, limit(id, name)])),
      cutoff: (id, incarnation, reason) => loader?.crashed({ kind: 'plugin', id, half: 'worker', incarnation }, reason),
      readyMs: RENDERER_READY_MS,
    })
    workers = renderer
    const runtime = electronRuntime(() => new MessageChannelMain(), renderer, limit)
    const wired = wireCore({ booted, installDir, runtime })
    carrier = wired.carrier
    loader = wired.loader
    parts = { loader: wired.loader, carrier: wired.carrier, release: booted.release }

    let editor: BrowserWindow | null = null
    // A second hetu on the same data folder quits before ready and this one comes to the front
    app.on('second-instance', () => {
      if (quitting !== null) return
      if (editor === null || editor.isDestroyed()) {
        editor = show(openEditor(BrowserWindow, sessions.editor, app.isPackaged))
        return
      }
      if (editor.isMinimized()) editor.restore()
      editor.focus()
    })

    await renderer.whenReady()
    await wired.loader.start()
    if (quitting === null) editor = show(openEditor(BrowserWindow, sessions.editor, app.isPackaged))
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
