import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import { FIRST_PARTY_SIGNER } from '../api/install.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import {
  coreInstall, entryFor, FakeRuntime, filesFor, firstPartyEntry, hashOf, plant, tempBase, until, workerManifest, writeFolder, writeInstall,
} from './plugins-manager-fakes.ts'

// Folder plugins on the joined core over a real boot, the core modules as they ship and the log on

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

type Reply = { ok?: boolean, result?: unknown, refusal?: { code: string } }

const listAll: Capability = { type: 'luoshu.list', paths: ['**'] }
const readAll: Capability = { type: 'luoshu.read', paths: ['**'] }
const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }

// A data folder the test fills before the boot, then the core started on it with the fake runtime. folder is the notes
// folder picked, none when null
async function joined(fill: (dataDir: string, store: StateStore) => Promise<void>, folder: string | null) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  await mkdir(installDir, { recursive: true })
  await writeInstall(installDir, coreInstall())
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  if (folder !== null) await store.writeLuoshu({ folder })
  await fill(dataDir, store)
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const runtime = new FakeRuntime()
  const { recording, pluginsManager, router, modules } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0 })
  open.push(async () => {
    await pluginsManager.shutdown().catch(() => {})
    router.close()
    await recording.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  await pluginsManager.start()
  await pluginsManager.settled()
  // The log's whole lines once what the core holds back is written
  const records = async () => {
    await recording.flush()
    const text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
    return text.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, unknown>)
  }
  // A call from a folder plugin's worker
  const call = async (id: string, action: string, args: unknown) => (await runtime.half(id).ask(action, args, 15_000)) as Reply | null
  return { booted, pluginsManager, modules, runtime, dataDir, records, call }
}

const notesFolder = async (notes: Record<string, string>) => {
  const folder = path.join(await tempBase(), 'notes')
  await writeFolder(folder, notes)
  open.push(() => rm(path.dirname(folder), { recursive: true, force: true }))
  return folder
}

// A data folder from before the file explorer left the first-party ids: its copy in the plugin folder, its entry with
// the first-party signer and the grant the copy derived, and a switches file naming it in removed beside search, as a
// remove that stopped between its two writes leaves it
describe('an old data folder holding the file explorer as first-party', () => {
  it('starts hetu, refuses the entry with signer, runs no worker for it and reads the switches with the ids dropped', async () => {
    const granted = [listAll, readAll, writeAll, { type: 'ui.view' } as Capability]
    const { booted, pluginsManager, runtime, records } = await joined(async (dataDir, store) => {
      const root = path.join(dataDir, 'plugins', 'file-explorer')
      await writeFolder(root, filesFor(workerManifest('file-explorer', { version: '0.1.0', capabilities: granted })))
      await store.writePlugin('file-explorer', firstPartyEntry(await hashOf(root), { version: '0.1.0', granted, class: 4, firstUse: [writeAll] }))
      await plant(path.join(dataDir, 'state', 'switches.json'), JSON.stringify({ format: 3, ...defaultSwitches(), removed: ['file-explorer', 'search'] }))
    }, await notesFolder({ 'a.md': 'alpha' }))

    // Hetu starts on it: nothing suspect, the tombstones still known and the core ready
    expect(booted.suspect).toBe(false)
    expect(booted.removedKnown).toBe(true)
    expect(booted.state.switches.removed).toEqual([])
    expect(booted.state.plugins['file-explorer']).toMatchObject({ signer: FIRST_PARTY_SIGNER, class: 4 })
    const all = await records()
    expect(all.some(record => record.event === 'core.ready')).toBe(true)

    // The entry is refused with signer, never migrated, and no worker runs for it
    expect(pluginsManager.list().find(row => row.id === 'file-explorer')).toMatchObject({ from: 'folder', state: 'refused', reason: 'signer' })
    expect(all).toContainEqual(expect.objectContaining({ event: 'plugin.refused', plugin: 'file-explorer', reason: 'signer' }))
    expect(runtime.order()).not.toContain('file-explorer')
    expect(all.some(record => record.event === 'plugin.started' && record.plugin === 'file-explorer')).toBe(false)
  })
})

// The luoshu module is on with no folder picked and answers unavailable, so a plugin requiring it starts and waits on
// nothing
describe('a plugin wanting the luoshu before a folder is picked', () => {
  it('starts with no plugin.waiting and its read answers unavailable', async () => {
    const { pluginsManager, modules, records, call } = await joined(async (dataDir, store) => {
      const root = path.join(dataDir, 'plugins', 'reader')
      await writeFolder(root, filesFor(workerManifest('reader', { requires: ['luoshu'], capabilities: [readAll] })))
      await store.writePlugin('reader', await entryFor(root, { granted: [readAll], class: 1 }))
    }, null)
    await until(() => pluginsManager.plugin('reader')?.state === 'ready')
    expect(modules.state('luoshu')).toBe('on')
    expect((await call('reader', 'luoshu.read', { path: 'a.md' }))?.refusal?.code).toBe('unavailable')
    const all = await records()
    expect(all.some(record => record.event === 'plugin.waiting')).toBe(false)
    expect(all).toContainEqual(expect.objectContaining({ event: 'plugin.started', plugin: 'reader' }))
  })
})

// The luoshu.read calls a plugin made as the audit records count them, each record standing for count calls
const readsBy = (all: Record<string, unknown>[], id: string) => all
  .filter(record => record.event === 'audit.call' && record.action === 'luoshu.read' && String(record.caller).startsWith(`${id}/`))
  .reduce((sum, record) => sum + (typeof record.count === 'number' ? record.count : 1), 0)

describe('the reads the audit counts', () => {
  it('counts no read for a listing and one for each read', async () => {
    const { pluginsManager, records, call } = await joined(async (dataDir, store) => {
      const root = path.join(dataDir, 'plugins', 'lister')
      await writeFolder(root, filesFor(workerManifest('lister', { capabilities: [listAll, readAll] })))
      await store.writePlugin('lister', await entryFor(root, { granted: [listAll, readAll], class: 1 }))
    }, await notesFolder({ 'a.md': 'alpha', 'inbox/b.md': 'beta' }))
    await until(() => pluginsManager.plugin('lister')?.state === 'ready')
    for (let i = 0; i < 3; i++) expect((await call('lister', 'luoshu.list', {}))?.result).toMatchObject({ paths: ['a.md', 'inbox/b.md'] })
    expect(readsBy(await records(), 'lister')).toBe(0)
    expect((await call('lister', 'luoshu.read', { path: 'inbox/b.md' }))?.ok).toBe(true)
    expect(readsBy(await records(), 'lister')).toBe(1)
  })
})
