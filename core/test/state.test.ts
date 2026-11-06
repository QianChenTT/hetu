import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contentHash, defaultState, stateDir, StateStore, type Check, type Loaded } from '../backend/boot/state.ts'
import { HOLD_TIMEOUT, holdOpen, onWindows, release, releaseAfter, releaseAll } from './hold.ts'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

// FileHandle isn't exported, so its prototype comes from a handle opened once
async function fileHandleProto() {
  const handle = await open(path.join(dir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(handle)
  await handle.close()
  await rm(path.join(dir, 'probe'))
  return proto
}

const HASH = 'a'.repeat(64)
const noSwitches = { guardsOff: [], devMode: false, skipVerification: false, allowUnsigned: [] }
const switchesIn = { guardsOff: ['leases'], devMode: true, skipVerification: false, allowUnsigned: [HASH] }
const pluginIn = (over: object = {}) => ({
  version: '1.0.0',
  contentHash: HASH,
  signer: 'github.com/someone/search/.github/workflows/release.yml',
  granted: [{ type: 'vault.read', paths: ['**'] }],
  class: 1,
  enabled: true,
  ...over,
})
// Every capability type, so each schema has to accept every one
const everyCapability = [
  { type: 'vault.read', paths: ['**'] },
  { type: 'vault.write', paths: ['04 - Daily/**'] },
  { type: 'net.fetch', hosts: ['example.com'] },
  { type: 'ui.panel' },
  { type: 'ui.decoration' },
  { type: 'ui.command' },
  { type: 'ui.statusBar' },
  { type: 'events.subscribe', topics: ['note.written'] },
  { type: 'storage' },
  { type: 'history', access: 'read', paths: ['**'] },
  { type: 'history', access: 'commit', paths: ['04 - Daily/**'] },
  { type: 'exec', commands: [['git', 'status']], env: ['HOME'] },
]

let dir: string
let store: StateStore
const stateFile = (...parts: string[]) => path.join(dir, 'state', ...parts)
const switchesPath = () => stateFile('switches.json')
const pluginPath = (id: string) => stateFile('plugins', `${id}.json`)
// A state file is its JSON and then one line holding the hash of every byte above it
const hashLine = (body: Buffer | string) => `${sha256(body)}\n`
async function bodyOf(file: string) {
  const text = await readFile(file, 'utf8')
  return text.slice(0, text.lastIndexOf('\n', text.length - 2) + 1)
}
const jsonOf = async (file: string) => JSON.parse(await bodyOf(file))
const hashOf = async (file: string) => (await readFile(file, 'utf8')).slice((await bodyOf(file)).length)

// What a program that knows hetu does: writes the bytes, ending in a newline, and a matching hash line after them
async function plant(file: string, bytes: Buffer | string) {
  const body = Buffer.from(bytes)
  const ended = body.at(-1) === 0x0a ? body : Buffer.concat([body, Buffer.from('\n')])
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, Buffer.concat([ended, Buffer.from(hashLine(ended))]))
}

async function pluginFiles(id: string, files: Record<string, string>) {
  const root = path.join(dir, 'plugins', id)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
  return root
}

// A plugin after install: code on disk and an entry holding the hash of that code
async function addPlugin(id: string, over: object = {}) {
  const root = await pluginFiles(id, { 'a.js': id })
  await store.writePlugin(id, pluginIn({ contentHash: await contentHash(root), ...over }))
  return root
}

async function snapshot() {
  const seen: Record<string, string> = {}
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name)
    seen[path.relative(dir, file)] = entry.isFile() ? (await readFile(file)).toString('base64') : '<folder>'
  }
  return seen
}

const result = (loaded: Loaded, check: Check['check'], id?: string) =>
  loaded.checks.find(c => c.check === check && c.id === id)?.result

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-state-'))
  store = new StateStore(dir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await releaseAll()
  await rm(dir, { recursive: true, force: true })
})

describe('defaults', () => {
  it('has every guard on and no plugins', () => {
    expect(defaultState()).toEqual({ plugins: {}, switches: noSwitches })
  })

  it('hands out a new object each time, so a caller can not change the next default', () => {
    defaultState().switches.guardsOff.push('leases')
    expect(defaultState().switches.guardsOff).toEqual([])
  })
})

