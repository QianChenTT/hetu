import { API_VERSION } from '../api/manifest.ts'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { Caller } from '../api/envelope.ts'
import { defaultLimits, type LimitName } from '../api/limits.ts'
import { FIRST_PARTY_SIGNER, INSTALL_LIST } from '../api/install.ts'
import type { ExecView, Gate, GrantRiskClassifier, GrantsSnapshot, Opening, Provider } from '../api/policy-jobs.ts'
import { defaultSwitches, StateStore, type Plugin, type Switches } from '../backend/boot/state.ts'
import { Carrier } from '../backend/carrier/carrier.ts'
import type { HumanLimits, Port } from '../backend/carrier/header.ts'
import { Limits } from '../backend/carrier/limits.ts'
import type { CoreModules, CoreModulesOptions } from '../backend/modules/header.ts'
import { realModules } from './modules-fakes.ts'
import { createGrantRiskClassifier } from '../backend/policy/grant-risk-classifier/grant-risk-classifier.ts'
import type { Exec } from '../backend/providers/exec/exec.ts'
import type { History } from '../backend/providers/history/history.ts'
import type { Luoshu } from '../backend/providers/luoshu/luoshu.ts'
import { PluginsManager, type PluginsManagerOptions } from '../backend/plugins-manager/plugins-manager.ts'
import type { CarrierLink, Landing } from '../backend/plugins-manager/header.ts'
import type { Runtime, UtilityStart, WorkerStart } from '../backend/runtime/header.ts'
import { carrierOptions } from '../backend/wire.ts'
import type { Field } from '../lib/event-log.ts'
import { hashFiles, readFiles } from '../lib/hash-files.ts'

export type Message = Record<string, unknown>
export type Files = Record<string, string>

export const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

const keyOf = (caller: Caller) => JSON.stringify(caller)

// Waits until check holds, a few seconds at most
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('never held')
    await tick(2)
  }
}

// What the plugins manager needs from the carrier, around a real carrier for the ways in. send, record, changed, stopping and
// limit are the join's to build, faked here
export class FakeLink implements CarrierLink {
  carrier: Carrier | null = null
  readonly records: { event: string, fields: Record<string, Field> }[] = []
  readonly sent: { caller: Caller, message: Message }[] = []
  readonly ended: { caller: Caller, code: string }[] = []
  readonly registered: Caller[] = []
  // What the plugins manager asked of the carrier, in order: stopping, each record and each lifecycle message by plugin
  readonly timeline: string[] = []
  // How each record lands. A test holds one back by answering a promise it settles itself
  landing: (event: string, fields: Record<string, Field>, signal?: AbortSignal) => Landing | Promise<Landing> = () => 'landed'
  changes = 0
  stopped = 0
  // How many records drain says still wait
  waiting = 0
  limits: Partial<Record<LimitName, number>> = {}
  private readonly ports = new Map<string, Port>()

  register(port: Port, caller: Caller): void {
    this.carrier!.register(port, caller)
    this.registered.push(caller)
    this.ports.set(keyOf(caller), port)
  }

  end(caller: Caller, code: 'stopped' | 'crashed' = 'stopped'): void {
    this.ended.push({ caller, code })
    if (caller.kind === 'plugin') this.timeline.push(`end ${caller.id}`)
    this.ports.delete(keyOf(caller))
    this.carrier!.end(caller, code)
  }

  send(caller: Caller, message: unknown): void {
    this.sent.push({ caller, message: message as Message })
    if (caller.kind === 'plugin') this.timeline.push(`${(message as Message).kind} ${caller.id}`)
    this.ports.get(keyOf(caller))?.postMessage(message)
  }

  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing> {
    this.records.push({ event, fields })
    this.timeline.push(`record ${event}${typeof fields.plugin === 'string' ? ` ${fields.plugin}` : ''}`)
    return Promise.resolve(this.landing(event, fields, signal))
  }

  changed(): void {
    this.changes++
  }

  stopping(): void {
    this.stopped++
    this.timeline.push('stopping')
  }

  async drain(_ms: number): Promise<number> {
    this.timeline.push('drain')
    return this.waiting
  }

  resume(): void {
    this.timeline.push('resume')
  }

  limit(_plugin: string, name: LimitName): number {
    return this.limits[name] ?? defaultLimits[name]
  }

