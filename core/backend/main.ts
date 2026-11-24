import path from 'node:path'
import { app, BrowserWindow, dialog, Menu, MessageChannelMain, type MessagePortMain, powerMonitor, protocol, screen, session, shell, type Session, utilityProcess, type WebContents } from 'electron'
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
import { frameOwner } from '../api/ids.ts'
import { ViewFiles } from './runtime/views.ts'
import { DragTokens } from './runtime/drag-tokens.ts'
import { ViewImages } from './runtime/images.ts'
import { bytesReader } from './providers/luoshu/bytes.ts'
import { WindowWay, type WindowContents } from './runtime/window-way.ts'
import { keepsOpen, pickFolder, pickPlugins, TrustedWindow } from './runtime/trusted.ts'
import { InstallStagings } from './plugins-manager/stagings.ts'
import { appMenu, editorKeyOfInput, frameKeyOfInput, guardContents, openEditor, openTrusted, quietPlacement } from './runtime/windows.ts'
import { openWorkersRenderer, WorkerRenderer, WorkerRenderers } from './runtime/workers.ts'
import type { Updater } from './updater/header.ts'
import { createUpdater } from './updater/updater.ts'
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
  let updater: Updater | null = null
  // An update's installer, started once Quit has run, false when it started nothing so hetu starts again
  let startAfterQuit: (() => boolean) | null = null
  let quitting: Promise<void> | null = null
  // Set once the system said its session ends: a shutdown, a restart or a logoff, which closes windows with no quit
  let sessionEnding = false
  let code = 0
  // Restart hetu, and quitting after a failure, start a new run once this one has exited
  let again = false
  // A quit after a failure and one that starts hetu again keep the restart marker, a clean one clears it
  const ending = new Ending()
  const seen = new Set<BrowserWindow>()
  app.on('before-quit', event => {
    event.preventDefault()
    updater?.close()
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
      // An installer started starts hetu again itself, so it wins over a restart
      if (startAfterQuit !== null ? !startAfterQuit() : again) app.relaunch()
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
    // Linux and macOS say a shutdown here. Windows says it to each window, which the trusted window hears
    powerMonitor.on('shutdown', () => { sessionEnding = true })
    const menu = appMenu(process.platform)
    Menu.setApplicationMenu(menu === null ? null : Menu.buildFromTemplate(menu))
    app.on('web-contents-created', (_event, contents) => guardContents(contents))
    await lockDown(session.defaultSession, null, pages)
    // Each running plugin's frames and icons, served on the plugin's own host in the editor session from the bytes
    // it started with
    const views = new ViewFiles()
    // The keys each plugin's views bound, as the editor page last sent them, for keys pressed in that plugin's frames
    const viewKeys = new Map<string, ReadonlySet<string>>()
    // The router and the plugins manager exist once the core is wired, before any worker starts
    let router: Router | null = null
    let pluginsManager: PluginsManager | null = null
    let modules: CoreModules | null = null
    // The notes' images plugins' nodes name, read through the luoshu for a plugin running with a ui item while its
    // luoshu.read reaches them, served on the editor session's images host
    const images = new ViewImages({
      running: plugin => views.incarnation(plugin),
      reads: (caller, at) => router?.readsNote(caller, at) ?? false,
      read: bytesReader(() => modules?.provider('luoshu') ?? null),
    })
    // Notes dragged out of plugins' frames, each token answered once on a drop in the editor
    const dragTokens = new DragTokens({
      running: plugin => views.incarnation(plugin),
      reads: (caller, at) => router?.readsNote(caller, at) ?? false,
    })
    const sessions = {} as Record<Role, Session>
    for (const role of Object.keys(ROLES) as Role[]) {
      sessions[role] = session.fromPartition(partition(role))
      await lockDown(sessions[role], role, pages, views, images)
    }

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
        // The startup flow has no way out until a plugin is installed, so the window stays. Quit still ends hetu, which
        // exits once its parts stopped whatever windows are left, and the session ending lets it close
        window.on('session-end', () => { sessionEnding = true })
        window.on('close', event => {
          if (keepsOpen({ due: pluginsManager?.startupDue() === true, quitting: quitting !== null, sessionEnding })) event.preventDefault()
        })
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
    // The Install button's stagings in the data folder, which only main's own dialog and downloads fill
    const stagings = new InstallStagings({ dataDir: booted.dataDir })
    let picking = false
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
      stagings,
      windows: {
        // Opening the trusted window, Quit and Restart hetu, the windows' own actions, which only main can do
        serve: async call => {
          // Checked before the dialog opens, so no folder is picked that couldn't be asked for. One dialog at a time, a
          // plugin pick's included
          if (call.action === 'app.pickFolder') {
            if (pluginsManager === null) throw { code: 'unavailable' }
            const manager = pluginsManager
            if (picking) throw { code: 'throttled' }
            picking = true
            try {
              return await pickFolder(trusted, (parent, options) => dialog.showOpenDialog(parent as unknown as BrowserWindow, options), change => manager.request(change, call.caller))
            } finally {
              picking = false
            }
          }
          // Staged here from the path main's own dialog answered, which never reaches the page
          // Checked before the dialog opens, so no staging is made that couldn't be answered. One dialog at a time
          if (call.action === 'app.stagePicked') {
            const { source } = call.args as { source: 'zip' | 'folder' }
            if (pluginsManager === null) throw { code: 'unavailable' }
            pluginsManager.canStage()
            if (picking) throw { code: 'throttled' }
            picking = true
            try {
              const picked = await pickPlugins(trusted, (parent, options) => dialog.showOpenDialog(parent as unknown as BrowserWindow, options), source)
              if (picked === null) return null
              return await pluginsManager.stagedAnswer(await stagings.stagePicked(source, picked))
            } finally {
              picking = false
            }
          }
          if (call.action === 'editor.frame' || call.action === 'editor.image') {
            const { plugin, frame, path: at } = call.args as { plugin: string, frame?: string, path?: string }
            const url = frame !== undefined ? views.mint(plugin, frame) : at !== undefined ? images.mint(call.caller, plugin, at) : null
            if (url === null) throw { code: 'not-found' }
            return { url }
          }
          if (call.action === 'editor.dragToken') {
            const { plugin, path: at } = call.args as { plugin: string, path: string }
            const token = dragTokens.mint(call.caller, plugin, at)
            if (token === null) throw { code: 'not-found' }
            return { token }
          }
          if (call.action === 'editor.dropToken') {
            const dropped = dragTokens.redeem(call.caller, (call.args as { token: string }).token)
            if (dropped === null) throw { code: 'not-found' }
            return dropped
          }
          if (call.action === 'editor.frameGone') {
            const { url, navigated } = call.args as { url: string, navigated: boolean }
            const gone = views.gone(url)
            if (gone !== null && navigated) recording?.coalesced('frame.navigated', { plugin: gone.plugin })
            return null
          }
          if (call.action === 'editor.focusTaken') {
            const plugin = frameOwner(new URL((call.args as { url: string }).url).hostname)
            if (plugin !== null) recording?.coalesced('frame.focus-taken', { plugin })
            return null
          }
          if (call.action === 'editor.viewKeys') {
            const { plugin, keys } = call.args as { plugin: string, keys: string[] }
            if (keys.length === 0) viewKeys.delete(plugin)
            else viewKeys.set(plugin, new Set(keys))
            return null
          }
          // The theme the editor page set, served at the root of each frame's ticket. Only the editor window draws frames
          if (call.action === 'editor.theme') {
            const { variables } = call.args as { variables: Record<string, string> }
            if (call.caller.kind === 'window' && call.caller.role === 'editor') views.theme(variables)
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
    // A locked build checks GitHub's latest full release for a signed update once the core is ready. Install quits the
    // way Quit does and starts the installer just before the exit
    updater = createUpdater({
      locked: LOCKED, running: app.getVersion(), platform: process.platform, recording: wired.recording, dataDir: booted.dataDir,
      quit: start => {
        if (quitting !== null) return false
        startAfterQuit = start
        app.quit()
        return true
      },
    })

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
        viewKeys.clear()
        images.unloaded()
        dragTokens.unloaded()
      }
      contents.on('did-navigate', unloaded)
      contents.on('render-process-gone', unloaded)
      contents.on('destroyed', unloaded)
      contents.on('dom-ready', () => drawers.loaded(contents))
      // The core keys reach the page whatever has focus, a frame included, and so do the keys a plugin's views bound
      // while focus is in one of its frames. Enter going on to a plugin's frame is pushed as a press there
      contents.on('before-input-event', (event, input) => {
        const focused = contents.focusedFrame?.url ?? null
        const took = editorKeyOfInput(input, focused, viewKeys, process.platform === 'darwin')
        const url = took === null ? frameKeyOfInput(input, focused) : null
        if (url !== null && !contents.isDestroyed()) contents.send('hetu:press', { key: true, url })
        if (took === null) return
        event.preventDefault()
        if (took.channel !== null && !contents.isDestroyed()) contents.send(took.channel, took.sent)
      })
      // Each press and release to the page at once, a frame's included, which the page alone never hears. A press in a
      // frame comes with the frame's own x and y, so the point on the page is taken from the screen
      contents.on('before-mouse-event', (_event, mouse) => {
        if ((mouse.type !== 'mouseDown' && mouse.type !== 'mouseUp') || mouse.globalX === undefined || mouse.globalY === undefined) return
        if (contents.isDestroyed()) return
        const content = window.getContentBounds()
        const zoom = contents.getZoomFactor()
        contents.send('hetu:press', { down: mouse.type === 'mouseDown', x: (mouse.globalX - content.x) / zoom, y: (mouse.globalY - content.y) / zoom })
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
    else {
      editor = show(editorWindow())
      updater.ready()
      // Over the editor, on the startup flow every install goes through
      if (wired.pluginsManager.startupDue()) trusted.show()
    }
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