describe('stateDir', () => {
  it('uses local app data on Windows, which does not roam', () => {
    expect(stateDir('win32', { LOCALAPPDATA: 'C:\\Users\\han\\AppData\\Local', APPDATA: 'C:\\Users\\han\\AppData\\Roaming' }))
      .toBe('C:\\Users\\han\\AppData\\Local\\hetu')
  })

  it('refuses to guess when local app data is not set', () => {
    expect(() => stateDir('win32', {})).toThrow(/LOCALAPPDATA/)
  })

  it('refuses a relative path, which would land wherever hetu started', () => {
    expect(() => stateDir('win32', { LOCALAPPDATA: 'notes' })).toThrow(/LOCALAPPDATA/)
  })

  it('uses Application Support on macOS, with forward slashes whatever runs the code', () => {
    expect(stateDir('darwin', { HOME: '/Users/han' })).toBe('/Users/han/Library/Application Support/hetu')
  })

  it('refuses a macOS home that is not set, relative or empty', () => {
    expect(() => stateDir('darwin', {})).toThrow(/HOME/)
    expect(() => stateDir('darwin', { HOME: 'han' })).toThrow(/HOME/)
    expect(() => stateDir('darwin', { HOME: '' })).toThrow(/HOME/)
  })

  it('does not take a Windows path as absolute on macOS', () => {
    expect(() => stateDir('darwin', { HOME: 'C:\\Users\\han' })).toThrow(/HOME/)
  })

  it('uses XDG_STATE_HOME on Linux when it is set', () => {
    expect(stateDir('linux', { XDG_STATE_HOME: '/data/state', HOME: '/home/han' })).toBe('/data/state/hetu')
  })

  it('falls back to .local/state under the home on Linux', () => {
    expect(stateDir('linux', { HOME: '/home/han' })).toBe('/home/han/.local/state/hetu')
  })

  it('does not need a home on Linux when XDG_STATE_HOME is set', () => {
    expect(stateDir('linux', { XDG_STATE_HOME: '/data/state' })).toBe('/data/state/hetu')
  })

  it('refuses a relative XDG_STATE_HOME instead of falling back to the home', () => {
    expect(() => stateDir('linux', { XDG_STATE_HOME: 'state', HOME: '/home/han' })).toThrow(/XDG_STATE_HOME/)
  })

  it('refuses an empty XDG_STATE_HOME instead of falling back to the home', () => {
    expect(() => stateDir('linux', { XDG_STATE_HOME: '', HOME: '/home/han' })).toThrow(/XDG_STATE_HOME/)
  })

  it('refuses a Linux home that is not set or relative when it is needed', () => {
    expect(() => stateDir('linux', {})).toThrow(/HOME/)
    expect(() => stateDir('linux', { HOME: 'han' })).toThrow(/HOME/)
  })

  it('refuses a platform with no design yet', () => {
    expect(() => stateDir('freebsd', { HOME: '/home/han', LOCALAPPDATA: 'C:\\Users\\han\\AppData\\Local' })).toThrow(/freebsd/)
  })
})

describe('contentHash', () => {
  it('hashes each file by path, size and bytes in sorted order', async () => {
    const root = await pluginFiles('search', { 'b.js': 'two', 'sub/a.js': 'one', 'a.js': 'zero' })
    const expected = createHash('sha256')
      .update('a.js\u00004\u0000zero')
      .update('b.js\u00003\u0000two')
      .update('sub/a.js\u00003\u0000one')
      .digest('hex')
    expect(await contentHash(root)).toBe(expected)
  })

  // NTFS lists a.js/b.js, a.js, B.js in that order, so the hash only matches if the code sorts by code unit itself
  it('sorts by code unit, not in the order the file system lists', async () => {
    const root = await pluginFiles('search', { 'a.js': '1', 'a/b.js': '2', 'B.js': '3' })
    const expected = createHash('sha256')
      .update('B.js\u00001\u00003')
      .update('a.js\u00001\u00001')
      .update('a/b.js\u00001\u00002')
      .digest('hex')
    expect(await contentHash(root)).toBe(expected)
  })

  it('tells apart the same bytes split across files differently', async () => {
    const one = await pluginFiles('one', { 'a': 'xy', 'b': 'z' })
    const two = await pluginFiles('two', { 'a': 'x', 'b': 'yz' })
    expect(await contentHash(one)).not.toBe(await contentHash(two))
  })

  it('refuses a link inside the folder', async () => {
    const outside = await pluginFiles('outside', { 'secret.js': '1' })
    const root = await pluginFiles('search', { 'a.js': '1' })
    await symlink(outside, path.join(root, 'link'), 'junction')
    await expect(contentHash(root)).rejects.toThrow(/not a file or folder: link/)
  })

  it('refuses a folder that is itself a link', async () => {
    const outside = await pluginFiles('outside', { 'a.js': '1' })
    const link = path.join(dir, 'plugins', 'search')
    await symlink(outside, link, 'junction')
    await expect(contentHash(link)).rejects.toThrow(/not a folder/)
  })
})

