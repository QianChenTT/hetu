import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import type { Gate, GrantedItem } from '../../api/policy-jobs.ts'
import { quotas } from '../../api/storage.ts'
import { createGate } from '../../backend/policy/gate/gate.ts'
import { createStorage } from '../../backend/providers/storage/store.ts'
import { ModeGate, pairKey } from '../../sdk/testing/gate.ts'
import { MemoryStorage } from '../../sdk/testing/providers.ts'
import { gateCases, type Grants } from './gate.cases.ts'
import { storageCases } from './storage.cases.ts'

// Every fake in sdk/testing beside the part it stands in for, each running the part's cases, so a change to either
// that the other doesn't follow fails here

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// A folder of its own, removed after the case
export async function folder(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-contract-')))
  made.push(dir)
  return dir
}

describe.each([
  ['MemoryStorage', async () => ({ provider: new MemoryStorage(), quotas })],
  // The module's own tests check it holds core/api's quotas when made with none
  ['the storage module', async () => {
    const small = { storage: { bytes: 4096, keys: 8 }, cache: { bytes: 4096, keys: 8 } }
    const store = createStorage({ quotas: small })
    store.open(await folder())
    return { provider: store, quotas: small }
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

// What a fake doesn't model it refuses, never guessing an answer
describe('what the fakes refuse', () => {
  it('ModeGate refuses a grants snapshot, its grants coming from the test', () => {
    const gate: Gate = new ModeGate('reader', 'manifest', [])
    expect(() => gate.stateChanged({ n: 2, foldCase: true, execAny: [], plugins: {} }))
      .toThrow('the fake gate takes grants from the test and does not model a grants snapshot')
  })
})
