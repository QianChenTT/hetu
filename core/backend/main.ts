import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, MessageChannelMain, type MessagePortMain, protocol, screen, session, type Session, type WebContents } from 'electron'
import { boot, type Booted } from './boot/boot.ts'
import { floorConstants, type FloorConstant } from '../api/floor.ts'
import { RELAY_LIMITS } from '../api/rate.ts'
import type { Carrier } from './carrier/carrier.ts'
import type { Failure, Loader } from './loader/loader.ts'
import { beforeReady, installDirFor } from './runtime/before-ready.ts'
import { LOCKED, PACKAGED } from './runtime/packaged.ts'
import { DrawerPorts, withDrawers } from './runtime/drawer-ports.ts'
import { electronRuntime } from './runtime/electron.ts'
import { freezeIntrinsics } from './runtime/intrinsics.ts'
import { afterFailure, DRAFT_GRACE_MS, quitInOrder, relaunches, type QuitParts } from './runtime/quit.ts'
import { lockDown, partition, ROLES, type Role } from './runtime/sessions.ts'
import { ViewFiles } from './runtime/views.ts'
import { WindowWay, type WindowContents } from './runtime/window-way.ts'
import { pickFolder, TrustedWindow } from './runtime/trusted.ts'
import { appMenu, coreKeyOfInput, guardContents, openEditor, openTrusted, quietPlacement } from './runtime/windows.ts'
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
  let listDir: string
  try {
    ;({ installDir, listDir } = installDirFor({ packaged: PACKAGED, locked: LOCKED, env: process.env, here, resourcesPath: process.resourcesPath, platform: process.platform }))
  } catch (err) {
    tell(err)
    return app.exit(1)
  }
  let booted: Booted
  try {
    booted = await boot({ packaged: LOCKED, installDir, env: process.env, platform: process.platform })
  } catch (err) {
    tell(err)
    return app.exit(1)
  }

  // Quit runs once, in order: the windows a human sees close, the core stops its plugins while the hidden renderers
  // still hold their workers, then the renderers end and the process exits. Before the core is wired there is only boot's
  // lock to give back. Electron closes no window itself, since the renderer must outlive the core's shutdown
  let parts: QuitParts | null = null
  let loaderOf: Loader | null = null
  let carrierOf: Carrier | null = null
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
      // A quit the human asked for: windows hear core.quitting and get a moment to keep their drafts, as after a failure
      if (!failed && carrierOf !== null && [...seen].some(window => !window.isDestroyed())) {
        carrierOf.quitting()
        await new Promise(resolve => setTimeout(resolve, DRAFT_GRACE_MS))
      }
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
    // Each running plugin's frames and icons, served on the editor session's views host from the bytes it started with
    const views = new ViewFiles()
    const sessions = {} as Record<Role, Session>
    for (const role of Object.keys(ROLES) as Role[]) {
      sessions[role] = session.fromPartition(partition(role))
      lockDown(sessions[role], role, pages, views)
    }

    // The carrier and the loader exist once the core is wired, before any worker starts
    let carrier: Carrier | null = null
    let loader: Loader | null = null
    const limit = (plugin: string, name: FloorConstant) => carrier?.limit(plugin, name) ?? floorConstants[name]
    // A renderer per community plugin and one for the first-party plugins, each opened when its first worker starts.
    // A worker's start waits for its page, within the plugin's own ready deadline
    const renderer = new WorkerRenderers(group => new WorkerRenderer({
      open: () => openWorkersRenderer(BrowserWindow, sessions.workers, workersPreload, LOCKED, group),
      record: (event, fields) => carrier?.floor(event, fields),
      limits: id => Object.fromEntries(RELAY_LIMITS.map(name => [name, limit(id, name)])),
      cutoff: (id, incarnation, reason) => loader?.crashed({ kind: 'plugin', id, half: 'worker', incarnation }, reason),
      sample: sample => carrier?.sample(sample),
    }))
    workers = renderer
    // A port between each worker holding a ui item and the editor page's drawer, made again for each page load
    const drawers = new DrawerPorts<WebContents>({
      channel: () => new MessageChannelMain(),
      toWorker: (id, incarnation, port) => renderer.drawer(id, incarnation, port as MessagePortMain),
      toPage: (page, plugin, incarnation, port) => {
        if (page.isDestroyed()) (port as MessagePortMain).close()
        else page.postMessage('hetu:drawer', { plugin, incarnation }, [port as MessagePortMain])
      },
      endInPage: (page, plugin, incarnation) => {
        if (!page.isDestroyed()) page.postMessage('hetu:drawer-end', { plugin, incarnation })
      },
    })
    const runtime = electronRuntime(() => new MessageChannelMain(), withDrawers(renderer, drawers, views), limit, { freeze: freezeIntrinsics, importer: url => import(url) })

    // The one trusted window with its way into the carrier, made before its page loads. Its input delay lives here in
    // main, so a Confirm counts only once it armed
    const trusted = new TrustedWindow({
      open: () => {
        const window = show(openTrusted(BrowserWindow, sessions.trusted, LOCKED, placement(), mountPreload))
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
      packaged: LOCKED,
      env: process.env,
      later: (run, ms) => setTimeout(run, ms).unref?.(),
    })
    const wired = wireCore({
      booted,
      installDir,
      listDir,
      runtime,
      limited: plugin => renderer.limited(plugin),
      onFailure,
      windows: {
        // Opening the trusted window, Quit and Restart hetu, the windows' own actions, which only main can do
        serve: async call => {
          if (call.action === 'core.pickFolder') {
            return pickFolder(trusted, (parent, options) => dialog.showOpenDialog(parent as unknown as BrowserWindow, options))
          }
          if (call.action === 'editor.frame') {
            const { plugin, frame } = call.args as { plugin: string, frame: string }
            const url = views.mint(plugin, frame)
            if (url === null) throw { code: 'not-found' }
            return { url }
          }
          if (call.action === 'editor.frameGone') {
            const { url, navigated } = call.args as { url: string, navigated: boolean }
            const gone = views.gone(url)
            if (gone !== null && navigated) carrier?.floorCoalesced('frame.navigated', { plugin: gone.plugin })
            return null
          }
          if (call.action === 'security.open') trusted.show()
          else if (call.action === 'core.relaunch') {
            again = relaunches({ packaged: LOCKED, env: process.env })
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
    carrierOf = wired.carrier
    parts = { loader: wired.loader, carrier: wired.carrier, release: booted.release }

    // Each editor window comes with its way into the carrier, made before its page loads, and its drawer ports once each
    // load's preload listens
    const editorWindow = () => {
      const window = openEditor(BrowserWindow, sessions.editor, LOCKED, placement(), mountPreload)
      const contents = window.webContents
      new WindowWay(contents as unknown as WindowContents, 'editor', wired.carrier)
      // A frame's token ends with the page that framed it
      const unloaded = () => {
        drawers.unloaded(contents)
        views.unloaded()
      }
      contents.on('did-navigate', unloaded)
      contents.on('render-process-gone', unloaded)
      contents.on('destroyed', unloaded)
      contents.on('dom-ready', () => drawers.loaded(contents))
      // The core keys reach the page whatever has focus, a frame included
      contents.on('before-input-event', (event, input) => {
        const core = coreKeyOfInput(input, process.platform === 'darwin')
        if (core === null) return
        event.preventDefault()
        if (!input.isAutoRepeat) contents.send('hetu:key', core)
      })
      // Closing the last window quits hetu, so it goes the way Quit goes and the page keeps its drafts first
      window.on('close', event => {
        if (quitting !== null || [...seen].some(other => other !== window && !other.isDestroyed())) return
        event.preventDefault()
        app.quit()
      })
      return window
    }
    const placement = () => quietPlacement({
      packaged: LOCKED,
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
  early = beforeReady(app, protocol, { env: process.env, platform: process.platform, locked: LOCKED, argv: process.argv })
} catch (err) {
  tell(err)
  app.exit(1)
}
if (early !== null) void start()
