import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { START_HUNG, type CoreStatus, type SecurityList } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import type { Failure } from '../backend/runtime/header.ts'
import { afterFailure, Ending } from '../backend/runtime/quit.ts'
import { createFloodControl } from '../backend/flood-control/flood-control.ts'
import { createHeartbeat } from '../backend/heartbeat/heartbeat.ts'
import { createSecurityView } from '../backend/security-view/security-view.ts'
import { StateStore } from '../backend/boot/state.ts'
import {
  allowAll, cleanup, coreInstall, entryFor, fakeExec, fakeHistory, fakeLuoshu, filesFor, harness, hostManifest, stateOf, tempBase, throwingClassifier, until,
  workerManifest, type Files,
} from './plugins-manager-fakes.ts'
import { storageModule } from './modules-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const worker = (id: string): Files => filesFor(workerManifest(id))
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, root: caller, action, args, deadline: Date.now() + 30_000 })
const exists = (file: string) => stat(file).then(() => true, () => false)
// An install list naming a core module, which the core holds and no list may name, so the list can't be read
const naming = () => ({ ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) } })
const plugins = () => ({ folder: { alpha: worker('alpha') }, entries: { alpha: (root: string) => entryFor(root) } })
const tampered = (again: boolean) => ({ control: 'install', why: 'tampered', reason: null, again })

