// File system errors this PC can't produce on demand, made by a stand-in for node:fs/promises so they run everywhere
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import { syncDir } from '../backend/disk.ts'
import { EventLog } from '../backend/events/log.ts'

const fake = vi.hoisted(() => ({
  readError: null as null | { match: string, code: string },
  syncError: null as null | string,
  openDirError: null as null | string,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const fail = (code: string) => Object.assign(new Error(code), { code })
  return {
    ...real,
    readFile: (async (file: Parameters<typeof real.readFile>[0], ...rest: unknown[]) => {
      if (fake.readError && String(file).endsWith(fake.readError.match)) throw fail(fake.readError.code)
      return (real.readFile as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof real.readFile,
    // A folder opened for a sync gets a handle whose sync answers as the file system was told to
    open: (async (file: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
      const isDir = (await real.stat(file).catch(() => null))?.isDirectory()
      if (isDir && (fake.syncError || fake.openDirError)) {
        if (fake.openDirError) throw fail(fake.openDirError)
        return { sync: async () => { throw fail(fake.syncError!) }, close: async () => {} }
      }
      return (real.open as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof real.open,
  }
})

const platform = process.platform
const pretend = (name: string) => Object.defineProperty(process, 'platform', { value: name })
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-fs-'))
  // Not Windows, so a lock error isn't retried and the folder sync runs
  pretend('linux')
})

afterEach(async () => {
  fake.readError = null
  fake.syncError = null
  fake.openDirError = null
  pretend(platform)
  await rm(dir, { recursive: true, force: true })
})

describe('a log segment that can not be read', () => {
  it('fails open rather than calling it broken, on every platform', async () => {
    const events = path.join(dir, 'events')
    await mkdir(events, { recursive: true })
    const line = JSON.stringify({ seq: 1, prev: '0'.repeat(64), at: '2026-11-02T00:00:00.000Z', event: 'test.line' })
    await writeFile(path.join(events, 'events-1.jsonl'), `${line}\n`)
    fake.readError = { match: 'events-1.jsonl', code: 'EACCES' }
    const log = new EventLog(dir)
    await expect(log.open()).rejects.toThrow('EACCES')
    expect(log.healthy).toBe(false)
    expect(await readdir(events)).toEqual(['events-1.jsonl'])
  })
})

describe('a file system that can not sync a folder', () => {
  it.each(['EINVAL', 'ENOTSUP', 'EBADF'])('is fine with a folder sync answering %s', async code => {
    fake.syncError = code
    await syncDir(dir)
  })

  it('is fine with a folder that can not be opened for a sync', async () => {
    fake.openDirError = 'EACCES'
    await syncDir(dir)
  })

  it('still throws a sync error that means the disk failed', async () => {
    fake.syncError = 'EIO'
    await expect(syncDir(dir)).rejects.toThrow('EIO')
  })

  it('writes the hash after the file, so the pair still matches', async () => {
    fake.syncError = 'EINVAL'
    const store = new StateStore(dir)
    await store.writeSwitches({ guardsOff: [], devMode: true, skipVerification: false, allowUnsigned: [] })
    fake.syncError = null
    const loaded = await store.load()
    expect(loaded.checks[0]).toEqual({ check: 'switches', result: 'ok' })
    expect(JSON.parse(await readFile(path.join(dir, 'state', 'switches.json'), 'utf8')).devMode).toBe(true)
  })
})