  events(name: string) {
    return this.records.filter(record => record.event === name).map(record => record.fields)
  }

  // Messages of one kind sent down a plugin's ways, oldest first
  sentTo(id: string, kind: string): Message[] {
    return this.sent.filter(({ caller, message }) => caller.kind === 'plugin' && caller.id === id && message.kind === kind).map(({ message }) => message)
  }
}

// What a fake plugin does: answer init with ready and stop with stopped, or not. utility runs a utility half on its
// port in place of the scripted half, such as a real plugin through the SDK
export type Behaviour = { ready: boolean, stopped: boolean, pong: boolean, throws: boolean, utility?: (start: UtilityStart) => void }

// A plugin half as the fake runtime started it. inbox holds what the core sent it
export class Half {
  readonly inbox: Message[] = []
  closed = false
  private id = 1
  private readonly post: (message: unknown) => void
  private readonly close_: () => void

  constructor(post: (message: unknown) => void, close: () => void) {
    this.post = post
    this.close_ = close
  }

  send(message: unknown): void {
    this.post(message)
  }

  ready(): void {
    this.post({ v: 1, kind: 'ready' })
  }

  // The plugin's own end goes away, as a dead renderer's would
  crash(): void {
    this.close_()
  }

  got(kind: string): Message[] {
    return this.inbox.filter(message => message.kind === kind)
  }

  // A call from this half through the carrier, its reply or null when none came within ms
  async ask(action: string, args: unknown = {}, ms = 1000): Promise<Message | null> {
    const id = 1000 + this.id++
    this.post({ v: 1, kind: 'call', id, action, args })
    const end = Date.now() + ms
    while (Date.now() < end) {
      const reply = this.inbox.find(message => message.kind === 'reply' && message.id === id)
      if (reply !== undefined) return reply
      await tick(2)
    }
    return null
  }
}

export class FakeRuntime implements Runtime {
  readonly started: { id: string, incarnation: number, half: 'worker' | 'utility', code: string | null }[] = []
  readonly terminated: { id: string, incarnation: number }[] = []
  // The utility processes the plugins manager asked to end, and every utility start as the plugins manager made it
  readonly killed: { id: string, incarnation: number }[] = []
  readonly utilityStarts: UtilityStart[] = []
  // The workers started with a port to the drawer
  readonly drawers: string[] = []
  // Every worker start as the plugins manager made it
  readonly workerStarts: WorkerStart[] = []
  readonly halves = new Map<string, Half>()
  readonly ports: MessagePort[] = []
  behave: Record<string, Partial<Behaviour>> = {}

  private of(id: string): Behaviour {
    return { ready: true, stopped: true, pong: true, throws: false, ...this.behave[id] }
  }

  half(id: string, incarnation = 1, half: 'worker' | 'utility' = 'worker'): Half {
    const found = this.halves.get(`${id}:${incarnation}:${half}`)
    if (found === undefined) throw new Error(`no ${half} for ${id} ${incarnation}`)
    return found
  }

  order(): string[] {
    return this.started.map(start => start.id)
  }

  // Each channel asked for, with whether main is to count its bytes
  readonly channels: { id: string, counted: boolean }[] = []

  channel(id = '', counted = false): { core: Port, plugin: unknown } {
    this.channels.push({ id, counted })
    const { port1, port2 } = new MessageChannel()
    this.ports.push(port1, port2)
    return { core: port1, plugin: port2 }
  }

  // Read each time, so a test can change what a running plugin does
  private answer(half: Half, id: string, message: Message): void {
    half.inbox.push(message)
    const behaviour = this.of(id)
    if (message.kind === 'init' && behaviour.ready) half.ready()
    if (message.kind === 'stop' && behaviour.stopped) half.send({ v: 1, kind: 'stopped' })
    if (message.kind === 'ping' && behaviour.pong) half.send({ v: 1, kind: 'pong' })
  }

  startWorker(start: WorkerStart): void {
    this.started.push({ id: start.id, incarnation: start.incarnation, half: 'worker', code: start.code.toString() })
    this.workerStarts.push(start)
    if (start.drawer) this.drawers.push(start.id)
    const behaviour = this.of(start.id)
    if (behaviour.throws) throw new Error('the renderer is gone')
    const port = start.port as MessagePort
    const half = new Half(message => port.postMessage(message), () => port.close())
    port.on('message', message => this.answer(half, start.id, message as Message))
    port.on('close', () => {
      half.closed = true
    })
    this.halves.set(`${start.id}:${start.incarnation}:worker`, half)
  }

