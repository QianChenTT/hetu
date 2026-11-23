import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, MessageChannelMain, type MessagePortMain, protocol, screen, session, shell, type Session, utilityProcess, type WebContents } from 'electron'
import { boot, type Booted } from './boot/boot.ts'
import { defaultLimits, type LimitName } from '../api/limits.ts'
import { RELAY_LIMITS } from '../api/rate.ts'
import type { Router } from './router/router.ts'
import { pacedLimit } from './flood-control/flood-control.ts'
import type { CoreModules } from './modules/header.ts'
import type { Recording } from './recording/header.ts'
import type { PluginsManager } from './plugins-manager/plugins-manager.ts'
import type { Failure } from './runtime/header.ts'
import { beforeReady, installDirFor } from './runtime/before-ready.ts'
import { DOOR_FILE } from './plugins-manager/verify.ts'
import { LOCKED, PACKAGED } from './runtime/packaged.ts'
import { DrawerPorts, withDrawers } from './runtime/drawer-ports.ts'
import { electronRuntime } from './runtime/electron.ts'
import { utilityRuntime } from './runtime/utility.ts'
import { freezeIntrinsics } from './runtime/intrinsics.ts'
import { afterFailure, DRAFT_GRACE_MS, Ending, quitInOrder, relaunches, stoppedBox, type QuitParts } from './runtime/quit.ts'
import { lockDown, partition, ROLES, type Role } from './runtime/sessions.ts'
import { runShim, shimArgv, shimError } from './runtime/shim.ts'
import { ViewFiles } from './runtime/views.ts'
import { WindowWay, type WindowContents } from './runtime/window-way.ts'
import { pickFolder, TrustedWindow } from './runtime/trusted.ts'
import { appMenu, coreKeyOfInput, guardContents, openEditor, openTrusted, quietPlacement } from './runtime/windows.ts'
import { openWorkersRenderer, WorkerRenderer, WorkerRenderers } from './runtime/workers.ts'
import { wireCore } from './wire.ts'

// The bundle sits in core/dist with the utility bootstrap, the door, the built pages and the workers preload beside it.
// A packaged build keeps all of them inside app.asar
const here = import.meta.dirname
const pages = path.join(here, 'frontend')
const workersPreload = path.join(here, 'workers-preload.js')
const editorPreload = path.join(here, 'editor-preload.js')

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Before ready the dialog prints to stderr on Linux and shows on Windows and macOS
function tell(err: unknown): void {
  console.error(`hetu could not start: ${reason(err)}`)
  dialog.showErrorBox('hetu could not start', reason(err))
}

