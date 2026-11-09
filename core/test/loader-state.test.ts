import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, filesFor, harness, hashOf, hostManifest, reasonOf, stateOf, until,
  workerManifest, type Files,
} from './loader-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))
const exists = (file: string) => stat(file).then(() => true, () => false)

describe('StateView versions', () => {
  it('start at 1, grow by one with every applied change and reach the gate through stateChanged', async () => {
    const gate = allowAll()
    const made = await harness({ behave: { gate: { exports: { gate } } } })
    await made.loader.start()
    expect(made.loader.view()).toBe(1)
    expect(gate.views).toEqual([1])
    const changes = made.link.changes
    await made.loader.apply({ kind: 'confirmOff', on: true })
    await made.loader.apply({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    expect(made.loader.view()).toBe(3)
    expect(gate.views).toEqual([1, 2, 3])
    expect(made.link.changes).toBeGreaterThan(changes)
    // The carrier refuses an answer made on an older one, so what the gate holds is what the carrier compares
    expect(made.loader.limits().all.readyMs).toBe(20000)
  })

  it('stay where they were when the write fails, and nothing applies', async () => {
    const gate = allowAll()
    const made = await harness({ behave: { gate: { exports: { gate } } } })
    await made.loader.start()
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    await expect(made.loader.apply({ kind: 'skipVerification', on: true })).rejects.toThrow('read-only')
    expect(made.loader.view()).toBe(1)
    expect(gate.views).toEqual([1])
  })

  it('mark the gate failed when it throws on a new one', async () => {
    const gate = allowAll()
    const made = await harness({ behave: { gate: { exports: { gate } } } })
    await made.loader.start()
    gate.throws = true
    await made.loader.apply({ kind: 'confirmOff', on: true })
    expect(made.loader.slot('gate')).toBe('failed')
    expect(reasonOf(made.loader, 'gate')).toBe('state-changed')
  })
})

describe('the human\'s switches, applied', () => {
  it('off switches an install plugin off at once and it stays down for the run once switched on, since a host half starts once', async () => {
    const made = await harness({ install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } } })
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.off', plugin: 'luoshu' })
    await made.loader.settled()
    expect(stateOf(made.loader, 'luoshu')).toBe('off')
    expect(made.link.sentTo('luoshu', 'stop')).toHaveLength(1)
    await made.loader.apply({ kind: 'plugin.on', plugin: 'luoshu' })
    await made.loader.settled()
    expect(stateOf(made.loader, 'luoshu')).toBe('stopped')
    expect(reasonOf(made.loader, 'luoshu')).toBe('restart-hetu')
    expect(made.runtime.order().filter(id => id === 'luoshu')).toHaveLength(1)
  })

  it('off switches a slot holder off at once, which reads off and not failed', async () => {
    const made = await harness()
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.off', plugin: 'gate' })
    expect(made.loader.slot('gate')).toBe('off')
    expect(made.link.events('slot.state')).toContainEqual({ slot: 'gate', state: 'off' })
  })

  it('off stops a folder plugin with its dependents first and on starts both again', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta', { requires: ['alpha'] }) },
      entries: { alpha: signed(), beta: signed() },
    })
    await made.loader.start()
    await made.loader.apply({ kind: 'plugin.off', plugin: 'alpha' })
    await made.loader.settled()
    expect(made.link.timeline.filter(line => line.startsWith('stop '))).toEqual(['stop beta', 'stop alpha'])
    expect(stateOf(made.loader, 'alpha')).toBe('off')
    expect(reasonOf(made.loader, 'beta')).toBe('dependency:alpha:off')
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.enabled).toBe(false)
    await made.loader.apply({ kind: 'plugin.on', plugin: 'alpha' })
    await made.loader.settled()
    expect(stateOf(made.loader, 'beta')).toBe('ready')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(2)
  })

  it('dev mode starts a plugin whose bytes changed once it names it, and stops it again once it doesn\'t', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed(), beta: signed() },
      before: async ({ dataDir }) => {
        await writeFile(path.join(dataDir, 'plugins', 'alpha', 'worker.js'), 'changed()')
        await writeFile(path.join(dataDir, 'plugins', 'beta', 'worker.js'), 'changed too()')
      },
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'alpha')).toBe('tampered')
    await made.loader.apply({ kind: 'devMode', plugin: 'alpha', on: true })
    await made.loader.settled()
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(reasonOf(made.loader, 'beta')).toBe('tampered')
    await made.loader.apply({ kind: 'devMode', plugin: 'alpha', on: false })
    await made.loader.settled()
    expect(reasonOf(made.loader, 'alpha')).toBe('tampered')
  })

  it('skipVerification lets changed bytes run and its switch-off refuses them again, with no other check moved', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed(), beta: signed({ signer: null }) },
      before: ({ dataDir }) => writeFile(path.join(dataDir, 'plugins', 'alpha', 'worker.js'), 'changed()'),
    })
    await made.loader.start()
    await made.loader.apply({ kind: 'skipVerification', on: true })
    await made.loader.settled()
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(reasonOf(made.loader, 'beta')).toBe('unsigned')
    await made.loader.apply({ kind: 'skipVerification', on: false })
    await made.loader.settled()
    expect(reasonOf(made.loader, 'alpha')).toBe('tampered')
  })

  it('allowUnsigned starts the one build it names and no other', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed({ signer: null }), beta: signed({ signer: null }) },
    })
    await made.loader.start()
    const hash = await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))
    await made.loader.apply({ kind: 'allowUnsigned', hash, on: true })
    await made.loader.settled()
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
    expect(reasonOf(made.loader, 'beta')).toBe('unsigned')
  })

  it('removed keeps a removed first-party plugin out and touches nothing else', async () => {
    const made = await harness({
      install: { ...coreInstall(), git: { files: worker('git'), firstParty: true }, mcp: { files: worker('mcp'), firstParty: true } },
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed() },
      switches: { removed: ['git'] },
    })
    await made.loader.start()
    expect(made.loader.plugin('git')).toBe(null)
    expect(stateOf(made.loader, 'mcp')).toBe('ready')
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
  })

  it('approves a found plugin from the one read it was found with', async () => {
    const made = await harness({ folder: { alpha: worker('alpha', { capabilities: [{ type: 'ui.panel' }] }) } })
    await made.loader.start()
    expect(stateOf(made.loader, 'alpha')).toBe('found')
    const hash = await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))
    await made.loader.apply({ kind: 'plugin.approve', plugin: 'alpha' })
    const entry = (await new StateStore(made.dataDir).load()).state.plugins.alpha
    // No capabilities slot here, so the class is unknown and every item asks at its first use
    expect(entry).toEqual({ version: '1.0.0', contentHash: hash, signer: null, granted: [{ type: 'ui.panel' }], class: null, enabled: true, firstUse: [{ type: 'ui.panel' }] })
    // No provenance yet, so the approved build still needs allowUnsigned to run
    expect(reasonOf(made.loader, 'alpha')).toBe('unsigned')
    await made.loader.apply({ kind: 'allowUnsigned', hash, on: true })
    await made.loader.settled()
    expect(stateOf(made.loader, 'alpha')).toBe('ready')
  })

  it('switching off a host half held by its marker clears the marker, so switched on again it starts fresh', async () => {
    const made = await harness({ install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } }, markers: ['luoshu'] })
    await mkdir(path.join(made.dataDir, 'starting'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'starting', 'luoshu'), '')
    await made.loader.start()
    expect(reasonOf(made.loader, 'luoshu')).toBe('marker')
    await made.loader.apply({ kind: 'plugin.off', plugin: 'luoshu' })
    expect(await exists(path.join(made.dataDir, 'starting', 'luoshu'))).toBe(false)
    await made.loader.apply({ kind: 'plugin.on', plugin: 'luoshu' })
    await until(() => stateOf(made.loader, 'luoshu') === 'ready')
  })

  it('writes the luoshu folder through the store', async () => {
    const made = await harness()
    await made.loader.start()
    const folder = process.platform === 'win32' ? 'C:\\notes' : '/home/han/notes'
    await made.loader.apply({ kind: 'luoshu.set', folder })
    expect(JSON.parse((await readFile(path.join(made.dataDir, 'state', 'luoshu.json'), 'utf8')).split('\n').slice(0, -2).join('\n')).folder).toBe(folder)
    expect(made.loader.view()).toBe(2)
  })

  it('applies changes one at a time, so two at once both land', async () => {
    const made = await harness({ folder: { alpha: worker('alpha'), beta: worker('beta') }, entries: { alpha: signed(), beta: signed() } })
    await made.loader.start()
    await Promise.all([
      made.loader.apply({ kind: 'devMode', plugin: 'alpha', on: true }),
      made.loader.apply({ kind: 'devMode', plugin: 'beta', on: true }),
    ])
    expect((await new StateStore(made.dataDir).load()).state.switches.devMode.sort()).toEqual(['alpha', 'beta'])
    expect(made.loader.view()).toBe(3)
  })

  it('applies the next change after one that failed', async () => {
    const made = await harness()
    await made.loader.start()
    const write = made.store.writeSwitches.bind(made.store)
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    await expect(made.loader.apply({ kind: 'confirmOff', on: true })).rejects.toThrow('read-only')
    made.store.writeSwitches = write
    await made.loader.apply({ kind: 'confirmOff', on: true })
    expect((await new StateStore(made.dataDir).load()).state.switches.confirmOff).toBe(true)
  })

  it('keeps judging plugins by the switches on disk when a write fails, through later changes', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed() },
      before: ({ dataDir }) => writeFile(path.join(dataDir, 'plugins', 'alpha', 'worker.js'), 'changed()'),
    })
    await made.loader.start()
    expect(reasonOf(made.loader, 'alpha')).toBe('tampered')
    const write = made.store.writeSwitches.bind(made.store)
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    await expect(made.loader.apply({ kind: 'skipVerification', on: true })).rejects.toThrow('read-only')
    made.store.writeSwitches = write
    // A later change writes the switches whole and replans
    await made.loader.apply({ kind: 'confirmOff', on: true })
    await made.loader.settled()
    expect(reasonOf(made.loader, 'alpha')).toBe('tampered')
    expect((await new StateStore(made.dataDir).load()).state.switches.skipVerification).toBe(false)
  })

  it('stores what each switch change names, both ways, and a plugin\'s limits beside its others', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.loader.start()
    const stored = async () => (await new StateStore(made.dataDir).load()).state.switches
    await made.loader.apply({ kind: 'exec.anyCommand', plugin: 'alpha', on: true })
    expect((await stored()).execAnyCommand).toEqual(['alpha'])
    await made.loader.apply({ kind: 'exec.anyCommand', plugin: 'alpha', on: false })
    expect((await stored()).execAnyCommand).toEqual([])
    await made.loader.apply({ kind: 'confirmOff', on: true })
    expect((await stored()).confirmOff).toBe(true)
    await made.loader.apply({ kind: 'confirmOff', on: false })
    expect((await stored()).confirmOff).toBe(false)
    await made.loader.apply({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    await made.loader.apply({ kind: 'limit.set', constant: 'readyMs', value: 15000, plugin: 'alpha' })
    await made.loader.apply({ kind: 'limit.set', constant: 'stopGraceMs', value: 5000, plugin: 'alpha' })
    const limits = { all: { readyMs: 20000 }, plugins: { alpha: { readyMs: 15000, stopGraceMs: 5000 } } }
    expect((await stored()).limits).toEqual(limits)
    expect(made.loader.limits()).toEqual(limits)
  })

  it('takes switching a crashed plugin back on as the human\'s restart of it', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.loader.start()
    made.runtime.half('alpha').crash()
    await until(() => stateOf(made.loader, 'alpha') === 'crashed')
    await made.loader.apply({ kind: 'plugin.off', plugin: 'alpha' })
    expect(stateOf(made.loader, 'alpha')).toBe('off')
    await made.loader.apply({ kind: 'plugin.on', plugin: 'alpha' })
    await until(() => stateOf(made.loader, 'alpha') === 'ready')
    expect(made.loader.plugin('alpha')?.incarnation).toBe(2)
  })

  it('refuses a change outside core/api\'s change schema', async () => {
    const made = await harness()
    await made.loader.start()
    await expect(made.loader.apply({ kind: 'plugin.off', plugin: 'Not An Id' } as never)).rejects.toThrow()
    await expect(made.loader.apply({ kind: 'off-everything' } as never)).rejects.toThrow()
  })
})

