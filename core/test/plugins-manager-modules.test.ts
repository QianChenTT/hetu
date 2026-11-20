import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreStatus, SecurityList } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import type { Failure } from '../backend/runtime/header.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, fakeExec, fakeHistory, fakeLuoshu, filesFor, harness, hostManifest, reasonOf, stateOf, until,
  workerManifest, type Files,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })
const worker = (id: string, requires: string[] = []): Files => filesFor(workerManifest(id, requires.length > 0 ? { requires } : {}))
// A plugin-folder plugin that requires the given core module
const needing = (id: string, module: string) => ({ folder: { [id]: worker(id, [module]) }, entries: { [id]: (root: string) => entryFor(root) } })
const rows = async (made: Awaited<ReturnType<typeof harness>>) => ((await made.pluginsManager.serve(call(trusted, 'security.list'))) as SecurityList).plugins
const changes = (made: Awaited<ReturnType<typeof harness>>) => made.link.events('module.state')

describe('a core module\'s start', () => {
  it('runs past readyMs as failed with start-failed while hetu opens without it, every plugin started', async () => {
    const exec = fakeExec()
    exec.start = () => new Promise(() => {})
    const made = await harness({ ...needing('alpha', 'luoshu'), modules: { exec }, limits: { readyMs: 50 } })
    await made.pluginsManager.start()
    expect(made.modules.state('exec')).toBe('failed')
    expect(made.modules.reason('exec')).toBe('start-failed')
    expect(made.link.events('fault')).toContainEqual({ plugin: 'exec', step: 'start-timeout' })
    expect(changes(made)).toContainEqual({ module: 'exec', state: 'failed', reason: 'start-failed' })
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(made.link.events('core.ready')).toHaveLength(1)
  })

  it('holds a switch on for at most readyMs, so the changes after it apply', async () => {
    const exec = fakeExec()
    const made = await harness({ modules: { exec }, switches: { off: ['exec'] }, limits: { readyMs: 50 } })
    await made.pluginsManager.start()
    exec.start = () => new Promise(() => {})
    const began = Date.now()
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'exec' })
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    expect(Date.now() - began).toBeLessThan(5000)
    expect(made.modules.state('exec')).toBe('failed')
    expect((await made.store.load()).state.switches.confirmOff).toBe(true)
  })

  it('records each module started once the core starts, one switched off off and nothing for one that never ran', async () => {
    const made = await harness({ switches: { off: ['history'] } })
    await made.pluginsManager.start()
    expect(changes(made)).toEqual(['gate', 'grant-risk-classifier', 'storage', 'luoshu', 'exec', 'flood-control', 'heartbeat', 'recording', 'security-view'].map(module => ({ module, state: 'started', reason: null })))
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'exec' })
    expect(changes(made).at(-1)).toEqual({ module: 'exec', state: 'stopped', reason: 'off' })
  })
})

describe('what requires a core module', () => {
  it('starts once the luoshu recovers on a pick, the luoshu having failed at start', async () => {
    const luoshu = fakeLuoshu()
    luoshu.throws = true
    const made = await harness({ ...needing('outline', 'luoshu'), modules: { luoshu } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('waiting')
    luoshu.throws = false
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder: path.join(made.base, 'notes') })
    await until(() => stateOf(made.pluginsManager, 'outline') === 'ready')
    expect(changes(made)).toContainEqual({ module: 'luoshu', state: 'recovered', reason: null })
  })

  it('waits once the luoshu fails on a pick', async () => {
    const luoshu = fakeLuoshu()
    const made = await harness({ ...needing('outline', 'luoshu'), modules: { luoshu } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'outline')).toBe('ready')
    luoshu.throws = true
    await made.pluginsManager.apply({ kind: 'luoshu.pick', folder: path.join(made.base, 'notes') })
    await until(() => stateOf(made.pluginsManager, 'outline') === 'waiting')
    expect(reasonOf(made.pluginsManager, 'outline')).toBe('dependency:luoshu:failed')
  })

  it('waits once exec fails on a grants snapshot and starts once one goes through', async () => {
    const exec = fakeExec()
    const made = await harness({ ...needing('runner', 'exec'), modules: { exec } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'runner')).toBe('ready')
    exec.throws = true
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    await until(() => stateOf(made.pluginsManager, 'runner') === 'waiting')
    exec.throws = false
    await made.pluginsManager.apply({ kind: 'confirmOff', on: false })
    await until(() => stateOf(made.pluginsManager, 'runner') === 'ready')
  })

  it('lists history waiting on the luoshu while the luoshu is off, a plugin requiring history waiting too', async () => {
    const made = await harness({ ...needing('timeline', 'history'), modules: { history: fakeHistory() }, switches: { off: ['luoshu'] } })
    await made.pluginsManager.start()
    expect((await rows(made)).find(row => row.id === 'history')).toMatchObject({ state: 'waiting', reason: 'dependency:luoshu:off', on: true })
    expect(stateOf(made.pluginsManager, 'timeline')).toBe('waiting')
    expect(reasonOf(made.pluginsManager, 'timeline')).toBe('dependency:history:waiting')
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'luoshu' })
    await until(() => stateOf(made.pluginsManager, 'timeline') === 'ready')
    expect((await rows(made)).find(row => row.id === 'history')).toMatchObject({ state: 'ready', reason: null })
  })
})