  terminate(id: string, incarnation: number): void {
    this.terminated.push({ id, incarnation })
  }

  // A utility half on its port, as a worker's. Its process ending is told through the start's exited, which exit calls
  startUtility(start: UtilityStart): void {
    this.started.push({ id: start.id, incarnation: start.incarnation, half: 'utility', code: start.code.toString() })
    this.utilityStarts.push(start)
    if (this.of(start.id).throws) throw new Error('the fork failed')
    const run = this.of(start.id).utility
    if (run !== undefined) return run(start)
    const port = start.port as MessagePort
    const half = new Half(message => port.postMessage(message), () => port.close())
    port.on('message', message => this.answer(half, start.id, message as Message))
    port.on('close', () => {
      half.closed = true
    })
    this.halves.set(`${start.id}:${start.incarnation}:utility`, half)
  }

  kill(id: string, incarnation: number): void {
    this.killed.push({ id, incarnation })
  }

  // The utility process of one incarnation ends, killed by the runtime or by itself
  exit(id: string, incarnation: number, killed: boolean): void {
    this.utilityStarts.find(start => start.id === id && start.incarnation === incarnation)!.exited({ killed })
  }
}

// A provider that serves nothing, for a core module's fake
const servesNothing = (): Provider => ({ prepare: async () => ({ scope: {} }), perform: async () => null })

// A luoshu that keeps each opening it was handed and how often it was closed. Its open throws while throws holds
export function fakeLuoshu(): Luoshu & { opened: Opening[], closed: number, throws: boolean } {
  const made = {
    opened: [] as Opening[],
    closed: 0,
    throws: false,
    provider: servesNothing(),
    role: {
      open(opening: Opening) {
        made.opened.push(opening)
        if (made.throws) throw new Error('no folder to open')
      },
    },
    close() {
      made.closed++
    },
  }
  return made
}

// History or exec as the core holds it, keeping what it was handed, how often it started and closed. start throws
// while fails holds and the push while throws holds
export function fakeHistory(): History & { opened: Opening[], started: number, closed: number, fails: boolean, throws: boolean } {
  const made = {
    opened: [] as Opening[],
    started: 0,
    closed: 0,
    fails: false,
    throws: false,
    provider: servesNothing(),
    role: {
      open(opening: Opening) {
        made.opened.push(opening)
        if (made.throws) throw new Error('no folder to open')
      },
    },
    async start() {
      made.started++
      if (made.fails) throw new Error('no git')
    },
    close() {
      made.closed++
    },
  }
  return made
}

export function fakeExec(): Exec & { views: ExecView[], started: number, closed: number, fails: boolean, throws: boolean } {
  const made = {
    views: [] as ExecView[],
    started: 0,
    closed: 0,
    fails: false,
    throws: false,
    provider: servesNothing(),
    role: {
      stateChanged(view: ExecView) {
        made.views.push(view)
        if (made.throws) throw new Error('bad view')
      },
    },
    async start() {
      made.started++
      if (made.fails) throw new Error('no folder')
    },
    close() {
      made.closed++
    },
  }
  return made
}

// The real grant risk classifier, each of whose calls throws while throws holds, as a classifier that fails per call
export function throwingClassifier(): GrantRiskClassifier & { throws: boolean } {
  const real = createGrantRiskClassifier()
  const made = { throws: true } as GrantRiskClassifier & { throws: boolean }
  for (const name of Object.keys(real) as (keyof GrantRiskClassifier)[]) {
    const own = real[name] as (...args: unknown[]) => unknown
    Object.assign(made, {
      [name]: (...args: unknown[]) => {
        if (made.throws) throw new Error('the policy threw')
        return own.apply(real, args)
      },
    })
  }
  return made
}

// A gate that allows everything and remembers each grants snapshot it was given
export function allowAll(): Gate & { views: number[], seen: GrantsSnapshot[], throws: boolean } {
  const gate = {
    views: [] as number[],
    seen: [] as GrantsSnapshot[],
    throws: false,
    decide: () => ({ allow: true as const, view: gate.views.at(-1) ?? 0 }),
    canRead: () => true,
    canList: () => true,
    verbs: () => [],
    stateChanged(view: GrantsSnapshot) {
      if (gate.throws) throw new Error('bad view')
      gate.views.push(view.n)
      gate.seen.push(view)
    },
  }
  return gate
}