describe('writing', () => {
  async function writeAll() {
    await store.writeSwitches(switchesIn)
    await store.writePlugin('search', pluginIn())
  }

  it('puts each file where the layout says and nothing else', async () => {
    await writeAll()
    expect((await readdir(stateFile())).sort()).toEqual(['plugins', 'switches.json'])
    expect((await readdir(stateFile('plugins'))).sort()).toEqual(['search.json'])
  })

  it('gives each file its format number and its own content', async () => {
    await writeAll()
    expect(await jsonOf(switchesPath())).toEqual({ format: 1, ...switchesIn })
    expect(await jsonOf(pluginPath('search'))).toEqual({ format: 1, ...pluginIn() })
  })

  it('ends every file with one line holding the hash of the exact bytes above it', async () => {
    await writeAll()
    for (const file of [switchesPath(), pluginPath('search')]) {
      const body = await bodyOf(file)
      expect(body.endsWith('}\n')).toBe(true)
      expect(await hashOf(file)).toBe(hashLine(body))
      expect(await readFile(file, 'utf8')).toBe(body + hashLine(body))
    }
  })

  it('loads back what it wrote, every check ok and nothing suspect', async () => {
    await addPlugin('search')
    await addPlugin('git')
    await store.writeSwitches(switchesIn)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.state.switches).toEqual(switchesIn)
    expect(Object.keys(loaded.state.plugins)).toEqual(['git', 'search'])
    expect(loaded.state.plugins.search).toEqual(pluginIn({ contentHash: await contentHash(path.join(dir, 'plugins', 'search')) }))
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'ok' },
      { check: 'plugin-entry', id: 'git', result: 'ok' },
      { check: 'plugin-files', id: 'git', result: 'ok' },
      { check: 'plugin-entry', id: 'search', result: 'ok' },
      { check: 'plugin-files', id: 'search', result: 'ok' },
    ])
  })

  it('takes back what load returned, so a caller can change one part and write it', async () => {
    await store.writeSwitches(switchesIn)
    await addPlugin('search')
    const { state } = await store.load()
    await store.writeSwitches(state.switches)
    await store.writePlugin('search', state.plugins.search)
    const again = await store.load()
    expect(again.suspect).toBe(false)
    expect(again.state.switches).toEqual(switchesIn)
    expect(again.state.plugins.search).toEqual(state.plugins.search)
  })

  it('accepts every capability type in a plugin, on the way in and on the way out', async () => {
    await addPlugin('search', { granted: everyCapability })
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.state.plugins.search.granted).toEqual(everyCapability)
  })

  it('writes a plugin whose id has dashes and underscores', async () => {
    await addPlugin('my-plugin-x_2')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-files', 'my-plugin-x_2')).toBe('ok')
    expect(loaded.suspect).toBe(false)
  })

  it('answers an unknown name with nothing, even one that every object has', async () => {
    await addPlugin('search')
    const { state } = await store.load()
    expect(state.plugins['constructor']).toBeUndefined()
    expect(state.plugins['toString']).toBeUndefined()
    expect(state.plugins['__proto__']).toBeUndefined()
    expect(defaultState().plugins['toString']).toBeUndefined()
  })

  it('leaves no temp files behind', async () => {
    await writeAll()
    await writeAll()
    expect((await readdir(stateFile())).sort()).toEqual(['plugins', 'switches.json'])
    expect((await readdir(stateFile('plugins'))).sort()).toEqual(['search.json'])
  })

  it('cleans up its temp file when a write fails, and fails at once on a folder in the way', async () => {
    await mkdir(switchesPath(), { recursive: true })
    const started = Date.now()
    await expect(store.writeSwitches(switchesIn)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(await readdir(stateFile())).toEqual(['switches.json'])
  })

  it('puts a new file in place rather than writing over the old one', async () => {
    await store.writeSwitches(switchesIn)
    const before = await stat(switchesPath(), { bigint: true })
    await store.writeSwitches(noSwitches)
    const after = await stat(switchesPath(), { bigint: true })
    expect(after.ino).not.toBe(before.ino)
  })

  // Folders can't be synced from Node on Windows, elsewhere each rename's folder is synced too
  it('syncs the file to disk', async () => {
    const sync = vi.spyOn(await fileHandleProto(), 'sync')
    await store.writeSwitches(switchesIn)
    expect(sync).toHaveBeenCalledTimes(onWindows ? 1 : 2)
  })

  describe.runIf(onWindows)('a file another program holds open', { timeout: HOLD_TIMEOUT }, () => {
    it('waits out a reader holding the file', async () => {
      await store.writeSwitches(noSwitches)
      const reader = await holdOpen(switchesPath(), 'Read')
      await Promise.all([store.writeSwitches(switchesIn), releaseAfter(reader, 300)])
      const loaded = await store.load()
      expect(result(loaded, 'switches')).toBe('ok')
      expect(loaded.state.switches).toEqual(switchesIn)
    })

    it('waits out a reader holding the entry of a plugin it removes', async () => {
      await store.writePlugin('search', pluginIn())
      const reader = await holdOpen(pluginPath('search'), 'Read')
      await Promise.all([store.removePlugin('search'), releaseAfter(reader, 300)])
      expect(await readdir(stateFile('plugins'))).toEqual([])
    })

    // rm deletes a read-only file by itself, so the read-only check that stops a write mustn't stop a delete
    it('waits out a hold on a read-only entry of a plugin it removes', async () => {
      await store.writePlugin('search', pluginIn())
      await chmod(pluginPath('search'), 0o444)
      const holder = await holdOpen(pluginPath('search'), 'None')
      await Promise.all([store.removePlugin('search'), releaseAfter(holder, 300)])
      expect(await readdir(stateFile('plugins'))).toEqual([])
    })

    it('replaces the file when a restore left it read-only', async () => {
      await store.writeSwitches(noSwitches)
      await chmod(switchesPath(), 0o444)
      await store.writeSwitches(switchesIn)
      const loaded = await store.load()
      expect(result(loaded, 'switches')).toBe('ok')
      expect(loaded.state.switches).toEqual(switchesIn)
    })

    it('waits out a short hold on a read-only file at load, a read is not blocked by the attribute', async () => {
      await store.writeSwitches(switchesIn)
      await chmod(switchesPath(), 0o444)
      const holder = await holdOpen(switchesPath(), 'None')
      const [loaded] = await Promise.all([store.load(), releaseAfter(holder, 300)])
      expect(result(loaded, 'switches')).toBe('ok')
    })

    it('waits out a short hold on a plugin code file at load', async () => {
      const root = await addPlugin('search')
      // Read-only too, which a read gets past, so only the read's own retry waits out the hold
      await chmod(path.join(root, 'a.js'), 0o444)
      const holder = await holdOpen(path.join(root, 'a.js'), 'None')
      const [loaded] = await Promise.all([store.load(), releaseAfter(holder, 300)])
      expect(result(loaded, 'plugin-files', 'search')).toBe('ok')
    })

    it('waits out a short hold at load rather than reading the file as unreadable', async () => {
      await store.writeSwitches(switchesIn)
      const holder = await holdOpen(switchesPath(), 'None')
      const [loaded] = await Promise.all([store.load(), releaseAfter(holder, 300)])
      expect(result(loaded, 'switches')).toBe('ok')
      expect(loaded.suspect).toBe(false)
    })

    // With the hash inside the file one rename writes both, so a write that fails leaves the old state as it was
    it('gives up after a few seconds and leaves the old file whole, which still reads as ok', async () => {
      await store.writeSwitches(noSwitches)
      const reader = await holdOpen(switchesPath(), 'Read')
      try {
        await expect(store.writeSwitches(switchesIn)).rejects.toThrow(/EPERM|EBUSY|EACCES/)
      } finally {
        await release(reader)
      }
      const loaded = await store.load()
      expect(result(loaded, 'switches')).toBe('ok')
      expect(loaded.state.switches).toEqual(noSwitches)
    }, 15_000)
  })

  describe('refusing bad input', () => {
    const refused: [string, () => Promise<void>][] = [
      ['a switch that is not a boolean', () => store.writeSwitches({ ...switchesIn, devMode: 'true' })],
      ['an unknown switch', () => store.writeSwitches({ ...switchesIn, gateOff: true })],
      ['switches that carry a format', () => store.writeSwitches({ ...switchesIn, format: 1 })],
      ['a guard name that is not a plugin id', () => store.writeSwitches({ ...switchesIn, guardsOff: ['../leases'] })],
      ['an allowlist entry that is not a hash', () => store.writeSwitches({ ...switchesIn, allowUnsigned: ['abc'] })],
      ['a plugin with an unknown capability', () => store.writePlugin('search', pluginIn({ granted: [{ type: 'host.replace' }] }))],
      // Entries are for folder plugins, which never hold an install-only type
      ['a plugin with an install-only capability', () => store.writePlugin('search', pluginIn({ granted: [{ type: 'guard.hook' }] }))],
      ['a plugin with an unknown field', () => store.writePlugin('search', pluginIn({ extra: 1 }))],
      ['a plugin that carries its own id', () => store.writePlugin('search', pluginIn({ id: 'search' }))],
      ['a plugin that carries a format', () => store.writePlugin('search', pluginIn({ format: 1 }))],
      ['a plugin class out of range', () => store.writePlugin('search', pluginIn({ class: 5 }))],
      ['a content hash that is not a hash', () => store.writePlugin('search', pluginIn({ contentHash: 'abc' }))],
      ['a plugin capability with no scope', () => store.writePlugin('search', pluginIn({ granted: [{ type: 'net.fetch' }] }))],
      // An extra key on each kind of capability, which a loose schema would strip without a word
      ...everyCapability.map((capability): [string, () => Promise<void>] => [
        `a ${capability.type} capability with an extra key`,
        () => store.writePlugin('search', pluginIn({ granted: [{ ...capability, ...('paths' in capability ? { hosts: ['x'] } : { paths: ['**'] }) }] })),
      ]),
    ]

    it.each(refused)('refuses %s and changes nothing on disk', async (_name, write) => {
      await writeAll()
      const before = await snapshot()
      await expect(write()).rejects.toThrow()
      expect(await snapshot()).toEqual(before)
    })

    const badIds = ['../evil', '..', 'a/b', 'a\\b', 'search.', '.search', 'Search', 'a b', 'a..b', '', 'evil\0',
      'con', 'prn', 'aux', 'nul', 'com0', 'com9', 'lpt0', 'lpt1', 'lpt9', 'con.x', 'nul.json', 'my.plugin', 'x.con']

    it.each(['console', 'com10', 'lpt', 'auxiliary', 'x-con'])('takes %j, which only looks like a device name', async id => {
      await store.writePlugin(id, pluginIn())
      expect(await readdir(stateFile('plugins'))).toContain(`${id}.json`)
    })

    it.each(badIds)('refuses to write a plugin named %j and creates nothing', async id => {
      await expect(store.writePlugin(id, pluginIn())).rejects.toThrow()
      expect(await readdir(dir, { recursive: true })).toEqual([])
    })

    it.each(['../switches', '..', 'a/b', 'Search', ''])('refuses to remove a plugin named %j and touches nothing', async id => {
      await writeAll()
      const before = await snapshot()
      await expect(store.removePlugin(id)).rejects.toThrow()
      expect(await snapshot()).toEqual(before)
    })
  })

  describe('overlapping calls', () => {
    it('keeps the last call on disk with a matching hash when writes overlap', async () => {
      await Promise.all(['1', '2', '3', '4', '5'].map(n => store.writePlugin('search', pluginIn({ version: `${n}.0.0` }))))
      expect(await hashOf(pluginPath('search'))).toBe(hashLine(await bodyOf(pluginPath('search'))))
      expect((await jsonOf(pluginPath('search'))).version).toBe('5.0.0')
    })

    // One rename per file means a load can't see half a write anyway, what the queue still gives is order
    it('lets a load called after two writes see both, without waiting for them first', async () => {
      const writes = [store.writeSwitches(switchesIn), store.writePlugin('search', pluginIn())]
      const loaded = await store.load()
      await Promise.all(writes)
      expect(loaded.state.switches).toEqual(switchesIn)
      expect(result(loaded, 'plugin-entry', 'search')).toBe('ok')
    })

    it('keeps going after a queued call fails', async () => {
      await store.writePlugin('search', pluginIn())
      await rm(pluginPath('search'))
      await mkdir(pluginPath('search'))
      await expect(store.removePlugin('search')).rejects.toThrow()
      await expect(store.writeSwitches(switchesIn)).resolves.toBeUndefined()
      expect((await store.load()).state.switches).toEqual(switchesIn)
    })
  })
})

