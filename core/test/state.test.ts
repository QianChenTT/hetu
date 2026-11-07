import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CAPABILITIES } from '../api/capabilities.ts'
import { MAX_FOLDER_LENGTH } from '../api/changes.ts'
import { MAX_TIMER_MS } from '../api/floor.ts'
import { installIds } from '../api/ids.ts'
import {
  defaultState, defaultSwitches, MAX_LISTED, stateDir, StateStore, type Check, type Loaded,
} from '../backend/boot/state.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'
import { HOLD_TIMEOUT, holdOpen, onWindows, release, releaseAfter, releaseAll } from './hold.ts'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const many = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i))

// FileHandle isn't exported, so its prototype comes from a handle opened once
async function fileHandleProto() {
  const handle = await open(path.join(dir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(handle)
  await handle.close()
  await rm(path.join(dir, 'probe'))
  return proto
}

const HASH = 'a'.repeat(64)
const noSwitches = {
  off: [],
  devMode: [],
  skipVerification: false,
  allowUnsigned: [],
  confirmOff: false,
  removed: [],
  execAnyCommand: [],
  limits: { all: {}, plugins: {} },
  recordNothing: false,
}
// Most switches away from the defaults, so a field the code drops or mixes up shows
const switchesIn = {
  off: ['gate', 'leases'],
  devMode: ['my-plugin'],
  skipVerification: false,
  allowUnsigned: [HASH],
  confirmOff: true,
  removed: ['git'],
  execAnyCommand: ['search'],
  limits: { all: { callsInFlight: 128 }, plugins: { search: { messagesPerSecond: 2000, readyMs: 20000 } } },
  recordNothing: false,
}
// Absolute by the rules of the platform the tests run on
const notes = onWindows ? 'C:\\Users\\han\\notes' : '/home/han/notes'
const luoshuIn = { folder: notes }
const pluginIn = (over: object = {}) => ({
  version: '1.0.0',
  contentHash: HASH,
  signer: 'github.com/someone/search/.github/workflows/release.yml',
  granted: [{ type: 'luoshu.read', paths: ['**'] }],
  class: 1,
  enabled: true,
  ...over,
})
// Every type a folder plugin may hold, so each schema has to accept every one
const everyCapability = [
  { type: 'luoshu.read', paths: ['**'] },
  { type: 'luoshu.write', paths: ['04 - Daily/**'] },
  { type: 'net.fetch', hosts: ['example.com'] },
  { type: 'ui.panel' },
  { type: 'ui.decoration' },
  { type: 'ui.command' },
  { type: 'ui.statusBar' },
  { type: 'ui.keys' },
  { type: 'events.subscribe', topics: ['note.written'] },
  { type: 'storage' },
  { type: 'history', access: 'read', paths: ['**'] },
  { type: 'history', access: 'commit', paths: ['04 - Daily/**'] },
  { type: 'exec', commands: [['git', 'status']], env: ['HOME'] },
  { type: 'plugin.call', targets: ['search'] },
  { type: 'log.read' },
]

let dir: string
let store: StateStore
const stateFile = (...parts: string[]) => path.join(dir, 'state', ...parts)
const switchesPath = () => stateFile('switches.json')
const luoshuPath = () => stateFile('luoshu.json')
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
  await store.writePlugin(id, pluginIn({ contentHash: hashFiles(await readFiles(root)), ...over }))
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
  it('loosen nothing: every install plugin on, empty lists, false switches, no raised limits and no luoshu', () => {
    expect(defaultSwitches()).toEqual(noSwitches)
    expect(defaultState()).toEqual({ plugins: {}, switches: noSwitches, luoshu: null })
  })

  it('hands out a new object each time, so a caller can not change the next default', () => {
    const changed = defaultState()
    changed.switches.off.push('leases')
    changed.switches.devMode.push('search')
    changed.switches.limits.all.callsInFlight = 1000
    changed.switches.limits.plugins.search = { readyMs: 1 }
    changed.plugins.search = pluginIn() as never
    expect(defaultState()).toEqual({ plugins: {}, switches: noSwitches, luoshu: null })
  })

  it('keeps every table free of a prototype, so a name every object has finds nothing', () => {
    const { plugins, switches } = defaultState()
    for (const found of [plugins, switches.limits.all, switches.limits.plugins]) {
      expect(Object.getPrototypeOf(found)).toBeNull()
      expect((found as Record<string, unknown>)['toString']).toBeUndefined()
    }
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

describe('writing', () => {
  async function writeAll() {
    await store.writeSwitches(switchesIn)
    await store.writeLuoshu(luoshuIn)
    await store.writePlugin('search', pluginIn())
  }

  it('puts each file where the layout says and nothing else', async () => {
    await writeAll()
    expect((await readdir(stateFile())).sort()).toEqual(['luoshu.json', 'plugins', 'switches.json'])
    expect((await readdir(stateFile('plugins'))).sort()).toEqual(['search.json'])
  })

  it('gives each file format 2 and its own content', async () => {
    await writeAll()
    expect(await jsonOf(switchesPath())).toEqual({ format: 2, ...switchesIn })
    expect(await jsonOf(luoshuPath())).toEqual({ format: 2, ...luoshuIn })
    expect(await jsonOf(pluginPath('search'))).toEqual({ format: 2, ...pluginIn() })
  })

  it('ends every file with one line holding the hash of the exact bytes above it', async () => {
    await writeAll()
    for (const file of [switchesPath(), luoshuPath(), pluginPath('search')]) {
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
    await store.writeLuoshu(luoshuIn)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.state.switches).toEqual(switchesIn)
    expect(loaded.state.luoshu).toEqual(luoshuIn)
    expect(Object.keys(loaded.state.plugins)).toEqual(['git', 'search'])
    expect(loaded.state.plugins.search).toEqual(pluginIn({ contentHash: hashFiles(await readFiles(path.join(dir, 'plugins', 'search'))) }))
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'ok' },
      { check: 'luoshu', result: 'ok' },
      { check: 'plugin-entry', id: 'git', result: 'ok' },
      { check: 'plugin-entry', id: 'search', result: 'ok' },
    ])
  })

  it('takes back what load returned, so a caller can change one part and write it', async () => {
    await writeAll()
    await addPlugin('search')
    const { state } = await store.load()
    state.switches.off.push('history')
    await store.writeSwitches(state.switches)
    await store.writeLuoshu(state.luoshu)
    await store.writePlugin('search', state.plugins.search)
    const again = await store.load()
    expect(again.suspect).toBe(false)
    expect(again.state.switches).toEqual({ ...switchesIn, off: ['gate', 'leases', 'history'] })
    expect(again.state.luoshu).toEqual(luoshuIn)
    expect(again.state.plugins.search).toEqual(state.plugins.search)
  })

  it('accepts every capability type a folder plugin may hold, on the way in and on the way out', async () => {
    await addPlugin('search', { granted: everyCapability })
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.state.plugins.search.granted).toEqual(everyCapability)
  })

  it('keeps a null class, which counts as 4 elsewhere', async () => {
    await addPlugin('search', { class: null })
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', 'search')).toBe('ok')
    expect(loaded.state.plugins.search.class).toBeNull()
  })

  it('takes every switch that names a plugin with any id some plugin can hold', async () => {
    const ids = ['watchdog', 'editor-core', 'search', 'my-plugin-x_2']
    const switches = {
      ...switchesIn,
      off: [...installIds],
      devMode: ids,
      execAnyCommand: ids,
      removed: ['mcp', 'git', 'search', 'file-explorer', 'artifacts', 'notify'],
      limits: { all: {}, plugins: Object.fromEntries(ids.map(id => [id, { heartbeatMs: 9000 }])) },
    }
    await store.writeSwitches(switches)
    expect((await store.load()).state.switches).toEqual(switches)
  })

  it('takes the most each list and map of plugins holds', async () => {
    // Pinned, since the cases follow MAX_LISTED wherever it goes. A lower cap would read a file another format 2 build
    // wrote as invalid
    expect(MAX_LISTED).toBe(256)
    const ids = many(MAX_LISTED, i => `p${i}`)
    const switches = {
      ...switchesIn,
      devMode: ids,
      execAnyCommand: ids,
      limits: { all: {}, plugins: Object.fromEntries(ids.map(id => [id, { callsInFlight: 1 }])) },
    }
    await store.writeSwitches(switches)
    expect((await store.load()).state.switches).toEqual(switches)
  })

  it('takes a time up to the longest timer and a size past it', async () => {
    const switches = {
      ...switchesIn,
      limits: { all: { callDeadlineMs: MAX_TIMER_MS, argumentBytes: MAX_TIMER_MS + 1 }, plugins: { search: { readyMs: MAX_TIMER_MS } } },
    }
    await store.writeSwitches(switches)
    const loaded = await store.load()
    expect(result(loaded, 'switches')).toBe('ok')
    expect(loaded.state.switches).toEqual(switches)
  })

  it('writes a plugin whose id has dashes and underscores', async () => {
    await addPlugin('my-plugin-x_2')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', 'my-plugin-x_2')).toBe('ok')
    expect(loaded.suspect).toBe(false)
  })

  it('answers an unknown name with nothing, even one that every object has', async () => {
    await writeAll()
    const { state } = await store.load()
    for (const found of [state.plugins, state.switches.limits.all, state.switches.limits.plugins, state.switches.limits.plugins.search]) {
      expect(Object.getPrototypeOf(found)).toBeNull()
      for (const name of ['constructor', 'toString', '__proto__']) expect((found as Record<string, unknown>)[name]).toBeUndefined()
    }
  })

  it('leaves no temp files behind', async () => {
    await writeAll()
    await writeAll()
    expect((await readdir(stateFile())).sort()).toEqual(['luoshu.json', 'plugins', 'switches.json'])
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

    it('waits out a short hold at load rather than reading the file as unreadable', async () => {
      await store.writeLuoshu(luoshuIn)
      const holder = await holdOpen(luoshuPath(), 'None')
      const [loaded] = await Promise.all([store.load(), releaseAfter(holder, 300)])
      expect(result(loaded, 'luoshu')).toBe('ok')
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
    const switches = (over: object) => () => store.writeSwitches({ ...switchesIn, ...over })
    const limits = (over: object) => switches({ limits: { all: {}, plugins: {}, ...over } })
    const forPlugin = (values: unknown) => limits({ plugins: { search: values } })
    const tooMany = many(MAX_LISTED + 1, i => `p${i}`)
    // An own __proto__ key, which only JSON.parse or defineProperty makes
    const proto = (json: string) => JSON.parse(json)
    const refused: [string, () => Promise<void>][] = [
      ['a switch that is not a boolean', switches({ confirmOff: 'true' })],
      ['an unknown switch', switches({ gateOff: true })],
      ['switches that carry a format', switches({ format: 2 })],
      ['the guard list of format 1', switches({ guardsOff: [] })],
      ['dev mode as the boolean of format 1', switches({ devMode: true })],
      // Each switch on its own, so a default on any one can't fill in what a caller left out
      ...Object.keys(switchesIn).map((key): [string, () => Promise<void>] => [
        `switches with no ${key}`,
        switches({ [key]: undefined }),
      ]),
      ['a first-party id in off', switches({ off: ['search'] })],
      ['a community plugin in off', switches({ off: ['my-plugin'] })],
      ['a namespace in off', switches({ off: ['core'] })],
      ['an id outside the grammar in off', switches({ off: ['../gate'] })],
      ['an id twice in off', switches({ off: ['gate', 'gate'] })],
      ['off as a string', switches({ off: 'gate' })],
      ['an id outside the grammar in dev mode', switches({ devMode: ['My-Plugin'] })],
      ['a dotted id in dev mode', switches({ devMode: ['my.plugin'] })],
      ['a namespace no plugin holds in dev mode', switches({ devMode: ['core'] })],
      ['cache in dev mode, a namespace storage serves', switches({ devMode: ['cache'] })],
      ['constructor in dev mode', switches({ devMode: ['constructor'] })],
      ['__proto__ in dev mode', switches({ devMode: ['__proto__'] })],
      ['an id twice in dev mode', switches({ devMode: ['search', 'search'] })],
      ['more ids in dev mode than a list holds', switches({ devMode: tooMany })],
      ['an id outside the grammar in execAnyCommand', switches({ execAnyCommand: ['a/b'] })],
      ['a namespace no plugin holds in execAnyCommand', switches({ execAnyCommand: ['security'] })],
      ['an id twice in execAnyCommand', switches({ execAnyCommand: ['search', 'search'] })],
      ['more ids in execAnyCommand than a list holds', switches({ execAnyCommand: tooMany })],
      ['an allowlist entry that is not a hash', switches({ allowUnsigned: ['abc'] })],
      ['an uppercase allowlist hash', switches({ allowUnsigned: ['A'.repeat(64)] })],
      ['an install id in removed', switches({ removed: ['luoshu'] })],
      ['a community plugin in removed', switches({ removed: ['my-plugin'] })],
      ['an id twice in removed', switches({ removed: ['git', 'git'] })],
      ['an unknown constant for all plugins', limits({ all: { callsPerSecond: 10 } })],
      ['an unknown constant for one plugin', forPlugin({ callsPerSecond: 10 })],
      ['a limit of zero', limits({ all: { callsInFlight: 0 } })],
      ['a negative limit', forPlugin({ readyMs: -1 })],
      ['a limit that is not whole', limits({ all: { readyMs: 1.5 } })],
      ['a limit as text', limits({ all: { readyMs: '100' } })],
      ['a limit past the safe integers', limits({ all: { readyMs: 2 ** 53 } })],
      ['a time past the longest timer', limits({ all: { callDeadlineMs: MAX_TIMER_MS + 1 } })],
      ['a time past the longest timer for one plugin', forPlugin({ floodMs: MAX_TIMER_MS + 1 })],
      ['a limit that is null', forPlugin({ readyMs: null })],
      ['limits with no value for all', switches({ limits: { plugins: {} } })],
      ['limits with an unknown field', limits({ watchdog: {} })],
      ['limits as a list', switches({ limits: [] })],
      ['limits for an id outside the grammar', limits({ plugins: { 'My-Plugin': { readyMs: 1 } } })],
      ['limits for a namespace no plugin holds', limits({ plugins: { events: { readyMs: 1 } } })],
      ['limits for constructor', limits({ plugins: { constructor: { readyMs: 1 } } })],
      ['limits for more plugins than a map holds', limits({ plugins: Object.fromEntries(tooMany.map(id => [id, {}])) })],
      ['__proto__ at the top of the switches', () => store.writeSwitches(Object.assign(proto('{"__proto__":{"recordNothing":true}}'), switchesIn))],
      ['__proto__ inside the limits', switches({ limits: proto('{"all":{},"plugins":{},"__proto__":{}}') })],
      ['__proto__ in the limits for all plugins', limits({ all: proto('{"__proto__":{"readyMs":1}}') })],
      ['__proto__ as a plugin in the limits', limits({ plugins: proto('{"__proto__":{"readyMs":1}}') })],
      ['__proto__ in the limits for one plugin', forPlugin(proto('{"__proto__":{"readyMs":1}}'))],
      ['a relative luoshu folder', () => store.writeLuoshu({ folder: 'notes' })],
      ['an empty luoshu folder', () => store.writeLuoshu({ folder: '' })],
      ['a luoshu folder that is not text', () => store.writeLuoshu({ folder: 5 })],
      ['a luoshu folder past the cap', () => store.writeLuoshu({ folder: notes + 'a'.repeat(MAX_FOLDER_LENGTH) })],
      ['a luoshu folder with a control character', () => store.writeLuoshu({ folder: `${notes}\u0007` })],
      ['a luoshu folder with a bidi override', () => store.writeLuoshu({ folder: `${notes}\u202egnp.exe` })],
      ['a luoshu with no folder', () => store.writeLuoshu({})],
      ['a luoshu with an unknown field', () => store.writeLuoshu({ ...luoshuIn, extra: 1 })],
      ['a luoshu that carries a format', () => store.writeLuoshu({ ...luoshuIn, format: 2 })],
      ['__proto__ inside the luoshu', () => store.writeLuoshu(proto(`{"folder":${JSON.stringify(notes)},"__proto__":{}}`))],
      ['a plugin with an unknown capability', () => store.writePlugin('search', pluginIn({ granted: [{ type: 'host.replace' }] }))],
      // Entries are for folder plugins, which never hold an install-only type
      ['a plugin with an install-only capability', () => store.writePlugin('search', pluginIn({ granted: [{ type: 'guard.hook' }] }))],
      ['a plugin with more capabilities than core/api allows', () => store.writePlugin('search', pluginIn({
        granted: many(MAX_CAPABILITIES + 1, () => ({ type: 'ui.panel' })),
      }))],
      // Counted across entries, so one type split over many can't get past the cap
      ['a plugin with more scopes for one type than core/api allows', () => store.writePlugin('search', pluginIn({
        granted: [{ type: 'luoshu.read', paths: many(40, i => `a${i}/**`) }, { type: 'luoshu.read', paths: many(40, i => `b${i}/**`) }],
      }))],
      ['a plugin with an unknown field', () => store.writePlugin('search', pluginIn({ extra: 1 }))],
      ['a plugin that carries its own id', () => store.writePlugin('search', pluginIn({ id: 'search' }))],
      ['a plugin that carries a format', () => store.writePlugin('search', pluginIn({ format: 2 }))],
      ['a plugin class out of range', () => store.writePlugin('search', pluginIn({ class: 5 }))],
      ['a plugin class as text', () => store.writePlugin('search', pluginIn({ class: '1' }))],
      ['a plugin with no class at all', () => store.writePlugin('search', pluginIn({ class: undefined }))],
      ['a content hash that is not a hash', () => store.writePlugin('search', pluginIn({ contentHash: 'abc' }))],
      ['a plugin capability with no scope', () => store.writePlugin('search', pluginIn({ granted: [{ type: 'net.fetch' }] }))],
      ['__proto__ inside a capability', () => store.writePlugin('search', pluginIn({ granted: [proto('{"type":"storage","__proto__":{}}')] }))],
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
    it('lets a load called after three writes see them all, without waiting for them first', async () => {
      const writes = [store.writeSwitches(switchesIn), store.writeLuoshu(luoshuIn), store.writePlugin('search', pluginIn())]
      const loaded = await store.load()
      await Promise.all(writes)
      expect(loaded.state.switches).toEqual(switchesIn)
      expect(loaded.state.luoshu).toEqual(luoshuIn)
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
  ['an unknown capability type', wrap({ type: 'luoshu.delete', paths: ['**'] })],
  ['an install-only capability type', wrap({ type: 'guard.hook' })],
  ['a capability with the scope of another', wrap({ type: 'luoshu.read', hosts: ['example.com'] })],
  ['a capability with no scope', wrap({ type: 'net.fetch' })],
  ['an exec command as a string', wrap({ type: 'exec', commands: ['git status'], env: [] })],
  ['an empty exec command', wrap({ type: 'exec', commands: [[]], env: [] })],
  ['an unknown history access', wrap({ type: 'history', access: 'rewrite', paths: ['**'] })],
  ['a duplicate key in a capability', wrap({ type: 'luoshu.read', paths: ['safe/**'] }).replace('"paths":["safe/**"]', '"paths":["safe/**"],"paths":["**"]')],
  ['__proto__ inside a capability', wrap({ type: 'storage' }).replace('{"type":"storage"', '{"__proto__":{"type":"guard.hook"},"type":"storage"')],
]

const badUtf8 = (before: string, after: string) => Buffer.concat([Buffer.from(before), Buffer.from([0xff]), Buffer.from(after)])
const switchesText = (over: object) => JSON.stringify({ format: 2, ...switchesIn, ...over })
const limitsText = JSON.stringify({ format: 2, ...switchesIn })

const kinds: Kind[] = [
  {
    name: 'switches',
    file: switchesPath,
    valid: { format: 2, ...switchesIn },
    seed: () => store.writeSwitches(switchesIn),
    edit: text => text.replace('"recordNothing": false', '"recordNothing": true'),
    result: loaded => result(loaded, 'switches'),
    absent: 'absent',
    seeded: loaded => expect(loaded.state.switches).toEqual(switchesIn),
    fellBack: loaded => expect(loaded.state.switches).toEqual(noSwitches),
    rejected: [
      // Each switch on its own, so a default on any one can't stand in for what the file left out
      ...Object.keys(switchesIn).map((key): [string, string] => [`no ${key}`, switchesText({ [key]: undefined })]),
      ['an unknown switch', switchesText({ gateOff: true })],
      ['the guard list of format 1', switchesText({ guardsOff: [] })],
      ['dev mode as the boolean of format 1', switchesText({ devMode: true })],
      ['confirmOff that is not a boolean', switchesText({ confirmOff: 1 })],
      ['recordNothing that is not a boolean', switchesText({ recordNothing: 'no' })],
      ['skipVerification that is not a boolean', switchesText({ skipVerification: 1 })],
      ['off as a string', switchesText({ off: 'gate' })],
      ['a first-party id in off', switchesText({ off: ['search'] })],
      ['an id outside the grammar in off', switchesText({ off: ['../leases'] })],
      ['an id twice in off', switchesText({ off: ['gate', 'leases', 'gate'] })],
      ['a namespace no plugin holds in dev mode', switchesText({ devMode: ['ui'] })],
      ['an id outside the grammar in dev mode', switchesText({ devMode: ['Search'] })],
      ['an id twice in execAnyCommand', switchesText({ execAnyCommand: ['search', 'search'] })],
      ['more ids in execAnyCommand than a list holds', switchesText({ execAnyCommand: many(MAX_LISTED + 1, i => `p${i}`) })],
      ['an install id in removed', switchesText({ removed: ['gate'] })],
      ['an allowlist entry that is not a hash', switchesText({ allowUnsigned: ['abc'] })],
      ['an uppercase allowlist hash', switchesText({ allowUnsigned: ['A'.repeat(64)] })],
      ['an unknown constant', switchesText({ limits: { all: { messagesPerMinute: 5 }, plugins: {} } })],
      ['a limit of zero', switchesText({ limits: { all: {}, plugins: { search: { callsInFlight: 0 } } } })],
      ['a negative limit', switchesText({ limits: { all: { callsInFlight: -64 }, plugins: {} } })],
      ['a time past the longest timer', switchesText({ limits: { all: {}, plugins: { search: { heartbeatMs: MAX_TIMER_MS + 1 } } } })],
      ['limits for a namespace no plugin holds', switchesText({ limits: { all: {}, plugins: { plugin: { readyMs: 1 } } } })],
      ['limits for constructor', switchesText({ limits: { all: {}, plugins: { constructor: { readyMs: 1 } } } })],
      ['__proto__ inside the limits', limitsText.replace('"limits":{', '"limits":{"__proto__":{},')],
      ['__proto__ in the limits for all plugins', limitsText.replace('"all":{', '"all":{"__proto__":{"readyMs":1},')],
      ['__proto__ as a plugin in the limits', limitsText.replace('"plugins":{', '"plugins":{"__proto__":{"readyMs":1},')],
      ['__proto__ in the limits for one plugin', limitsText.replace('"search":{', '"search":{"__proto__":{"readyMs":1},')],
      ['a constant twice in the limits', limitsText.replace('"all":{', '"all":{"callsInFlight":64,')],
      ['a duplicate switch', limitsText.replace('"confirmOff":true', '"confirmOff":false,"confirmOff":true')],
    ],
  },
  {
    name: 'luoshu',
    file: luoshuPath,
    valid: { format: 2, ...luoshuIn },
    seed: () => store.writeLuoshu(luoshuIn),
    edit: text => text.replace('notes"', 'other"'),
    result: loaded => result(loaded, 'luoshu'),
    absent: 'absent',
    seeded: loaded => expect(loaded.state.luoshu).toEqual(luoshuIn),
    fellBack: loaded => expect(loaded.state.luoshu).toBeNull(),
    rejected: [
      ['a relative folder', JSON.stringify({ format: 2, folder: 'notes' })],
      ['an empty folder', JSON.stringify({ format: 2, folder: '' })],
      ['a folder that is not text', JSON.stringify({ format: 2, folder: ['/notes'] })],
      ['a null folder', JSON.stringify({ format: 2, folder: null })],
      ['no folder', JSON.stringify({ format: 2 })],
      ['a folder with a control character', JSON.stringify({ format: 2, folder: `${notes}\u0000` })],
      ['an unknown luoshu field', JSON.stringify({ format: 2, ...luoshuIn, extra: 1 })],
      ['a duplicate folder', JSON.stringify({ format: 2, ...luoshuIn }).replace('{"format":2', '{"format":2,"folder":"/elsewhere"')],
    ],
  },
  {
    name: 'plugin entry',
    file: () => pluginPath('search'),
    valid: { format: 2, ...pluginIn() },
    seed: async () => { await addPlugin('search') },
    edit: text => text.replace('"class": 1', '"class": 0'),
    result: loaded => result(loaded, 'plugin-entry', 'search'),
    absent: undefined,
    seeded: loaded => expect(loaded.state.plugins.search).toMatchObject({ version: '1.0.0', class: 1, enabled: true }),
    fellBack: loaded => expect(loaded.state.plugins.search).toBeUndefined(),
    rejected: [
      ['a missing field', JSON.stringify({ format: 2, ...pluginIn(), enabled: undefined })],
      ['an unknown plugin field', JSON.stringify({ format: 2, ...pluginIn(), extra: 1 })],
      ['an id inside the file, which the file name already gives', JSON.stringify({ format: 2, ...pluginIn(), id: 'other' })],
      ['a content hash that is not a hash', JSON.stringify({ format: 2, ...pluginIn({ contentHash: 'abc' }) })],
      ['an uppercase content hash', JSON.stringify({ format: 2, ...pluginIn({ contentHash: 'A'.repeat(64) }) })],
      ['a class out of range', JSON.stringify({ format: 2, ...pluginIn({ class: 5 }) })],
      ['a negative class', JSON.stringify({ format: 2, ...pluginIn({ class: -1 }) })],
      ['a class that is not whole', JSON.stringify({ format: 2, ...pluginIn({ class: 1.5 }) })],
      ['a class as text', JSON.stringify({ format: 2, ...pluginIn({ class: '4' }) })],
      ['an empty version', JSON.stringify({ format: 2, ...pluginIn({ version: '' }) })],
      ['an empty signer', JSON.stringify({ format: 2, ...pluginIn({ signer: '' }) })],
      ['a signer that is not text or null', JSON.stringify({ format: 2, ...pluginIn({ signer: 5 }) })],
      ['enabled that is not a boolean', JSON.stringify({ format: 2, ...pluginIn({ enabled: 'yes' }) })],
      ['more capabilities than core/api allows', JSON.stringify({
        format: 2, ...pluginIn({ granted: many(MAX_CAPABILITIES + 1, () => ({ type: 'storage' })) }),
      })],
      ['bytes that are not UTF-8', badUtf8('{"format":2,"version":"1.0.', `","contentHash":"${HASH}","signer":null,"granted":[],"class":1,"enabled":true}`)],
      ...capabilityCases(capability => JSON.stringify({ format: 2, ...pluginIn({ granted: [capability] }) })),
    ],
  },
]

// Same rules for every kind of file: a failure shows in that file's check and falls back for that file alone
describe.each(kinds)('the $name file', kind => {
  const validText = JSON.stringify(kind.valid)
  const newerText = validText.replace('{"format":2', '{"format":3')
  const raw: [string, string | Buffer][] = [
    ['not JSON', 'hello'],
    ['an empty file', ''],
    ['a comment', `${validText} // note`],
    ['a trailing comma', validText.replace(/}$/, ',}')],
    ['a BOM', `\ufeff${validText}`],
    ['a duplicate top level key', validText.replace('{"format":2', '{"format":3,"format":2')],
    ['a duplicate key hidden by an escape', validText.replace('{"format":2', '{"format":3,"\\u0066ormat":2')],
    ['__proto__ at the top', validText.replace('{"format":2', '{"__proto__":{"recordNothing":true},"format":2')],
    ['nesting too deep to parse', `${'['.repeat(200000)}${']'.repeat(200000)}`],
    ['format 1, which no reader takes', validText.replace('{"format":2', '{"format":1')],
    ['format 0', validText.replace('{"format":2', '{"format":0')],
    ['a negative format', validText.replace('{"format":2', '{"format":-3')],
    ['a format that is not whole', validText.replace('{"format":2', '{"format":2.5')],
    ['a format as text', validText.replace('{"format":2', '{"format":"3"')],
    ['a format past the safe integers', validText.replace('{"format":2', '{"format":9007199254740993')],
    ['no format', validText.replace('{"format":2,', '{')],
    ['a list in place of the object', `[${validText}]`],
    ['JSON null', 'null'],
    ['an unknown top level field', validText.replace(/}$/, ',"extra":1}')],
  ]

  it('loads what was written', async () => {
    await kind.seed()
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('ok')
    expect(loaded.suspect).toBe(false)
    kind.seeded(loaded)
  })

  it('is absent when the file does not exist, which is not suspect', async () => {
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

  it.each([...raw, ...kind.rejected])('fails closed on %s', async (_name, bytes) => {
    await plant(kind.file(), bytes)
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('invalid')
    expect(loaded.suspect).toBe(true)
    kind.fellBack(loaded)
  })

  // A file a newer build wrote: this build runs on defaults and leaves the file to the build that reads that format
  it('reads a later format as newer, with the defaults in memory and nothing suspect', async () => {
    await plant(kind.file(), newerText)
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('newer')
    expect(loaded.suspect).toBe(false)
    kind.fellBack(loaded)
  })

  it('reads any whole format past 2 as newer, whatever else the file holds', async () => {
    await plant(kind.file(), '{"format":4096,"anything":[1,{"x":null}]}')
    expect(kind.result(await store.load())).toBe('newer')
  })

  it('still checks the hash of a newer file first', async () => {
    await plant(kind.file(), newerText)
    await writeFile(kind.file(), (await readFile(kind.file(), 'utf8')).replace('"format":3', '"format":4'))
    const loaded = await store.load()
    expect(kind.result(loaded)).toBe('hash-mismatch')
    expect(loaded.suspect).toBe(true)
  })

  it('refuses to write a newer file for the rest of the run and leaves it as found', async () => {
    await plant(kind.file(), newerText)
    const before = await readFile(kind.file())
    await store.load()
    await expect(kind.seed()).rejects.toThrow(/newer format/)
    expect(await readFile(kind.file())).toEqual(before)
    expect(kind.result(await store.load())).toBe('newer')
    // Still held with the file gone, so nothing this run writes takes the newer state's place
    await rm(kind.file())
    await expect(kind.seed()).rejects.toThrow(/newer format/)
    // Even after a load that no longer finds it
    await store.load()
    await expect(kind.seed()).rejects.toThrow(/newer format/)
  })

  it('holds a newer file again in the next run, which loads before any write', async () => {
    await plant(kind.file(), newerText)
    await store.load()
    store = new StateStore(dir)
    expect(kind.result(await store.load())).toBe('newer')
    await expect(kind.seed()).rejects.toThrow(/newer format/)
  })
})

describe('newer formats', () => {
  it('hold only the file that is newer, every other file still writes', async () => {
    await plant(switchesPath(), JSON.stringify({ format: 3 }))
    await store.load()
    await store.writeLuoshu(luoshuIn)
    await addPlugin('search')
    const loaded = await store.load()
    expect(result(loaded, 'switches')).toBe('newer')
    expect(result(loaded, 'luoshu')).toBe('ok')
    expect(result(loaded, 'plugin-entry', 'search')).toBe('ok')
  })

  it('refuse removing a plugin entry in a newer format', async () => {
    await plant(pluginPath('search'), JSON.stringify({ format: 3 }))
    await store.load()
    await expect(store.removePlugin('search')).rejects.toThrow(/newer format/)
    expect(await readdir(stateFile('plugins'))).toEqual(['search.json'])
  })

  it('hold a write queued behind the load that finds the newer file', async () => {
    await plant(switchesPath(), JSON.stringify({ format: 3 }))
    const [loaded, written] = await Promise.allSettled([store.load(), store.writeSwitches(switchesIn)])
    expect(loaded.status === 'fulfilled' && result(loaded.value, 'switches')).toBe('newer')
    expect(written.status).toBe('rejected')
  })
})

// The limits the design accepts: detect only against a program that knows hetu, threats 24, 25 and 55
describe('what the hash does not catch', () => {
  it('accepts an edit whose hash was rewritten too', async () => {
    await store.writeSwitches(noSwitches)
    await plant(switchesPath(), JSON.stringify({ format: 2, ...noSwitches, recordNothing: true }))
    const loaded = await store.load()
    expect(loaded.state.switches.recordNothing).toBe(true)
    expect(loaded.suspect).toBe(false)
  })

  it('accepts an older file put back with its own hash', async () => {
    await store.writeSwitches(switchesIn)
    const oldFile = await readFile(switchesPath())
    await store.writeSwitches(noSwitches)
    // The old file carries its own hash line, so a plain copy puts it back
    await writeFile(switchesPath(), oldFile)
    const loaded = await store.load()
    expect(loaded.state.switches.off).toEqual(['gate', 'leases'])
    expect(loaded.suspect).toBe(false)
  })
})

describe('files that fail alone', () => {
  async function setup() {
    const searchRoot = await addPlugin('search')
    const gitRoot = await addPlugin('git')
    await store.writeSwitches(switchesIn)
    await store.writeLuoshu(luoshuIn)
    return { searchRoot, gitRoot }
  }

  const change = async (file: string) => writeFile(file, (await readFile(file, 'utf8')).replace('"version": "1.0.0"', '"version": "9.9.9"'))
  // One byte more above the hash line: a space after the first brace
  const tamper = async (file: string) => {
    const text = await readFile(file, 'utf8')
    const at = text.indexOf('{') + 1
    await writeFile(file, `${text.slice(0, at)} ${text.slice(at)}`)
  }

  it('leaves every other plugin, the switches and the luoshu loaded when one plugin entry is edited', async () => {
    await setup()
    await change(pluginPath('search'))
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'plugin-entry', 'search')).toBe('hash-mismatch')
    expect(result(loaded, 'plugin-entry', 'git')).toBe('ok')
    expect(Object.keys(loaded.state.plugins)).toEqual(['git'])
    expect(loaded.state.plugins.git.enabled).toBe(true)
    expect(loaded.state.switches).toEqual(switchesIn)
    expect(loaded.state.luoshu).toEqual(luoshuIn)
  })

  it('leaves the plugins and the luoshu alone when the switches are edited', async () => {
    await setup()
    await tamper(switchesPath())
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(result(loaded, 'switches')).toBe('hash-mismatch')
    expect(loaded.state.switches).toEqual(noSwitches)
    expect(result(loaded, 'luoshu')).toBe('ok')
    expect(loaded.state.luoshu).toEqual(luoshuIn)
    expect(Object.keys(loaded.state.plugins)).toEqual(['git', 'search'])
    expect(loaded.state.plugins.search.enabled).toBe(true)
    expect(loaded.state.plugins.git.enabled).toBe(true)
  })

  it.each([
    ['missing', () => rm(switchesPath())],
    ['in a newer format', () => plant(switchesPath(), JSON.stringify({ format: 3 }))],
    ['unreadable', async () => { await rm(switchesPath()); await mkdir(switchesPath()) }],
  ])('keeps the luoshu when the switches file is %s', async (_name, spoil) => {
    await setup()
    await spoil()
    const loaded = await store.load()
    expect(loaded.state.switches).toEqual(noSwitches)
    expect(result(loaded, 'luoshu')).toBe('ok')
    expect(loaded.state.luoshu).toEqual(luoshuIn)
  })

  it.each([
    ['edited', () => tamper(luoshuPath())],
    ['missing', () => rm(luoshuPath())],
    ['in a newer format', () => plant(luoshuPath(), JSON.stringify({ format: 3 }))],
    ['relative inside', () => plant(luoshuPath(), JSON.stringify({ format: 2, folder: 'notes' }))],
  ])('keeps the switches and the plugins when the luoshu file is %s', async (_name, spoil) => {
    await setup()
    await spoil()
    const loaded = await store.load()
    expect(loaded.state.luoshu).toBeNull()
    expect(result(loaded, 'switches')).toBe('ok')
    expect(loaded.state.switches).toEqual(switchesIn)
    expect(Object.keys(loaded.state.plugins)).toEqual(['git', 'search'])
  })

  it('writing one file does not repair another bad one', async () => {
    await setup()
    await change(pluginPath('git'))
    await tamper(switchesPath())
    await tamper(luoshuPath())
    await store.writeSwitches(switchesIn)
    const loaded = await store.load()
    expect(result(loaded, 'switches')).toBe('ok')
    expect(result(loaded, 'luoshu')).toBe('hash-mismatch')
    expect(result(loaded, 'plugin-entry', 'git')).toBe('hash-mismatch')
    expect(loaded.suspect).toBe(true)
  })
})

// A failed check leaves a plugin out of what loads. A switch-off is the human's and only the human changes one
describe('a failed check and a switch-off', () => {
  it('reads entries only, with no check of any plugin code', async () => {
    const searchRoot = await addPlugin('search')
    await writeFile(path.join(searchRoot, 'a.js'), 'changed')
    const loaded = await store.load()
    expect(loaded.checks.map(c => c.check)).toEqual(['switches', 'luoshu', 'plugin-entry'])
    expect(loaded.suspect).toBe(false)
  })

  const codeChanges: [string, (root: string) => Promise<unknown>][] = [
    ['a changed file', root => writeFile(path.join(root, 'a.js'), 'changed')],
    ['a file dropped in', root => writeFile(path.join(root, 'extra.js'), 'new')],
    ['the folder removed', root => rm(root, { recursive: true })],
    ['a link in place of the folder', async root => {
      const copy = await pluginFiles('elsewhere', { 'a.js': 'search' })
      await rm(root, { recursive: true })
      await symlink(copy, root, 'junction')
    }],
  ]

  it.each(codeChanges)('keeps an entry with enabled true as true whatever the code holds, here %s', async (_name, spoil) => {
    const root = await addPlugin('search')
    await addPlugin('git')
    await spoil(root)
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', 'search')).toBe('ok')
    expect(loaded.state.plugins.search.enabled).toBe(true)
    expect(loaded.state.plugins.git.enabled).toBe(true)
  })

  it('keeps enabled false as the human left it, which is no failed check', async () => {
    await addPlugin('search', { enabled: false })
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', 'search')).toBe('ok')
    expect(loaded.state.plugins.search.enabled).toBe(false)
    expect(loaded.suspect).toBe(false)
  })

  const switchesSpoiled: [string, () => Promise<unknown>][] = [
    ['edited', async () => writeFile(switchesPath(), (await readFile(switchesPath(), 'utf8')).replace('"confirmOff": false', '"confirmOff": true'))],
    ['invalid', () => plant(switchesPath(), switchesText({ off: [...installIds, 'search'] }))],
    ['in a newer format', () => plant(switchesPath(), JSON.stringify({ format: 3, off: [...installIds] }))],
    ['missing', () => rm(switchesPath())],
  ]

  it.each(switchesSpoiled)('reads a switches file that is %s as every install plugin on, never as one off', async (_name, spoil) => {
    await store.writeSwitches({ ...noSwitches, off: [...installIds] })
    await spoil()
    const { state } = await store.load()
    expect(state.switches).toEqual(noSwitches)
    for (const id of installIds) expect(state.switches.off).not.toContain(id)
  })

  it('leaves out a plugin whose entry is bad and touches no switch', async () => {
    await store.writeSwitches(switchesIn)
    await addPlugin('search')
    await writeFile(pluginPath('search'), 'tampered')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', 'search')).toBe('hash-missing')
    expect(loaded.state.plugins.search).toBeUndefined()
    expect(loaded.state.switches).toEqual(switchesIn)
  })
})

// removed lives in the switches, so a switches file that didn't check out has lost the tombstones
describe('the tombstones', () => {
  it('are known when the switches file checked out', async () => {
    await store.writeSwitches(switchesIn)
    const loaded = await store.load()
    expect(loaded.removedKnown).toBe(true)
    expect(loaded.state.switches.removed).toEqual(['git'])
  })

  it('are known with nothing removed, when the file says so', async () => {
    await store.writeSwitches(noSwitches)
    expect((await store.load()).removedKnown).toBe(true)
  })

  it.each([
    ['missing, which only boot can tell from a first run', () => rm(switchesPath())],
    ['edited', () => writeFile(switchesPath(), 'tampered')],
    ['invalid', () => plant(switchesPath(), switchesText({ removed: ['luoshu'] }))],
    ['in a newer format', () => plant(switchesPath(), JSON.stringify({ format: 3, removed: ['git'] }))],
    ['unreadable', async () => { await rm(switchesPath()); await mkdir(switchesPath()) }],
  ])('are not known when the switches file is %s', async (_name, spoil) => {
    await store.writeSwitches(switchesIn)
    await spoil()
    const loaded = await store.load()
    expect(loaded.removedKnown).toBe(false)
    expect(loaded.state.switches.removed).toEqual([])
  })
})

describe('the luoshu folder', () => {
  const folders: [string, string, boolean][] = [
    ['win32', 'C:\\Users\\han\\notes', true],
    ['win32', 'c:/Users/han/notes', true],
    ['win32', 'D:\\', true],
    ['win32', '\\\\server\\share\\notes', true],
    ['win32', '//server/share/notes', true],
    ['win32', '\\\\?\\C:\\Users\\han\\notes', true],
    // Windows reads these against the drive or the folder that is current
    ['win32', '\\Users\\han\\notes', false],
    ['win32', '/Users/han/notes', false],
    ['win32', 'C:notes', false],
    ['win32', 'notes', false],
    ['win32', '.\\notes', false],
    // A third separator is no share: D:\work against these gives D:\notes
    ['win32', '\\\\\\notes', false],
    ['win32', '///notes', false],
    ['darwin', '/Users/han/notes', true],
    ['darwin', 'Users/han/notes', false],
    ['darwin', 'C:\\Users\\han\\notes', false],
    ['darwin', '~/notes', false],
    ['linux', '/home/han/notes', true],
    ['linux', './notes', false],
  ]

  it.each(folders)('on %s takes %j as absolute: %s', async (platform, folder, absolute) => {
    const onPlatform = new StateStore(dir, platform)
    if (absolute) {
      await onPlatform.writeLuoshu({ folder })
      expect((await onPlatform.load()).state.luoshu).toEqual({ folder })
    } else {
      await expect(onPlatform.writeLuoshu({ folder })).rejects.toThrow(/absolute/)
    }
  })

  it('takes a folder of exactly the cap and refuses one character more', async () => {
    const posix = new StateStore(dir, 'linux')
    const folder = `/${'a'.repeat(MAX_FOLDER_LENGTH - 1)}`
    await posix.writeLuoshu({ folder })
    expect((await posix.load()).state.luoshu).toEqual({ folder })
    await expect(posix.writeLuoshu({ folder: `${folder}a` })).rejects.toThrow(/too_big/)
  })

  it('reads a folder absolute only on another platform as invalid', async () => {
    await plant(luoshuPath(), JSON.stringify({ format: 2, folder: 'C:\\Users\\han\\notes' }))
    expect(result(await new StateStore(dir, 'linux').load(), 'luoshu')).toBe('invalid')
    await plant(luoshuPath(), JSON.stringify({ format: 2, folder: '/home/han/notes' }))
    expect(result(await new StateStore(dir, 'win32').load(), 'luoshu')).toBe('invalid')
  })
})

describe('names in the plugins folder', () => {
  const entry = JSON.stringify({ format: 2, ...pluginIn() })

  it.each(['Evil', 'a b', '.hidden', 'trail.', 'a..b', '-a', '_a', 'a-', 'con', 'nul'])('ignores %j and reports it as invalid', async name => {
    await addPlugin('search')
    await plant(pluginPath(name), entry)
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry', name)).toBe('invalid')
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
    expect(loaded.checks.map(c => c.id)).toEqual([undefined, undefined, 'search'])
  })

  it('ignores files ending in .tmp, which are what a crashed write leaves', async () => {
    await addPlugin('search')
    await writeFile(stateFile('plugins', 'search.json.0b6f.tmp'), 'half a fi')
    await writeFile(stateFile('plugins', 'search.json.sha256.0b6f.tmp'), 'ab')
    await writeFile(stateFile('plugins', 'Evil.json.tmp'), entry)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.checks.map(c => c.id)).toEqual([undefined, undefined, 'search'])
    expect(loaded.state.plugins.search.enabled).toBe(true)
  })

  it('reads a folder that is not there as no plugins', async () => {
    await store.writeSwitches(switchesIn)
    const loaded = await store.load()
    expect(loaded.suspect).toBe(false)
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'ok' },
      { check: 'luoshu', result: 'absent' },
    ])
  })

  it('fails closed when the folder can not be listed, without touching the other files', async () => {
    await store.writeSwitches(switchesIn)
    await store.writeLuoshu(luoshuIn)
    await writeFile(stateFile('plugins'), 'not a folder')
    const loaded = await store.load()
    expect(result(loaded, 'plugin-entry')).toBe('unreadable')
    expect(loaded.suspect).toBe(true)
    expect(loaded.state.plugins).toEqual({})
    expect(loaded.state.switches).toEqual(switchesIn)
    expect(loaded.state.luoshu).toEqual(luoshuIn)
  })
})

describe('removing a plugin', () => {
  it('is fine with removing a plugin whose entry is already gone', async () => {
    await expect(store.removePlugin('search')).resolves.toBeUndefined()
  })

  // Reads like an uninstalled plugin, the same as a wiped file. The loader's scan for a code folder with no entry asks
  // about such a folder
  it('reads a deleted entry as no plugin at all, with no check of its own', async () => {
    await addPlugin('search')
    await rm(pluginPath('search'))
    const loaded = await store.load()
    expect(loaded.state.plugins.search).toBeUndefined()
    expect(loaded.checks.map(c => c.check)).toEqual(['switches', 'luoshu'])
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
  it('reads no files at all as no switches and no luoshu, nothing suspect', async () => {
    const loaded = await store.load()
    expect(loaded.state).toEqual(defaultState())
    expect(loaded.suspect).toBe(false)
    expect(loaded.removedKnown).toBe(false)
    expect(loaded.checks).toEqual([
      { check: 'switches', result: 'absent' },
      { check: 'luoshu', result: 'absent' },
    ])
  })

  it('creates nothing, not even the folder', async () => {
    await new StateStore(path.join(dir, 'never')).load()
    expect(await readdir(dir)).toEqual([])
  })

  it('changes nothing on disk, however much is wrong', async () => {
    const searchRoot = await addPlugin('search')
    await addPlugin('git')
    await addPlugin('mcp')
    await store.writeSwitches(switchesIn)
    await store.writeLuoshu(luoshuIn)
    await writeFile(path.join(searchRoot, 'a.js'), 'changed')
    await writeFile(switchesPath(), 'tampered')
    await plant(luoshuPath(), JSON.stringify({ format: 3 }))
    await writeFile(pluginPath('git'), 'tampered')
    await plant(pluginPath('mcp'), JSON.stringify({ format: 1, ...pluginIn() }))
    await writeFile(stateFile('plugins', 'notes.txt'), 'x')
    const before = await snapshot()
    const loaded = await store.load()
    expect(loaded.suspect).toBe(true)
    expect(await snapshot()).toEqual(before)
  })
})
