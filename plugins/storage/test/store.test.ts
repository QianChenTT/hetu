import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from 'hetu-core/api/envelope.ts'
import { quotas } from 'hetu-core/api/storage.ts'
import type { Call } from 'hetu-core/api/slots.ts'
import { createStorage, fileOf, type Storage } from '../src/store.ts'

const plugin = (id: string): Caller => ({ kind: 'plugin', id, half: 'worker', incarnation: 1 })
const editor: Caller = { kind: 'window', role: 'editor', n: 0 }
const search = plugin('search')

let dataDir: string
let n = 0

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'hetu-storage-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

function opened(options: Parameters<typeof createStorage>[0] = {}): Storage {
  const store = createStorage(options)
  store.open(dataDir)
  return store
}

// One call through prepare and perform, as the carrier makes it. A refusal comes back as the value thrown
async function ask(store: Storage, caller: Caller, action: string, args: object): Promise<unknown> {
  const call: Call = { callId: `c${++n}`, caller, action, args, deadline: Date.now() + 30000 }
  const prepared = await store.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await store.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

const spaceDir = (kind: 'storage' | 'cache', space: string) => path.join(dataDir, kind, space)
const keyFile = (kind: 'storage' | 'cache', space: string, key: string) => path.join(spaceDir(kind, space), fileOf(key))

describe('a caller\'s own space', () => {
  it('answers what was set, null for a key never set, and null for set and delete', async () => {
    const store = opened()
    expect(await ask(store, search, 'storage.get', { key: 'index' })).toBeNull()
    expect(await ask(store, search, 'storage.set', { key: 'index', value: { notes: ['a.md'], count: 1, done: true, gone: null } })).toBeNull()
    expect(await ask(store, search, 'storage.get', { key: 'index' })).toEqual({ notes: ['a.md'], count: 1, done: true, gone: null })
    expect(await ask(store, search, 'storage.delete', { key: 'index' })).toBeNull()
    expect(await ask(store, search, 'storage.get', { key: 'index' })).toBeNull()
    expect(await ask(store, search, 'storage.delete', { key: 'index' })).toBeNull()
  })

  it('keeps each plugin, the editor window and the cache apart', async () => {
    const store = opened()
    await ask(store, search, 'storage.set', { key: 'k', value: 'search' })
    await ask(store, plugin('git'), 'storage.set', { key: 'k', value: 'git' })
    await ask(store, editor, 'storage.set', { key: 'k', value: 'editor' })
    await ask(store, search, 'cache.set', { key: 'k', value: 'cached' })
    expect(await ask(store, search, 'storage.get', { key: 'k' })).toBe('search')
    expect(await ask(store, plugin('git'), 'storage.get', { key: 'k' })).toBe('git')
    expect(await ask(store, editor, 'storage.get', { key: 'k' })).toBe('editor')
    expect(await ask(store, search, 'cache.get', { key: 'k' })).toBe('cached')
    expect(await ask(store, plugin('other'), 'storage.get', { key: 'k' })).toBeNull()
    expect((await readdir(path.join(dataDir, 'storage'))).sort()).toEqual(['git', 'search', 'window.editor'])
  })

  it('is one space for every half and incarnation of a plugin', async () => {
    const store = opened()
    await ask(store, { kind: 'plugin', id: 'search', half: 'host', incarnation: 1 }, 'storage.set', { key: 'k', value: 1 })
    expect(await ask(store, { kind: 'plugin', id: 'search', half: 'worker', incarnation: 4 }, 'storage.get', { key: 'k' })).toBe(1)
  })

  it('keeps what was set for the next run', async () => {
    await ask(opened(), search, 'storage.set', { key: 'settings', value: { theme: 'dark' } })
    await ask(opened(), search, 'cache.set', { key: 'index', value: [1, 2] })
    const later = opened()
    expect(await ask(later, search, 'storage.get', { key: 'settings' })).toEqual({ theme: 'dark' })
    expect(await ask(later, search, 'cache.get', { key: 'index' })).toEqual([1, 2])
  })

  it('refuses a content caller, which has no space yet', async () => {
    const content: Caller = { kind: 'content', plugin: 'search', token: 'a'.repeat(32) }
    expect(await ask(opened(), content, 'storage.get', { key: 'k' })).toEqual({ refused: { code: 'not-granted' } })
  })

  it('refuses undefined, which JSON can\'t hold, and a key outside the grammar', async () => {
    const store = opened()
    expect(await ask(store, search, 'storage.set', { key: 'k', value: undefined })).toEqual({ refused: { code: 'invalid' } })
    expect(await ask(store, search, 'storage.set', { key: 'k' })).toEqual({ refused: { code: 'invalid' } })
    for (const key of ['../git/k', 'K', 'a.b', 'a b', 'a:b', 'a\\b', '', 'a'.repeat(65)]) {
      expect(await ask(store, search, 'storage.get', { key })).toEqual({ refused: { code: 'invalid' } })
    }
  })
})

describe('the file a key is kept in', () => {
  it('is key- and the key with each capital written as _ and the letter, so case pairs stay two keys', async () => {
    expect(fileOf('index')).toBe('key-index')
    expect(fileOf('myKey')).toBe('key-my_key')
    expect(fileOf('aB')).toBe('key-a_b')
    const store = opened()
    await ask(store, search, 'storage.set', { key: 'aB', value: 'upper' })
    await ask(store, search, 'storage.set', { key: 'ab', value: 'lower' })
    expect(await ask(store, search, 'storage.get', { key: 'aB' })).toBe('upper')
    expect(await ask(store, search, 'storage.get', { key: 'ab' })).toBe('lower')
    expect((await readdir(spaceDir('storage', 'search'))).sort()).toEqual(['key-a_b', 'key-ab'])
  })

  it.each(['con', 'cON', 'nul', 'aux', 'prn', 'com1', 'lpt9', 'conin', 'clock'])('is a plain file for %s, named like a Windows device', async key => {
    const store = opened()
    await ask(store, search, 'storage.set', { key, value: key })
    expect(await ask(store, search, 'storage.get', { key })).toBe(key)
    expect(await readdir(spaceDir('storage', 'search'))).toEqual([fileOf(key)])
    expect(await ask(store, search, 'storage.delete', { key })).toBeNull()
    expect(await readdir(spaceDir('storage', 'search'))).toEqual([])
  })

  it('never holds the ~ an 8.3 alias carries, so no key opens another key\'s file through one', () => {
    for (const key of ['a', 'abcdefghijkl', 'aVeryLongKeyName', `a${'Z'.repeat(63)}`]) expect(fileOf(key)).toMatch(/^key-[a-z0-9_]+$/)
  })
})

describe('a stored key\'s hash line', () => {
  async function stored(key = 'grants', value: unknown = { agent: 'a' }): Promise<{ store: Storage, file: string, bytes: Buffer }> {
    const store = opened()
    await ask(store, search, 'storage.set', { key, value })
    const file = keyFile('storage', 'search', key)
    return { store, file, bytes: await readFile(file) }
  }

  it('sits under one JSON line naming the key', async () => {
    const { bytes } = await stored()
    const [line, hash, end] = bytes.toString('utf8').split('\n')
    expect(JSON.parse(line)).toEqual({ key: 'grants', value: { agent: 'a' } })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(end).toBe('')
  })

  it.each([
    ['an edited value', (text: string) => text.replace('"a"', '"b"')],
    ['an edited hash', (text: string) => text.replace(/[0-9a-f](?=\n$)/, c => (c === '0' ? '1' : '0'))],
    ['the hash line gone', (text: string) => `${text.split('\n')[0]}\n`],
    ['half the file', (text: string) => text.slice(0, text.length / 2)],
    ['an empty file', () => ''],
  ])('answers tampered for %s', async (_name, damage) => {
    const { store, file, bytes } = await stored()
    await writeFile(file, damage(bytes.toString('utf8')))
    expect(await ask(store, search, 'storage.get', { key: 'grants' })).toEqual({ refused: { code: 'tampered' } })
  })

  it('answers tampered for another key\'s file copied in, whose hash still checks', async () => {
    const { store, bytes } = await stored('other', { agent: 'b' })
    await ask(store, search, 'storage.set', { key: 'grants', value: { agent: 'a' } })
    await writeFile(keyFile('storage', 'search', 'grants'), bytes)
    expect(await ask(store, search, 'storage.get', { key: 'grants' })).toEqual({ refused: { code: 'tampered' } })
  })

  it('answers tampered for a hashed body that isn\'t one object with the key and a value', async () => {
    const { createHash } = await import('node:crypto')
    const store = opened()
    for (const body of ['[1]\n', '{"key":"grants"}\n', '{"key":"grants","value":1,"more":2}\n', 'not json\n']) {
      await mkdir(spaceDir('storage', 'search'), { recursive: true })
      await writeFile(keyFile('storage', 'search', 'grants'), `${body}${createHash('sha256').update(body).digest('hex')}\n`)
      expect(await ask(store, search, 'storage.get', { key: 'grants' })).toEqual({ refused: { code: 'tampered' } })
    }
  })

  it('lets the plugin set or delete a tampered key, since it decides', async () => {
    const { store, file } = await stored()
    await writeFile(file, 'edited')
    expect(await ask(store, search, 'storage.set', { key: 'grants', value: 'fresh' })).toBeNull()
    expect(await ask(store, search, 'storage.get', { key: 'grants' })).toBe('fresh')
    await writeFile(file, 'edited')
    expect(await ask(store, search, 'storage.delete', { key: 'grants' })).toBeNull()
    expect(await ask(store, search, 'storage.get', { key: 'grants' })).toBeNull()
  })
})

describe('the cache', () => {
  it('has no hash line and answers an edit as it reads, since the plugin can rebuild it', async () => {
    const store = opened()
    await ask(store, search, 'cache.set', { key: 'index', value: [1] })
    const file = keyFile('cache', 'search', 'index')
    expect((await readFile(file, 'utf8')).split('\n').filter(line => line !== '')).toHaveLength(1)
    await writeFile(file, '{"key":"index","value":[2]}\n')
    expect(await ask(store, search, 'cache.get', { key: 'index' })).toEqual([2])
  })

  it.each([['bytes that don\'t parse', 'not json'], ['another key\'s line', '{"key":"other","value":[2]}\n'], ['an empty file', '']])(
    'answers null for %s', async (_name, text) => {
      const store = opened()
      await ask(store, search, 'cache.set', { key: 'index', value: [1] })
      await writeFile(keyFile('cache', 'search', 'index'), text)
      expect(await ask(store, search, 'cache.get', { key: 'index' })).toBeNull()
    })
})

describe('the quota', () => {
  const small = { storage: { bytes: 400, keys: 3 }, cache: { bytes: 300, keys: 2 } }

  it('is core/api\'s unless a test passes its own', () => {
    expect(createStorage().quotas).toEqual(quotas)
  })

  it('refuses a set that takes a space past its bytes with failed and quota', async () => {
    const store = opened({ quotas: small })
    expect(await ask(store, search, 'storage.set', { key: 'a', value: 'x'.repeat(100) })).toBeNull()
    expect(await ask(store, search, 'storage.set', { key: 'b', value: 'x'.repeat(100) })).toBeNull()
    expect(await ask(store, search, 'storage.set', { key: 'c', value: 'x'.repeat(100) })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, search, 'storage.get', { key: 'c' })).toBeNull()
    // Another space isn't counted against this one
    expect(await ask(store, plugin('git'), 'storage.set', { key: 'c', value: 'x'.repeat(100) })).toBeNull()
  })

  it('refuses a set past its keys, counts a replaced key once and frees what a delete took', async () => {
    const store = opened({ quotas: small })
    for (const key of ['a', 'b', 'c']) expect(await ask(store, search, 'storage.set', { key, value: 1 })).toBeNull()
    expect(await ask(store, search, 'storage.set', { key: 'd', value: 1 })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, search, 'storage.set', { key: 'a', value: 2 })).toBeNull()
    await ask(store, search, 'storage.delete', { key: 'b' })
    expect(await ask(store, search, 'storage.set', { key: 'd', value: 1 })).toBeNull()
  })

  it('holds the cache to its own numbers', async () => {
    const store = opened({ quotas: small })
    for (const key of ['a', 'b']) expect(await ask(store, search, 'cache.set', { key, value: 1 })).toBeNull()
    expect(await ask(store, search, 'cache.set', { key: 'c', value: 1 })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, search, 'cache.set', { key: 'a', value: 'x'.repeat(400) })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, search, 'cache.get', { key: 'a' })).toBe(1)
  })

  it('counts from disk, so a space the loader cleared takes a full quota again', async () => {
    const store = opened({ quotas: small })
    for (const key of ['a', 'b', 'c']) await ask(store, search, 'storage.set', { key, value: 1 })
    await rm(spaceDir('storage', 'search'), { recursive: true })
    for (const key of ['d', 'e', 'f']) expect(await ask(store, search, 'storage.set', { key, value: 1 })).toBeNull()
  })

  it('lets one of two sets that each fit alone through when both together don\'t', async () => {
    const store = opened({ quotas: small })
    const both = await Promise.all(['a', 'b', 'c', 'd'].map(key => ask(store, search, 'storage.set', { key, value: 1 })))
    expect(both.filter(answer => answer === null)).toHaveLength(3)
    expect(both.filter(answer => answer !== null)).toEqual([{ refused: { code: 'failed', reason: 'quota' } }])
  })
})

