import { stoppedCause, type StoppedMode } from '../../api/actions.ts'
import type { Failure } from './header.ts'

// What Quit needs from the joined core and from boot
export type QuitParts = {
  pluginsManager: { shutdown(): Promise<void> }
  router: { close(): void }
  recording: { flush(): Promise<void> }
  release(): Promise<void>
}

// The longest Quit waits on each step before it goes on. Shutdown stops one plugin at a time, each within its stop
// grace, so its deadline only catches a plugins manager that hangs. A flush waits on an append that may never settle
export type Deadlines = { readonly shutdown: number, readonly flush: number, readonly release: number }
export const QUIT_DEADLINES: Deadlines = Object.freeze({ shutdown: 30_000, flush: 2_000, release: 2_000 })

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// shutdown, flush, close, flush and release. The first flush writes what the audit queue holds and gives a core record
// backlog waiting to retry one more try before close drops it. Closing the router ends every way and closes
// recording. The second flush writes the records of the calls close stopped and waits for the drain close leaves
// running, which carries the counts close writes.
// The lock goes last, once nothing more is written. Returns each step that didn't finish and why, since the log is
// closed by then
export async function quitInOrder(parts: QuitParts, deadlines: Deadlines = QUIT_DEADLINES): Promise<string[]> {
  const missed: string[] = []
  const wait = async (name: string, work: () => Promise<void>, ms: number) => {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), ms)
    })
    try {
      const result = await Promise.race([Promise.resolve().then(work).then(() => 'done' as const), late])
      if (result === 'late') missed.push(`${name}: no answer in ${ms} ms`)
    } catch (err) {
      missed.push(`${name}: ${reason(err)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  await wait('shutdown', () => parts.pluginsManager.shutdown(), deadlines.shutdown)
  await wait('flush', () => parts.recording.flush(), deadlines.flush)
  try {
    parts.router.close()
  } catch (err) {
    missed.push(`close: ${reason(err)}`)
  }
  await wait('flush', () => parts.recording.flush(), deadlines.flush)
  await wait('release', () => parts.release(), deadlines.release)
  return missed
}

// The new instance starts once this one has exited, so Quit runs in full and the lock is free by then
export function relaunch(app: { relaunch(): void, quit(): void }): void {
  app.relaunch()
  app.quit()
}

// How a run ends, which decides the restart marker. Only a clean Quit clears it: a quit after a failure keeps it and so
// does one that starts hetu again, Try again on the stopped screen or in the native box and Restart hetu. A change
// applied in the stopped mode clears it on its own. Try again and Restart hetu clear the start markers instead, so a
// control whose start hung starts as usual at the next launch
export class Ending {
  private failed = false
  private again = false

  // The log failed while hetu ran and the windows heard core.quitting
  fail(): void {
    this.failed = true
  }

  // Try again or Restart hetu
  relaunch(): void {
    this.again = true
  }

  // A quit the human asked for, which gives the windows a moment to keep their drafts
  asked(): boolean {
    return !this.failed
  }

  async leave(pluginsManager: { cleanQuit(): Promise<void>, triedAgain?(): Promise<void> } | null): Promise<void> {
    if (this.again) await pluginsManager?.triedAgain?.()
    else if (!this.failed) await pluginsManager?.cleanQuit()
  }
}

// How long windows hear core.quitting before a quit after a failure goes on, so the editor can keep a draft
export const QUIT_GRACE_MS = 2000
// How long a quit the human asked for waits after core.quitting before its windows close, for the same drafts
export const DRAFT_GRACE_MS = 750

// What a close of the editor window does. A close main makes itself goes on, as Quit closing the windows and the
// stopped mode leaving only the trusted window. A human close during a quit or once a failure is on its way to quitting
// is held, and that quit closes the window itself once its grace ended. Any other is held and hetu quits the way Quit
// does instead, the trusted window open or not, so the page keeps its drafts first
export function closeBecomesQuit(state: { byMain: boolean, quitting: boolean, failing: boolean }): 'close' | 'hold' | 'quit' {
  if (state.byMain) return 'close'
  return state.quitting || state.failing ? 'hold' : 'quit'
}

export type Closable = { close(): void, isDestroyed(): boolean }

// What a quit needs from main
export type QuitRunParts<W> = {
  // The windows a human sees
  windows(): Iterable<W>
  // Tells the windows hetu quits when they get a grace to keep their drafts, true when told
  announce(): boolean
  wait(ms: number): Promise<void>
  // All after the windows closed: the plugins manager's leave, Quit in its order, the hidden renderers
  finish(): Promise<void>
  // Once the quit settled, null when nothing threw
  exit(err: unknown): void
  // app.quit, which raises before-quit
  quit(): void
}

// The one quit of a run, kept apart from Electron so it runs in tests. Every window it closes is marked first, so only
// closes main makes itself go through while it runs
export class QuitRun<W extends Closable> {
  private run: Promise<void> | null = null
  private failing = false
  private readonly byMain = new WeakSet<W>()
  private readonly parts: QuitRunParts<W>

  constructor(parts: QuitRunParts<W>) {
    this.parts = parts
  }

  started(): boolean {
    return this.run !== null
  }

  // The first before-quit starts the quit and later ones join it. Set before any of it runs, so a close or a quit from
  // inside it never starts a second
  start(): void {
    if (this.run !== null) return
    this.run = Promise.resolve().then(async () => {
      if (this.parts.announce()) await this.parts.wait(DRAFT_GRACE_MS)
      for (const window of this.parts.windows()) this.close(window)
      await this.parts.finish()
    }).then(() => this.parts.exit(null), (err: unknown) => this.parts.exit(err))
  }

  // A window main closes itself, which closes with no quit
  close(window: W): void {
    if (window.isDestroyed()) return
    this.byMain.add(window)
    window.close()
  }

  // A failure is on its way to quitting with its own exit code and start again, which a human close joins
  failed(): void {
    this.failing = true
  }

  // The editor window's close event
  editorClosing(window: W, event: { preventDefault(): void }): void {
    const done = closeBecomesQuit({ byMain: this.byMain.has(window), quitting: this.run !== null, failing: this.failing })
    if (done === 'close') return
    event.preventDefault()
    if (done === 'quit') this.parts.quit()
  }
}

// What main does about a failure, kept apart from Electron so it runs in tests
export type FailureParts = {
  quitting(): boolean
  announce(): void
  quit(code: number, again: boolean): void
  // How the run ends, told of a failure and of Try again in the native box
  ending: Ending
  showTrusted(): void
  // The native box naming why hetu stopped, with quit only. It returns once the human closed it
  // The human's answer, Try again offered only for a control that failed at start
  showBox(mode: StoppedMode): 'quit' | 'retry'
  closeEditors(): void
  // From here a human close of the editor waits for this failure's quit
  holdCloses(): void
  editorsOpen(): boolean
  packaged: boolean
  env: Record<string, string | undefined>
  later(run: () => void, ms: number): void
}

// The native box for the stopped mode while the security view is off: the cause, what to fix before hetu starts again
// and its buttons. A control that failed at start can be tried again, while starting with it switched off needs the
// typed word the security view holds
export function stoppedBox(mode: StoppedMode): { title: string, message: string, detail: string, buttons: string[] } {
  if (mode.why === 'start-failed') {
    return {
      title: 'hetu stopped',
      message: stoppedCause(mode),
      detail: `The security view is off, so hetu can’t start with ${mode.control} switched off. Try again starts hetu again`,
      buttons: ['Quit', 'Try again'],
    }
  }
  const fix = mode.control === 'log' ? 'Free space or fix the data folder’s permissions, then start hetu' : 'Repair hetu with its installer'
  return {
    title: 'hetu stopped',
    message: stoppedCause(mode),
    detail: `The security view is off, so the choices that would start hetu again can’t be made. ${fix}`,
    buttons: ['Quit'],
  }
}

// A control that failed while hetu ran: windows hear core.quitting, then after the grace hetu quits with exit code 1
// and starts again, unless HETU_NO_RELAUNCH says not to. Once the plugins manager stopped in the stopped mode instead, only the
// trusted window stays
export function afterFailure(
  failure: Failure,
  parts: FailureParts,
): void {
  if (failure.action === 'stopped' && failure.box) {
    parts.holdCloses()
    const boxed = () => {
      // A quit the human started in the grace goes on with this failure's exit code and no box
      if (parts.quitting()) {
        parts.quit(1, false)
        return
      }
      parts.closeEditors()
      const retry = parts.showBox(failure.mode) === 'retry'
      if (retry) parts.ending.relaunch()
      parts.quit(1, retry && relaunches({ packaged: parts.packaged, env: parts.env }))
    }
    // An open editor hears core.quitting and gets the draft grace a Quit gives, since the box blocks main once shown
    if (!parts.editorsOpen()) return boxed()
    parts.announce()
    parts.later(boxed, DRAFT_GRACE_MS)
    return
  }
  if (failure.action === 'stopped') {
    parts.showTrusted()
    parts.closeEditors()
    return
  }
  if (parts.quitting()) return
  parts.ending.fail()
  parts.holdCloses()
  parts.announce()
  const again = relaunches({ packaged: parts.packaged, env: parts.env })
  parts.later(() => parts.quit(1, again), QUIT_GRACE_MS)
}

// Whether hetu starts again after quitting for a failure. A run from the source with HETU_NO_RELAUNCH set to 1, as the
// end-to-end tests run it, exits without starting again, so the test starts the next run itself. A packaged build
// ignores it
export function relaunches(options: { packaged: boolean, env: Record<string, string | undefined> }): boolean {
  return options.packaged || options.env.HETU_NO_RELAUNCH !== '1'
}