type Kind = {
  name: string
  file: () => string
  valid: object
  seed: () => Promise<void>
  // A change that is still valid, the kind an attacker wants
  edit: (text: string) => string
  result: (loaded: Loaded) => string | undefined
  absent: string | undefined
  seeded: (loaded: Loaded) => void
  fellBack: (loaded: Loaded) => void
  rejected: [string, string | Buffer][]
}

const capabilityCases = (wrap: (capability: object) => string): [string, string][] => [
  ['an unknown capability type', wrap({ type: 'vault.delete', paths: ['**'] })],
  ['an install-only capability type', wrap({ type: 'guard.hook' })],
  ['a capability with the scope of another', wrap({ type: 'vault.read', hosts: ['example.com'] })],
  ['a capability with no scope', wrap({ type: 'net.fetch' })],
  ['an exec command as a string', wrap({ type: 'exec', commands: ['git status'], env: [] })],
  ['an empty exec command', wrap({ type: 'exec', commands: [[]], env: [] })],
  ['an unknown history access', wrap({ type: 'history', access: 'rewrite', paths: ['**'] })],
  ['a duplicate key in a capability', wrap({ type: 'vault.read', paths: ['safe/**'] }).replace('"paths":["safe/**"]', '"paths":["safe/**"],"paths":["**"]')],
]