describe("the StateView's grants", () => {
  const read = { type: 'luoshu.read' as const, paths: ['notes/**'] }
  const panel = { type: 'ui.panel' as const }
  const item = (capability: object, off = false) => ({ capability, off, firstUse: false })

  async function started() {
    const gate = allowAll()
    const made = await harness({
      install: { ...coreInstall(), gate: { files: filesFor(hostManifest('gate', { capabilities: [{ type: 'log.read' }] })) } },
      folder: { alpha: worker('alpha', { capabilities: [read, panel] }), beta: worker('beta') },
      entries: { alpha: signed({ granted: [read, panel] }), beta: signed() },
      behave: { gate: { exports: { gate } } },
    })
    await made.loader.start()
    return { ...made, gate }
  }

  it("carry each plugin's grants as items, a folder plugin's from its entry and an install plugin's from its manifest", async () => {
    const { gate } = await started()
    const view = gate.seen[0]
    expect(view.n).toBe(1)
    expect(view.foldCase).toBe(false)
    expect(view.plugins.alpha).toEqual([item(read), item(panel)])
    expect(view.plugins.gate).toEqual([item({ type: 'log.read' })])
    // A plugin holding nothing is left out, and an id every object has finds nothing
    expect(Object.keys(view.plugins).sort()).toEqual(['alpha', 'gate'])
    expect(Object.getPrototypeOf(view.plugins)).toBe(null)
    expect(view.plugins.constructor).toBeUndefined()
    expect(Object.isFrozen(view.plugins.alpha[0].capability)).toBe(true)
  })

  it("switch one item off with item.off, kept in the plugin's entry and in the next StateView, and back on with item.on", async () => {
    const made = await started()
    await made.loader.apply({ kind: 'item.off', plugin: 'alpha', capability: read })
    expect(made.gate.seen.at(-1)!.n).toBe(2)
    expect(made.gate.seen.at(-1)!.plugins.alpha).toEqual([item(read, true), item(panel)])
    expect((await made.store.load()).state.plugins.alpha.off).toEqual([read])
    await made.loader.apply({ kind: 'item.on', plugin: 'alpha', capability: read })
    expect(made.gate.seen.at(-1)!.plugins.alpha).toEqual([item(read), item(panel)])
    expect((await made.store.load()).state.plugins.alpha.off ?? []).toEqual([])
  })

  it("refuse a switch for an item the plugin wasn't granted, a plugin with no entry and an install plugin, applying nothing", async () => {
    const made = await started()
    await expect(made.loader.apply({ kind: 'item.off', plugin: 'alpha', capability: { type: 'luoshu.read', paths: ['other/**'] } })).rejects.toThrow()
    await expect(made.loader.apply({ kind: 'item.off', plugin: 'nobody', capability: read })).rejects.toThrow()
    await expect(made.loader.apply({ kind: 'item.off', plugin: 'gate', capability: { type: 'log.read' } })).rejects.toThrow()
    expect(made.loader.view()).toBe(1)
  })

  // Its stop grace runs after the switch, and a call it makes then must not pass on grants the human took away
  it("leave out a plugin the human switched off from the next one, before its stop has ended, and an install plugin switched off", async () => {
    const gate = allowAll()
    const made = await harness({
      install: { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu', { capabilities: [{ type: 'log.read' }] })) } },
      folder: { alpha: worker('alpha', { capabilities: [read] }) },
      entries: { alpha: signed({ granted: [read] }) },
      switches: { off: ['luoshu'] },
      behave: { gate: { exports: { gate } }, alpha: { stopped: false } },
    })
    await made.loader.start()
    expect(Object.keys(gate.seen[0].plugins)).toEqual(['alpha'])
    void made.loader.apply({ kind: 'plugin.off', plugin: 'alpha' })
    await until(() => stateOf(made.loader, 'alpha') === 'stopping')
    expect(gate.seen.at(-1)!.plugins.alpha).toBeUndefined()
  })
})
