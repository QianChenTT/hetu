import path from 'node:path'
import { app, BrowserWindow, dialog, MessageChannelMain, protocol, screen, session, type Session } from 'electron'
import { boot, type Booted } from './boot/boot.ts'
import { floorConstants, type FloorConstant } from '../api/floor.ts'
import { RELAY_LIMITS } from '../api/rate.ts'
import type { Carrier } from './carrier/carrier.ts'
import type { Loader } from './loader/loader.ts'
import { beforeReady, installDirFor } from './runtime/before-ready.ts'
import { electronRuntime } from './runtime/electron.ts'
import { freezeIntrinsics } from './runtime/intrinsics.ts'
import { quitInOrder, type QuitParts } from './runtime/quit.ts'
import { lockDown, partition, ROLES, type Role } from './runtime/sessions.ts'
import { guardContents, openEditor, quietPlacement } from './runtime/windows.ts'
import { openWorkersRenderer, WorkerRenderer, WorkerRenderers } from './runtime/workers.ts'
import { wireCore } from './wire.ts'

// The bundle sits in core/dist with the install list, the built pages and the workers preload beside it. A packaged
// build keeps its install plugins beside app.asar
const here = import.meta.dirname
const pages = path.join(here, 'frontend')
const workersPreload = path.join(here, 'workers-preload.js')

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Before ready the dialog prints to stderr on Linux and shows on Windows and macOS
function tell(err: unknown): void {
  console.error(`hetu could not start: ${reason(err)}`)
  dialog.showErrorBox('hetu could not start', reason(err))
}

async function start(): Promise<void> {
  let installDir: string
  try {
    installDir = installDirFor({ packaged: app.isPackaged, env: process.env, here, resourcesPath: process.resourcesPath, platform: process.platform })
  } catch (err) {
    tell(err)
    return app.exit(1)
  }
  let booted: Booted
  try {
    booted = await boot({ packaged: app.isPackaged, installDir, env: process.env, platform: process.platform })
  } catch (err) {
    tell(err)
    return app.exit(1)
  }

  // Quit runs once, in order: the windows a human sees close, the core stops its plugins while the hidden renderers
  // still hold their workers, then the renderers end and the process exits. Before the core is wired there is only boot's
  // lock to give back. Electron closes no window itself, since the renderer must outlive the core's shutdown
  let parts: QuitParts | null = null
  let workers: WorkerRenderers | null = null
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
  // The hidden renderers never close, so hetu quits when the last window a human sees does
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
    // A renderer per community plugin and one for the first-party plugins, each opened when its first worker starts.
    // A worker's start waits for its page, within the plugin's own ready deadline
    const renderer = new WorkerRenderers(group => new WorkerRenderer({
      open: () => openWorkersRenderer(BrowserWindow, sessions.workers, workersPreload, app.isPackaged, group),
      record: (event, fields) => carrier?.floor(event, fields),
      limits: id => Object.fromEntries(RELAY_LIMITS.map(name => [name, limit(id, name)])),
      cutoff: (id, incarnation, reason) => loader?.crashed({ kind: 'plugin', id, half: 'worker', incarnation }, reason),
      sample: sample => carrier?.sample(sample),
    }))
    workers = renderer
    const runtime = electronRuntime(() => new MessageChannelMain(), renderer, limit, { freeze: freezeIntrinsics, importer: url => import(url) })
    const wired = wireCore({ booted, installDir, runtime, limited: plugin => renderer.limited(plugin) })
    carrier = wired.carrier
    loader = wired.loader
    parts = { loader: wired.loader, carrier: wired.carrier, release: booted.release }

    let editor: BrowserWindow | null = null
    const placement = () => quietPlacement({
      packaged: app.isPackaged,
      env: process.env,
      displays: screen.getAllDisplays(),
      cursorDisplay: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
    })
    // A second hetu on the same data folder quits before ready and this one comes to the front
    app.on('second-instance', () => {
      if (quitting !== null) return
      if (editor === null || editor.isDestroyed()) {
        editor = show(openEditor(BrowserWindow, sessions.editor, app.isPackaged, placement()))
        return
      }
      if (editor.isMinimized()) editor.restore()
      editor.focus()
    })

    await wired.loader.start()
    if (quitting === null) editor = show(openEditor(BrowserWindow, sessions.editor, app.isPackaged, placement()))
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