async function start(): Promise<void> {
  let installDir: string
  let codeDir: string
  try {
    ;({ installDir, codeDir } = installDirFor({ packaged: PACKAGED, locked: LOCKED, env: process.env, here, resourcesPath: process.resourcesPath, platform: process.platform }))
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
  let pluginsManagerOf: PluginsManager | null = null
  let routerOf: Router | null = null
  let workers: WorkerRenderers | null = null
  let quitting: Promise<void> | null = null
  let code = 0
  // Restart hetu, and quitting after a failure, start a new run once this one has exited
  let again = false
  // A quit after a failure and one that starts hetu again keep the restart marker, a clean one clears it
  const ending = new Ending()
  const seen = new Set<BrowserWindow>()
  app.on('before-quit', event => {
    event.preventDefault()
    quitting ??= (async () => {
      // A quit the human asked for: windows hear core.quitting and get a moment to keep their drafts, as after a failure
      if (ending.asked() && routerOf !== null && [...seen].some(window => !window.isDestroyed())) {
        routerOf.quitting()
        await new Promise(resolve => setTimeout(resolve, DRAFT_GRACE_MS))
      }
      for (const window of seen) if (!window.isDestroyed()) window.close()
      await ending.leave(pluginsManagerOf)
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
    await lockDown(session.defaultSession, null, pages)
    // Each running plugin's frames and icons, served on the editor session's views host from the bytes it started with
    const views = new ViewFiles()
    const sessions = {} as Record<Role, Session>
    for (const role of Object.keys(ROLES) as Role[]) {
      sessions[role] = session.fromPartition(partition(role))
      await lockDown(sessions[role], role, pages, views)
    }

    // The router and the plugins manager exist once the core is wired, before any worker starts
    let router: Router | null = null
    let pluginsManager: PluginsManager | null = null
    let modules: CoreModules | null = null
    let recording: Recording | null = null
    // What paces a plugin's messages before main reads them follows flood control: with it off nothing paces them
    const limit = pacedLimit(
      (plugin: string, name: LimitName) => router?.limit(plugin, name) ?? defaultLimits[name],
      () => modules?.state('flood-control') === 'off',
    )
    // A renderer per plugin, opened when its first worker starts.
    // A worker's start waits for its page, within the plugin's own ready deadline
    const renderer = new WorkerRenderers(plugin => new WorkerRenderer({
      open: () => openWorkersRenderer(BrowserWindow, sessions.workers, workersPreload, LOCKED, plugin),
      record: (event, fields) => recording?.coreRecord(event, fields),
      limits: id => Object.fromEntries(RELAY_LIMITS.map(name => [name, limit(id, name)])),
      cutoff: (id, incarnation, reason) => pluginsManager?.crashed({ kind: 'plugin', id, half: 'worker', incarnation }, reason),
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
    // A utility half forks from utility.js beside main.js, paced to the same limits main holds it to
    const utility = utilityRuntime({
      fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
      bootstrap: path.join(here, 'utility.js'),
      locked: LOCKED,
      limits: id => Object.fromEntries(RELAY_LIMITS.map(name => [name, limit(id, name)])) as Record<typeof RELAY_LIMITS[number], number>,
    })
    const runtime = electronRuntime(() => new MessageChannelMain(), withDrawers(renderer, drawers, views), limit, utility)

    // The one trusted window with its way into the router, made before its page loads. Its input delay lives here in
    // main, so a Confirm counts only once it armed
    const trusted = new TrustedWindow({
      open: () => {
        const window = show(openTrusted(BrowserWindow, sessions.trusted, LOCKED, placement(), editorPreload))
        if (router !== null) new WindowWay(window.webContents as unknown as WindowContents, 'trusted', router)
        return window
      },
    })
    let editor: BrowserWindow | null = null
    const closeEditors = () => {
      for (const window of seen) if (window !== trusted.window && !window.isDestroyed()) window.close()
      editor = null
    }
    // The log failing while running: windows hear core.quitting and get their grace, then hetu quits with an error and
    // starts once more. Or the plugins manager stopped in the stopped mode, which leaves only the trusted window
    const onFailure = (failure: Failure) => afterFailure(failure, {
      quitting: () => quitting !== null,
      announce: () => router?.quitting(),
      quit: (exitCode, restart) => {
        code = exitCode
        again = restart
        app.quit()
      },
      ending,
      showTrusted: () => trusted.show(),
      // Modal, so the quit follows once the human closed it
      showBox: mode => (dialog.showMessageBoxSync({ type: 'error', defaultId: 0, ...stoppedBox(mode) }) === 1 ? 'retry' : 'quit'),
      closeEditors,
      packaged: LOCKED,
      env: process.env,
      later: (run, ms) => setTimeout(run, ms).unref?.(),
    })
    const wired = wireCore({
      booted,
      installDir,
      doorFile: path.join(codeDir, DOOR_FILE),
      runtime,
      // A plugin's running workers and utility halves get its limits again after each change
      limited: plugin => {
        renderer.limited(plugin)
        utility.limited(plugin)
      },
      onFailure,
      // A removed note goes to the OS's bin, so it can be put back with hetu closed. A bin that refuses rejects
      trash: absolute => shell.trashItem(absolute),
      windows: {
        // Opening the trusted window, Quit and Restart hetu, the windows' own actions, which only main can do
        serve: async call => {
          if (call.action === 'app.pickFolder') {
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
            if (gone !== null && navigated) recording?.coalesced('frame.navigated', { plugin: gone.plugin })
            return null
          }
          if (call.action === 'app.openSecurity') trusted.show()
          else if (call.action === 'app.relaunch') {
            ending.relaunch()
            again = relaunches({ packaged: LOCKED, env: process.env })
            app.quit()
          } else if (call.action === 'app.quit') app.quit()
          else throw { code: 'unavailable' }
          return null
        },
        armed: caller => trusted.armed(caller),
      },
    })
    router = wired.router
    pluginsManager = wired.pluginsManager
    modules = wired.modules
    recording = wired.recording
    pluginsManagerOf = wired.pluginsManager
    routerOf = wired.router
    parts = { pluginsManager: wired.pluginsManager, router: wired.router, recording: wired.recording, release: booted.release }

    // Each editor window comes with its way into the router, made before its page loads, and its drawer ports once each
    // load's preload listens
    const editorWindow = () => {
      const window = openEditor(BrowserWindow, sessions.editor, LOCKED, placement(), editorPreload)
      const contents = window.webContents
      new WindowWay(contents as unknown as WindowContents, 'editor', wired.router)
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
      if (wired.pluginsManager.stopped() !== null) {
        if (!wired.pluginsManager.stoppedBox()) trusted.show()
        return
      }
      if (editor === null || editor.isDestroyed()) {
        editor = show(editorWindow())
        return
      }
      if (editor.isMinimized()) editor.restore()
      editor.focus()
    })

    // The built-ins main decides with are frozen for the run before the core modules start
    freezeIntrinsics()
    await wired.pluginsManager.start()
    if (quitting !== null) return
    // A control failed at start: only the trusted window opens, or the native box with the security view off
    const stopped = wired.pluginsManager.stopped()
    if (stopped !== null) onFailure({ action: 'stopped', mode: stopped, box: wired.pluginsManager.stoppedBox() })
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
  // The shim speaks on stderr alone
  if (shimArgv(process.argv, LOCKED)) shimError(`could not start: ${reason(err)}`)
  else tell(err)
  app.exit(1)
}
// The shim relays and nothing else: no boot, no log, no window
if (early?.shim === true) runShim(app)
else if (early !== null) void start()
