import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { takeLock } from './lock.ts'

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function lockPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hetu-lock-test-'))
  made.push(dir)
  return path.join(dir, 'door.lock')
}
// A pid no process holds: past the largest pid macOS, Linux and Windows hand out
const DEAD = 2 ** 30
const settled = async (promise: Promise<unknown>) => {
  let done = false
  void promise.then(() => { done = true }, () => { done = true })
  await new Promise(resolve => setTimeout(resolve, 150))
  return done
}

describe('the tier 0 lock', () => {
  it('holds a second caller until the first releases, then hands it over', async () => {
    const lock = await lockPath()
    const first = await takeLock(lock, { poll: 20 })
    const second = takeLock(lock, { poll: 20 })
    expect(await settled(second)).toBe(false)
    await first()
    const release = await second
    await release()
    expect(await readdir(path.dirname(lock))).toEqual([])
  })

  it('takes over a lock whose owner died', async () => {
    const lock = await lockPath()
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: DEAD, startedAt: Date.now(), token: 'gone' }))
    const release = await takeLock(lock, { poll: 20, ms: 1000 })
    await release()
  })

  it('takes over an empty owner file only once it is older than the stale time', async () => {
    const lock = await lockPath()
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner.json'), '')
    await expect(takeLock(lock, { poll: 20, ms: 300, staleMs: 5000 })).rejects.toThrow(/waited/)
    const old = new Date(Date.now() - 10_000)
    await utimes(path.join(lock, 'owner.json'), old, old)
    await utimes(lock, old, old)
    const release = await takeLock(lock, { poll: 20, ms: 1000, staleMs: 5000 })
    await release()
  })

  it('lets one of two callers break a stale lock and makes the other wait for it', async () => {
    const lock = await lockPath()
    await mkdir(lock)
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: DEAD, startedAt: 0, token: 'gone' }))
    const both = [takeLock(lock, { poll: 10 }), takeLock(lock, { poll: 10 })]
    const first = await Promise.race(both.map((taken, at) => taken.then(release => ({ release, at }))))
    expect(await settled(both[1 - first.at]!)).toBe(false)
    await first.release()
    await (await both[1 - first.at]!)()
  })

  it('is free again after a start that failed past taking it, and stops waiting when aborted', async () => {
    const lock = await lockPath()
    const release = await takeLock(lock)
    await expect((async () => {
      try {
        throw new Error('the launch failed')
      } finally {
        await release()
      }
    })()).rejects.toThrow('the launch failed')
    await release()
    const again = await takeLock(lock, { ms: 200 })
    const abort = new AbortController()
    const waiting = takeLock(lock, { signal: abort.signal, poll: 20 })
    abort.abort()
    await expect(waiting).rejects.toThrow(/aborted/)
    await again()
  })
})
