import { watch, type FSWatcher } from 'chokidar'
import path from 'node:path'
import type { VaultCore } from './core.ts'
import { callContext } from './log.ts'

// A save outside the daemon (an editor, Obsidian, a script) is a human edit. Commit it once the file has been quiet for debounceMs
export function watchVault(core: VaultCore, debounceMs: number): FSWatcher {
  const timers = new Map<string, NodeJS.Timeout>()
  const watcher = watch(core.root, {
    ignoreInitial: true,
    ignored: (p: string) => p.split(/[\\/]/).includes('.git'),
    // Editors often write a file in several chunks, wait for the size to settle
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  })

  const onChange = (abs: string) =>
    callContext.run({ source: 'watcher' }, async () => {
      const p = path.relative(core.root, abs).split(path.sep).join('/')
      if (!(await core.noticeChange(p))) return
      clearTimeout(timers.get(p))
      timers.set(
        p,
        setTimeout(() => {
          timers.delete(p)
          core.commitHumanEdit(p).catch(err => core.events.emit('git.failed', { op: 'commit', path: p, error: String(err) }, 'error'))
        }, debounceMs),
      )
    })

  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange)
  watcher.on('error', err => core.events.emit('watch.error', { error: String(err) }, 'error'))
  const close = watcher.close.bind(watcher)
  watcher.close = async () => {
    for (const t of timers.values()) clearTimeout(t)
    return close()
  }
  return watcher
}
