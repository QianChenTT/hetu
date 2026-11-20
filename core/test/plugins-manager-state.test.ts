import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../backend/boot/state.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, fakeLuoshu, filesFor, harness, hashOf, hostManifest, reasonOf, stateOf, until,
  workerManifest, type Files,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const signed = (extra = {}) => (root: string) => entryFor(root, extra)
const worker = (id: string, extra: object = {}): Files => filesFor(workerManifest(id, extra))

describe('grants snapshot versions', () => {
  it('start at 1, grow by one with every applied change and reach the gate through stateChanged', async () => {
    const gate = allowAll()
    const made = await harness({ modules: { gate } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.view()).toBe(1)
    expect(gate.views).toEqual([1])
    const changes = made.link.changes
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    expect(made.pluginsManager.view()).toBe(3)
    expect(gate.views).toEqual([1, 2, 3])
    expect(made.link.changes).toBeGreaterThan(changes)
    // The router refuses an answer made on an older one, so what the gate holds is what the router compares
    expect(made.pluginsManager.limits().all.readyMs).toBe(20000)
  })

  it('stay where they were when the write fails, and nothing applies', async () => {
    const gate = allowAll()
    const made = await harness({ modules: { gate } })
    await made.pluginsManager.start()
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    await expect(made.pluginsManager.apply({ kind: 'skipVerification', on: true })).rejects.toThrow('read-only')
    expect(made.pluginsManager.view()).toBe(1)
    expect(gate.views).toEqual([1])
  })

  it('mark the gate failed when it throws on a new one, stopping nothing, until the next one goes through', async () => {
    const gate = allowAll()
    const made = await harness({ modules: { gate } })
    await made.pluginsManager.start()
    gate.throws = true
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect(made.pluginsManager.policyJob('gate')).toBe('failed')
    expect(made.modules.reason('gate')).toBe('state-changed')
    expect(made.modules.gate()).toBeNull()
    expect(made.link.events('policy-job.state')).toContainEqual({ policyJob: 'gate', state: 'failed' })
    expect(made.pluginsManager.stopped()).toBeNull()
    gate.throws = false
    await made.pluginsManager.apply({ kind: 'confirmOff', on: false })
    expect(made.pluginsManager.policyJob('gate')).toBe('on')
    expect(gate.views.at(-1)).toBe(made.pluginsManager.view())
  })
})

describe('the human\'s switches, applied', () => {
  it('off switches a core module off at once and on starts it again in the run', async () => {
    const luoshu = fakeLuoshu()
    const made = await harness({ modules: { luoshu } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'luoshu' })
    expect(made.modules.state('luoshu')).toBe('off')
    expect(made.modules.provider('luoshu')).toBeNull()
    expect(luoshu.closed).toBe(1)
    expect((await new StateStore(made.dataDir).load()).state.switches.off).toEqual(['luoshu'])
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'luoshu' })
    expect(made.modules.state('luoshu')).toBe('on')
    expect(made.modules.provider('luoshu')).toBe(luoshu.provider)
    expect(luoshu.opened).toHaveLength(2)
  })

  it('off switches a policy job holder off at once, which reads off and not failed', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'gate' })
    expect(made.pluginsManager.policyJob('gate')).toBe('off')
    expect(made.link.events('policy-job.state')).toContainEqual({ policyJob: 'gate', state: 'off' })
  })

  it('off stops a folder plugin with its dependents first and on starts both again', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta', { requires: ['alpha'] }) },
      entries: { alpha: signed(), beta: signed() },
    })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect(made.link.timeline.filter(line => line.startsWith('stop '))).toEqual(['stop beta', 'stop alpha'])
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('off')
    expect(reasonOf(made.pluginsManager, 'beta')).toBe('dependency:alpha:off')
    expect((await new StateStore(made.dataDir).load()).state.plugins.alpha.enabled).toBe(false)
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'alpha' })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'beta')).toBe('ready')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(2)
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
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('tampered')
    await made.pluginsManager.apply({ kind: 'devMode', plugin: 'alpha', on: true })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(reasonOf(made.pluginsManager, 'beta')).toBe('tampered')
    await made.pluginsManager.apply({ kind: 'devMode', plugin: 'alpha', on: false })
    await made.pluginsManager.settled()
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('tampered')
  })

  it('skipVerification lets changed bytes run and its switch-off refuses them again, with no other check moved', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed(), beta: signed({ signer: null }) },
      before: ({ dataDir }) => writeFile(path.join(dataDir, 'plugins', 'alpha', 'worker.js'), 'changed()'),
    })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'skipVerification', on: true })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(reasonOf(made.pluginsManager, 'beta')).toBe('unsigned')
    await made.pluginsManager.apply({ kind: 'skipVerification', on: false })
    await made.pluginsManager.settled()
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('tampered')
  })

  it('allowUnsigned starts the one build it names and no other', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha'), beta: worker('beta') },
      entries: { alpha: signed({ signer: null }), beta: signed({ signer: null }) },
    })
    await made.pluginsManager.start()
    const hash = await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))
    await made.pluginsManager.apply({ kind: 'allowUnsigned', hash, on: true })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(reasonOf(made.pluginsManager, 'beta')).toBe('unsigned')
  })

  it('removed keeps a removed first-party plugin out and touches nothing else', async () => {
    const made = await harness({
      install: { ...coreInstall(), git: { files: worker('git'), firstParty: true }, mcp: { files: worker('mcp'), firstParty: true } },
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed() },
      switches: { removed: ['git'] },
    })
    await made.pluginsManager.start()
    expect(made.pluginsManager.plugin('git')).toBe(null)
    expect(stateOf(made.pluginsManager, 'mcp')).toBe('ready')
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  it('approves a found plugin from the one read it was found with', async () => {
    const made = await harness({ folder: { alpha: worker('alpha', { capabilities: [{ type: 'ui.view' }] }) } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('found')
    const hash = await hashOf(path.join(made.dataDir, 'plugins', 'alpha'))
    await made.pluginsManager.apply({ kind: 'plugin.approve', plugin: 'alpha' })
    const entry = (await new StateStore(made.dataDir).load()).state.plugins.alpha
    // The grant risk classifier classes a view at 0, which asks nothing at its first use
    expect(entry).toEqual({ version: '1.0.0', contentHash: hash, signer: null, granted: [{ type: 'ui.view' }], class: 0, enabled: true })
    // No provenance yet, so the approved build still needs allowUnsigned to run
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('unsigned')
    await made.pluginsManager.apply({ kind: 'allowUnsigned', hash, on: true })
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  it('writes the luoshu folder through the store', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const folder = process.platform === 'win32' ? 'C:\\notes' : '/home/han/notes'
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder })
    expect(JSON.parse((await readFile(path.join(made.dataDir, 'state', 'luoshu.json'), 'utf8')).split('\n').slice(0, -2).join('\n')).folder).toBe(folder)
    expect(made.pluginsManager.view()).toBe(2)
  })

  it('applies changes one at a time, so two at once both land', async () => {
    // Each holds nothing, so the pass at start leaves the class 0 its entry holds
    const made = await harness({ folder: { alpha: worker('alpha'), beta: worker('beta') }, entries: { alpha: signed({ class: 0 }), beta: signed({ class: 0 }) } })
    await made.pluginsManager.start()
    await Promise.all([
      made.pluginsManager.apply({ kind: 'devMode', plugin: 'alpha', on: true }),
      made.pluginsManager.apply({ kind: 'devMode', plugin: 'beta', on: true }),
    ])
    expect((await new StateStore(made.dataDir).load()).state.switches.devMode.sort()).toEqual(['alpha', 'beta'])
    expect(made.pluginsManager.view()).toBe(3)
  })

  it('applies the next change after one that failed', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const write = made.store.writeSwitches.bind(made.store)
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    await expect(made.pluginsManager.apply({ kind: 'confirmOff', on: true })).rejects.toThrow('read-only')
    made.store.writeSwitches = write
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect((await new StateStore(made.dataDir).load()).state.switches.confirmOff).toBe(true)
  })

  it('keeps judging plugins by the switches on disk when a write fails, through later changes', async () => {
    const made = await harness({
      folder: { alpha: worker('alpha') },
      entries: { alpha: signed() },
      before: ({ dataDir }) => writeFile(path.join(dataDir, 'plugins', 'alpha', 'worker.js'), 'changed()'),
    })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('tampered')
    const write = made.store.writeSwitches.bind(made.store)
    made.store.writeSwitches = async () => { throw new Error('read-only') }
    await expect(made.pluginsManager.apply({ kind: 'skipVerification', on: true })).rejects.toThrow('read-only')
    made.store.writeSwitches = write
    // A later change writes the switches whole and replans
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    await made.pluginsManager.settled()
    expect(reasonOf(made.pluginsManager, 'alpha')).toBe('tampered')
    expect((await new StateStore(made.dataDir).load()).state.switches.skipVerification).toBe(false)
  })

  it('stores what each switch change names, both ways, and a plugin\'s limits beside its others', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    const stored = async () => (await new StateStore(made.dataDir).load()).state.switches
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'alpha', on: true })
    expect((await stored()).execAnyCommand).toEqual(['alpha'])
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'alpha', on: false })
    expect((await stored()).execAnyCommand).toEqual([])
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect((await stored()).confirmOff).toBe(true)
    await made.pluginsManager.apply({ kind: 'confirmOff', on: false })
    expect((await stored()).confirmOff).toBe(false)
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'readyMs', value: 15000, plugin: 'alpha' })
    await made.pluginsManager.apply({ kind: 'limit.set', constant: 'stopGraceMs', value: 5000, plugin: 'alpha' })
    const limits = { all: { readyMs: 20000 }, plugins: { alpha: { readyMs: 15000, stopGraceMs: 5000 } } }
    expect((await stored()).limits).toEqual(limits)
    expect(made.pluginsManager.limits()).toEqual(limits)
  })

  it('takes switching a crashed plugin back on as the human\'s restart of it', async () => {
    const made = await harness({ folder: { alpha: worker('alpha') }, entries: { alpha: signed() } })
    await made.pluginsManager.start()
    made.runtime.half('alpha').crash()
    await until(() => stateOf(made.pluginsManager, 'alpha') === 'crashed')
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'alpha' })
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('off')
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'alpha' })
    await until(() => stateOf(made.pluginsManager, 'alpha') === 'ready')
    expect(made.pluginsManager.plugin('alpha')?.incarnation).toBe(2)
  })

  it('refuses a change outside core/api\'s change schema', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    await expect(made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'Not An Id' } as never)).rejects.toThrow()
    await expect(made.pluginsManager.apply({ kind: 'off-everything' } as never)).rejects.toThrow()
  })
})