const badUtf8 = (before: string, after: string) => Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)])

const kinds: Kind[] = [
  {
    name: 'switches',
    file: switchesPath,
    valid: { format: 1, ...switchesIn },
    seed: () => store.writeSwitches(switchesIn),
    edit: text => text.replace('"devMode": true', '"devMode": false'),
    result: loaded => result(loaded, 'switches'),
    absent: 'absent',
    seeded: loaded => expect(loaded.state.switches).toEqual(switchesIn),
    fellBack: loaded => expect(loaded.state.switches).toEqual(noSwitches),
    rejected: [
      ['a missing switch', JSON.stringify({ format: 1, guardsOff: [], devMode: false, allowUnsigned: [] })],
      ['an unknown switch', JSON.stringify({ format: 1, ...switchesIn, gateOff: true })],
      ['devMode that is not a boolean', JSON.stringify({ format: 1, ...switchesIn, devMode: 'true' })],
      ['skipVerification that is not a boolean', JSON.stringify({ format: 1, ...switchesIn, skipVerification: 1 })],
      ['a guard list that is a string', JSON.stringify({ format: 1, ...switchesIn, guardsOff: 'leases' })],
      ['a guard name that is not a plugin id', JSON.stringify({ format: 1, ...switchesIn, guardsOff: ['../leases'] })],
      ['an allowlist entry that is not a hash', JSON.stringify({ format: 1, ...switchesIn, allowUnsigned: ['abc'] })],
      ['an uppercase allowlist hash', JSON.stringify({ format: 1, ...switchesIn, allowUnsigned: ['A'.repeat(64)] })],
      ['a duplicate switch', JSON.stringify({ format: 1, ...switchesIn }).replace('"devMode":true', '"devMode":false,"devMode":true')],
    ],
  },
  {
    name: 'plugin entry',
    file: () => pluginPath('search'),
    valid: { format: 1, ...pluginIn() },
    seed: async () => { await addPlugin('search') },
    edit: text => text.replace('"class": 1', '"class": 0'),
    result: loaded => result(loaded, 'plugin-entry', 'search'),
    absent: undefined,
    seeded: loaded => expect(loaded.state.plugins.search).toMatchObject({ version: '1.0.0', class: 1, enabled: true }),
    fellBack: loaded => expect(loaded.state.plugins.search).toBeUndefined(),
    rejected: [
      ['a missing field', JSON.stringify({ format: 1, ...pluginIn(), enabled: undefined })],
      ['an unknown plugin field', JSON.stringify({ format: 1, ...pluginIn(), extra: 1 })],
      ['an id inside the file, which the file name already gives', JSON.stringify({ format: 1, ...pluginIn(), id: 'other' })],
      ['a content hash that is not a hash', JSON.stringify({ format: 1, ...pluginIn({ contentHash: 'abc' }) })],
      ['an uppercase content hash', JSON.stringify({ format: 1, ...pluginIn({ contentHash: 'A'.repeat(64) }) })],
      ['a class out of range', JSON.stringify({ format: 1, ...pluginIn({ class: 5 }) })],
      ['a negative class', JSON.stringify({ format: 1, ...pluginIn({ class: -1 }) })],
      ['a class that is not whole', JSON.stringify({ format: 1, ...pluginIn({ class: 1.5 }) })],
      ['an empty version', JSON.stringify({ format: 1, ...pluginIn({ version: '' }) })],
      ['an empty signer', JSON.stringify({ format: 1, ...pluginIn({ signer: '' }) })],
      ['a signer that is not text or null', JSON.stringify({ format: 1, ...pluginIn({ signer: 5 }) })],
      ['enabled that is not a boolean', JSON.stringify({ format: 1, ...pluginIn({ enabled: 'yes' }) })],
      ['bytes that are not UTF-8', badUtf8('{"format":1,"version":"1.0.', `","contentHash":"${HASH}","signer":null,"granted":[],"class":1,"enabled":true}`)],
      ...capabilityCases(capability => JSON.stringify({ format: 1, ...pluginIn({ granted: [capability] }) })),
    ],
  },
]

