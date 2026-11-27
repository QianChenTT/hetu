import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import type { Gate, GrantedItem } from '../../api/policy-jobs.ts'
import { createLock } from '../../backend/lock/lock.ts'
import { createGate } from '../../backend/policy/gate/gate.ts'
import { createHistory } from '../../backend/providers/history/history.ts'
import { createLuoshu } from '../../backend/providers/luoshu/luoshu.ts'
import { createStorage, type Quotas } from '../../backend/providers/storage/store.ts'
import { ModeGate, pairKey } from '../../sdk/testing/gate.ts'
import { MemoryHistory, MemoryLuoshu, MemoryStorage, memoryLock } from '../../sdk/testing/providers.ts'
import { gateCases, type Grants } from './gate.cases.ts'
import { historyCases } from './history.cases.ts'
import { lockCases, type MakeLock } from './lock.cases.ts'
import { luoshuCases } from './luoshu.cases.ts'
import { storageCases } from './storage.cases.ts'

// Every fake in sdk/testing beside the part it stands in for, each running the part's cases, so a change to either
// that the other doesn't follow fails here

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// A folder of its own, removed after the case
async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-contract-')))
  made.push(dir)
  return dir
}

// A notes folder with hetu's data and install folders beside it, as the core opens a part on them
async function opening(): Promise<{ folder: string, dataDir: string, installDir: string }> {
  const base = await folder()
  const where = { folder: path.join(base, 'notes'), dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') }
  for (const dir of Object.values(where)) await mkdir(dir)
  return where
}

async function written(notes: string, name: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(notes, name)), { recursive: true })
  await writeFile(path.join(notes, name), text)
}

describe.each([
  ['MemoryStorage', async (quotas: Quotas) => new MemoryStorage(0, quotas)],
  ['the storage module', async (quotas: Quotas) => {
    const store = createStorage({ quotas })
    store.open(await folder())
    return store
  }],
])('%s', (_, make) => storageCases(make))

const items = (grants: readonly Capability[]): GrantedItem[] => grants.map(capability => ({ capability, off: false, firstUse: false }))
const each = <T, U>(table: Record<string, T>, map: (value: T) => U) => Object.fromEntries(Object.entries(table).map(([key, value]) => [key, map(value)]))

describe.each([
  // reader is the plugin under test, so the manifest's grants hold for it and the test's for every other plugin
  ['ModeGate', (grants: Grants): Gate => {
    const gate = new ModeGate('reader', 'manifest', grants.plugins.reader ?? [])
    for (const [id, granted] of Object.entries(grants.plugins)) if (id !== 'reader') gate.grants.set(id, granted)
    for (const [plugin, fields] of Object.entries(grants.pairs ?? {})) {
      for (const [field, granted] of Object.entries(fields)) gate.pairs.set(pairKey({ plugin, field }), granted)
    }
    return gate
  }],
  ['the gate module', (grants: Grants): Gate => {
    const gate = createGate()
    gate.stateChanged({ n: 1, foldCase: false, execAny: [], plugins: each(grants.plugins, items), pairs: each(grants.pairs ?? {}, fields => each(fields, items)) })
    return gate
  }],
])('%s', (_, make) => gateCases(make))

describe.each([
  ['MemoryLuoshu', async (names: readonly string[], pageSize: number) => {
    const luoshu = new MemoryLuoshu(async () => {}, 0, pageSize)
    for (const name of names) luoshu.notes.set(name, name)
    return luoshu
  }],
  ['the luoshu module', async (names: readonly string[], pageSize: number) => {
    const where = await opening()
    for (const name of names) await written(where.folder, name, name)
    const luoshu = createLuoshu({ pageSize })
    luoshu.role.open(where)
    return luoshu.provider
  }],
])('%s', (_, make) => luoshuCases(make))

describe.each([
  ['MemoryHistory', async () => {
    const history = new MemoryHistory(new Map())
    return {
      provider: history,
      write: async (name: string, text: string) => { history.notes.set(name, text) },
      remove: async (name: string) => { history.notes.delete(name) },
    }
  }],
  ['the history module', async () => {
    const where = await opening()
    const history = createHistory()
    await history.start(where.dataDir)
    history.role.open(where)
    return {
      provider: history.provider,
      write: (name: string, text: string) => written(where.folder, name, text),
      remove: (name: string) => rm(path.join(where.folder, name)),
    }
  }],
])('%s', (_, make) => historyCases(make))

const lockMakers: [string, MakeLock][] = [
  ['memoryLock', async clock => {
    const told: object[] = []
    const lock = memoryLock({ clock: () => clock.now, wall: () => clock.now, publish: (at, change) => { told.push({ path: at, ...change }) } })
    return { ...lock, told }
  }],
  ['the lock module', async clock => {
    const told: object[] = []
    const lock = createLock({ clock: () => clock.now, wall: () => clock.now, publish: (at, change) => { told.push({ path: at, ...change }) } })
    lock.role.open(await opening())
    return { provider: lock.provider, guard: lock.guard, told }
  }],
]
describe.each(lockMakers)('%s', (_, make) => lockCases(make))

// What a fake doesn't model it refuses, never guessing an answer
describe('what the fakes refuse', () => {
  it('ModeGate refuses a grants snapshot, its grants coming from the test', () => {
    const gate: Gate = new ModeGate('reader', 'manifest', [])
    expect(() => gate.stateChanged({ n: 2, foldCase: true, execAny: [], plugins: {} }))
      .toThrow('the fake gate takes grants from the test and does not model a grants snapshot')
  })
})