export const manifest = (id: string, extra: object = {}) => ({ id, name: id, version: '1.0.0', api: `^${API_VERSION}`, ...extra })
export const hostManifest = (id: string, extra: object = {}) => manifest(id, { entries: { host: 'host.js' }, ...extra })
export const workerManifest = (id: string, extra: object = {}) => manifest(id, { entries: { worker: 'worker.js' }, ...extra })

// A plugin folder's files: its manifest and a file for each entry it names
export function filesFor(plugin: Record<string, unknown>, extra: Files = {}): Files {
  const files: Files = { 'hetu-plugin.json': `${JSON.stringify(plugin, null, 2)}\n` }
  const entries = (plugin.entries ?? {}) as Record<string, unknown>
  for (const entry of Object.values(entries)) {
    const names = typeof entry === 'string' ? [entry] : Object.values((entry ?? {}) as Record<string, string>)
    for (const name of names) files[name] = `// ${plugin.id} ${name} ${plugin.version}\n`
  }
  return { ...files, ...extra }
}

export async function writeFolder(root: string, files: Files): Promise<void> {
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'))
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
}

export const hashOf = async (root: string) => hashFiles(await readFiles(root))

// A state file as a program that knows hetu writes one: the body and its hash line
export async function plant(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${body}\n${createHash('sha256').update(`${body}\n`).digest('hex')}\n`)
}

export type Listing = { files: Files, firstParty?: boolean, version?: string, hash?: string }

// Writes an install folder: each plugin under plugins/<id> and the install list with each one's version and hash, as
// the Electron build is to. hash replaces the real one, for a list that doesn't match its files
export async function writeInstall(dir: string, plugins: Record<string, Listing>): Promise<void> {
  const listed: Record<string, unknown> = {}
  for (const [id, plugin] of Object.entries(plugins)) {
    const root = path.join(dir, 'plugins', id)
    await writeFolder(root, plugin.files)
    const version = plugin.version ?? (JSON.parse(plugin.files['hetu-plugin.json']) as { version: string }).version
    listed[id] = {
      path: `plugins/${id}`, version, hash: plugin.hash ?? await hashOf(root), ...(plugin.firstParty ? { firstParty: true } : {}),
    }
  }
  await writeFile(path.join(dir, INSTALL_LIST), `${JSON.stringify({ format: 1, plugins: listed }, null, 2)}\n`)
}

// An approved entry for the folder at root
export async function entryFor(root: string, extra: Partial<Plugin> = {}): Promise<Plugin> {
  return { version: '1.0.0', contentHash: await hashOf(root), signer: 'sigstore:someone', granted: [], class: 1, enabled: true, ...extra }
}

export const firstPartyEntry = (hash: string, extra: Partial<Plugin> = {}): Plugin =>
  ({ version: '1.0.0', contentHash: hash, signer: FIRST_PARTY_SIGNER, granted: [], class: null, enabled: true, ...extra })

// The install the core needs to come up: nothing, the gate and the other core modules ship inside the core as the log
// does
export const coreInstall = (): Record<string, Listing> => ({})

// The core modules' instances a test hands in place of the real ones, and the OS's bin for the luoshu
export type ModuleFakes = Partial<Pick<CoreModulesOptions, 'gate' | 'grantRiskClassifier' | 'storage' | 'luoshu' | 'history' | 'exec' | 'heartbeat' | 'trash'>>

// The core modules as wireCore makes them, each the real one unless a test hands its own, the luoshu publishing through
// the carrier the link points at and flood control counting by limit
export function coreModules(
  dirs: { dataDir: string, installDir: string }, link: FakeLink, fakes: ModuleFakes = {}, limit?: (plugin: string | null, name: LimitName) => number,
): CoreModules {
  return realModules({
    ...dirs, ...fakes, publish: (topic, path) => link.carrier?.publishCore('luoshu', topic, path), ...(limit !== undefined ? { limit } : {}),
  })
}

// A real carrier over the plugins manager and the core modules, built from the options wireCore builds it from, with no
// core record log
export function wire(pluginsManager: PluginsManager, modules: CoreModules, link: FakeLink): Carrier {
  const carrier = new Carrier(carrierOptions(pluginsManager, modules, { log: null }))
  link.carrier?.close()
  link.carrier = carrier
  return carrier
}

export type Harness = {
  base: string
  installDir: string
  dataDir: string
  store: StateStore
  link: FakeLink
  runtime: FakeRuntime
  modules: CoreModules
  // The gate the core modules hold, the one handed in or one that allows everything
  gate: Gate
  pluginsManager: PluginsManager
  carrier: Carrier
}

const live: Harness[] = []
// Folders a harness made, removed after each test even when its setup threw before the harness was whole
const bases = new Set<string>()

export async function tempBase(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hetu-plugins-manager-'))
}

// A plugins manager over a real StateStore, the core modules and a real carrier, with the fake runtime. state writes the
// entries and switches the boot hands over. removedKnown stands in for what boot found. The gate allows everything
// unless modules hands another, as the gate the install held did, and every other core module is the real one unless
// modules hands a fake
export async function harness(options: {
  base?: string
  install?: Record<string, Listing> | null
  folder?: Record<string, Files>
  entries?: Record<string, Plugin | ((root: string) => Promise<Plugin>)>
  switches?: Partial<Switches>
  removedKnown?: boolean
  behave?: FakeRuntime['behave']
  modules?: ModuleFakes
  limits?: FakeLink['limits']
  pluginsManager?: Partial<PluginsManagerOptions>
  // Runs once the folders and entries are written and before the store loads, to plant what boot would find
  before?: (dirs: { dataDir: string, installDir: string }) => Promise<void>
} = {}): Promise<Harness> {
  const base = options.base ?? await tempBase()
  bases.add(base)
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  await mkdir(installDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  if (options.install !== null) await writeInstall(installDir, options.install ?? coreInstall())
  for (const [id, files] of Object.entries(options.folder ?? {})) await writeFolder(path.join(dataDir, 'plugins', id), files)
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), ...options.switches })
  for (const [id, entry] of Object.entries(options.entries ?? {})) {
    const root = path.join(dataDir, 'plugins', id)
    await store.writePlugin(id, typeof entry === 'function' ? await entry(root) : entry)
  }
  await options.before?.({ dataDir, installDir })
  const loaded = await store.load()
  const link = new FakeLink()
  // Short enough that a plugin that never answers costs a test little
  link.limits = { readyMs: 1000, stopGraceMs: 100, ...options.limits }
  const runtime = new FakeRuntime()
  runtime.behave = options.behave ?? {}
  const gate = options.modules?.gate ?? allowAll()
  // Flood control counts by the human's limits, which are the plugins manager's once it exists, as wireCore has it
  const human: { limits: () => HumanLimits } = { limits: () => ({ all: {}, plugins: {} }) }
  const limits = new Limits(() => human.limits())
  const modules = coreModules({ dataDir, installDir }, link, { ...options.modules, gate }, (plugin, name) => limits.of(plugin, name))
  const pluginsManager = new PluginsManager({
    booted: { state: loaded.state, checks: loaded.checks, removedKnown: options.removedKnown ?? loaded.removedKnown, store, dataDir },
    installDir,
    link,
    runtime,
    modules,
    // A request counts at once unless a test is about the delay
    confirmDelayMs: 0,
    ...options.pluginsManager,
  })
  human.limits = () => pluginsManager.limits()
  const carrier = wire(pluginsManager, modules, link)
  const made = { base, installDir, dataDir, store, link, runtime, modules, gate, pluginsManager, carrier }
  live.push(made)
  return made
}

export async function cleanup(): Promise<void> {
  for (const made of live.splice(0)) {
    await made.pluginsManager.shutdown().catch(() => {})
    made.carrier.close()
    made.link.carrier?.close()
    for (const port of made.runtime.ports) port.close()
  }
  for (const base of [...bases]) {
    bases.delete(base)
    await rm(base, { recursive: true, force: true })
  }
}

export const stateOf = (pluginsManager: PluginsManager, id: string) => pluginsManager.plugin(id)?.state ?? null
export const reasonOf = (pluginsManager: PluginsManager, id: string) => pluginsManager.list().find(row => row.id === id)?.reason ?? null