// Same rules for every kind of file: a failure shows in that file's check and falls back for that file alone
describe.each(kinds)('the $name file', kind => {
  const validText = JSON.stringify(kind.valid)
  const raw: [string, string | Buffer][] = [
    ['not JSON', 'hello'],
    ['an empty file', ''],
    ['a comment', `${validText} // note`],
    ['a trailing comma', validText.replace(/}$/, ',}')],
    ['a BOM', `\ufeff${validText}`],
    ['a duplicate top level key', validText.replace('{"format":1', '{"format":2,"format":1')],
    ['a duplicate key hidden by an escape', validText.replace('{"format":1', '{"format":2,"\\u0066ormat":1')],
    ['__proto__ at the top', validText.replace('{"format":1', '{"__proto__":{"devMode":true},"format":1')],
    ['nesting too deep to parse', `${'['.repeat(200000)}${']'.repeat(200000)}`],
    ['an unknown format', validText.replace('{"format":1', '{"format":2')],
    ['an unknown top level field', validText.replace(/}$/, ',"extra":1}')],
  ]

  it('loads what was written', async () => {
    await kind.seed()
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('ok')
    expect(loaded.suspect).toBe(false)
    kind.seeded(loaded)
  })

  it('is absent when neither file exists, which is not suspect', async () => {
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe(kind.absent)
    expect(loaded.suspect).toBe(false)
    kind.fellBack(loaded)
  })

  it('reads a deleted file as absent, which is not suspect', async () => {
    await kind.seed()
    await rm(kind.file())
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe(kind.absent)
    expect(loaded.suspect).toBe(false)
    kind.fellBack(loaded)
  })

  it('fails closed on one changed byte', async () => {
    await kind.seed()
    const text = await readFile(kind.file(), 'utf8')
    await writeFile(kind.file(), kind.edit(text))
    const loaded = await store.load()
    expect(kind.edit(text)).not.toBe(text)
    expect(kind.result(loaded)).toBe('hash-mismatch')
    expect(loaded.suspect).toBe(true)
    kind.fellBack(loaded)
  })

  // The hash line is exact too, an editor or a sync conflict can leave any of these. A last line that isn't a hash
  // means there is none, one that is but doesn't match is a mismatch
  const changedHashes: [string, (hash: string) => string, string][] = [
    ['no hash line', () => '', 'hash-missing'],
    ['a hash cut short', hash => `${hash.slice(0, 32)}\n`, 'hash-missing'],
    ['a blank line after the hash', hash => `${hash}\n\n`, 'hash-missing'],
    ['a hash with CRLF', hash => `${hash}\r\n`, 'hash-missing'],
    ['a hash with no newline after it', hash => hash, 'hash-mismatch'],
    ['a hash in upper case', hash => `${hash.toUpperCase()}\n`, 'hash-mismatch'],
    ['a hash with one character changed', hash => `${hash[0] === 'a' ? 'b' : 'a'}${hash.slice(1)}\n`, 'hash-mismatch'],
  ]

  it.each(changedHashes)('fails closed on %s', async (_name, change, expected) => {
    await kind.seed()
    const body = await bodyOf(kind.file())
    await writeFile(kind.file(), body + change(hashLine(body).trimEnd()))
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe(expected)
    expect(loaded.suspect).toBe(true)
    kind.fellBack(loaded)
  })

  it('counts a reformat of the same JSON as a mismatch', async () => {
    await kind.seed()
    await writeFile(kind.file(), `${JSON.stringify(await jsonOf(kind.file()))}\n${await hashOf(kind.file())}`)
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('hash-mismatch')
    expect(loaded.suspect).toBe(true)
  })

  // The hash of no bytes at all, so only the rule that a hash needs a body above it says this has none
  it('fails closed on a file that is only a hash line', async () => {
    await kind.seed()
    await writeFile(kind.file(), hashLine(''))
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('hash-missing')
    expect(loaded.suspect).toBe(true)
    kind.fellBack(loaded)
  })

  it('fails closed on the JSON alone, with its hash line taken off', async () => {
    await kind.seed()
    await writeFile(kind.file(), await bodyOf(kind.file()))
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('hash-missing')
    expect(loaded.suspect).toBe(true)
    kind.fellBack(loaded)
  })

  it('fails closed when the file can not be read, at once since a folder is not a lock', async () => {
    await mkdir(kind.file(), { recursive: true })
    const started = Date.now()
    const loaded = await store.load()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(kind.result(loaded)).toBe('unreadable')
    expect(loaded.suspect).toBe(true)
    kind.fellBack(loaded)
  })

  it('takes the next write of the file as the way out of a bad one', async () => {
    await kind.seed()
    await writeFile(kind.file(), kind.edit(await readFile(kind.file(), 'utf8')))
    expect(kind.result(await store.load())).toBe('hash-mismatch')
    await kind.seed()
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('ok')
    expect(loaded.suspect).toBe(false)
    kind.seeded(loaded)
  })

  it.each([...raw, ...kind.rejected].filter(([name]) => name !== 'bytes that are not UTF-8' || kind.name !== 'switches'))(
    'fails closed on %s',
    async (_name, bytes) => {
      await plant(kind.file(), bytes)
      const loaded = await store.load()
      expect(kind.result(loaded)).toBe('invalid')
      expect(loaded.suspect).toBe(true)
      kind.fellBack(loaded)
    },
  )
})

