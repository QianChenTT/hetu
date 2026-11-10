import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, MessageChannelMain, protocol, screen, session, type Session } from 'electron'
import { boot, type Booted } from './boot/boot.ts'
import { floorConstants, type FloorConstant } from '../api/floor.ts'
import { RELAY_LIMITS } from '../api/rate.ts'
import type { Carrier } from './carrier/carrier.ts'
import type { Failure, Loader } from './loader/loader.ts'
import { beforeReady, installDirFor } from './runtime/before-ready.ts'
import { electronRuntime } from './runtime/electron.ts'
import { freezeIntrinsics } from './runtime/intrinsics.ts'
import { afterFailure, quitInOrder, relaunches, type QuitParts } from './runtime/quit.ts'
import { lockDown, partition, ROLES, type Role } from './runtime/sessions.ts'
import { WindowWay, type WindowContents } from './runtime/window-way.ts'
import { pickFolder, TrustedWindow } from './runtime/trusted.ts'
import { appMenu, guardContents, openEditor, openTrusted, quietPlacement } from './runtime/windows.ts'
import { openWorkersRenderer, WorkerRenderer, WorkerRenderers } from './runtime/workers.ts'
import { wireCore } from './wire.ts'

// The bundle sits in core/dist with the install list, the built pages and the workers preload beside it. A packaged
// build keeps its install plugins beside app.asar
const here = import.meta.dirname
const pages = path.join(here, 'frontend')
const workersPreload = path.join(here, 'workers-preload.js')
const mountPreload = path.join(here, 'mount-preload.js')

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
  let loaderOf: Loader | null = null
  let workers: WorkerRenderers | null = null
  let quitting: Promise<void> | null = null
  let code = 0
  // Restart hetu, and quitting after a failure, start a new run once this one has exited
  let again = false
  // A quit after a failure keeps the restart marker, a clean one clears it
  let failed = false
  const seen = new Set<BrowserWindow>()
  app.on('before-quit', event => {
    event.preventDefault()
    quitting ??= (async () => {
      for (const window of seen) if (!window.isDestroyed()) window.close()
      if (!failed) await loaderOf?.cleanQuit()
      const missed = parts === null ? (await booted.release(), []) : await quitInOrder(parts)
      for (const line of missed) console.error(`quit: ${line}`)
      workers?.close()
    })().catch((err: unknown) => console.error(`quit: ${reason(err)}`)).finally(() => {
      if (again) app.relaunch()
      app.exit(code)
    })
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
    const menu = appMenu(process.platform)
    Menu.setApplicationMenu(menu === null ? null : Menu.buildFromTemplate(menu))
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

    // The one trusted window with its way into the carrier, made before its page loads. Its input delay lives here in
    // main, so a Confirm counts only once it armed
    const trusted = new TrustedWindow({
      open: () => {
        const window = show(openTrusted(BrowserWindow, sessions.trusted, app.isPackaged, placement(), mountPreload))
        if (carrier !== null) new WindowWay(window.webContents as unknown as WindowContents, 'trusted', carrier)
        return window
      },
    })
    let editor: BrowserWindow | null = null
    const closeEditors = () => {
      for (const window of seen) if (window !== trusted.window && !window.isDestroyed()) window.close()
      editor = null
    }
    // A failure while running: windows hear core.quitting and get their grace, then hetu quits with an error and starts
    // once more. Or the loader stopped in the stopped mode, which leaves only the trusted window
    const onFailure = (failure: Failure) => afterFailure(failure, {
      quitting: () => quitting !== null,
      announce: () => {
        failed = true
        carrier?.quitting()
      },
      quit: (exitCode, restart) => {
        code = exitCode
        again = restart
        app.quit()
      },
      showTrusted: () => trusted.show(),
      closeEditors,
      packaged: app.isPackaged,
      env: process.env,
      later: (run, ms) => setTimeout(run, ms).unref?.(),
    })
    const wired = wireCore({
      booted,
      installDir,
      runtime,
      limited: plugin => renderer.limited(plugin),
      onFailure,
      windows: {
        // Opening the trusted window, Quit and Restart hetu, the windows' own actions, which only main can do
        serve: async call => {
          if (call.action === 'core.pickFolder') {
            return pickFolder(trusted, (parent, options) => dialog.showOpenDialog(parent as unknown as BrowserWindow, options))
          }
          if (call.action === 'security.open') trusted.show()
          else if (call.action === 'core.relaunch') {
            again = relaunches({ packaged: app.isPackaged, env: process.env })
            app.quit()
          } else if (call.action === 'core.quit') app.quit()
          else throw { code: 'unavailable' }
          return null
        },
        armed: caller => trusted.armed(caller),
      },
    })
    carrier = wired.carrier
    loader = wired.loader
    loaderOf = wired.loader
    parts = { loader: wired.loader, carrier: wired.carrier, release: booted.release }

    // Each editor window comes with its way into the carrier, made before its page loads
    const editorWindow = () => {
      const window = openEditor(BrowserWindow, sessions.editor, app.isPackaged, placement(), mountPreload)
      new WindowWay(window.webContents as unknown as WindowContents, 'editor', wired.carrier)
      return window
    }
    const placement = () => quietPlacement({
      packaged: app.isPackaged,
      env: process.env,
      displays: screen.getAllDisplays(),
      cursorDisplay: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id,
    })
    // A second hetu on the same data folder quits before ready and this one comes to the front. In the stopped mode that
    // is the trusted window
    app.on('second-instance', () => {
      if (quitting !== null) return
      if (wired.loader.stopped() !== null) {
        trusted.show()
        return
      }
      if (editor === null || editor.isDestroyed()) {
        editor = show(editorWindow())
        return
      }
      if (editor.isMinimized()) editor.restore()
      editor.focus()
    })

    await wired.loader.start()
    if (quitting !== null) return
    // A security control failed at start: only the trusted window opens, with the human's three choices
    if (wired.loader.stopped() !== null) trusted.show()
    else editor = show(editorWindow())
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
