import { stoppedCause, type StoppedMode } from '../../api/actions.ts'
import type { Failure } from './header.ts'

// What Quit needs from the joined core and from boot
export type QuitParts = {
  pluginsManager: { shutdown(): Promise<void> }
  carrier: { close(): void }
  recording: { flush(): Promise<void> }
  release(): Promise<void>
}

// The longest Quit waits on each step before it goes on. Shutdown stops one plugin at a time, each within its stop
// grace, so its deadline only catches a plugins manager that hangs. A flush waits on an append that may never settle
export type Deadlines = { readonly shutdown: number, readonly flush: number, readonly release: number }
export const QUIT_DEADLINES: Deadlines = Object.freeze({ shutdown: 30_000, flush: 2_000, release: 2_000 })

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// shutdown, flush, close, flush and release. The first flush writes what the audit queue holds and gives a core record
// backlog waiting to retry one more try before close drops it. Closing the carrier ends every way and closes
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
    parts.carrier.close()
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

// How long windows hear core.quitting before a quit after a failure goes on, so the editor can keep a draft
export const QUIT_GRACE_MS = 2000
// How long a quit the human asked for waits after core.quitting before its windows close, for the same drafts
export const DRAFT_GRACE_MS = 750

// What main does about a failure, kept apart from Electron so it runs in tests
export type FailureParts = {
  quitting(): boolean
  announce(): void
  quit(code: number, again: boolean): void
  showTrusted(): void
  // The native box naming why hetu stopped, with quit only. It returns once the human closed it
  showBox(mode: StoppedMode): void
  closeEditors(): void
  packaged: boolean
  env: Record<string, string | undefined>
  later(run: () => void, ms: number): void
}

// The native box for the stopped mode while the security view is off: the cause, and what to fix before hetu starts again
export function stoppedBox(mode: StoppedMode): { title: string, message: string, detail: string } {
  const fix = mode.control === 'log' ? 'Free space or fix the data folder’s permissions, then start hetu' : 'Repair hetu with its installer'
  return {
    title: 'hetu stopped',
    message: stoppedCause(mode),
    detail: `The security view is off, so the choices that would start hetu again can’t be made. ${fix}`,
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
    parts.closeEditors()
    parts.showBox(failure.mode)
    parts.quit(1, false)
    return
  }
  if (failure.action === 'stopped') {
    parts.showTrusted()
    parts.closeEditors()
    return
  }
  if (parts.quitting()) return
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