// The limits the design accepts: detect only against a program that knows hetu, threats 24, 25 and 55
describe('what the hash does not catch', () => {
  it('accepts an edit whose hash was rewritten too', async () => {
    await store.writeSwitches(noSwitches)
    await plant(switchesPath(), JSON.stringify({ format: 1, ...noSwitches, devMode: true }))
    const loaded = await store.load()
    expect(loaded.state.switches.devMode).toBe(true)
    expect(loaded.suspect).toBe(false)
  })

  it('accepts an older file put back with its own hash', async () => {
    await store.writeSwitches(switchesIn)
    const oldFile = await readFile(switchesPath())
    await store.writeSwitches(noSwitches)
    // The old file carries its own hash line, so a plain copy puts it back
    await writeFile(switchesPath(), oldFile)
    const loaded = await store.load()
    expect(loaded.state.switches.devMode).toBe(true)
    expect(loaded.suspect).toBe(false)
  })
})

describe('files that fail alone', () => {
  async function setup() {
    const searchRoot = await addPlugin('search')
    const gitRoot = await addPlugin('git')
    await store.writeSwitches(switchesIn)
    return { searchRoot, gitRoot }
  }

  const change = async (file: string) => writeFile(file, (await readFile(file, 'utf8')).replace('"version": "1.0.0"', '"version": "9.9.9"'))

  it('leaves every other plugin loaded when one plugin entry is edited', async () => {
    await setup()
    await change(pluginPath('search'))
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'plugin-entry', 'search')).toBe('hash-mismatch')
    expect(result(loaded, 'plugin-entry', 'git')).toBe('ok')
    expect(result(loaded, 'plugin-files', 'git')).toBe('ok')
    expect(Object.keys(loaded.state.plugins)).toEqual(['git'])
    expect(loaded.state.plugins.git.enabled).toBe(true)
    expect(loaded.state.switches).toEqual(switchesIn)
  })

  it('does not look at the code of a plugin whose entry failed', async () => {
    await setup()
    await change(pluginPath('search'))
    expect(result(await store.load(), 'plugin-files', 'search')).toBeUndefined()
  })

  it('leaves the plugins alone when the switches are edited', async () => {
    await setup()
    await writeFile(switchesPath(), (await readFile(switchesPath(), 'utf8')).replace('"devMode": true', '"devMode": false'))
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'switches')).toBe('hash-mismatch')
    expect(loaded.state.switches).toEqual(noSwitches)
    expect(Object.keys(loaded.state.plugins)).toEqual(['git', 'search'])
    expect(loaded.state.plugins.search.enabled).toBe(true)
    expect(loaded.state.plugins.git.enabled).toBe(true)
  })

  it('does not reset the switches when a plugin file changes', async () => {
    const { searchRoot } = await setup()
    await writeFile(path.join(searchRoot, 'a.js'), 'changed')
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'plugin-files', 'search')).toBe('mismatch')
    expect(result(loaded, 'switches')).toBe('ok')
    expect(loaded.state.switches).toEqual(switchesIn)
  })

  it('writing one file does not repair another bad one', async () => {
    await setup()
    await change(pluginPath('git'))
    await writeFile(switchesPath(), (await readFile(switchesPath(), 'utf8')).replace('"devMode": true', '"devMode": false'))
    await store.writeSwitches(switchesIn)
    const loaded = await store.load()
    expect(result(loaded, 'switches')).toBe('ok')
    expect(result(loaded, 'plugin-entry', 'git')).toBe('hash-mismatch')
    expect(loaded.suspect).toBe(true)
  })
})

describe('the plugin files check', () => {
  async function setup() {
    const searchRoot = await addPlugin('search')
    await addPlugin('git')
    return searchRoot
  }

  it('leaves every plugin enabled when all of them match', async () => {
    await setup()
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.state.plugins.search.enabled).toBe(true)
    expect(loaded.state.plugins.git.enabled).toBe(true)
  })

  it('turns off only the changed plugin and keeps it listed', async () => {
    const searchRoot = await setup()
    await writeFile(path.join(searchRoot, 'a.js'), 'changed')
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'plugin-files', 'search')).toBe('mismatch')
    expect(loaded.state.plugins.search.enabled).toBe(false)
    expect(loaded.state.plugins.search.version).toBe('1.0.0')
    expect(loaded.state.plugins.git.enabled).toBe(true)
  })

  it('catches a file dropped into the plugin', async () => {
    const searchRoot = await setup()
    await writeFile(path.join(searchRoot, 'extra.js'), 'new')
    expect(result(await store.load(), 'plugin-files', 'search')).toBe('mismatch')
  })

  it('catches a removed plugin folder', async () => {
    const searchRoot = await setup()
    await rm(searchRoot, { recursive: true })
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'plugin-files', 'search')).toBe('missing')
    expect(loaded.state.plugins.search.enabled).toBe(false)
  })

  it('catches a link swapped in for the plugin folder', async () => {
    const searchRoot = await setup()
    const copy = await pluginFiles('elsewhere', { 'a.js': 'search' })
    await rm(searchRoot, { recursive: true })
    await symlink(copy, searchRoot, 'junction')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-files', 'search')).toBe('unreadable')
    expect(loaded.state.plugins.search.enabled).toBe(false)
  })

  it('reports a change to a plugin that was already off', async () => {
    const searchRoot = await addPlugin('search', { enabled: false })
    await writeFile(path.join(searchRoot, 'a.js'), 'changed')
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'plugin-files', 'search')).toBe('mismatch')
  })

  it('checks each plugin against its own folder', async () => {
    const searchRoot = await setup()
    const gitRoot = path.join(dir, 'plugins', 'git')
    await writeFile(path.join(searchRoot, 'a.js'), 'git')
    await writeFile(path.join(gitRoot, 'a.js'), 'search')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-files', 'search')).toBe('mismatch')
    expect(result(loaded, 'plugin-files', 'git')).toBe('mismatch')
  })
})