describe('calls on one space', () => {
  it('run in the order they came, so the last set wins', async () => {
    const store = opened()
    await Promise.all(Array.from({ length: 10 }, (_, i) => ask(store, search, 'storage.set', { key: 'k', value: i })))
    expect(await ask(store, search, 'storage.get', { key: 'k' })).toBe(9)
  })

  it('counts only key files, so a file of another name in the space takes nothing from the quota', async () => {
    await mkdir(spaceDir('storage', 'search'), { recursive: true })
    await writeFile(path.join(spaceDir('storage', 'search'), 'notes.txt'), 'x'.repeat(1000))
    const store = opened({ quotas: { storage: { bytes: 400, keys: 3 }, cache: { bytes: 400, keys: 3 } } })
    expect(await ask(store, search, 'storage.set', { key: 'a', value: 1 })).toBeNull()
  })

  it('remove the temp files a crash left the first time the space is touched and never count them', async () => {
    await mkdir(spaceDir('storage', 'search'), { recursive: true })
    await writeFile(path.join(spaceDir('storage', 'search'), 'key-a.5f0e.tmp'), 'x'.repeat(1000))
    const store = opened({ quotas: { storage: { bytes: 400, keys: 3 }, cache: { bytes: 400, keys: 3 } } })
    expect(await ask(store, search, 'storage.set', { key: 'a', value: 1 })).toBeNull()
    expect(await readdir(spaceDir('storage', 'search'))).toEqual(['key-a'])
  })
})

