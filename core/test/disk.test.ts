import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { retried, syncDir, writable } from '../backend/disk.ts'

const platform = process.platform
const pretend = (name: string) => Object.defineProperty(process, 'platform', { value: name })
const fail = (code: string) => Object.assign(new Error(code), { code })

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-disk-'))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  pretend(platform)
  await rm(dir, { recursive: true, force: true })
})

// Fake timers, so the whole window runs in no time and its length is measured exactly
async function timed(work: () => Promise<unknown>, calls: () => number) {
  vi.useFakeTimers()
  const started = Date.now()
  const outcome = work().then(() => 'resolved', err => (err as NodeJS.ErrnoException).code)
  await vi.runAllTimersAsync()
  return { outcome: await outcome, ms: Date.now() - started, calls: calls() }
}

describe('retried on Windows', () => {
  beforeEach(() => pretend('win32'))

  it.each(['EPERM', 'EBUSY', 'EACCES'])('waits out %s for about 2.5 seconds over 9 tries, then throws it', async code => {
    const work = vi.fn(() => Promise.reject(fail(code)))
    const { outcome, ms, calls } = await timed(() => retried(work), () => work.mock.calls.length)
    expect(outcome).toBe(code)
    expect(calls).toBe(9)
    expect(ms).toBe(10 + 20 + 40 + 80 + 160 + 320 + 640 + 1280)
  })

  it('gives back the answer once a lock has passed', async () => {
    const work = vi.fn()
      .mockRejectedValueOnce(fail('EBUSY'))
      .mockRejectedValueOnce(fail('EBUSY'))
      .mockResolvedValue('done')
    vi.useFakeTimers()
    const answer = retried(work)
    await vi.runAllTimersAsync()
    expect(await answer).toBe('done')
    expect(work).toHaveBeenCalledTimes(3)
  })

  it.each(['ENOENT', 'EISDIR', 'EINVAL', 'EEXIST'])('throws %s at once, it is not a lock', async code => {
    const work = vi.fn(() => Promise.reject(fail(code)))
    await expect(retried(work)).rejects.toThrow(code)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('throws at once when a folder is in the way', async () => {
    const target = path.join(dir, 'in-the-way')
    await mkdir(target)
    const work = vi.fn(() => Promise.reject(fail('EPERM')))
    await expect(retried(work, target)).rejects.toThrow('EPERM')
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('waits out a sharing lock on a read for the same window', async () => {
    const work = vi.fn(() => Promise.reject(fail('EBUSY')))
    const { outcome, calls } = await timed(() => retried(work, undefined, 'read'), () => work.mock.calls.length)
    expect(outcome).toBe('EBUSY')
    expect(calls).toBe(9)
  })

  // Access denied on a read is an ACL, which never passes, so waiting would cost 2.5 seconds per file at every boot
  it.each(['EPERM', 'EACCES'])('throws %s on a read at once', async code => {
    const work = vi.fn(() => Promise.reject(fail(code)))
    await expect(retried(work, undefined, 'read')).rejects.toThrow(code)
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('still waits out a lock on a read of a read-only file, the attribute doesn\'t block a read', async () => {
    const target = path.join(dir, 'read-only')
    await writeFile(target, 'x')
    await chmod(target, 0o444)
    const work = vi.fn(() => Promise.reject(fail('EBUSY')))
    // Real timers, the check on the file is real I/O that fake timers would run ahead of
    try {
      await expect(retried(work, target, 'read')).rejects.toThrow('EBUSY')
      expect(work).toHaveBeenCalledTimes(9)
    } finally {
      await chmod(target, 0o666)
    }
  }, 10_000)

  it('throws at once when the target is a read-only file, which is not a lock either', async () => {
    const target = path.join(dir, 'read-only')
    await writeFile(target, 'x')
    await chmod(target, 0o444)
    const work = vi.fn(() => Promise.reject(fail('EPERM')))
    try {
      await expect(retried(work, target)).rejects.toThrow('EPERM')
      // Only Windows has a read-only attribute that shows in the mode this way
      if (platform === 'win32') expect(work).toHaveBeenCalledTimes(1)
    } finally {
      await chmod(target, 0o666)
    }
  })
})

describe('writable', () => {
  it('leaves a folder alone', async () => {
    pretend('win32')
    const folder = path.join(dir, 'folder')
    await mkdir(folder)
    await writable(folder)
    expect((await lstat(folder)).isDirectory()).toBe(true)
  })

  it('does nothing for a file that is not there', async () => {
    pretend('win32')
    await writable(path.join(dir, 'gone'))
  })

  it.runIf(platform === 'win32')('clears the read-only attribute on a file', async () => {
    const file = path.join(dir, 'read-only')
    await writeFile(file, 'x')
    await chmod(file, 0o444)
    await writable(file)
    expect((await lstat(file)).mode & 0o200).not.toBe(0)
  })

  it.runIf(platform !== 'win32')('leaves the mode alone off Windows, where a read-only mode is the owner\'s choice', async () => {
    const file = path.join(dir, 'read-only')
    await writeFile(file, 'x')
    await chmod(file, 0o444)
    await writable(file)
    expect((await lstat(file)).mode & 0o777).toBe(0o444)
    await chmod(file, 0o666)
  })
})

describe('retried elsewhere', () => {
  it.each(['linux', 'darwin'])('throws a lock error at once on %s, where nothing holds files this way', async name => {
    pretend(name)
    const work = vi.fn(() => Promise.reject(fail('EBUSY')))
    await expect(retried(work)).rejects.toThrow('EBUSY')
    expect(work).toHaveBeenCalledTimes(1)
  })
})

describe.skipIf(platform === 'win32')('syncDir', () => {
  it('syncs a folder', async () => {
    await syncDir(dir)
  })

  it('does nothing for a folder that is not there', async () => {
    await syncDir(path.join(dir, 'gone'))
  })
})

describe.runIf(platform === 'win32')('syncDir on Windows', () => {
  it('does nothing, Node can not open a folder for it', async () => {
    await syncDir(path.join(dir, 'gone'))
  })
})
