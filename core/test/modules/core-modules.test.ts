import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../api/envelope.ts'
import type { Call, ExecView, Gate, GrantsSnapshot, Opening, Provider } from '../../api/policy-jobs.ts'
import { CoreModules, type CoreModulesOptions, type Handed, type StorageModule } from '../../backend/modules.ts'
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

// What the plugins manager hands, with every fault kept
function handing(folder: string | null = null) {
  const faults: string[] = []
  let n = 1
  const handed: Handed = {
    grants: () => snapshot(n),
    exec: (): ExecView => ({ plugins: Object.create(null), any: [], opening: { folder, dataDir, installDir } }),
    folder: () => folder,
    fault: (id, step) => faults.push(`${id} ${step}`),
  }
  return { handed, faults, next: () => n++ }
}

let n = 0

// prepare then perform, as the carrier makes a call
async function ask(served: Provider, action: string, args: unknown): Promise<unknown> {
  const call: Call = { callId: `c${++n}`, caller: editor, action, args, deadline: Date.now() + 30000 }
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
  const luoshu: Luoshu = { provider: provider(), role: { open: () => maybe('luoshu.open') }, close: () => maybe('luoshu.close') }
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
  const options: Omit<CoreModulesOptions, 'publish'> = { dataDir: '', installDir: '', gate, storage, luoshu, history, exec }
  return { options, seen, throws, gate, storage, luoshu, history, exec }
}

function made(options: Partial<CoreModulesOptions> = {}) {
  return new CoreModules({ dataDir, installDir, publish: () => {}, ...options })
}

describe('the core modules', () => {
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
    expect(modules.gate()?.decide({ stage: 'raw', caller: editor, action: 'storage.get', capability: 'storage', scope: {} })).toEqual({ allow: true, view: 1 })
    expect(typeof modules.grantRiskClassifier()?.classify([], [])).toBe('number')
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
    throws.add('gate.stateChanged')
    const modules = made(options)
    const { handed, faults } = handing()
    await modules.start([], handed)
    expect(modules.state('gate')).toBe('failed')
    expect(modules.gate()).toBeNull()
    expect(faults).toEqual(['gate stateChanged'])
    // Exec is pushed beside it and stays on
    modules.bumped()
    expect(modules.state('gate')).toBe('failed')
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
      'storage.open', 'history.start', 'exec.start', 'gate.stateChanged', 'luoshu.open', 'history.open', 'exec.stateChanged',
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
    const modules = new CoreModules({ ...options, dataDir, installDir, trash, publish: () => {} })
    await modules.start([], handing(notes).handed)
    expect(opened).toEqual([{ folder: notes, dataDir, installDir, trash }])
  })

  it('close what runs at shutdown and serve no provider after, while the gate and the classifier answer to the end', async () => {
    const { options, seen } = fakes()
    const modules = made(options)
    await modules.start([], handing().handed)
    seen.length = 0
    modules.close()
    expect(seen).toEqual(['luoshu.close', 'history.close', 'exec.close'])
    expect(modules.provider('storage')).toBeNull()
    expect(modules.provider('luoshu')).toBeNull()
    expect(modules.gate()).toBe(options.gate)
    expect(modules.grantRiskClassifier()).not.toBeNull()
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