describe('a clear of a space', () => {
  it('runs after every call already queued on it, so no set queued before the clear survives it', async () => {
    const store = opened()
    await ask(store, search, 'storage.set', { key: 'kept', value: 1 })
    const queued = Array.from({ length: 20 }, (_, i) => ask(store, search, 'storage.set', { key: `planted${i}`, value: i }))
    // Each set's prepare answers first, then its perform joins the space's queue, as for a plugin the loader then stops
    await new Promise(resolve => setImmediate(resolve))
    const cleared = store.clear('storage', 'search')
    await Promise.all(queued)
    await cleared
    expect(await readdir(spaceDir('storage', 'search')).catch(() => [])).toEqual([])
    expect(await ask(store, search, 'storage.get', { key: 'kept' })).toBeNull()
    // A set after the clear starts the space again
    expect(await ask(store, search, 'storage.set', { key: 'fresh', value: 2 })).toBeNull()
    expect(await ask(store, search, 'storage.get', { key: 'fresh' })).toBe(2)
  })

  it('clears the cache apart from storage and leaves other spaces alone', async () => {
    const store = opened()
    await ask(store, search, 'storage.set', { key: 'k', value: 1 })
    await ask(store, search, 'cache.set', { key: 'k', value: 1 })
    await ask(store, plugin('git'), 'cache.set', { key: 'k', value: 1 })
    await store.clear('cache', 'search')
    expect(await ask(store, search, 'cache.get', { key: 'k' })).toBeNull()
    expect(await ask(store, search, 'storage.get', { key: 'k' })).toBe(1)
    expect(await ask(store, plugin('git'), 'cache.get', { key: 'k' })).toBe(1)
  })
})
