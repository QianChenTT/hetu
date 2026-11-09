import { createCapabilities } from '../../plugins/capabilities/src/capabilities.ts'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { Caller } from '../api/envelope.ts'
import { floorConstants, type FloorConstant } from '../api/floor.ts'
import { FIRST_PARTY_SIGNER, INSTALL_LIST } from '../api/install.ts'
import type { Gate, StateView } from '../api/slots.ts'
import { defaultSwitches, StateStore, type Plugin, type Switches } from '../backend/boot/state.ts'
import { Carrier } from '../backend/carrier/carrier.ts'
import type { Port } from '../backend/carrier/seams.ts'
import { Loader, type LoaderOptions } from '../backend/loader/loader.ts'
import type { CarrierLink, HostExports, HostLink, HostStart, Landing, Runtime, WorkerStart } from '../backend/loader/seams.ts'
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

// What the loader needs from the carrier, around a real carrier for the ways in. send, record, changed, stopping and
// limit are the join's to build, faked here
export class FakeLink implements CarrierLink {
  carrier: Carrier | null = null
  readonly records: { event: string, fields: Record<string, Field> }[] = []
  readonly sent: { caller: Caller, message: Message }[] = []
  readonly ended: { caller: Caller, code: string }[] = []
  readonly registered: Caller[] = []
  // What the loader asked of the carrier, in order: stopping, each record and each lifecycle message by plugin
  readonly timeline: string[] = []
  // How each record lands. A test holds one back by answering a promise it settles itself
  landing: (event: string, fields: Record<string, Field>, signal?: AbortSignal) => Landing | Promise<Landing> = () => 'landed'
  changes = 0
  stopped = 0
  // How many records drain says still wait
  waiting = 0
  limits: Partial<Record<FloorConstant, number>> = {}
  private readonly ports = new Map<string, Port>()
  private readonly receivers = new Map<string, (message: unknown) => void>()

  register(port: Port, caller: Caller): void {
    this.carrier!.register(port, caller)
    this.registered.push(caller)
    this.ports.set(keyOf(caller), port)
  }

  handle(caller: Caller, receive: (message: unknown) => void): { post: (message: unknown) => void } {
    const way = this.carrier!.handle(caller, receive)
    this.registered.push(caller)
    this.receivers.set(keyOf(caller), receive)
    return way
  }

  end(caller: Caller, code: 'stopped' | 'crashed' = 'stopped'): void {
    this.ended.push({ caller, code })
    if (caller.kind === 'plugin') this.timeline.push(`end ${caller.id}`)
    this.ports.delete(keyOf(caller))
    this.receivers.delete(keyOf(caller))
    this.carrier!.end(caller, code)
  }

  send(caller: Caller, message: unknown): void {
    this.sent.push({ caller, message: message as Message })
    if (caller.kind === 'plugin') this.timeline.push(`${(message as Message).kind} ${caller.id}`)
    const port = this.ports.get(keyOf(caller))
    if (port !== undefined) return port.postMessage(message)
    const receive = this.receivers.get(keyOf(caller))
    if (receive === undefined) return
    const copy = structuredClone(message)
    queueMicrotask(() => {
      try {
        receive(copy)
      } catch {}
    })
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

  limit(_plugin: string, name: FloorConstant): number {
    return this.limits[name] ?? floorConstants[name]
  }

  events(name: string) {
    return this.records.filter(record => record.event === name).map(record => record.fields)
  }

  // Messages of one kind sent down a plugin's ways, oldest first
  sentTo(id: string, kind: string): Message[] {
    return this.sent.filter(({ caller, message }) => caller.kind === 'plugin' && caller.id === id && message.kind === kind).map(({ message }) => message)
  }
}

// What a fake plugin does: answer init with ready and stop with stopped, or not
export type Behaviour = { ready: boolean, stopped: boolean, pong: boolean, throws: boolean, exports: HostExports }

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
  readonly started: { id: string, incarnation: number, half: 'worker' | 'host', code: string | null }[] = []
  readonly terminated: { id: string, incarnation: number }[] = []
  readonly halves = new Map<string, Half>()
  readonly ports: MessagePort[] = []
  behave: Record<string, Partial<Behaviour>> = {}