describe('the grants snapshot', () => {
  it.each(['gate', 'grant-risk-classifier', 'exec'])('grows by one when %s is switched off and by one when it is switched on', async id => {
    const gate = allowAll()
    const made = await harness({ modules: { gate } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.view()).toBe(1)
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: id })
    expect(made.pluginsManager.view()).toBe(2)
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: id })
    expect(made.pluginsManager.view()).toBe(3)
    await made.pluginsManager.settled()
    expect(made.pluginsManager.view()).toBe(3)
  })
})

describe('flood control as a core module', () => {
  it('is a row of its own with its switch, a security control switched off only with its id typed', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    expect((await rows(made)).find(row => row.id === 'flood-control')).toMatchObject({
      from: 'core', place: 'core', state: 'ready', security: true, on: true,
    })
    expect(made.modules.floodControl()).not.toBe(null)
    const held = await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'flood-control' }, trusted) as { held: string }
    const listed = (await made.pluginsManager.serve(call(trusted, 'security.list'))) as SecurityList
    expect(listed.requests.find(request => request.id === held.held)?.type).toBe('flood-control')
  })

  it('reads off once switched off, so the carrier asks nothing, handing every running plugin its limits again each way', async () => {
    const limited: string[] = []
    const made = await harness({ ...needing('alpha', 'luoshu'), pluginsManager: { limited: plugin => void limited.push(plugin) } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'flood-control' })
    expect(made.modules.state('flood-control')).toBe('off')
    expect(made.modules.floodControl()).toBe(null)
    expect(limited).toEqual(['alpha'])
    await made.pluginsManager.apply({ kind: 'plugin.on', plugin: 'flood-control' })
    expect(made.modules.floodControl()).not.toBe(null)
    expect(limited).toEqual(['alpha', 'alpha'])
  })
})

describe('the banner', () => {
  // A policy job switched off shows as its state already, so the list names the other modules
  it('names each core module the human switched off but the policy jobs', async () => {
    const made = await harness({ switches: { off: ['gate', 'flood-control', 'heartbeat', 'recording', 'security-view', 'exec'] } })
    await made.pluginsManager.start()
    const status = await made.pluginsManager.serve(call(trusted, 'core.status')) as CoreStatus
    expect(status.modulesOff).toEqual(['exec', 'flood-control', 'heartbeat', 'recording', 'security-view'])
    expect(status.policyJobs.gate).toBe('off')
  })
})

describe('the core modules in the stopped mode', () => {
  it('never start when the install list fails its check, so nothing judges or serves', async () => {
    const luoshu = fakeLuoshu()
    const history = fakeHistory()
    const exec = fakeExec()
    const gate = allowAll()
    const made = await harness({ install: { ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) } }, modules: { luoshu, history, exec, gate } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toMatchObject({ control: 'install', why: 'tampered' })
    expect(history.started + exec.started).toBe(0)
    expect(luoshu.opened).toEqual([])
    expect(gate.views).toEqual([])
    expect(made.modules.gate()).toBeNull()
    expect(made.pluginsManager.policyJob('gate')).toBe('failed')
    expect(made.modules.provider('storage')).toBeNull()
    expect(changes(made)).toEqual([])
  })

  it('close once every plugin stopped, in the reverse of their start with the gate last, when the log fails again', async () => {
    const failures: Failure[] = []
    const luoshu = fakeLuoshu()
    const history = fakeHistory()
    const exec = fakeExec()
    const made = await harness({
      ...needing('alpha', 'luoshu'),
      modules: { luoshu, history, exec },
      pluginsManager: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log'),
    })
    await made.pluginsManager.start()
    const started = changes(made).length
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(changes(made).slice(started)).toEqual(['heartbeat', 'exec', 'history', 'luoshu', 'storage', 'grant-risk-classifier', 'gate'].map(module => ({
      module, state: 'stopped', reason: 'stopped-mode',
    })))
    const timeline = made.link.timeline
    expect(timeline.indexOf('stop alpha')).toBeGreaterThan(-1)
    expect(timeline.indexOf('stop alpha')).toBeLessThan(timeline.indexOf('record module.state', timeline.indexOf('record core.stopped')))
    expect([luoshu.closed, history.closed, exec.closed]).toEqual([1, 1, 1])
    expect(made.modules.gate()).toBeNull()
    expect(made.modules.grantRiskClassifier()).toBeNull()
    for (const namespace of ['storage', 'luoshu', 'history', 'exec']) expect(made.modules.provider(namespace)).toBeNull()
    expect(made.pluginsManager.policyJob('gate')).toBe('failed')
    expect(made.link.events('policy-job.state')).toContainEqual({ policyJob: 'gate', state: 'failed' })
    // A switch in the stopped mode starts nothing again
    await made.pluginsManager.shutdown()
    expect([luoshu.closed, history.closed, exec.closed]).toEqual([1, 1, 1])
  })

  it('list each module stopped in the trusted window, one switched off still off', async () => {
    const failures: Failure[] = []
    const made = await harness({
      switches: { off: ['exec'] },
      pluginsManager: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log'),
    })
    await made.pluginsManager.start()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    const listed = await rows(made)
    expect(listed.find(row => row.id === 'gate')).toMatchObject({ state: 'stopped', reason: 'stopped-mode', on: true })
    expect(listed.find(row => row.id === 'exec')).toMatchObject({ state: 'off', reason: 'off', on: false })
  })
})
