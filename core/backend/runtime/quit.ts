// What Quit needs from the joined core and from boot
export type QuitParts = {
  loader: { shutdown(): Promise<void> }
  carrier: { flush(): Promise<void>, close(): void }
  release(): Promise<void>
}

// The longest Quit waits on each step before it goes on. Shutdown stops one plugin at a time, each within its stop
// grace, so its deadline only catches a loader that hangs. A flush waits on an append that may never settle
export type Deadlines = { readonly shutdown: number, readonly flush: number, readonly release: number }
export const QUIT_DEADLINES: Deadlines = Object.freeze({ shutdown: 30_000, flush: 2_000, release: 2_000 })

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))

// shutdown, flush, close, flush and release. The first flush writes what the audit queue holds and gives a floor
// backlog waiting to retry one more try before close drops it. The second writes the records of the calls close
// stopped and waits for the drain close leaves running, which carries the counts close writes.
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
  await wait('shutdown', () => parts.loader.shutdown(), deadlines.shutdown)
  await wait('flush', () => parts.carrier.flush(), deadlines.flush)
  try {
    parts.carrier.close()
  } catch (err) {
    missed.push(`close: ${reason(err)}`)
  }
  await wait('flush', () => parts.carrier.flush(), deadlines.flush)
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

// Whether hetu starts again after quitting for a failure. A run from the source with HETU_NO_RELAUNCH set to 1, as the
// end-to-end tests run it, exits without starting again, so the test starts the next run itself. A packaged build
// ignores it
export function relaunches(options: { packaged: boolean, env: Record<string, string | undefined> }): boolean {
  return options.packaged || options.env.HETU_NO_RELAUNCH !== '1'
}