  // A security control's module and the luoshu's give their role, as the install's own do, so a test stops hetu only on purpose
  private of(id: string): Behaviour {
    const roles: Record<string, HostExports> = {
      gate: { gate: allowAll() }, watchdog: { watchdog: { sample() {} } }, luoshu: { luoshu: { open() {} } }, capabilities: { capabilities: createCapabilities() },
    }
    const exports: HostExports = roles[id] ?? {}
    return { ready: true, stopped: true, pong: true, throws: false, exports, ...this.behave[id] }
  }

  half(id: string, incarnation = 1, half: 'worker' | 'host' = 'worker'): Half {
    const found = this.halves.get(`${id}:${incarnation}:${half}`)
    if (found === undefined) throw new Error(`no ${half} for ${id} ${incarnation}`)
    return found
  }

  order(): string[] {
    return this.started.map(start => start.id)
  }

  channel(): { core: Port, plugin: unknown } {
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

  async startHost(start: HostStart): Promise<HostExports> {
    this.started.push({ id: start.id, incarnation: start.incarnation, half: 'host', code: null })
    const behaviour = this.of(start.id)
    if (behaviour.throws) throw new Error('the module threw')
    const link: HostLink = start.link
    const half = new Half(message => link.post(message), () => {})
    link.listen(message => this.answer(half, start.id, message as Message))
    this.halves.set(`${start.id}:${start.incarnation}:host`, half)
    return behaviour.exports
  }

  terminate(id: string, incarnation: number): void {
    this.terminated.push({ id, incarnation })
  }
}

// A gate that allows everything and remembers each StateView it was given
export function allowAll(): Gate & { views: number[], seen: StateView[], throws: boolean } {
  const gate = {
    views: [] as number[],
    seen: [] as StateView[],
    throws: false,
    decide: () => ({ allow: true as const, view: gate.views.at(-1) ?? 0 }),
    canRead: () => true,
    canList: () => true,
    verbs: () => [],
    stateChanged(view: StateView) {
      if (gate.throws) throw new Error('bad view')
      gate.views.push(view.n)
      gate.seen.push(view)
    },
  }
  return gate
}

export const manifest = (id: string, extra: object = {}) => ({ id, name: id, version: '1.0.0', api: '^1', ...extra })
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

// The install the host tier needs to come up: the gate, with a host half. The log is the core's own
export const coreInstall = (): Record<string, Listing> => ({
  gate: { files: filesFor(hostManifest('gate')) },
})

// A real carrier over the loader, built from the options wireCore builds it from, with no floor log
export function wire(loader: Loader, link: FakeLink): Carrier {
  const carrier = new Carrier(carrierOptions(loader, { log: null }))
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
  loader: Loader
  carrier: Carrier
}

const live: Harness[] = []
// Folders a harness made, removed after each test even when its setup threw before the harness was whole
const bases = new Set<string>()

export async function tempBase(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hetu-loader-'))
}

// A loader over a real StateStore and a real carrier, with the fake runtime. state writes the entries and switches the
// boot hands over. removedKnown and markers stand in for what boot found
export async function harness(options: {
  base?: string
  install?: Record<string, Listing> | null
  folder?: Record<string, Files>
  entries?: Record<string, Plugin | ((root: string) => Promise<Plugin>)>
  switches?: Partial<Switches>
  removedKnown?: boolean
  markers?: string[]
  behave?: FakeRuntime['behave']
  limits?: FakeLink['limits']
  loader?: Partial<LoaderOptions>
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
  const loader = new Loader({
    booted: { state: loaded.state, checks: loaded.checks, removedKnown: options.removedKnown ?? loaded.removedKnown, store, dataDir, markers: options.markers ?? [] },
    installDir,
    link,
    runtime,
    // A request counts at once unless a test is about the delay
    confirmDelayMs: 0,
    ...options.loader,
  })
  const carrier = wire(loader, link)
  const made = { base, installDir, dataDir, store, link, runtime, loader, carrier }
  live.push(made)
  return made
}

export async function cleanup(): Promise<void> {
  for (const made of live.splice(0)) {
    await made.loader.shutdown().catch(() => {})
    made.carrier.close()
    made.link.carrier?.close()
    for (const port of made.runtime.ports) port.close()
  }
  for (const base of [...bases]) {
    bases.delete(base)
    await rm(base, { recursive: true, force: true })
  }
}

export const stateOf = (loader: Loader, id: string) => loader.plugin(id)?.state ?? null
export const reasonOf = (loader: Loader, id: string) => loader.list().find(row => row.id === id)?.reason ?? null