describe('a core module that fails at start', () => {
  it.each([
    ['history', 'history', 'start-failed'],
  ] as const)('stops nothing when %s throws, which reads failed while every plugin starts', async (_name, id, reason) => {
    const history = fakeHistory()
    history.fails = id === 'history'
    const made = await harness({ ...plugins(), modules: { history } })
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

  it('ignores a failure told before the start finished, so the router can tell it again later', async () => {
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

// A control that judges yes or no and failed at start stops hetu in the fail-safe: the human quits, tries again or starts
// with it switched off, which counts as switching it off
describe('the fail-safe at start', () => {
  const failing = () => {
    const gate = allowAll()
    gate.throws = true
    return gate
  }
  const trustedWindow = { kind: 'window', role: 'trusted', n: 1 } as const

  it('stops hetu in the stopped mode for the gate whose first grants snapshot throws, no plugin starting and no marker written', async () => {
    const made = await harness({ ...plugins(), modules: { gate: failing() } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toEqual({ control: 'gate', why: 'start-failed', reason: 'state-changed', again: false })
    expect(made.link.events('core.stopped')).toEqual([{ control: 'gate', why: 'start-failed', reason: 'state-changed', again: false }])
    expect(made.link.events('core.ready')).toEqual([])
    expect(stateOf(made.pluginsManager, 'alpha')).not.toBe('ready')
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })

  it('starts again with the gate switched off once its off applied in the stopped mode with its typed word', async () => {
    const base = await tempBase()
    const made = await harness({ base, ...plugins(), modules: { gate: failing() } })
    await made.pluginsManager.start()
    await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trustedWindow)
    const [held] = made.pluginsManager.pending()
    await made.pluginsManager.confirm(held.id, { typed: 'gate' })
    const { switches } = (await made.store.load()).state
    expect(switches.off).toContain('gate')
    await made.pluginsManager.shutdown()
    // The harness writes the switches it is handed, so the next start is handed the ones on disk
    const again = await harness({ base, switches, modules: { gate: failing() } })
    await again.pluginsManager.start()
    expect(again.pluginsManager.stopped()).toBe(null)
    expect(again.pluginsManager.policyJob('gate')).toBe('off')
    expect(stateOf(again.pluginsManager, 'alpha')).toBe('ready')
  })

  // The modules the plugins manager hands a folder and a snapshot to, each counting what it was handed, with a notes
  // folder picked so the luoshu and history would be handed it
  const counted = () => {
    const storage = Object.assign(storageModule({ prepare: async () => ({ scope: {} }), perform: async () => null }), { opened: 0 })
    storage.open = () => { storage.opened++ }
    const modules = { storage, luoshu: fakeLuoshu(), history: fakeHistory(), exec: fakeExec() }
    const untouched = () => {
      expect(storage.opened).toBe(0)
      expect(modules.luoshu.opened).toEqual([])
      expect(modules.history.started).toBe(0)
      expect(modules.history.opened).toEqual([])
      expect(modules.exec.started).toBe(0)
      expect(modules.exec.views).toEqual([])
    }
    const picked = async ({ dataDir }: { dataDir: string }) => new StateStore(dataDir).writeLuoshu({ folder: path.join(dataDir, '..', 'notes') })
    return { modules, untouched, picked }
  }
  const noCall = (made: Awaited<ReturnType<typeof harness>>) => {
    expect(made.runtime.order()).toEqual([])
    expect(made.link.coalesces).toEqual([])
    expect(made.link.records.map(record => record.event).filter(event => event.startsWith('audit.') || event.startsWith('plugin.'))).toEqual([])
  }

  it('begins and hands nothing to storage, the luoshu, history or exec when the gate\'s first grants snapshot throws', async () => {
    const { modules, untouched, picked } = counted()
    const made = await harness({ ...plugins(), modules: { ...modules, gate: failing() }, before: picked })
    await made.pluginsManager.start()
    await made.pluginsManager.settled()
    expect(made.pluginsManager.stopped()).toEqual({ control: 'gate', why: 'start-failed', reason: 'state-changed', again: false })
    untouched()
    noCall(made)
  })

  it('stops hetu the same way for an expected guard nothing holds, before any module begins', async () => {
    const { modules, untouched, picked } = counted()
    const gate = allowAll()
    const made = await harness({ ...plugins(), modules: { ...modules, gate }, before: picked, pluginsManager: { guardsFor: () => ['leases'] } })
    await made.pluginsManager.start()
    await made.pluginsManager.settled()
    expect(made.pluginsManager.stopped()).toEqual({ control: 'leases', why: 'start-failed', reason: 'absent', again: false })
    expect(made.link.events('core.stopped')).toEqual([{ control: 'leases', why: 'start-failed', reason: 'absent', again: false }])
    expect(gate.views).toEqual([])
    untouched()
    noCall(made)
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })

  it('starts on with an expected guard the human switched off', async () => {
    const made = await harness({ ...plugins(), switches: { off: ['leases'] }, pluginsManager: { guardsFor: () => ['leases'] } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toBe(null)
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    // The router reads the same switch, so the guard is no step and a write passes it
    expect(made.pluginsManager.policyJob('leases')).toBe('off')
  })

  it('starts again with an expected guard nothing holds switched off once its off applied in the stopped mode', async () => {
    const base = await tempBase()
    const expecting = { guardsFor: () => ['leases'] }
    const made = await harness({ base, ...plugins(), pluginsManager: expecting })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toMatchObject({ control: 'leases', why: 'start-failed' })
    // What the Confirm applies. The contract expects no guard yet, so its typed word can't be asked for here
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'leases' })
    const { switches } = (await made.store.load()).state
    expect(switches.off).toContain('leases')
    await made.pluginsManager.shutdown()
    const again = await harness({ base, switches, pluginsManager: expecting })
    await again.pluginsManager.start()
    expect(again.pluginsManager.stopped()).toBe(null)
    expect(again.pluginsManager.policyJob('leases')).toBe('off')
  })

  // Only a clean Quit or a change applied in the stopped mode clears the restart marker, so a failure that comes back
  // after Try again still stops hetu instead of starting it again
  it.each([
    ['on the stopped screen', false],
    ['in the native box', true],
  ])('keeps the restart marker the run before wrote through Try again %s', async (_where, box) => {
    const base = await tempBase()
    const marker = (dataDir: string) => readFile(path.join(dataDir, 'failed-once'), 'utf8')
    const first = await harness({ base, pluginsManager: { onFailure: () => {} } })
    await first.pluginsManager.start()
    first.pluginsManager.controlFailed('log', 'log-failing')
    await first.pluginsManager.shutdown()
    expect(await marker(first.dataDir)).toBe('log')
    const second = await harness({ base, modules: { gate: failing() }, switches: box ? { off: ['security-view'] } : {} })
    await second.pluginsManager.start()
    const mode = second.pluginsManager.stopped()!
    expect(mode).toMatchObject({ control: 'gate', why: 'start-failed' })
    expect(second.pluginsManager.stoppedBox()).toBe(box)
    // What main does for each: the screen's Try again asks for app.relaunch, the box answers retry
    const ending = new Ending()
    const quits: string[] = []
    if (box) {
      afterFailure({ action: 'stopped', mode, box }, {
        quitting: () => false, announce: () => {}, quit: (code, again) => { quits.push(`quit ${code} ${again}`) },
        ending, showTrusted: () => {}, showBox: () => 'retry', closeEditors: () => {}, packaged: false, env: {}, later: () => {},
      })
      expect(quits).toEqual(['quit 1 true'])
    } else ending.relaunch()
    await ending.leave(second.pluginsManager)
    expect(await marker(second.dataDir)).toBe('log')
    // A clean Quit is what clears it
    await new Ending().leave(second.pluginsManager)
    expect(await exists(path.join(second.dataDir, 'failed-once'))).toBe(false)
  })

  // A start that hangs main can't be tested by hanging, so the gate's first push looks at the disk instead and a
  // marker left in place stands for the hang the run before
  describe('the start marker', () => {
    const starting = (dataDir: string, id: string) => path.join(dataDir, 'starting', id)
    const marked = (id: string) => async ({ dataDir }: { dataDir: string }) => {
      await mkdir(path.join(dataDir, 'starting'), { recursive: true })
      await writeFile(starting(dataDir, id), '')
    }

    it('stands for the gate alone while its first grants snapshot is pushed and is gone once its start returned', async () => {
      const gate = allowAll()
      const push = gate.stateChanged.bind(gate)
      const onDisk: boolean[][] = []
      let dataDir = ''
      gate.stateChanged = view => {
        if (onDisk.length === 0) onDisk.push([existsSync(starting(dataDir, 'gate')), existsSync(starting(dataDir, 'flood-control'))])
        push(view)
      }
      const made = await harness({ ...plugins(), modules: { gate }, before: async dirs => { dataDir = dirs.dataDir } })
      await made.pluginsManager.start()
      expect(onDisk).toEqual([[true, false]])
      expect(made.pluginsManager.stopped()).toBe(null)
      expect(await readdir(path.join(made.dataDir, 'starting'))).toEqual([])
    })

    it('stops hetu in the fail-safe naming the control whose start hung the run before, before any module begins', async () => {
      const { modules, untouched, picked } = counted()
      const gate = allowAll()
      const made = await harness({
        ...plugins(), modules: { ...modules, gate },
        before: async dirs => {
          await picked(dirs)
          await marked('gate')(dirs)
        },
      })
      await made.pluginsManager.start()
      await made.pluginsManager.settled()
      const mode = { control: 'gate', why: 'start-failed', reason: START_HUNG, again: false }
      expect(made.pluginsManager.stopped()).toEqual(mode)
      expect(made.link.events('core.stopped')).toEqual([mode])
      expect(gate.views).toEqual([])
      untouched()
      noCall(made)
    })

    it('clears the marker once the gate\'s off applied in the stopped mode, so the next launch starts with it off', async () => {
      const base = await tempBase()
      const made = await harness({ base, ...plugins(), before: marked('gate') })
      await made.pluginsManager.start()
      expect(made.pluginsManager.stopped()).toMatchObject({ control: 'gate', reason: START_HUNG })
      await made.pluginsManager.request({ kind: 'plugin.off', plugin: 'gate' }, trustedWindow)
      const [held] = made.pluginsManager.pending()
      await made.pluginsManager.confirm(held.id, { typed: 'gate' })
      const { switches } = (await made.store.load()).state
      expect(switches.off).toContain('gate')
      expect(existsSync(starting(made.dataDir, 'gate'))).toBe(false)
      await made.pluginsManager.shutdown()
      const again = await harness({ base, switches })
      await again.pluginsManager.start()
      expect(again.pluginsManager.stopped()).toBe(null)
      expect(again.pluginsManager.policyJob('gate')).toBe('off')
    })

    it('keeps the marker through Quit, so the next launch lands in the fail-safe again', async () => {
      const base = await tempBase()
      const made = await harness({ base, ...plugins(), before: marked('gate') })
      await made.pluginsManager.start()
      await made.pluginsManager.shutdown()
      await new Ending().leave(made.pluginsManager)
      expect(existsSync(starting(made.dataDir, 'gate'))).toBe(true)
      const again = await harness({ base })
      await again.pluginsManager.start()
      expect(again.pluginsManager.stopped()).toMatchObject({ control: 'gate', reason: START_HUNG })
    })

    // A second hang leaves a new marker, so Try again can't loop the fail-safe for good
    it.each([
      ['on the stopped screen', false],
      ['in the native box', true],
    ])('clears the marker through Try again %s, so the next launch starts as usual', async (_where, box) => {
      const base = await tempBase()
      const made = await harness({ base, ...plugins(), switches: box ? { off: ['security-view'] } : {}, before: marked('gate') })
      await made.pluginsManager.start()
      const mode = made.pluginsManager.stopped()!
      expect(mode).toMatchObject({ control: 'gate', reason: START_HUNG })
      const ending = new Ending()
      if (box) {
        afterFailure({ action: 'stopped', mode, box }, {
          quitting: () => false, announce: () => {}, quit: () => {},
          ending, showTrusted: () => {}, showBox: () => 'retry', closeEditors: () => {}, packaged: false, env: {}, later: () => {},
        })
      } else ending.relaunch()
      await made.pluginsManager.shutdown()
      await ending.leave(made.pluginsManager)
      const third = await harness({ base, switches: box ? { off: ['security-view'] } : {} })
      await third.pluginsManager.start()
      expect(third.pluginsManager.stopped()).toBe(null)
    })

    it('holds nothing back for a marker naming no control the fail-safe covers', async () => {
      const made = await harness({ ...plugins(), before: marked('storage') })
      await made.pluginsManager.start()
      expect(made.pluginsManager.stopped()).toBe(null)
      expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
    })
  })

  it('refuses everything and stops nothing for the gate failing in use', async () => {
    const gate = allowAll()
    const made = await harness({ ...plugins(), modules: { gate } })
    await made.pluginsManager.start()
    gate.throws = true
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'alpha' })
    expect(made.pluginsManager.policyJob('gate')).toBe('failed')
    expect(made.pluginsManager.stopped()).toBe(null)
  })

  it('keeps the class fallback and stops nothing for the grant risk classifier failing at start', async () => {
    const made = await harness({ ...plugins(), modules: { grantRiskClassifier: throwingClassifier() } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.stopped()).toBe(null)
    expect((await made.store.load()).state.plugins.alpha).toMatchObject({ class: null })
    expect(stateOf(made.pluginsManager, 'alpha')).toBe('ready')
  })
})