describe('names in the plugins folder', () => {
  const entry = JSON.stringify({ format: 1, ...pluginIn() })

  it.each(['Evil', 'a b', '.hidden', 'trail.', 'a..b', '-a', '_a', 'a-', 'con', 'nul'])('ignores %j and reports it as invalid', async name => {
    await addPlugin('search')
    await plant(pluginPath(name), entry)
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', name)).toBe('invalid')
    expect(result(loaded, 'plugin-files', name)).toBeUndefined()
    expect(loaded.suspect).toBe(true)
    expect(Object.keys(loaded.state.plugins)).toEqual(['search'])
    expect(loaded.state.plugins.search.enabled).toBe(true)
  })

  it.each(['notes.txt', 'search.json.bak', 'search', 'search.json.sha256'])('reports a file that is not an entry, such as %j, as invalid', async name => {
    await addPlugin('search')
    await writeFile(stateFile('plugins', name), 'x')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', name)).toBe('invalid')
    expect(loaded.suspect).toBe(true)
    expect(loaded.state.plugins.search.enabled).toBe(true)
  })

  it.each(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'Desktop.ini'])('ignores %j, which the OS leaves in a folder someone looked at', async name => {
    await addPlugin('search')
    await writeFile(stateFile('plugins', name), entry)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.checks.map(c => c.id)).toEqual([undefined, 'search', 'search'])
  })

  it('ignores files ending in .tmp, which are what a crashed write leaves', async () => {
    await addPlugin('search')
    await writeFile(stateFile('plugins', 'search.json.0b6f.tmp'), 'half a fi')
    await writeFile(stateFile('plugins', 'search.json.sha256.0b6f.tmp'), 'ab')
    await writeFile(stateFile('plugins', 'Evil.json.tmp'), entry)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.checks.map(c => c.id)).toEqual([undefined, 'search', 'search'])
    expect(loaded.state.plugins.search.enabled).toBe(true)
  })

  it('reads a folder that is not there as no plugins', async () => {
    await store.writeSwitches(switchesIn)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'ok' },
    ])
  })

  it('fails closed when the folder can not be listed, without touching the other files', async () => {
    await store.writeSwitches(switchesIn)
    await writeFile(stateFile('plugins'), 'not a folder')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry')).toBe('unreadable')
    expect(loaded.suspect).toBe(true)
    expect(loaded.state.plugins).toEqual({})
    expect(loaded.state.switches).toEqual(switchesIn)
  })
})

describe('removing a plugin', () => {
  it('is fine with removing a plugin whose entry is already gone', async () => {
    await expect(store.removePlugin('search')).resolves.toBeUndefined()
  })

  // Reads like an uninstalled plugin, the same as a wiped file. The host's scan for a code folder with no entry (#66)
  // is what asks about it
  it('reads a deleted entry as no plugin at all, with no check of its own', async () => {
    await addPlugin('search')
    await rm(pluginPath('search'))
    const loaded = await store.load()
    expect(loaded.state.plugins.search).toBeUndefined()
    expect(loaded.checks.map(c => c.check)).toEqual(['switches'])
  })

  it('removes its entry and leaves the others', async () => {
    await addPlugin('search')
    await addPlugin('git')
    await store.removePlugin('search')
    expect((await readdir(stateFile('plugins'))).sort()).toEqual(['git.json'])
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(Object.keys(loaded.state.plugins)).toEqual(['git'])
    expect(result(loaded, 'plugin-entry', 'search')).toBeUndefined()
  })

  it('clears a bad entry, which is the way out for a plugin that did not load', async () => {
    await addPlugin('search')
    await writeFile(pluginPath('search'), 'tampered')
    expect(result(await store.load(), 'plugin-entry', 'search')).toBe('hash-missing')
    await store.removePlugin('search')
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.state.plugins).toEqual({})
  })

})

describe('loading', () => {
  it('reads no files at all as a first run, nothing suspect', async () => {
    const loaded = await store.load()
    expect(loaded.state).toEqual(defaultState())
    expect(loaded.suspect).toBe(false)
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'absent' },
    ])
  })

  it('creates nothing, not even the folder', async () => {
    await new StateStore(path.join(dir, 'never')).load()
    expect(await readdir(dir)).toEqual([])
  })

  it('changes nothing on disk, however much is wrong', async () => {
    const searchRoot = await addPlugin('search')
    await addPlugin('git')
    await store.writeSwitches(switchesIn)
    await writeFile(path.join(searchRoot, 'a.js'), 'changed')
    await writeFile(switchesPath(), 'tampered')
    await writeFile(pluginPath('git'), 'tampered')
    await writeFile(stateFile('plugins', 'notes.txt'), 'x')
    const before = await snapshot()
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(await snapshot()).toEqual(before)
  })
})
