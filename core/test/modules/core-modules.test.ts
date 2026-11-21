import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../api/envelope.ts'
import type { Call, ExecView, Gate, GrantsSnapshot, Opening, Provider } from '../../api/policy-jobs.ts'
import { moduleRequires, type CoreModulesOptions, type Handed, type StorageModule } from '../../backend/modules/header.ts'
import { realModules } from '../modules-fakes.ts'
import type { Exec } from '../../backend/providers/exec/exec.ts'
import type { History } from '../../backend/providers/history/history.ts'
import type { Luoshu } from '../../backend/providers/luoshu/luoshu.ts'

const editor: Caller = { kind: 'window', role: 'editor', n: 0 }

let base: string
let dataDir: string
let installDir: string
let notes: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-modules-')))
  dataDir = path.join(base, 'data')
  installDir = path.join(base, 'install')
  notes = path.join(base, 'notes')
  for (const dir of [dataDir, installDir, notes]) await mkdir(dir, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const snapshot = (n = 1): GrantsSnapshot => ({ n, foldCase: false, plugins: Object.create(null), execAny: [] })

// What the plugins manager hands, with every fault and every change of state kept
function handing(folder: string | null = null, readyMs = 10000) {
  const faults: string[] = []
  const changes: string[] = []
  let n = 1
  const handed: Handed = {
    grants: () => snapshot(n),
    exec: (): ExecView => ({ plugins: Object.create(null), any: [], opening: { folder, dataDir, installDir } }),
    folder: () => folder,
    readyMs: () => readyMs,
    fault: (id, step) => faults.push(`${id} ${step}`),
    changed: (id, change, reason) => changes.push(reason === null ? `${id} ${change}` : `${id} ${change} ${reason}`),
    heartbeat: { ping: () => {}, unresponsive: () => {}, kill: () => {}, limit: () => 1000 },
    starting: async () => {},
    started: async () => {},
  }
  return { handed, faults, changes, next: () => n++ }
}

let n = 0

// prepare then perform, as the router makes a call
async function ask(served: Provider, action: string, args: unknown): Promise<unknown> {
  const call: Call = { callId: `c${++n}`, caller: editor, root: editor, action, args, deadline: Date.now() + 30000 }
  const prepared = await served.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  return served.perform(call, prepared)
}

const provider = (): Provider => ({ prepare: async () => ({ scope: {} }), perform: async () => null })

// Fakes that count what the core does with them. start and the pushes throw while told to
function fakes() {
  const seen: string[] = []
  const throws = new Set<string>()
  const maybe = (what: string) => {
    seen.push(what)
    if (throws.has(what)) throw new Error(`${what} threw`)
  }
  const gate: Gate = {
    decide: () => ({ allow: false, code: 'not-granted', view: 1 }),
    canRead: () => false,
    canList: () => false,
    verbs: () => [],
    stateChanged: () => maybe('gate.stateChanged'),
  }
  const storage: StorageModule = { ...provider(), open: () => maybe('storage.open'), clear: async () => {} }
  const luoshu: Luoshu = { provider: provider(), role: { open: () => maybe('luoshu.open') }, close: () => maybe('luoshu.close'), calls: () => 0 }
  const history: History = {
    provider: provider(),
    role: { open: () => maybe('history.open') },
    start: async () => maybe('history.start'),
    close: () => maybe('history.close'),
  }
  const exec: Exec = {
    provider: provider(),
    role: { stateChanged: () => maybe('exec.stateChanged') },
    start: async () => maybe('exec.start'),
    close: () => maybe('exec.close'),
  }
  const options: Partial<CoreModulesOptions> = { gate, storage, luoshu, history, exec }
  return { options, seen, throws, gate, storage, luoshu, history, exec }
}

function made(options: Partial<CoreModulesOptions> & { publish?: (topic: string, path: string) => void } = {}) {
  return realModules({ dataDir, installDir, ...options })
}

describe('the core modules', () => {
  // Told on every message heard from a plugin, so nothing is built per message
  it('hands the same heartbeat each time it is asked while on', async () => {
    const modules = made(fakes().options)
    await modules.start([], handing().handed)
    expect(modules.heartbeat()).not.toBe(null)
    expect(modules.heartbeat()).toBe(modules.heartbeat())
  })

  it('answer nothing before start, so nothing is judged or served on a gate with no grants snapshot', () => {
    const modules = made()
    expect(modules.gate()).toBeNull()
    expect(modules.grantRiskClassifier()).toBeNull()
    expect(modules.provider('storage')).toBeNull()
  })

  it('start the real modules on a data folder, the gate holding the first grants snapshot and storage serving a space', async () => {
    const { options } = fakes()
    // History looks for git on the path, which the test machine may not have
    const modules = made({ history: options.history })
    const { handed, faults } = handing(notes)
    await modules.start([], handed)
    expect(faults).toEqual([])
    for (const id of ['gate', 'grant-risk-classifier', 'storage', 'luoshu', 'history', 'exec'] as const) expect(modules.state(id)).toBe('on')
    expect(modules.gate()?.decide({ stage: 'raw', caller: editor, root: editor, action: 'storage.get', capability: 'storage', scope: {} })).toEqual({ allow: true, view: 1 })
    expect(modules.grantRiskClassifier()?.classes({ cause: 'start', change: null, confirm: false, plugins: [] })).toEqual({ plugins: [], lines: [], unasked: false })
    const storage = modules.provider('storage')!
    await ask(storage, 'storage.set', { key: 'k', value: 1 })
    expect(await ask(storage, 'storage.get', { key: 'k' })).toBe(1)
    modules.close()
  })

  it('answer null for a module switched off and report it off', async () => {
    const { options } = fakes()
    const modules = made(options)
    await modules.start(['gate', 'storage', 'luoshu', 'grant-risk-classifier'], handing().handed)
    expect(modules.state('gate')).toBe('off')
    expect(modules.reason('gate')).toBe('off')
    expect(modules.reason('exec')).toBeNull()
    expect(modules.gate()).toBeNull()
    expect(modules.grantRiskClassifier()).toBeNull()
    expect(modules.provider('storage')).toBeNull()
    expect(modules.provider('cache')).toBeNull()
    expect(modules.provider('luoshu')).toBeNull()
    expect(modules.storage()).toBeNull()
    expect(modules.provider('exec')).toBe(options.exec!.provider)
  })

  it('look a provider up by namespace: cache through storage, leases and net with no module, anything else nothing', async () => {
    const { options } = fakes()
    const modules = made(options)
    await modules.start([], handing().handed)
    expect(modules.provider('storage')).toBe(options.storage)
    expect(modules.provider('cache')).toBe(options.storage)
    expect(modules.provider('luoshu')).toBe(options.luoshu!.provider)
    expect(modules.provider('history')).toBe(options.history!.provider)
    expect(modules.provider('exec')).toBe(options.exec!.provider)
    expect(modules.provider('leases')).toBeNull()
    expect(modules.provider('net')).toBeNull()
    expect(modules.provider('gate')).toBeNull()
    expect(modules.provider('constructor')).toBeNull()
    expect(modules.provider('__proto__')).toBeNull()
  })

  it('serve history only while luoshu serves, as it waited on luoshu before', async () => {
    const { options } = fakes()
    const modules = made(options)
    await modules.start(['luoshu'], handing().handed)
    expect(modules.state('history')).toBe('on')
    expect(modules.provider('history')).toBeNull()
    await modules.apply([])
    expect(modules.provider('history')).toBe(options.history!.provider)
  })

  it('mark a module whose start throws failed with a fault, refuse its calls, run on and clear it once a start goes through', async () => {
    const { options, throws } = fakes()
    throws.add('history.start')
    const modules = made(options)
    const { handed, faults } = handing()
    await modules.start([], handed)
    expect(modules.state('history')).toBe('failed')
    expect(modules.reason('history')).toBe('start-failed')
    expect(modules.provider('history')).toBeNull()
    expect(faults).toEqual(['history start'])
    // The rest started and serve
    expect(modules.state('exec')).toBe('on')
    expect(modules.provider('luoshu')).toBe(options.luoshu!.provider)
    throws.delete('history.start')
    await modules.apply(['history'])
    await modules.apply([])
    expect(modules.state('history')).toBe('on')
    expect(modules.provider('history')).toBe(options.history!.provider)
  })

  it('mark the gate failed when a push throws, which refuses its calls, and clear it on the next push that goes through', async () => {
    const { options, throws } = fakes()
    const modules = made(options)
    const { handed, faults } = handing()
    await modules.start([], handed)
    throws.add('gate.stateChanged')
    // Exec is pushed beside it and stays on
    modules.bumped()
    expect(modules.state('gate')).toBe('failed')
    expect(modules.reason('gate')).toBe('state-changed')
    expect(modules.gate()).toBeNull()
    expect(faults).toEqual(['gate stateChanged'])
    expect(modules.state('exec')).toBe('on')
    throws.delete('gate.stateChanged')
    modules.bumped()
    expect(modules.state('gate')).toBe('on')
    expect(modules.gate()).toBe(options.gate)
  })

  it('mark luoshu or history failed when its folder throws and clear it once a folder goes in', async () => {
    const { options, throws } = fakes()
    const modules = made(options)
    const { handed, faults } = handing()
    await modules.start([], handed)
    throws.add('luoshu.open')
    modules.picked()
    expect(modules.state('luoshu')).toBe('failed')
    expect(modules.state('history')).toBe('on')
    expect(faults).toEqual(['luoshu open'])
    throws.delete('luoshu.open')
    modules.picked()
    expect(modules.state('luoshu')).toBe('on')
  })

  it('close luoshu, history and exec when switched off and start and hand each its part again when switched on', async () => {
    const { options, seen } = fakes()
    const modules = made(options)
    const { handed, next } = handing()
    await modules.start([], handed)
    expect(seen).toEqual([
      'gate.stateChanged', 'storage.open', 'history.start', 'exec.start', 'luoshu.open', 'history.open', 'exec.stateChanged',
    ])
    seen.length = 0
    await modules.apply(['luoshu', 'history', 'exec', 'storage', 'gate'])
    expect(seen).toEqual(['luoshu.close', 'history.close', 'exec.close'])
    for (const id of ['luoshu', 'history', 'exec', 'storage', 'gate'] as const) expect(modules.state(id)).toBe('off')
    // Nothing goes to a module that is off
    seen.length = 0
    next()
    modules.bumped()
    modules.picked()
    expect(seen).toEqual([])
    await modules.apply([])
    expect(seen).toEqual([
      'gate.stateChanged', 'storage.open', 'luoshu.open', 'history.start', 'history.open', 'exec.start', 'exec.stateChanged',
    ])
    for (const id of ['luoshu', 'history', 'exec', 'storage', 'gate'] as const) expect(modules.state(id)).toBe('on')
  })

  // The controls that judge yes or no start alone first, so one that fails leaves the rest for the fail-safe
  it('start the gate alone first and begin or hand nothing else once its first grants snapshot throws', async () => {
    const { options, seen, throws } = fakes()
    throws.add('gate.stateChanged')
    const modules = made(options)
    const { handed, changes } = handing(notes)
    await modules.start([], handed)
    expect(seen).toEqual(['gate.stateChanged'])
    expect(modules.state('gate')).toBe('failed')
    // The modules with no start of their own that serve the stopped mode read on
    expect(changes).toEqual(['gate failed state-changed', 'flood-control started', 'recording started', 'security-view started'])
    for (const id of ['grant-risk-classifier', 'storage', 'luoshu', 'history', 'exec', 'heartbeat'] as const) expect(modules.state(id)).toBe('starting')
    for (const namespace of ['storage', 'luoshu', 'history', 'exec']) expect(modules.provider(namespace)).toBeNull()
    expect(modules.grantRiskClassifier()).toBeNull()
    expect(modules.heartbeat()).toBeNull()
    // A new snapshot reaches the gate alone and a folder picked reaches no one
    seen.length = 0
    modules.bumped()
    modules.picked()
    expect(seen).toEqual(['gate.stateChanged'])
    // The stopped mode closes nothing that never began
    seen.length = 0
    changes.length = 0
    modules.stop([])
    expect(seen).toEqual([])
    expect(changes).toEqual(['gate stopped stopped-mode'])
  })

  // A start that hangs main leaves its marker, so the marker names the one control whose start ran
  it('mark each judging module from before its start until its first push returned, one at a time', async () => {
    const { options, seen } = fakes()
    const modules = made(options)
    const { handed } = handing(notes)
    handed.starting = async id => { seen.push(`${id} marked`) }
    handed.started = async id => { seen.push(`${id} unmarked`) }
    await modules.start([], handed)
    expect(seen.slice(0, 5)).toEqual(['gate marked', 'gate.stateChanged', 'gate unmarked', 'flood-control marked', 'flood-control unmarked'])
    expect(seen.slice(5).filter(what => what.endsWith('marked'))).toEqual([])
  })

  it('mark no judging module the human switched off and start on with a fault when a mark throws', async () => {
    const { options, seen } = fakes()
    const modules = made(options)
    const { handed, faults } = handing(notes)
    handed.starting = async id => {
      seen.push(`${id} marked`)
      throw new Error('disk full')
    }
    await modules.start(['flood-control'], handed)
    expect(seen.filter(what => what.endsWith('marked'))).toEqual(['gate marked'])
    expect(faults).toEqual(['gate marker'])
    expect(modules.state('gate')).toBe('on')
  })

  it('hand the gate each new grants snapshot and exec its view with it', async () => {
    const { options } = fakes()
    const views: number[] = []
    options.gate!.stateChanged = view => views.push(view.n)
    const modules = made(options)
    const { handed, next } = handing()
    await modules.start([], handed)
    next()
    modules.bumped()
    expect(views).toEqual([1, 2])
  })

  it('hand the luoshu its folder with hetu\'s own folders and the bin', async () => {
    const { options } = fakes()
    const opened: Opening[] = []
    options.luoshu!.role.open = opening => opened.push(opening)
    const trash = async () => {}
    const modules = realModules({ ...options, dataDir, installDir, trash })
    await modules.start([], handing(notes).handed)
    expect(opened).toEqual([{ folder: notes, dataDir, installDir, trash }])
  })

  it('close what runs at shutdown in the reverse of the start and serve no provider after, while the gate and the classifier answer to the end', async () => {
    const { options, seen } = fakes()
    const modules = made(options)
    const { handed, changes } = handing()
    await modules.start([], handed)
    seen.length = 0
    changes.length = 0
    modules.close()
    expect(seen).toEqual(['exec.close', 'history.close', 'luoshu.close'])
    expect(changes).toEqual([
      'heartbeat stopped shutdown', 'exec stopped shutdown', 'history stopped shutdown', 'luoshu stopped shutdown', 'storage stopped shutdown',
    ])
    expect(modules.state('storage')).toBe('stopped')
    expect(modules.provider('storage')).toBeNull()
    expect(modules.provider('luoshu')).toBeNull()
    expect(modules.gate()).toBe(options.gate)
    expect(modules.grantRiskClassifier()).not.toBeNull()
    expect(modules.state('gate')).toBe('on')
  })

  it('hold what each module requires frozen all the way down, as the graph and the lookups read it', () => {
    expect(moduleRequires.history).toEqual(['luoshu'])
    expect(Object.isFrozen(moduleRequires)).toBe(true)
    for (const requires of Object.values(moduleRequires)) expect(Object.isFrozen(requires)).toBe(true)
  })

  it('read starting before start, so the gate is no holder and reads as starting and not as on', () => {
    const modules = made(fakes().options)
    for (const id of ['gate', 'grant-risk-classifier', 'storage', 'luoshu', 'history', 'exec'] as const) {
      expect(modules.state(id)).toBe('starting')
      expect(modules.reason(id)).toBeNull()
    }
    expect(modules.gate()).toBeNull()
  })

  it('tell each module that started and each that failed at start but nothing for one switched off', async () => {
    const { options, throws } = fakes()
    throws.add('exec.start')
    const modules = made(options)
    const { handed, changes } = handing()
    await modules.start(['history'], handed)
    expect(changes).toEqual([
      'gate started', 'grant-risk-classifier started', 'storage started', 'luoshu started', 'exec failed start-failed',
      'flood-control started', 'heartbeat started', 'recording started', 'security-view started',
    ])
  })

  it('tell a module switched off as stopped, switched on as started and one whose push went through again as recovered', async () => {
    const { options, throws } = fakes()
    const modules = made(options)
    const { handed, changes } = handing()
    await modules.start([], handed)
    changes.length = 0
    await modules.apply(['exec'])
    await modules.apply([])
    throws.add('gate.stateChanged')
    expect(modules.bumped()).toBe(true)
    // A second push that throws changes nothing more
    expect(modules.bumped()).toBe(false)
    throws.delete('gate.stateChanged')
    expect(modules.bumped()).toBe(true)
    expect(modules.bumped()).toBe(false)
    expect(changes).toEqual(['exec stopped off', 'exec started', 'gate failed state-changed', 'gate recovered'])
  })

  it('answer from picked whether the luoshu or history changed state, so the plugins manager can plan again', async () => {
    const { options, throws } = fakes()
    const modules = made(options)
    const { handed, changes } = handing()
    await modules.start([], handed)
    changes.length = 0
    throws.add('luoshu.open')
    expect(modules.picked()).toBe(true)
    expect(modules.provider('history')).toBeNull()
    throws.delete('luoshu.open')
    expect(modules.picked()).toBe(true)
    expect(modules.picked()).toBe(false)
    expect(modules.provider('history')).toBe(options.history!.provider)
    expect(changes).toEqual(['luoshu failed state-changed', 'luoshu recovered'])
  })

  describe('a start that runs past readyMs', () => {
    it('marks the module failed with start-failed, gives the rest their start and serves nothing from it', async () => {
      const { options, seen } = fakes()
      options.exec!.start = () => new Promise(() => {})
      const modules = made(options)
      const { handed, faults, changes } = handing(null, 50)
      await modules.start([], handed)
      expect(modules.state('exec')).toBe('failed')
      expect(modules.reason('exec')).toBe('start-failed')
      expect(modules.provider('exec')).toBeNull()
      expect(faults).toEqual(['exec start-timeout'])
      expect(changes).toContain('exec failed start-failed')
      expect(modules.state('history')).toBe('on')
      expect(seen).toContain('gate.stateChanged')
    })

    it('holds a switch on for at most readyMs and leaves the module failed', async () => {
      const { options } = fakes()
      let hang = false
      const start = options.history!.start
      options.history!.start = dir => (hang ? new Promise(() => {}) : start(dir))
      const modules = made(options)
      const { handed } = handing(null, 50)
      await modules.start(['history'], handed)
      hang = true
      const began = Date.now()
      await modules.apply([])
      expect(Date.now() - began).toBeLessThan(5000)
      expect(modules.state('history')).toBe('failed')
      expect(modules.reason('history')).toBe('start-failed')
    })

    it('reads starting while the start runs and serves nothing until it is done', async () => {
      const { options } = fakes()
      let finish = () => {}
      options.exec!.start = () => new Promise<void>(resolve => {
        finish = resolve
      })
      const modules = made(options)
      const { handed } = handing()
      await modules.start(['exec'], handed)
      const on = modules.apply([])
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(modules.state('exec')).toBe('starting')
      expect(modules.provider('exec')).toBeNull()
      finish()
      await on
      expect(modules.state('exec')).toBe('on')
    })

    it('closes what a late start opened, unless a later start began meanwhile', async () => {
      const { options, seen } = fakes()
      let finish = () => {}
      options.exec!.start = () => new Promise<void>(resolve => {
        finish = resolve
      })
      const modules = made(options)
      await modules.start([], handing(null, 20).handed)
      expect(modules.state('exec')).toBe('failed')
      seen.length = 0
      finish()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(seen).toEqual(['exec.close'])
      expect(modules.state('exec')).toBe('failed')
    })
  })

  describe('while the start runs', () => {
    it('reads every module starting and serves nothing until all are started and handed what they need', async () => {
      const { options } = fakes()
      let finish = () => {}
      options.storage!.open = () => {}
      options.history!.start = () => new Promise<void>(resolve => {
        finish = resolve
      })
      const modules = made(options)
      const on = modules.start([], handing().handed)
      await new Promise(resolve => setTimeout(resolve, 10))
      for (const id of ['gate', 'grant-risk-classifier', 'storage', 'luoshu', 'history', 'exec'] as const) expect(modules.state(id)).toBe('starting')
      expect(modules.gate()).toBeNull()
      expect(modules.provider('storage')).toBeNull()
      expect(modules.provider('exec')).toBeNull()
      finish()
      await on
      expect(modules.state('exec')).toBe('on')
      expect(modules.gate()).not.toBeNull()
    })

    it('starts nothing more once shutdown began', async () => {
      const { options, seen } = fakes()
      let finish = () => {}
      options.history!.start = () => new Promise<void>(resolve => {
        finish = resolve
      })
      const modules = made(options)
      const on = modules.start([], handing().handed)
      await new Promise(resolve => setTimeout(resolve, 10))
      modules.close()
      finish()
      await on
      expect(seen).not.toContain('exec.start')
      expect(modules.provider('exec')).toBeNull()
    })
  })

  it('leaves the gate and the classifier answering when the stopped mode comes after shutdown began', async () => {
    const { options } = fakes()
    const modules = made(options)
    await modules.start([], handing().handed)
    modules.close()
    modules.stop([])
    expect(modules.gate()).toBe(options.gate)
    expect(modules.grantRiskClassifier()).not.toBeNull()
    expect(modules.provider('luoshu')).toBeNull()
  })

  describe('the stopped mode', () => {
    it('closes every module in the reverse of its start with the gate last and serves nothing after, the gate and the classifier included', async () => {
      const { options, seen } = fakes()
      const modules = made(options)
      const { handed, changes } = handing()
      await modules.start(['storage'], handed)
      seen.length = 0
      changes.length = 0
      modules.stop(['storage'])
      expect(seen).toEqual(['exec.close', 'history.close', 'luoshu.close'])
      expect(changes).toEqual([
        'heartbeat stopped stopped-mode', 'exec stopped stopped-mode', 'history stopped stopped-mode', 'luoshu stopped stopped-mode',
        'grant-risk-classifier stopped stopped-mode', 'gate stopped stopped-mode',
      ])
      expect(modules.gate()).toBeNull()
      expect(modules.grantRiskClassifier()).toBeNull()
      for (const namespace of ['storage', 'luoshu', 'history', 'exec']) expect(modules.provider(namespace)).toBeNull()
      expect(modules.state('gate')).toBe('stopped')
      expect(modules.reason('gate')).toBe('stopped-mode')
      expect(modules.state('storage')).toBe('off')
    })

    it('hands nothing more and starts nothing after, whatever the switches or a push', async () => {
      const { options, seen } = fakes()
      const modules = made(options)
      await modules.start(['exec'], handing().handed)
      modules.stop(['exec'])
      seen.length = 0
      modules.bumped()
      modules.picked()
      await modules.apply([])
      modules.close()
      expect(seen).toEqual([])
      expect(modules.state('exec')).toBe('stopped')
    })

    it('before start leaves every module unstarted and tells nothing', async () => {
      const { options, seen } = fakes()
      const modules = made(options)
      modules.stop([])
      const { handed, changes } = handing()
      await modules.start([], handed)
      expect(seen).toEqual([])
      expect(changes).toEqual([])
      expect(modules.gate()).toBeNull()
      expect(modules.state('gate')).toBe('stopped')
    })
  })

  it('pass on only luoshu\'s two topics', async () => {
    const published: string[] = []
    const modules = made({ publish: (topic, at) => published.push(`${topic} ${at}`), history: fakes().options.history })
    await modules.start([], handing(notes).handed)
    expect(await ask(modules.provider('luoshu')!, 'luoshu.write', { path: 'a.md', text: 'hi' })).toMatchObject({ version: expect.any(String) })
    expect(published).toEqual(['changed a.md'])
    modules.close()
  })
})
