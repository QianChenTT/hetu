// A lock every tier 0 process on the machine sees: a folder, made or not in one step, holding its owner's pid, start
// time and a token of its own. A lock whose owner died, or whose owner file stayed empty or unreadable past the stale
// time, is broken behind a second folder of the same kind, so two waiters never both break it
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type LockOptions = { ms?: number, staleMs?: number, poll?: number, signal?: AbortSignal }
type Owner = { pid: number, startedAt: number, token: string }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function owner(lock: string): Promise<Owner | null> {
  try {
    return JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')) as Owner
  } catch {
    // Missing, empty or half written all read as no owner, which the stale time judges
    return null
  }
}
const age = (file: string) => stat(file).then(found => Date.now() - found.mtimeMs, () => null)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM is a live process of another user, ESRCH a dead one
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Whether the lock as it stands now is stale: its owner dead, or no readable owner past the stale time. A lock made a
// moment ago has no owner written yet and is not
async function stale(lock: string, staleMs: number): Promise<boolean> {
  const held = await owner(lock)
  if (held !== null) return !alive(held.pid)
  const since = await age(lock)
  return since !== null && since > staleMs
}

// Waits for the lock and answers its release. Throws once ms passed or the signal aborted
export async function takeLock(lock: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const { ms = 90_000, staleMs = 5000, poll = 100, signal } = options
  const token = randomUUID()
  const breaking = `${lock}.breaking`
  for (const begun = Date.now(); ;) {
    if (signal?.aborted) throw new Error(`aborted waiting for ${path.basename(lock)}`)
    try {
      await mkdir(lock)
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token } satisfies Owner))
      if ((await owner(lock))?.token !== token) throw new Error(`${path.basename(lock)} changed hands while it was taken`)
      return async () => {
        if ((await owner(lock))?.token === token) await rm(lock, { recursive: true, force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    if (await stale(lock, staleMs)) {
      // A breaker that died leaves its folder, which is short-lived, so an old one is taken away first
      if (((await age(breaking)) ?? 0) > staleMs) await rm(breaking, { recursive: true, force: true })
      const broke = await mkdir(breaking).then(() => true, () => false)
      if (broke) {
        try {
          // Judged again behind the breaker's folder, since another waiter may have broken it and taken it since
          if (await stale(lock, staleMs)) await rm(lock, { recursive: true, force: true })
        } finally {
          await rm(breaking, { recursive: true, force: true })
        }
        continue
      }
    }
    if (Date.now() - begun > ms) throw new Error(`waited ${ms / 1000} s for ${path.basename(lock)}, held by ${JSON.stringify(await owner(lock))}`)
    await sleep(poll)
  }
}
