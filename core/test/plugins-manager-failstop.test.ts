import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreStatus, SecurityList } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import type { Failure } from '../backend/runtime/header.ts'
import { createFloodControl } from '../backend/flood-control/flood-control.ts'
import { createHeartbeat } from '../backend/heartbeat/heartbeat.ts'
import { createSecurityView } from '../backend/security-view/security-view.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, fakeHistory, filesFor, harness, hostManifest, stateOf, until, workerManifest, type Files,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const worker = (id: string): Files => filesFor(workerManifest(id))
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })
const exists = (file: string) => stat(file).then(() => true, () => false)
// An install list naming a core module, which the core holds and no list may name, so the list can't be read
const naming = () => ({ ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) } })
const plugins = () => ({ folder: { alpha: worker('alpha') }, entries: { alpha: (root: string) => entryFor(root) } })
const tampered = (again: boolean) => ({ control: 'install', why: 'tampered', reason: null, again })

describe('a core module that fails at start', () => {
  it.each([
    ['the gate', 'gate', 'state-changed'],
    ['history', 'history', 'start-failed'],
  ] as const)('stops nothing when %s throws, which reads failed while every plugin starts', async (_name, id, reason) => {
    const gate = allowAll()
    gate.throws = id === 'gate'
    const history = fakeHistory()
    history.fails = id === 'history'
    const made = await harness({ ...plugins(), modules: { gate, history } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toBe(null)
    expect(made.modules.state(id)).toBe('failed')
    expect(made.modules.reason(id)).toBe(reason)
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    expect(made.link.events('core.stopped')).toEqual([])
    expect(made.link.events('core.ready')).toHaveLength(1)
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })

  it('shows a failed module in the trusted window list and in the banner as crashed, its switch still on', async () => {
    const history = fakeHistory()
    history.fails = true
    const made = await harness({ modules: { history }, switches: { off: ['exec'] } })
    await made.pluginsManager.start()
    const rows = ((await made.pluginsManager.serve(call(trusted, 'security.list'))) as SecurityList).plugins
    expect(rows.find(row => row.id === 'history')).toMatchObject({ from: 'core', place: 'core', state: 'failed', reason: 'start-failed', on: true, security: false })
    expect(rows.find(row => row.id === 'exec')).toMatchObject({ state: 'off', reason: 'off', on: false })
    expect(rows.find(row => row.id === 'grant-risk-classifier')).toMatchObject({ state: 'ready', reason: null, on: true, security: true })
    expect(((await made.pluginsManager.serve(call(editor, 'core.status'))) as CoreStatus).crashed).toEqual(['history'])
  })

  it('starts on with the gate the human switched off', async () => {
    const gate = allowAll()
    gate.throws = true
    const made = await harness({ ...plugins(), modules: { gate }, switches: { off: ['gate'] } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toBe(null)
    expect(made.pluginsManager.policyJob('gate')).toBe('off')
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  it('never stops for a plugin-folder plugin that fails', async () => {
    const made = await harness({ behave: { alpha: { ready: false } }, folder: { alpha: worker('alpha') } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toBe(null)
  })
})

describe('an install list that can\'t be read', () => {
  it('stops hetu in the stopped mode as tampered when it names a core module, starting no plugin', async () => {
    const made = await harness({ ...plugins(), install: naming() })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toEqual(tampered(false))
    expect(made.runtime.order()).toEqual([])
    expect(stateOf(made.pluginsManager, 'alpha')).not.toBe('ready')
    expect(made.link.events('core.ready')).toEqual([])
    expect(made.link.events('core.stopped')).toEqual([tampered(false)])
  })

  it('says again when the run before restarted', async () => {
    const made = await harness({ install: naming(), before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log') })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toEqual(tampered(true))
  })

  it('shows the stopped mode in core.status and the trusted window\'s list', async () => {
    const made = await harness({ install: naming() })
    await made.pluginsManager.start()
    expect(((await made.pluginsManager.serve(call(editor, 'core.status'))) as CoreStatus).stopped).toEqual(tampered(false))
    expect(((await made.pluginsManager.serve(call(trusted, 'security.list'))) as SecurityList).stopped).toEqual(tampered(false))
  })

  it('takes the human\'s choice in the stopped mode and clears the restart marker with it', async () => {
    const made = await harness({ install: naming(), before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log') })
    await made.pluginsManager.start()
    const { held } = await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trusted) as { held: string }
    await made.pluginsManager.confirm(held, { typed: 'gate' })
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })
})

describe('the log failing while hetu runs', () => {
  const failing = async () => {
    const failures: Failure[] = []
    const gate = allowAll()
    const made = await harness({ ...plugins(), modules: { gate }, pluginsManager: { onFailure: failure => { failures.push(failure) } } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toBe(null)
    return { made, gate, failures }
  }

  it('asks the runtime to quit and start again, with the restart marker written first', async () => {
    const { made, failures } = await failing()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'relaunch', control: 'log', reason: 'log-failing' }])
    expect(await readFile(path.join(made.dataDir, 'failed-once'), 'utf8')).toBe('log')
    expect(made.link.events('core.failed')).toEqual([{ control: 'log', reason: 'log-failing' }])
  })

  it('stops in the stopped mode instead when the run before restarted for it', async () => {
    const failures: Failure[] = []
    const made = await harness({
      ...plugins(),
      pluginsManager: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log'),
    })
    await made.pluginsManager.start()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    const mode = { control: 'log', why: 'failed', reason: 'log-failing', again: true }
    expect(failures).toEqual([{ action: 'stopped', mode, box: false }])
    expect(made.pluginsManager.stoppedBox()).toBe(false)
    expect(made.pluginsManager.stopped()).toEqual(mode)
    await made.pluginsManager.settled()
    expect(stateOf(made.pluginsManager, 'alpha')).not.toBe('ready')
  })

  // A core module that throws is refused per call and stops nothing, the log alone stops hetu
  it('asks nothing of the runtime when a core module throws while hetu runs', async () => {
    const { made, gate, failures } = await failing()
    gate.throws = true
    await made.pluginsManager.apply({ kind: 'confirmOff', on: true })
    await made.pluginsManager.settled()
    expect(made.pluginsManager.policyJob('gate')).toBe('failed')
    expect(failures).toEqual([])
    expect(made.link.events('core.failed')).toEqual([])
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  // The security view holds the stopped mode's choices, so with it off nothing could take one: the native box names
  // the cause with quit only
  it('stops in the native box when the security view is off', async () => {
    const failures: Failure[] = []
    const made = await harness({
      ...plugins(),
      switches: { off: ['security-view'] },
      pluginsManager: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log'),
    })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stoppedBox()).toBe(true)
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'stopped', mode: { control: 'log', why: 'failed', reason: 'log-failing', again: true }, box: true }])
  })

  // Only the log stops hetu: every other core module that throws is refused for that one thing and hetu runs on
  it('never stops for flood control, the heartbeat, the security view or recording throwing', async () => {
    const failures: Failure[] = []
    const thrown = () => { throw new Error('broken') }
    const floodControl = createFloodControl({ limit: () => 1000, clock: () => 0 })
    floodControl.acquire = thrown
    const heartbeat = createHeartbeat()
    heartbeat.started = thrown
    heartbeat.heard = thrown
    const securityView = createSecurityView()
    securityView.asked = thrown
    const made = await harness({
      ...plugins(), modules: { floodControl, heartbeat, securityView },
      limits: { heartbeatMs: 10 }, pluginsManager: { onFailure: failure => { failures.push(failure) } },
    })
    await made.pluginsManager.start()
    made.link.landing = () => { throw new Error('broken') }
    await made.pluginsManager.request({ kind: 'skipVerification', on: true }, { kind: 'window', role: 'trusted', n: 1 }).catch(() => {})
    expect((await made.runtime.half('alpha').ask('luoshu.read', { path: 'a.md' }))?.refusal).toMatchObject({ code: 'failed' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failures).toEqual([])
    expect(made.pluginsManager.stopped()).toBe(null)
    expect(made.link.events('core.failed')).toEqual([])
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })

  it('reports one failure however many follow', async () => {
    const { made, failures } = await failing()
    made.pluginsManager.controlFailed('log', 'log-failing')
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failures).toHaveLength(1)
  })

  it('reports nothing during shutdown', async () => {
    const { made, failures } = await failing()
    await made.pluginsManager.shutdown()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failures).toEqual([])
  })
})
describe('the restart marker, after the review', () => {
  it('stops hetu on the log failing once the run before restarted, whatever the marker names', async () => {
    const failures: Failure[] = []
    const made = await harness({
      pluginsManager: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'gate'),
    })
    await made.pluginsManager.start()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'stopped', mode: { control: 'log', why: 'failed', reason: 'log-failing', again: true }, box: false }])
  })

  it('stops hetu instead of starting it again when the marker can\u2019t be written', async () => {
    const failures: Failure[] = []
    const made = await harness({ pluginsManager: { onFailure: failure => { failures.push(failure) } } })
    await made.pluginsManager.start()
    // A folder where the marker goes makes its write fail
    await mkdir(path.join(made.dataDir, 'failed-once'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'failed-once', 'x'), '')
    made.pluginsManager.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'stopped', mode: { control: 'log', why: 'failed', reason: 'log-failing', again: false }, box: false }])
  })

  it('makes shutdown wait for its write', async () => {
    const { made } = await (async () => {
      const made = await harness({ pluginsManager: { onFailure: () => {} } })
      await made.pluginsManager.start()
      return { made }
    })()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await made.pluginsManager.shutdown()
    expect(await readFile(path.join(made.dataDir, 'failed-once'), 'utf8')).toBe('log')
  })

  it('is cleared by a clean Quit only once a write under way has landed', async () => {
    const made = await harness({ pluginsManager: { onFailure: () => {} } })
    await made.pluginsManager.start()
    made.pluginsManager.controlFailed('log', 'log-failing')
    await made.pluginsManager.cleanQuit()
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })

  it('ignores a failure told before the start finished, so the carrier can tell it again later', async () => {
    const failures: Failure[] = []
    const made = await harness({ pluginsManager: { onFailure: failure => { failures.push(failure) } } })
    expect(made.pluginsManager.controlFailed('log', 'log-failing')).toBe(false)
    await made.pluginsManager.start()
    expect(made.pluginsManager.controlFailed('log', 'log-failing')).toBe(true)
    expect(made.pluginsManager.controlFailed('log', 'log-failing')).toBe(false)
  })
})

describe('the restart marker', () => {
  it('is cleared by a clean Quit', async () => {
    const made = await harness()
    await mkdir(made.dataDir, { recursive: true })
    await writeFile(path.join(made.dataDir, 'failed-once'), 'gate')
    await made.pluginsManager.start()
    await made.pluginsManager.cleanQuit()
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })
})