describe("the grants snapshot's grants", () => {
  const read = { type: 'luoshu.read' as const, paths: ['notes/**'] }
  const panel = { type: 'ui.view' as const }
  const item = (capability: object, off = false) => ({ capability, off, firstUse: false })

  const http = 'mcp-http-handler'
  async function started() {
    const gate = allowAll()
    const made = await harness({
      install: { ...coreInstall(), [http]: { files: filesFor(hostManifest(http, { capabilities: [{ type: 'log.read' }] })) } },
      folder: { alpha: worker('alpha', { capabilities: [read, panel] }), beta: worker('beta') },
      entries: { alpha: signed({ granted: [read, panel], class: 1 }), beta: signed({ class: 0 }) },
      modules: { gate },
    })
    await made.pluginsManager.start()
    return { ...made, gate }
  }

  it("carry each plugin's grants as items, a folder plugin's from its entry and a core plugin's from its manifest", async () => {
    const { gate } = await started()
    const view = gate.seen[0]
    expect(view.n).toBe(1)
    expect(view.foldCase).toBe(false)
    expect(view.plugins.alpha).toEqual([item(read), item(panel)])
    expect(view.plugins[http]).toEqual([item({ type: 'log.read' })])
    // A plugin holding nothing is left out, and an id every object has finds nothing
    expect(Object.keys(view.plugins).sort()).toEqual(['alpha', http])
    expect(Object.getPrototypeOf(view.plugins)).toBe(null)
    expect(view.plugins.constructor).toBeUndefined()
    expect(Object.isFrozen(view.plugins.alpha[0].capability)).toBe(true)
  })

  it('name the plugins the human let exec run any command for, from the switch on', async () => {
    const made = await started()
    expect(made.gate.seen[0].execAny).toEqual([])
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'alpha', on: true })
    expect(made.gate.seen.at(-1)!.execAny).toEqual(['alpha'])
    expect(Object.isFrozen(made.gate.seen.at(-1)!.execAny)).toBe(true)
    await made.pluginsManager.apply({ kind: 'exec.anyCommand', plugin: 'alpha', on: false })
    expect(made.gate.seen.at(-1)!.execAny).toEqual([])
  })

  it("switch one item off with item.off, kept in the plugin's entry and in the next grants snapshot, and back on with item.on", async () => {
    const made = await started()
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'alpha', capability: read })
    expect(made.gate.seen.at(-1)!.n).toBe(2)
    expect(made.gate.seen.at(-1)!.plugins.alpha).toEqual([item(read, true), item(panel)])
    expect((await made.store.load()).state.plugins.alpha.off).toEqual([read])
    await made.pluginsManager.apply({ kind: 'item.on', plugin: 'alpha', capability: read })
    expect(made.gate.seen.at(-1)!.plugins.alpha).toEqual([item(read), item(panel)])
    expect((await made.store.load()).state.plugins.alpha.off ?? []).toEqual([])
  })

  it("refuse a switch for an item the plugin wasn't granted, a plugin with no entry and a core plugin, applying nothing", async () => {
    const made = await started()
    await expect(made.pluginsManager.apply({ kind: 'item.off', plugin: 'alpha', capability: { type: 'luoshu.read', paths: ['other/**'] } })).rejects.toThrow()
    await expect(made.pluginsManager.apply({ kind: 'item.off', plugin: 'nobody', capability: read })).rejects.toThrow()
    await expect(made.pluginsManager.apply({ kind: 'item.off', plugin: http, capability: { type: 'log.read' } })).rejects.toThrow()
    expect(made.pluginsManager.view()).toBe(1)
  })

  // Its stop grace runs after the switch, and a call it makes then must not pass on grants the human took away
  it("leave out a plugin the human switched off from the next one, before its stop has ended, and a core plugin switched off", async () => {
    const gate = allowAll()
    const made = await harness({
      install: { ...coreInstall(), [http]: { files: filesFor(hostManifest(http, { capabilities: [{ type: 'log.read' }] })) } },
      folder: { alpha: worker('alpha', { capabilities: [read] }) },
      entries: { alpha: signed({ granted: [read] }) },
      switches: { off: [http] },
      modules: { gate },
      behave: { alpha: { stopped: false } },
    })
    await made.pluginsManager.start()
    expect(Object.keys(gate.seen[0].plugins)).toEqual(['alpha'])
    void made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'alpha' })
    await until(() => stateOf(made.pluginsManager, 'alpha') === 'stopping')
    expect(gate.seen.at(-1)!.plugins.alpha).toBeUndefined()
  })
})
