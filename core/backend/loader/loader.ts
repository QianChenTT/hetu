import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ActionResults, CoreStatus, CoreViewsPlugin, HeldRequest, ListedPlugin, PendingRequest, SecurityList, StateKind, StoppedMode } from '../../api/actions.ts'
import { change as changeSchema, changeEffect, mustType, type Change } from '../../api/changes.ts'
import { describeChange } from '../../api/describe.ts'
import { capabilityText, INPUT_DELAY_MS } from '../../api/trusted.ts'
import { VERSION, type Caller } from '../../api/envelope.ts'
import { floorConstants, MAX_TIMER_MS, type FloorConstant } from '../../api/floor.ts'
import {
  firstPartyIds, guardableActions, guards as expectedGuards, installIds, isReservedId, isSecurityControl, pluginId, providers,
  securityControls, slotIds,
  type GuardableAction,
} from '../../api/ids.ts'
import {
  FIRST_PARTY_SIGNER, INSTALL_LIST, installList, isNewer, MAX_INSTALL_LIST_BYTES, type InstallList, type Listed,
} from '../../api/install.ts'
import type { DepState, Init } from '../../api/lifecycle.ts'
import { API_VERSION } from '../../api/manifest.ts'
import { frozen, table } from '../../api/plain.ts'
import { askOnUpdateTypes, capabilityKey, type Capability } from '../../api/capabilities.ts'
import type { Capabilities, ClassMove, ExecGrant, ExecView, Flow, GrantedItem, Opening, PluginState, SlotState, StateView } from '../../api/slots.ts'
import { retried } from '../../lib/disk.ts'
import { parseStrict } from '../../lib/hashed-file.ts'
import { firstPartyPath, type Booted } from '../boot/boot.ts'
import type { FileResult, Plugin, SecurityState, StateStore, Switches } from '../boot/state.ts'
import type { AskRefusal, Asks, HumanLimits, Loader as Seam, PluginInfo, Served } from '../carrier/seams.ts'
import {
  clear, clearFailedOnce, folders, readFailedOnce, readInstalled, removeMarker, stage, swapIn, writeFailedOnce, writeInstalled,
  writeMarker, type Installed,
} from './folders.ts'
import { plan, type Node, type Plan, type Status, type Verdict } from './graph.ts'
import type { CarrierLink, HostExports, Runtime } from './seams.ts'
import { MAX_PENDING, Requests, type RequestAnswer } from './requests.ts'
import { readPlugin, unread, type Read } from './verify.ts'

export type LoaderOptions = {
  // What boot handed over: the state to run with, its checks, whether the tombstones are known, the one StateStore,
  // the data folder and the start markers it found
  booted: Pick<Booted, 'state' | 'checks' | 'removedKnown' | 'store' | 'dataDir' | 'markers'>
  installDir: string
  // Where the install list is, the install folder unless the build keeps the list apart from the plugins, as a
  // packaged build does inside app.asar
  listDir?: string
  link: CarrierLink
  runtime: Runtime
  // The rules the install list's paths follow, the platform the install is on
  platform?: string
  // The guards expected on an action. Defaults to core/api's list, which is empty until #77
  guardsFor?: (action: GuardableAction) => readonly string[]
  // Whether boot's event log takes appends, for the banner. The join passes the EventLog's health
  logWrites?: () => boolean
  // A security control failed while hetu ran: the runtime quits with an error and starts hetu again, or opens only the
  // trusted window once the loader stopped in the stopped mode
  onFailure?: (failure: Failure) => void
  // How long a request must be first in line before its Confirm counts. The input delay unless a test names another
  confirmDelayMs?: number
  // How long a Confirm waits for its record to land, 10 s unless a test names another
  confirmRecordMs?: number
  // The OS's bin the runtime gives, handed to the luoshu alone
  trash?: (absolute: string) => Promise<void>
}

// What the runtime does about a security control that failed while hetu ran
export type Failure =
  | { action: 'relaunch', control: string, reason: string }
  | { action: 'stopped', mode: StoppedMode }

// The role export each security control's module must give. Capabilities gets its own at step 17 and the guards theirs
// with #77
const roleOf: Readonly<Record<string, keyof HostExports>> = Object.freeze({
  gate: 'gate', capabilities: 'capabilities', watchdog: 'watchdog', luoshu: 'luoshu', history: 'history', exec: 'exec',
})

// What an update staged beside the old version came to
export type UpdateOutcome =
  | { outcome: 'applied' }
  | { outcome: 'refused', reason: string }
  | { outcome: 'confirm', stops: readonly string[] }

// One row of the plugin list. from is where the code came from: the install or the plugin folder
export type Listing = {
  id: string
  from: 'install' | 'folder'
  place: PluginInfo['place']
  state: PluginState
  reason: string | null
  incarnation: number
}

type HalfName = 'host' | 'worker'
type Held = { kind: 'held', state: 'crashed' | 'failed' | 'stopped', reason: string }
type Run = { caller: Caller, ready: boolean, stopped: boolean }

// One incarnation. exports are the roles a host half's module gave. A planned stop keeps why and who stopped with it
type Live = {
  readonly n: number
  readonly halves: Map<HalfName, Run>
  exports: HostExports | null
  imported: boolean
  readyTimer: ReturnType<typeof setTimeout> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  stop: { done: Promise<void>, end: () => void, reason: string } | null
  // The worker's heartbeat: pings sent with no pong since and the timer that sends the next
  beat: { timer: ReturnType<typeof setInterval>, misses: number, waiting: boolean } | null
  // The running plugins that stop with this one, named when its stop is decided, since they stop before it does
  with: string[]
  over: boolean
  deps: string
  // A host half's start marker is on disk and no removal has started
  marked: boolean
}

// A plugin the loader knows. read holds the bytes that run. held is what happened in this run that only a restart
// clears. ran is a host half that started in this run, which can't start again until Restart hetu. updated is the
// version an app update replaced, until its record lands
type Known = {
  readonly id: string
  readonly from: 'install' | 'folder'
  root: string
  listed: Listed | null
  entry: Plugin | null
  read: Read
  place: PluginInfo['place']
  state: PluginState
  reason: string | null
  held: Held | null
  live: Live | null
  incarnations: number
  ran: boolean
  lastStop: string | null
  previousVersion: string | null
  updated: string | null
}

type Staged = { dir: string, read: Read }

// A change to one plugin not applied yet: what that plugin would hold, null once it is gone
type Pending = { readonly id: string, readonly granted: readonly Capability[] | null }

// What moves a class, in three groups. Install: a first approval, a first-party copy at start, an update. Running: a
// widen, a narrow, a restore, a remove, a reset, another plugin's change that moves this one. Stationary: the pass at
// start, which finds what changed while hetu was not running
type Cause = 'approve' | 'copy' | 'update' | 'widen' | 'narrow' | 'restore' | 'remove' | 'reset' | 'moved' | 'start'

// The capabilities slot as classing reads it: on with its role ready, off once the human switched it off, down any
// other way
type Classing = 'on' | 'off' | 'down'

// One class change: the plugin, its entry before, null for a first approval, the entry the change leaves before it is
// classed, null once the plugin goes, the cause, whether a Confirm for the change is on screen and the change to one
// plugin whose state it is classed under
type ClassChange = {
  readonly id: string
  readonly before: Plugin | null
  readonly after: Plugin | null
  readonly cause: Cause
  readonly confirm: boolean
  readonly pending?: Pending
}

// What a class change comes to: the entry stored, null once the plugin goes, whether its class, first-use list,
// confirmed record or mark differ from the entry before, the move shown on the Confirm, the items that start to ask,
// whether the entry rises and so is written before the change that causes it and the slot's state it was decided under
type Decided = {
  readonly id: string
  readonly entry: Plugin | null
  readonly changed: boolean
  readonly move: ClassMove | null
  readonly asks: readonly Capability[]
  readonly rises: boolean
  readonly slot: Classing
}

// The same items whatever their order, an item being its type with its scope
function sameItems(items: readonly Capability[], others: readonly Capability[] = []): boolean {
  const keys = new Set(others.map(capabilityKey))
  return items.length === others.length && items.every(item => keys.has(capabilityKey(item)))
}

// Section 6's order for install plugins: the slot holders, then the providers, then the guard and the rest. A
// requirement still starts before its dependent
export const bootOrder = frozen([
  'gate', 'capabilities', 'watchdog', 'storage', 'luoshu', 'history', 'exec', 'net', 'leases', 'http', 'hidden-marks',
] as const)

const FOLDER_RANK = 1000
// What Finder and Explorer leave in a folder the user only looked at
const osFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const isOne = (list: readonly string[], value: string) => list.includes(value)
const refused = (reason: string): Status => ({ kind: 'refused', reason })

const targetsOf = (granted: readonly Capability[]) => granted.flatMap(item => (item.type === 'plugin.call' ? item.targets : []))
// The plugins whose topics a grant hears, each topic published as <id>.<name> by that plugin alone
const publishersOf = (granted: readonly Capability[]) =>
  granted.flatMap(item => (item.type === 'events.subscribe' ? item.topics.map(topic => topic.slice(0, topic.indexOf('.'))) : []))

// Every plugin the links lead to from the plugins in start, followed in turn and never through the one asking
function followed(links: ReadonlyMap<string, ReadonlySet<string>>, start: readonly string[], asking: string): Set<string> {
  const seen = new Set<string>([asking])
  const queue = start.flatMap(from => [...(links.get(from) ?? [])])
  while (queue.length > 0) {
    const other = queue.shift()!
    if (seen.has(other)) continue
    seen.add(other)
    queue.push(...(links.get(other) ?? []))
  }
  seen.delete(asking)
  return seen
}

// The human's item switches carried over to a new set of grants, a first-party copy's or a restore's. An item switched
// off stays off. A new version can change an item's paths, so an item of a type the human switched one off in starts
// off unless it is exactly an item that was on. An item no longer granted goes with its switch
function carriedOff(old: Plugin | null, granted: readonly Capability[]): Capability[] {
  const off = old?.off ?? []
  if (off.length === 0) return []
  const offKeys = new Set(off.map(capabilityKey))
  const offTypes = new Set<string>(off.map(item => item.type))
  const onKeys = new Set((old?.granted ?? []).map(capabilityKey).filter(key => !offKeys.has(key)))
  return granted.filter(item => {
    const key = capabilityKey(item)
    return offKeys.has(key) || (offTypes.has(item.type) && !onKeys.has(key))
  })
}
const ok: Status = { kind: 'ok' }
const none: Readonly<Record<string, { readonly from?: readonly string[] }>> = table({})

function placeOf(read: Read, from: 'install' | 'folder'): PluginInfo['place'] {
  const entries = read.manifest?.entries
  if (entries === undefined) return from === 'install' ? 'host' : 'sandboxed'
  if (entries.host !== undefined) return 'host'
  if (entries.worker === undefined && entries.page !== undefined) return 'page'
  return 'sandboxed'
}

// Messages for a host half before its module listens, kept in order
function mailbox() {
  const kept: unknown[] = []
  let listener: ((message: unknown) => void) | null = null
  return {
    put(message: unknown): void {
      if (listener === null) kept.push(message)
      else listener(message)
    },
    listen(next: (message: unknown) => void): void {
      listener = next
      for (const message of kept.splice(0)) {
        try {
          next(message)
        } catch {}
      }
    },
  }
}

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
  const rest = list.filter(entry => entry !== item)
  return on ? [...rest, item] : rest
}

// A table with no prototype that can still be written, as the state's own limit tables are
function bare<T extends object>(entries: T): T {
  return Object.assign(Object.create(null), entries)
}

// The loader: what may run, where, when and as whom. It checks every plugin's bytes once before they run, places each
// by where its code came from, resolves the requires graph, mints every port and handle and owns every lifecycle state.
// It runs no plugin code itself and decides no grant
export class Loader implements Seam {
  private readonly link: CarrierLink
  private readonly runtime: Runtime
  private readonly store: StateStore
  private readonly dataDir: string
  private readonly installDir: string
  private readonly listDir: string
  private readonly platform: string
  private readonly guardsFor: (action: GuardableAction) => readonly string[]
  private readonly logWrites: () => boolean
  private readonly markers: Set<string>
  private readonly entryChecks = new Map<string, FileResult>()
  // The kinds of state file that failed their check at boot, for the banner
  private readonly suspect: StateKind[]
  private readonly known = new Map<string, Known>()
  // Folder plugins and entries under ids no folder plugin may hold, kept apart so they never touch the install's own
  private readonly strays = new Map<string, string>()
  private readonly bundled = new Map<string, Read>()
  private readonly staged = new Map<string, Staged>()
  // Versions an update replaced in this run, passed on as previousVersion once the plugin is known
  private readonly versions = new Map<string, string>()
  // The last incarnation minted per plugin, kept when a plugin is known again so no number repeats in a run
  private readonly minted = new Map<string, number>()
  private readonly lastSlots = new Map<string, SlotState>()
  private readonly waiters: (() => void)[] = []
  // Marker writes and removals under way, which shutdown waits for, so none is cut off when the process ends
  private readonly markerWork = new Set<Promise<void>>()
  private state: SecurityState
  private removedKnown: boolean
  private install: InstallList | null = null
  private listResult: 'unread' | 'ok' | 'absent' | 'invalid' = 'unread'
  private installed: Installed = Object.create(null)
  private planned: Plan = { verdicts: new Map(), order: [] }
  private n = 1
  private closing = false
  private pumping: Promise<void> | null = null
  private again = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly requests: Requests
  private readonly onFailure: LoaderOptions['onFailure']
  private readonly trash: LoaderOptions['trash']
  // controls while only the security controls may start, all once they are up, stopped once one failed
  private phase: 'controls' | 'all' | 'stopped' = 'controls'
  private stoppedMode: StoppedMode | null = null
  // The control the run before restarted for, from the restart marker
  private failedBefore: string | null = null
  private failing = false
  // Items whose ask the human cancelled this run, by plugin and item, which answer declined until Restart hetu
  private readonly declinedAsks = new Set<string>()

  constructor(options: LoaderOptions) {
    const { booted } = options
    this.link = options.link
    this.runtime = options.runtime
    this.store = booted.store
    this.dataDir = booted.dataDir
    this.installDir = options.installDir
    this.listDir = options.listDir ?? options.installDir
    this.platform = options.platform ?? process.platform
    this.guardsFor = options.guardsFor ?? (action => expectedGuards[action])
    this.logWrites = options.logWrites ?? (() => true)
    this.onFailure = options.onFailure
    this.trash = options.trash
    this.markers = new Set(booted.markers)
    this.state = booted.state
    this.removedKnown = booted.removedKnown
    for (const check of booted.checks) {
      if (check.check === 'plugin-entry' && check.id !== undefined) this.entryChecks.set(check.id, check.result as FileResult)
    }
    // A file in a later format is read no further but is no sign of tampering, as boot reads it
    const failed = new Set(booted.checks.filter(c => !['ok', 'absent', 'newer'].includes(c.result)).map(c => c.check))
    this.suspect = (['switches', 'luoshu', 'plugin-entry'] as const).filter(kind => failed.has(kind))
      .map(kind => (kind === 'plugin-entry' ? 'plugins' : kind))
    this.requests = new Requests({
      effect: change => changeEffect(change),
      fingerprint: change => this.store.fingerprint('plugin' in change ? change.plugin : null),
      exclusive: work => this.serial(work),
      applyNow: change => this.applyNow(change),
      record: (event, fields, signal) => this.link.record(event, fields, signal),
      confirmOff: () => this.state.switches.confirmOff,
      drain: ms => this.link.drain(ms),
      resume: () => this.link.resume(),
      changed: () => this.refresh(),
      clock: () => performance.now(),
      delayMs: options.confirmDelayMs ?? INPUT_DELAY_MS,
      ...(options.confirmRecordMs !== undefined ? { recordMs: options.confirmRecordMs } : {}),
      declined: (plugin, change) => {
        if (change.kind === 'item.on') this.declinedAsks.add(`${plugin}
${capabilityKey(change.capability)}`)
      },
    })
  }

  // ---- the carrier's seam

  // An install plugin's slot or guard role. A switch-off is off whatever the plugin's check said, a failed hash check
  // is tampered and every other way of not being ready is failed, so nothing reads as off that the human didn't switch
  // off. Before the install list is read every slot is starting, as every action with power answers starting while the
  // core starts
  slot(id: string): SlotState {
    if (this.listResult === 'unread') return 'starting'
    if (this.listResult === 'absent') return 'absent'
    if (this.listResult === 'invalid') return 'tampered'
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'install') return 'absent'
    if (isOne(this.state.switches.off, id)) return 'off'
    const status = this.status(k)
    if (status.kind === 'refused' && (status.reason === 'tampered' || status.reason === 'missing')) return 'tampered'
    if (k.state === 'ready') return 'on'
    if (k.state === 'starting' || (k.state === 'found' && this.verdictOf(k).kind === 'start')) return 'starting'
    return 'failed'
  }

  view(): number {
    return this.n
  }

  plugin(id: string): PluginInfo | null {
    const k = this.known.get(id)
    if (k === undefined) return null
    const manifest = k.read.manifest
    return {
      state: k.state,
      place: k.place,
      incarnation: k.live?.n ?? k.incarnations,
      serves: manifest?.entries.host !== undefined ? 'host' : 'worker',
      actions: manifest?.provides?.actions ?? none,
      topics: manifest?.provides?.topics ?? [],
    }
  }

  limits(): HumanLimits {
    return this.state.switches.limits
  }

  recordNothing(): boolean {
    return this.state.switches.recordNothing
  }

  // A way closed under its plugin, was closed for a flood or the worker host page cut its worker off for a flood or a
  // message that wasn't text within the cap. Every dependent is waiting before this returns, then the
  // ways of the plugin's other halves end. A close during a planned stop is that stop ending. A caller from an
  // incarnation that is over finds nothing
  crashed(caller: Caller, reason: 'closed' | 'flood' | 'malformed'): void {
    const found = this.runOf(caller)
    if (found === null) return
    this.die(found.k, reason)
  }

  heard(caller: Caller, kind: 'ready' | 'pong' | 'stopped'): void {
    const found = this.runOf(caller)
    if (found === null) return
    const { k, live, run } = found
    if (kind === 'ready') {
      if (run.ready || live.stop !== null || k.state !== 'starting') return
      run.ready = true
      this.readied(k, live)
    } else if (kind === 'stopped' && live.stop !== null) {
      run.stopped = true
      if ([...live.halves.values()].every(half => half.stopped)) this.finished(k, live)
    } else if (kind === 'pong' && live.beat !== null) {
      live.beat.misses = 0
      live.beat.waiting = false
      if (k.state === 'unresponsive') {
        k.state = 'ready'
        this.refresh()
      }
    }
  }

  // ---- what else the core asks of the loader

  // core.status for a window, and watchdog.stop and watchdog.restart, as the carrier's core seam takes them. The carrier
  // has checked that the caller is a window, or holds the watchdog slot and names a sandboxed plugin holding no slot or
  // guard role
  readonly serve: Served = async call => {
    if (call.action === 'core.status') return this.banner()
    if (call.action === 'core.views') return this.views()
    const args = (call.args ?? {}) as Record<string, unknown>
    switch (call.action) {
      case 'security.request':
        return this.request(args.change, call.caller)
      case 'security.confirm':
        await this.confirm(args.requestId as string, args.typed === undefined ? {} : { typed: args.typed as string })
        return null
      case 'security.cancel':
        await this.cancel(args.requestId as string)
        return null
      case 'security.list':
        return this.securityList()
      case 'core.stop':
      case 'core.restart': {
        const k = this.known.get(args.plugin as string)
        if (k === undefined) throw { code: 'not-found' }
        if (k.place !== 'sandboxed') throw { code: 'not-granted' }
        // The human stopped it from the trusted window, so only the trusted window starts it again
        const trusted = call.caller.kind === 'window' && call.caller.role === 'trusted'
        if (call.action === 'core.restart' && this.stoppedByHuman(k) && !trusted) throw { code: 'not-granted' }
        if (call.action === 'core.stop') await this.stop(k.id, 'human')
        else await this.restart(k.id, 'human')
        return null
      }
    }
    const target = (call.args as { plugin?: unknown } | null)?.plugin
    if (call.action !== 'watchdog.stop' && call.action !== 'watchdog.restart') throw { code: 'unavailable' }
    const k = typeof target === 'string' ? this.known.get(target) : undefined
    if (k === undefined || k.place !== 'sandboxed') throw { code: 'not-found' }
    // The human's stop outranks the watchdog's policy
    if (call.action === 'watchdog.restart' && this.stoppedByHuman(k)) throw { code: 'not-granted' }
    if (call.action === 'watchdog.stop') await this.stop(k.id, 'watchdog')
    else await this.restart(k.id, 'watchdog')
    return null
  }

  // Each plugin that declares views or a theme, whatever its state, so the views menu lists a view whose plugin is down.
  // Not one whose bytes failed their check or whose manifest is refused, since its text can't be trusted
  private views(): ActionResults['core.views'] {
    const plugins: CoreViewsPlugin[] = []
    for (const k of this.known.values()) {
      const manifest = k.read.manifest
      if (manifest === null || k.read.problem !== null || k.state === 'refused') continue
      const views = manifest.views ?? {}
      if (Object.keys(views).length === 0 && manifest.theme === undefined) continue
      plugins.push({
        plugin: k.id, name: manifest.name, running: k.state === 'ready', worker: manifest.entries.worker !== undefined,
        views: { ...views }, theme: manifest.theme ?? null,
      })
    }
    return { plugins }
  }

  private stoppedByHuman(k: Known): boolean {
    return k.held?.state === 'stopped' && k.held.reason === 'human'
  }

  // What the trusted window draws. Ids, states and fixed reasons only, and each request in the core's own words
  private securityList(): SecurityList {
    const { switches } = this.state
    const plugins: ListedPlugin[] = this.list().map(row => {
      const k = this.known.get(row.id)
      const entry = row.from === 'folder' ? k?.entry ?? null : null
      const off = new Set((entry?.off ?? []).map(capabilityKey))
      const asking = new Set((entry?.firstUse ?? []).map(capabilityKey))
      return {
        id: row.id, from: row.from, place: row.place, state: row.state, reason: row.reason,
        security: row.from === 'install' && isSecurityControl(row.id),
        firstParty: row.from === 'folder' && isOne(firstPartyIds, row.id),
        on: row.from === 'install' ? !isOne(switches.off, row.id) : entry?.enabled ?? false,
        items: (entry?.granted ?? []).map(capability => ({
          capability, off: off.has(capabilityKey(capability)), firstUse: asking.has(capabilityKey(capability)),
        })),
        class: entry?.class ?? null,
      }
    })
    const requests: HeldRequest[] = this.requests.changes().map(({ id, change }) => {
      const { text, notes } = describeChange(change)
      return {
        id, kind: change.kind, plugin: 'plugin' in change ? change.plugin : null, text, notes: [...notes, ...this.what(change)],
        type: mustType(change),
      }
    })
    return {
      plugins,
      switches: {
        devMode: [...switches.devMode], execAnyCommand: [...switches.execAnyCommand], skipVerification: switches.skipVerification,
        allowUnsigned: [...switches.allowUnsigned], confirmOff: switches.confirmOff, recordNothing: switches.recordNothing,
      },
      limits: {
        all: { ...switches.limits.all },
        plugins: Object.fromEntries(Object.entries(switches.limits.plugins).map(([id, set]) => [id, { ...set }])),
      },
      luoshu: this.state.luoshu?.folder ?? null,
      requests,
      stopped: this.stoppedMode,
    }
  }

  // What an approval or an update would load, from the one read it was found or staged with: the version and every
  // grant an approval takes from the manifest, the versions an update goes from and to. A change to what one plugin
  // holds adds the classes it moves, from the state the change asks for, with the Confirm on screen
  private what(change: Change): string[] {
    if (change.kind === 'plugin.approve') {
      const k = this.known.get(change.plugin)
      const manifest = k?.read.manifest
      if (k === undefined || manifest === undefined || manifest === null) return []
      const asks = manifest.capabilities ?? []
      return [
        `Version ${manifest.version}`, ...(asks.length === 0 ? ['It asks for nothing'] : asks.map(granted => `It asks for: ${capabilityText(granted)}`)),
        ...this.screen(change.plugin, asks), ...this.shown(this.changeOf('approve', change.plugin, this.approval(k), true)),
      ]
    }
    if (change.kind === 'plugin.update') {
      const read = this.staged.get(change.plugin)?.read
      const to = read?.manifest?.version
      const entry = this.known.get(change.plugin)?.entry
      if (read === undefined || to === undefined || entry === undefined || entry === null) return []
      const after: Plugin = { ...entry, version: to, contentHash: read.hash! }
      return [`From ${entry.version} to ${to}`, ...this.screen(change.plugin, entry.granted), ...this.shown(this.changeOf('update', change.plugin, after, true))]
    }
    if (change.kind === 'grant.widen') {
      const entry = this.known.get(change.plugin)?.entry
      if (entry === undefined || entry === null) return []
      const after: Plugin = { ...entry, granted: [...entry.granted, change.capability] }
      return [...this.screen(change.plugin, after.granted), ...this.shown(this.changeOf('widen', change.plugin, after, true))]
    }
    if (change.kind === 'plugin.restore') {
      const read = this.bundled.get(change.plugin)
      const listed = this.install?.plugins[change.plugin]
      if (read?.manifest === undefined || read.manifest === null || listed === undefined) return []
      const after = this.copied(change.plugin, read, listed, this.state.plugins[change.plugin]?.enabled ?? true)
      return this.shown(this.changeOf('restore', change.plugin, after, true))
    }
    if (change.kind === 'plugin.remove' || change.kind === 'plugin.reset') {
      const k = this.known.get(change.plugin)
      return k?.from === 'folder' && k.entry !== null ? this.shown(this.changeOf(change.kind === 'plugin.remove' ? 'remove' : 'reset', change.plugin, null, true)) : []
    }
    return []
  }

  // A plugin's storage or cache space cleared through the storage plugin while it runs, in the space's turn after the
  // calls already queued on it, so a set a stopping plugin queued can't land after the clear. With storage down nothing
  // is queued and the folder goes directly
  private async clearSpace(kind: 'storage' | 'cache', id: string): Promise<void> {
    const role = this.role('storage', 'storage')
    if (role !== null) {
      try {
        await role.clear(kind, id)
        return
      } catch {
        this.note('fault', { plugin: 'storage', step: 'clear' })
      }
    }
    await clear(kind === 'storage' ? folders.storage(this.dataDir, id) : folders.cache(this.dataDir, id))
  }

  // ---- classes

  // The capabilities slot's role while the slot is on and its plugin ready, null otherwise
  private capabilities(): Capabilities | null {
    return this.slot('capabilities') === 'on' ? this.role('capabilities', 'capabilities') : null
  }

  // What a plugin holds: a plugin-folder plugin's entry, an install plugin's manifest
  private grantsOf(id: string): readonly Capability[] {
    const k = this.known.get(id)
    if (k?.from === 'install') return k.read.manifest?.capabilities ?? []
    return this.state.plugins[id]?.granted ?? []
  }

  // Every plugin the loader knows and what each holds, id's own being granted, which may be a change not applied yet,
  // and another plugin's as a pending change to it would leave it
  private holders(id: string, granted: readonly Capability[], pending?: Pending) {
    const gone = pending?.granted === null ? pending.id : null
    const ids = [...new Set([
      ...Object.keys(this.state.plugins), ...[...this.known.values()].filter(k => k.from === 'install').map(k => k.id), id,
      ...(pending === undefined ? [] : [pending.id]),
    ])].filter(other => other === id || other !== gone)
    const held = (other: string) => (other === id ? granted : other === pending?.id ? pending.granted ?? [] : this.grantsOf(other))
    return { ids, held }
  }

  // Every plugin connected to id through plugin.call, either way round and followed in turn, with what each holds. A
  // callee answers its caller, so data moves both ways along a call: a reader and a network plugin that share a callee
  // can pass notes out through it
  private connected(id: string, granted: readonly Capability[], pending?: Pending): { id: string, granted: readonly Capability[] }[] {
    const { ids, held } = this.holders(id, granted, pending)
    const links = new Map<string, Set<string>>(ids.map(other => [other, new Set<string>()]))
    for (const from of ids) {
      for (const to of targetsOf(held(from))) {
        if (to === from) continue
        if (!links.has(to)) links.set(to, new Set())
        links.get(from)!.add(to)
        links.get(to)!.add(from)
      }
    }
    return [...followed(links, [id], id)].sort().map(other => ({ id: other, granted: held(other) }))
  }

  // Where data can move to and from id, for the pair rule: along plugin.call both ways, and along a subscription to
  // another plugin's topics from the plugin that owns the topic to id, never back. Publishing needs no grant, so a
  // plugin can signal every plugin that hears its topics by what and when it publishes, while a plugin that hears
  // another passes it nothing. Two plugins hearing one topic share nothing through it
  private flow(id: string, granted: readonly Capability[], pending?: Pending): Flow {
    const { ids, held } = this.holders(id, granted, pending)
    const out = new Map<string, Set<string>>()
    const into = new Map<string, Set<string>>()
    const link = (from: string, to: string) => {
      if (from === to) return
      if (!out.has(from)) out.set(from, new Set())
      if (!into.has(to)) into.set(to, new Set())
      out.get(from)!.add(to)
      into.get(to)!.add(from)
    }
    for (const from of ids) {
      for (const to of targetsOf(held(from))) {
        link(from, to)
        link(to, from)
      }
      for (const owner of publishersOf(held(from))) link(owner, from)
    }
    const peers = (others: Set<string>) => [...others].sort().map(other => ({ id: other, granted: held(other) }))
    const heard = granted.flatMap(item => {
      const owners = publishersOf([item]).filter(owner => owner !== id)
      if (owners.length === 0) return []
      const upstream = new Set([...owners, ...followed(into, owners, id)])
      upstream.delete(id)
      return [{ item, upstream: peers(upstream).flatMap(peer => [...peer.granted]) }]
    })
    return { upstream: peers(followed(into, [id], id)), downstream: peers(followed(out, [id], id)), heard }
  }

  private reachable(id: string, granted: readonly Capability[], pending?: Pending): Capability[] {
    return this.connected(id, granted, pending).flatMap(other => [...other.granted])
  }

  // What a plugin's class rests on past its own grants: what it reaches through plugin.call and where data moves to and
  // from it
  private links(id: string, granted: readonly Capability[], pending?: Pending): string {
    return JSON.stringify([this.reachable(id, granted, pending), this.flow(id, granted, pending)])
  }

  // The capabilities slot as classing reads it: on while its plugin is ready with its role, off only once the human
  // switched it off and down for anything else, a failed, absent or tampered plugin included
  private classing(): Classing {
    const state = this.slot('capabilities')
    if (state === 'off') return 'off'
    return this.capabilities() !== null ? 'on' : 'down'
  }

  // The one function every class change goes through, whatever causes it. With the slot on the policy classes the
  // plugin under the state the change asks for and an item asks unless the entry records the human confirmed it. With
  // the slot switched off by the human the change passes: the class stays the last one classed, the entry is marked as
  // not classed and lists every item not confirmed, which the gate is handed only once the slot is on again. Down any
  // other way, or a role that fails, the class is not known and every item asks, except at start, where every entry
  // stands as stored. A move is shown only on a Confirm on screen with the slot on and which moves show is the policy's.
  // A confirmed item stays confirmed while the plugin holds it
  private decide(change: ClassChange): Decided {
    const { id, before, after, cause, confirm, pending } = change
    let slot = this.classing()
    if (after === null) return { id, entry: null, changed: before !== null, move: null, asks: [], rises: false, slot }
    const held = new Set(after.granted.map(capabilityKey))
    const confirmed = (before?.confirmed ?? []).filter(item => held.has(capabilityKey(item)))
    const known = new Set(confirmed.map(capabilityKey))
    const classed = slot === 'on' ? this.classed(id, after.granted, pending) : null
    if (classed === null && slot === 'on') slot = 'down'
    if (slot !== 'on' && cause === 'start') return { id, entry: before, changed: false, move: null, asks: [], rises: false, slot }
    const n = classed !== null ? classed.class : slot === 'off' ? before?.class ?? null : null
    const asking = classed !== null
      ? classed.firstUse.filter(item => !known.has(capabilityKey(item)))
      : after.granted.filter(item => slot === 'down' || !known.has(capabilityKey(item)))
    const next: Plugin = { ...after, class: n }
    delete next.firstUse
    delete next.confirmed
    delete next.unclassed
    if (asking.length > 0) next.firstUse = asking
    if (confirmed.length > 0) next.confirmed = confirmed
    if (slot === 'off' || (slot === 'down' && after.unclassed === true)) next.unclassed = true
    const listed = new Set((before?.firstUse ?? []).map(capabilityKey))
    const asks = asking.filter(item => !listed.has(capabilityKey(item)))
    const changed = before === null || n !== before.class || !sameItems(asking, before.firstUse) || !sameItems(confirmed, before.confirmed)
      || next.unclassed !== before.unclassed
    return {
      id, entry: next, changed, asks, slot,
      rises: asks.length > 0 || (next.unclassed === true && before?.unclassed !== true) || (n ?? 4) > (before?.class ?? 4),
      move: confirm && slot === 'on' && before !== null && n !== before.class ? { id, from: before.class, to: n } : null,
    }
  }

  // A change to one plugin as class changes: its own, then one for every other plugin-folder plugin whose links it
  // moves and whose entry it changes, each decided under the state the change asks for
  private changeOf(cause: Cause, id: string, after: Plugin | null, confirm: boolean): { own: Decided, others: Decided[] } {
    const pending: Pending = { id, granted: after?.granted ?? null }
    const own = this.decide({ id, before: this.state.plugins[id] ?? null, after, cause, confirm, pending })
    const others: Decided[] = []
    for (const [other, entry] of Object.entries(this.state.plugins)) {
      if (other === id || this.known.get(other)?.from === 'install') continue
      if (this.links(other, entry.granted) === this.links(other, entry.granted, pending)) continue
      const decided = this.decide({ id: other, before: entry, after: entry, cause: 'moved', confirm, pending })
      if (decided.changed) others.push(decided)
    }
    return { own, others }
  }

  // An approval's entry before it is classed, from the one read the request was made on: its hash, version and the
  // manifest's grants
  private approval(k: Known): Plugin {
    const manifest = k.read.manifest!
    return { version: manifest.version, contentHash: k.read.hash!, signer: null, granted: manifest.capabilities ?? [], class: null, enabled: true }
  }

  // A first-party copy's entry before it is classed, with the human's item switches carried over
  private copied(id: string, read: Read, listed: Listed, enabled: boolean): Plugin {
    const granted = read.manifest!.capabilities ?? []
    const before = this.state.plugins[id] ?? null
    const off = carriedOff(before, granted)
    return {
      version: listed.version, contentHash: listed.hash, signer: FIRST_PARTY_SIGNER, granted, class: before?.class ?? null, enabled,
      ...(off.length > 0 ? { off } : {}),
    }
  }

  // Every plugin-folder entry classed again at start from the graph as it stands, before any plugin-folder plugin runs:
  // an app update can change what an install plugin holds with no change to any entry and an entry can be out of date.
  // Only an entry that comes out different is written. One that rises and can't be written still asks in the run, one
  // that lowers keeps its entry
  private async classAll(): Promise<void> {
    let changed = false
    for (const [id, entry] of Object.entries(this.state.plugins)) {
      if (this.known.get(id)?.from === 'install') continue
      const decided = this.decide({ id, before: entry, after: entry, cause: 'start', confirm: false })
      if (!decided.changed || decided.entry === null) continue
      try {
        await this.store.writePlugin(id, decided.entry)
      } catch {
        this.note('fault', { plugin: id, step: 'reclass' })
        if (!decided.rises) continue
      }
      this.putEntry(id, decided.entry)
      changed = true
    }
    if (changed) this.bump()
  }

  // Writes the entries of the other plugins a change moves: those that rise before the change's own write and the rest
  // after it, so a write that fails between them leaves a class too high or an item asking, never a class too low. A
  // write after the change that fails leaves that entry as it was, higher
  private async settle(others: readonly Decided[], rises: boolean): Promise<void> {
    for (const other of others) {
      if (other.rises !== rises || other.entry === null) continue
      const written = this.store.writePlugin(other.id, other.entry)
      if (rises) await written
      else if (!await written.then(() => true, () => false)) {
        this.note('fault', { plugin: other.id, step: 'reclass' })
        continue
      }
      this.putEntry(other.id, other.entry)
    }
  }

  // The lines a request's Confirm shows for the classes its change moves, the changed plugin's own first, each as the
  // slot words it. A slot without moves shows none
  private shown(change: { own: Decided, others: readonly Decided[] }): string[] {
    const moves = [change.own, ...change.others].flatMap(decided => (decided.move === null ? [] : [decided.move]))
    const slot = this.capabilities()
    if (moves.length === 0 || slot === null || typeof slot.moves !== 'function') return []
    try {
      const lines = slot.moves(moves)
      if (Array.isArray(lines) && lines.every(line => typeof line === 'string')) return lines
    } catch {}
    this.note('fault', { plugin: 'capabilities', step: 'moves' })
    return []
  }

  // A plugin's class and the items that ask at first use, from the slot. Null with the slot down or a role that fails
  private classed(id: string, granted: readonly Capability[], pending?: Pending): { class: number, firstUse: Capability[] } | null {
    const slot = this.capabilities()
    if (slot === null) return null
    try {
      const reachable = this.reachable(id, granted, pending)
      const flow = this.flow(id, granted, pending)
      const n = slot.classify(granted, reachable, flow)
      const asking = slot.firstUse(granted, reachable, flow)
      if (Number.isInteger(n) && n >= 0 && n <= 4 && Array.isArray(asking)) return { class: n, firstUse: asking }
    } catch {}
    this.note('fault', { plugin: 'capabilities', step: 'classify' })
    return null
  }

  // The slot's lines under the core's words, or with the slot down what that means. Nothing with the slot switched off
  // by the human, who chose to see nothing about classes
  private screen(id: string, granted: readonly Capability[]): string[] {
    if (this.classing() === 'off') return []
    const slot = this.capabilities()
    if (slot !== null) {
      try {
        const connected = this.connected(id, granted)
        const lines = slot.screen({ granted, reachable: connected.flatMap(other => [...other.granted]), callers: connected, flow: this.flow(id, granted) })
        if (Array.isArray(lines) && lines.every(line => typeof line === 'string')) return lines
      } catch {}
      this.note('fault', { plugin: 'capabilities', step: 'screen' })
    }
    return ['The capabilities plugin is down, so the class is unknown and counted as 4: every item asks at its first use']
  }

  // What a window's banner shows, from the loader's own states and the state it runs with
  private banner(): CoreStatus {
    const down = new Set(['crashed', 'failed', 'unresponsive'])
    const { switches } = this.state
    return {
      slots: Object.fromEntries(slotIds.map(id => [id, this.slot(id)])) as CoreStatus['slots'],
      crashed: this.list().filter(row => down.has(row.state)).map(row => row.id),
      devMode: [...switches.devMode],
      allowUnsigned: switches.allowUnsigned.length,
      skipVerification: switches.skipVerification,
      recordNothing: switches.recordNothing,
      logWrites: this.logWrites(),
      luoshuPicked: this.state.luoshu !== null,
      page: this.list().filter(row => row.place === 'page' && row.state === 'ready').map(row => row.id),
      pending: this.pending(),
      stopped: this.stoppedMode,
      suspect: [...this.suspect],
    }
  }

  // A host half's role interface, only while its plugin is ready. The carrier's gate, guards, providers and watchdog
  // seams read it through here once the join wires them
  role<R extends keyof HostExports>(id: string, name: R): NonNullable<HostExports[R]> | null {
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'install' || k.state !== 'ready' || k.live === null) return null
    return k.live.exports?.[name] ?? null
  }

  list(): Listing[] {
    const rows: Listing[] = [...this.known.values()].map(k => ({
      id: k.id, from: k.from, place: k.place, state: k.state, reason: k.reason, incarnation: k.live?.n ?? k.incarnations,
    }))
    for (const [id, reason] of this.strays) rows.push({ id, from: 'folder', place: 'sandboxed', state: 'refused', reason, incarnation: 0 })
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.from < b.from ? -1 : 1))
  }

  // ---- boot

  // In boot's order: the install checked and its host tier started, the first-party reconcile, every plugin-folder
  // entry classed again, the plugin folder scanned and the sandboxed tier started in graph order. core.ready closes it
  // with every slot's state, unless a shutdown began on the way
  async start(): Promise<void> {
    await this.readInstall()
    this.failedBefore = await readFailedOnce(this.dataDir)
    // The security controls start alone first. One that is on and fails stops hetu before anything else runs
    this.replan()
    await this.settled()
    const failed = this.controlFailure()
    if (failed !== null) return this.enterStopped(failed)
    this.phase = 'all'
    this.replan()
    await this.settled()
    await this.saveInstalled()
    await this.reconcile()
    // In the changes' turn, since a restore needs no plugin the scan found and could write an entry under the pass
    await this.serial(() => this.classAll())
    await this.scan()
    this.replan()
    await this.settled()
    if (!this.closing) this.note('core.ready', Object.fromEntries(slotIds.map(id => [id, this.slot(id)])))
  }

  // The stopped mode hetu is in, null while it runs
  stopped(): StoppedMode | null {
    return this.stoppedMode
  }

  // The first security control the install names that is on and not ready once the controls started: tampered, absent
  // from the install while the list names it, or failed. An install list that can't be read counts as tampered, since
  // it ships inside hetu's own files. One the human switched off is no failure
  private controlFailure(): StoppedMode | null {
    const again = (_control: string) => this.failedBefore !== null
    if (this.listResult === 'invalid') return { control: 'install', why: 'tampered', reason: null, again: again('install') }
    for (const id of securityControls(Object.keys(this.install?.plugins ?? {}))) {
      const k = this.known.get(id)
      if (k === undefined || isOne(this.state.switches.off, id) || k.state === 'ready') continue
      const refusedFor = (reason: string) => k.state === 'refused' && k.reason === reason
      const why = refusedFor('tampered') ? 'tampered' : refusedFor('missing') ? 'absent' : 'failed'
      return { control: id, why, reason: k.reason, again: again(id) }
    }
    return null
  }

  // The stopped mode: every plugin stops and none starts. Only the trusted window opens, with the human's three choices
  private async enterStopped(mode: StoppedMode): Promise<void> {
    this.stoppedMode = mode
    this.phase = 'stopped'
    this.note('core.stopped', { control: mode.control, why: mode.why, reason: mode.reason, again: mode.again })
    this.replan()
    await this.pumped()
  }

  // A security control or the core's log failed while hetu ran. The first time, the restart marker goes down and the
  // runtime quits with an error to start hetu again. When the run before already restarted for a failure, of this
  // control or another, hetu stops in the stopped mode instead, so two controls failing in turns can't restart it
  // forever. A marker that can't be written stops it too, since nothing would then bound the restarts. One failure is
  // enough, the ones after it change nothing. Answers whether it took the failure, so a failure told while hetu starts
  // or stops can be told again
  controlFailed(control: string, reason: string): boolean {
    if (this.closing || this.phase !== 'all' || this.failing) return false
    this.failing = true
    this.note('core.failed', { control, reason })
    const stop = (again: boolean) => {
      const mode: StoppedMode = { control, why: 'failed', reason, again }
      void this.enterStopped(mode).finally(() => this.tell({ action: 'stopped', mode }))
    }
    if (this.failedBefore !== null) {
      stop(true)
      return true
    }
    // Shutdown and a clean Quit wait for the write like any marker's, so neither can cut it off or clear it first
    const work = writeFailedOnce(this.dataDir, control).then(() => true, () => false)
    const tracked = work.then(() => {})
    this.markerWork.add(tracked)
    void work.then(written => {
      this.markerWork.delete(tracked)
      if (written) this.tell({ action: 'relaunch', control, reason })
      else stop(false)
    })
    return true
  }

  private tell(failure: Failure): void {
    try {
      this.onFailure?.(failure)
    } catch {}
  }

  // The human quit hetu: nothing failed, so the next failure restarts hetu again
  async cleanQuit(): Promise<void> {
    while (this.markerWork.size > 0) await Promise.all(this.markerWork)
    await clearFailedOnce(this.dataDir).catch(() => {})
  }

  // Resolves once nothing is starting or stopping and nothing more can start
  settled(): Promise<void> {
    return new Promise(resolve => {
      this.waiters.push(resolve)
      this.checkIdle()
    })
  }

  // Shutdown after the windows: sandboxed plugins in reverse graph order, then host plugins in reverse with the gate
  // last. The carrier hears it first, so nothing stopped for shutdown reads as down
  async shutdown(): Promise<void> {
    if (!this.closing) {
      this.closing = true
      try {
        this.link.stopping()
      } catch {}
      this.note('core.stopping', {})
      this.replan()
    }
    await this.pumped()
    while (this.markerWork.size > 0) await Promise.all(this.markerWork)
  }

  // ---- the install

  private async readInstall(): Promise<void> {
    const file = path.join(this.listDir, INSTALL_LIST)
    let bytes: Buffer | null = null
    try {
      bytes = await retried(() => readFile(file), file, 'read')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.listResult = 'invalid'
    }
    if (bytes !== null) {
      try {
        if (bytes.length > MAX_INSTALL_LIST_BYTES) throw new Error('too large')
        this.install = parseStrict(bytes, installList)
        this.listResult = 'ok'
      } catch {
        this.listResult = 'invalid'
      }
    } else if (this.listResult === 'unread') {
      this.listResult = 'absent'
    }
    this.note('install.checked', { result: this.listResult })
    if (this.install === null) return

    for (const [id, listed] of Object.entries(this.install.plugins)) {
      let root: string | null = null
      try {
        root = firstPartyPath(this.installDir, listed.path, this.platform)
      } catch {}
      const read = root === null ? unread : await readPlugin(root, id, listed.firstParty ? 'folder' : 'install')
      if (listed.firstParty) {
        this.bundled.set(id, read)
        this.checked(id, 'bundled', read, listed.hash, false)
        continue
      }
      this.know(id, 'install', root ?? this.installDir, read, listed, null)
      this.checked(id, 'install', read, listed.hash, this.loose(id))
    }

    this.installed = await readInstalled(this.dataDir)
    for (const k of this.known.values()) {
      const last = this.installed[k.id]
      if (last !== undefined && k.listed !== null && (last.version !== k.listed.version || last.hash !== k.listed.hash)) {
        k.updated = last.version
      }
    }
    // A host half whose start marker an earlier boot left froze main at start, so it is held failed until the human
    // switches it off and on again or restarts hetu once the marker is gone
    for (const id of this.markers) {
      const k = this.known.get(id)
      if (k === undefined || k.from !== 'install' || k.place !== 'host') continue
      k.held = { kind: 'held', state: 'failed', reason: 'marker' }
      this.note('plugin.failed', { plugin: id, incarnation: 0, reason: 'marker' })
    }
  }

  // The marker for the next run: every install plugin's version and hash, except one whose update hasn't applied yet,
  // which keeps the version it had so the next start finds the change again
  private async saveInstalled(): Promise<void> {
    if (this.install === null) return
    const next: Installed = Object.create(null)
    for (const k of this.known.values()) {
      if (k.from !== 'install' || k.listed === null) continue
      const last = this.installed[k.id]
      next[k.id] = k.updated !== null && last !== undefined ? last : { version: k.listed.version, hash: k.listed.hash }
    }
    try {
      await writeInstalled(this.dataDir, next)
      this.installed = next
    } catch {
      this.note('fault', { plugin: null, step: 'installed' })
    }
  }

  // ---- the first-party reconcile

  // Copies a first-party plugin when its entry is absent with no tombstone or when the install's version is newer,
  // through staging, a swap and the entry last. The human's switch survives. A community plugin holding the id is
  // never overwritten or adopted. An entry that failed its check or is in a newer format counts as present and is never
  // written over. In a boot that lost the tombstones nothing is copied that has no entry, a tombstone goes in instead
  private async reconcile(): Promise<void> {
    const tombstones: string[] = []
    for (const [id, read] of this.bundled) {
      const listed = this.install!.plugins[id]
      // The install's own copy must match its list, or there is nothing trustworthy to copy
      if (read.problem !== null || read.hash !== listed.hash) continue
      const result = this.entryChecks.get(id) ?? 'absent'
      if (result !== 'ok' && result !== 'absent') continue
      const entry = this.state.plugins[id] ?? null
      if (entry === null) {
        if (isOne(this.state.switches.removed, id)) continue
        if (!this.removedKnown) {
          tombstones.push(id)
          continue
        }
        if (await this.foreign(id, listed.hash)) {
          this.note('plugin.collision', { plugin: id })
          continue
        }
        await this.copy(id, read, listed, 'copy', true, null).catch(() => this.note('fault', { plugin: id, step: 'copy' }))
      } else if (entry.signer !== FIRST_PARTY_SIGNER) {
        this.note('plugin.collision', { plugin: id })
      } else if (isNewer(listed.version, entry.version)) {
        await this.copy(id, read, listed, 'copy', entry.enabled, entry.version)
          .catch(() => this.note('fault', { plugin: id, step: 'copy' }))
      }
    }
    if (tombstones.length > 0) await this.tombstone(tombstones)
  }

  // A folder already at plugins/<id> holding other bytes than the install's copy, which the reconcile never overwrites
  private async foreign(id: string, hash: string): Promise<boolean> {
    const found = await readPlugin(folders.plugins(this.dataDir, id), id, 'folder')
    return found.hash !== null && found.hash !== hash
  }

  // Applies only once its record has landed, so the copy's floor record is on disk before the entry widens anything. A
  // restore is asked for on a Confirm, a copy at start has none
  private async copy(id: string, read: Read, listed: Listed, cause: 'copy' | 'restore', enabled: boolean, previous: string | null): Promise<boolean> {
    const dir = await stage(this.dataDir, id, read.files)
    const landing = await this.landing(id, cause === 'restore' ? 'plugin.restored' : 'plugin.copied', { plugin: id, version: listed.version })
    if (landing === 'lost') {
      await clear(dir).catch(() => {})
      return false
    }
    await swapIn(this.dataDir, id, dir)
    if (previous !== null && previous !== listed.version) await this.clearSpace('cache', id).catch(() => {})
    const change = this.changeOf(cause, id, this.copied(id, read, listed, enabled), cause === 'restore')
    const entry = change.own.entry!
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.putEntry(id, entry)
    await this.settle(change.others, false)
    if (previous !== null && previous !== listed.version) this.versions.set(id, previous)
    this.bump()
    return true
  }

  // A narrowing write with no Confirm, so a first-party plugin the human may have removed stays out until plugin.restore
  private async tombstone(ids: string[]): Promise<void> {
    const removed = [...new Set([...this.state.switches.removed, ...ids])]
    try {
      await this.writeSwitches({ ...this.state.switches, removed })
    } catch {
      this.note('fault', { plugin: null, step: 'tombstone' })
      return
    }
    this.removedKnown = true
    for (const id of ids) this.note('plugin.tombstone', { plugin: id })
  }

  // ---- the plugin folder

  // The plugin folder scan: every folder and every entry, each folder's bytes read and hashed once. An id no folder
  // plugin may hold is refused reserved-id unread and kept apart, entry or folder
  private async scan(): Promise<void> {
    const dir = path.join(this.dataDir, 'plugins')
    const found = new Set<string>()
    let bad = 0
    try {
      for (const dirent of await readdir(dir, { withFileTypes: true })) {
        if (osFiles.has(dirent.name.toLowerCase())) continue
        if (dirent.isDirectory() && pluginId.safeParse(dirent.name).success) found.add(dirent.name)
        else bad++
      }
    } catch {}
    if (bad > 0) this.note('plugin.checked', { plugin: null, from: 'folder', result: 'bad-name', count: bad })
    const ids = new Set([...found, ...Object.keys(this.state.plugins)])
    for (const [id, result] of this.entryChecks) if (result !== 'ok' && result !== 'absent') ids.add(id)
    for (const id of [...ids].sort()) await this.scanOne(id, found.has(id))
  }

  private async scanOne(id: string, present: boolean): Promise<void> {
    if (isReservedId(id) && !isOne(firstPartyIds, id)) {
      this.strays.set(id, 'reserved-id')
      this.note('plugin.checked', { plugin: id, from: 'folder', result: 'reserved-id' })
      this.note('plugin.refused', { plugin: id, reason: 'reserved-id' })
      return
    }
    const root = folders.plugins(this.dataDir, id)
    const entry = this.state.plugins[id] ?? null
    const read = present ? await readPlugin(root, id, 'folder') : unread
    this.know(id, 'folder', root, read, null, entry)
    this.checked(id, 'folder', read, entry?.contentHash ?? null, this.loose(id))
  }

  private know(id: string, from: 'install' | 'folder', root: string, read: Read, listed: Listed | null, entry: Plugin | null): Known {
    const k: Known = {
      id, from, root, listed, entry, read, place: placeOf(read, from), state: 'found', reason: null, held: null,
      live: null, incarnations: 0, ran: false, lastStop: null, previousVersion: this.versions.get(id) ?? null,
      updated: null,
    }
    this.known.set(id, k)
    return k
  }

  // plugin.checked for every result, ok included. A mismatch the human's switches let through says which switch did
  private checked(id: string, from: string, read: Read, expected: string | null, loose: boolean): void {
    let result: string
    if (read.hash === null) result = 'missing'
    else if (expected !== null && read.hash !== expected) result = !loose ? 'tampered' : this.dev(id) ? 'dev' : 'skipped'
    else result = read.problem ?? (expected === null ? 'new' : 'ok')
    this.note('plugin.checked', { plugin: id, from, result })
  }

  // ---- judging

  private dev(id: string): boolean {
    return isOne(this.state.switches.devMode, id)
  }

  // Whether the human's switches let this plugin's bytes differ from what its entry or the list names
  private loose(id: string): boolean {
    return this.dev(id) || this.state.switches.skipVerification
  }

  private isSlot(id: string): boolean {
    return isOne(slotIds, id)
  }

  private expected(): string[] {
    const guards = guardableActions.flatMap(action => this.guardsFor(action))
    return [...new Set([...slotIds, ...guards])]
  }

  // Slot holders, providers and guards fill roles only a host half can hold
  private needsHost(id: string): boolean {
    return this.isSlot(id) || isOne(Object.values(providers), id) || this.expected().includes(id)
  }

  // Slot holders require nothing and can't be required. Install plugins require only install plugins
  private requiresProblem(k: Known): boolean {
    const requires = k.read.manifest?.requires ?? []
    if (this.isSlot(k.id) && requires.length > 0) return true
    return requires.some(id => this.isSlot(id) || (k.from === 'install' && !isOne(installIds, id)))
  }

  // What the checks and this run make of a plugin, before the graph. The human's switch comes first, so a plugin the
  // human switched off reads off whatever its check said and a failed check never reads as off
  private status(k: Known): Status {
    return k.from === 'install' ? this.installStatus(k) : this.folderStatus(k)
  }

  // Dev mode on an install plugin loads its bytes unhashed, from the install and never from the plugin folder. A host
  // half still starts once per run, so its live reload is Restart hetu
  private installStatus(k: Known): Status {
    const listed = k.listed!
    if (isOne(this.state.switches.off, k.id)) return { kind: 'off' }
    const loose = this.loose(k.id)
    if (k.read.hash === null) return refused('missing')
    if (!loose && k.read.hash !== listed.hash) return refused('tampered')
    if (k.read.problem !== null) return refused(k.read.problem)
    const manifest = k.read.manifest!
    if (!loose && manifest.version !== listed.version) return refused('invalid')
    if (this.needsHost(k.id) && manifest.entries.host === undefined) return refused('place')
    if (this.requiresProblem(k)) return refused('requires')
    return k.held ?? ok
  }

  // A first-party id loads only as the install's own copy: the reserved signer in its entry and its bytes equal to the
  // install's, which dev mode alone lets differ. A null signer loads only for a build allowUnsigned names by the hash
  // of the bytes read, or in dev mode, which is for a build with no fixed hash
  private folderStatus(k: Known): Status {
    const { id, read, entry } = k
    if (entry === null) {
      const result = this.entryChecks.get(id) ?? 'absent'
      if (result === 'newer') return refused('newer')
      if (result !== 'ok' && result !== 'absent') return refused('entry')
      if (isOne(firstPartyIds, id)) return refused('reserved-id')
      if (read.hash === null) return refused('missing')
      if (read.problem !== null) return refused(read.problem)
      return { kind: 'found' }
    }
    // The tombstone wins over an entry beside it, which only a remove that stopped between the two writes or an edit of
    // the state leaves, since a restore clears the tombstone before it writes the entry
    if (isOne(firstPartyIds, id) && isOne(this.state.switches.removed, id)) return refused('removed')
    if (!entry.enabled) return { kind: 'off' }
    if (read.hash === null) return refused('missing')
    const dev = this.dev(id)
    if (!this.loose(id) && read.hash !== entry.contentHash) return refused('tampered')
    if (read.problem !== null) return refused(read.problem)
    if (isOne(firstPartyIds, id)) {
      const listed = this.install?.plugins[id]
      const own = entry.signer === FIRST_PARTY_SIGNER && listed?.firstParty === true && (dev || read.hash === listed.hash)
      if (!own) return refused('reserved-id')
    } else if (entry.signer === FIRST_PARTY_SIGNER) {
      return refused('signer')
    } else if (entry.signer === null && !dev && !isOne(this.state.switches.allowUnsigned, read.hash)) {
      return refused('unsigned')
    }
    if (this.requiresProblem(k)) return refused('requires')
    return k.held ?? ok
  }

  private rank(k: Known): number {
    if (k.from === 'folder') return FOLDER_RANK
    const at = (bootOrder as readonly string[]).indexOf(k.id)
    return at === -1 ? FOLDER_RANK - 1 : at
  }

  private verdictOf(k: Known): Verdict {
    return this.planned.verdicts.get(k.id) ?? { kind: 'found' }
  }

  // Whether a plugin should be running now
  private runs(k: Known): boolean {
    return !this.closing && this.phase !== 'stopped' && k.held === null && this.verdictOf(k).kind === 'start'
  }

  // ---- the plan and its states

  // Judges every plugin, resolves the graph and sets each state. Synchronous, so a crash has moved every dependent to
  // waiting before the carrier answers a call. The stops and starts it calls for follow in the pump
  private replan(): void {
    const nodes: Node[] = [...this.known.values()].map(k => ({
      id: k.id, status: this.status(k), requires: k.read.manifest?.requires ?? [], rank: this.rank(k),
    }))
    this.planned = plan(nodes)
    for (const k of this.known.values()) this.show(k)
    this.refresh()
    this.pump()
  }

  // The state a plugin shows for its verdict. A running one keeps its state while it should run. One that must stop
  // shows waiting at once when a requirement went, else stopping until it has stopped
  private show(k: Known): void {
    if (k.live !== null && this.runs(k)) return
    // Shutdown stops one plugin at a time in reverse graph order, so each keeps its state until its own stop begins.
    // A host half serves its roles until then and a plugin in its stop grace can still save
    if (this.closing && k.live !== null && k.live.stop === null) return
    const verdict = this.verdictOf(k)
    const shown = k.live === null ? this.final(k, verdict) : verdict.kind === 'waiting'
      ? { state: 'waiting' as const, reason: verdict.reason }
      : { state: 'stopping' as const, reason: this.stopReason(k) }
    if (shown.state === k.state && shown.reason === k.reason) return
    // Named now, while the plugins that stop with it still run, since they stop before it does
    if (shown.state === 'stopping' && k.live !== null) k.live.with = this.liveDependents(k)
    k.state = shown.state
    k.reason = shown.reason
    if (shown.state === 'waiting') {
      k.lastStop = shown.reason
      this.note('plugin.waiting', { plugin: k.id, reason: shown.reason })
    } else if (shown.state === 'refused') {
      this.note('plugin.refused', { plugin: k.id, reason: shown.reason })
    } else if (shown.state === 'found' && shown.reason === 'new') {
      this.note('plugin.found', { plugin: k.id })
      // A plugin found in the folder waits as a notice for the human's approval
      this.requests.raise({ kind: 'plugin.approve', plugin: k.id }, null, MAX_PENDING)
    }
  }

  private final(k: Known, verdict: Verdict): { state: PluginState, reason: string | null } {
    if (this.closing && verdict.kind === 'start') return { state: 'stopped', reason: 'shutdown' }
    if (this.phase === 'stopped' && verdict.kind === 'start') return { state: 'stopped', reason: 'control-failed' }
    switch (verdict.kind) {
      case 'start':
        return k.place === 'host' && k.ran ? { state: 'stopped', reason: 'restart-hetu' } : { state: 'found', reason: null }
      case 'found':
        return { state: 'found', reason: 'new' }
      case 'off':
        return { state: 'off', reason: 'off' }
      case 'refused':
      case 'waiting':
        return { state: verdict.kind, reason: verdict.reason }
      case 'held':
        return { state: verdict.state, reason: verdict.reason }
    }
  }

  private stopReason(k: Known): string {
    if (this.closing) return 'shutdown'
    if (k.held !== null) return k.held.reason
    const verdict = this.verdictOf(k)
    if (verdict.kind === 'refused' || verdict.kind === 'waiting') return verdict.reason
    if (verdict.kind === 'off') return 'off'
    return 'removed'
  }

  // Tells the carrier, records each slot that changed and sends deps to every plugin whose own requirements changed
  private refresh(): void {
    for (const id of this.expected()) {
      const now = this.slot(id)
      if (this.lastSlots.get(id) === now) continue
      this.lastSlots.set(id, now)
      // A slot reads failed to the carrier once its stop for shutdown began, so nothing passes unguarded. It didn't
      // fail, so its record says stopped. One that failed before its own stop began is recorded failed
      const state = this.known.get(id)?.state
      const stopped = this.closing && now === 'failed' && (state === 'stopping' || state === 'stopped')
      this.note('slot.state', { slot: id, state: stopped ? 'stopped' : now })
    }
    try {
      this.link.changed()
    } catch {}
    this.sendDeps()
    this.checkIdle()
  }

  // A plugin's own requires and plugin.call targets, as it may know them
  private depsOf(k: Known): Record<string, DepState> {
    const granted = k.from === 'install' ? k.read.manifest?.capabilities ?? [] : k.entry?.granted ?? []
    const targets = granted.flatMap(item => (item.type === 'plugin.call' ? item.targets : []))
    const deps: Record<string, DepState> = {}
    for (const id of [...new Set([...(k.read.manifest?.requires ?? []), ...targets])].sort()) {
      const other = this.known.get(id)
      const coming = other !== undefined && (other.state === 'starting' || (other.state === 'found' && this.verdictOf(other).kind === 'start'))
      deps[id] = other?.state === 'ready' ? 'ready' : coming ? 'starting' : 'unavailable'
    }
    return deps
  }

  private sendDeps(): void {
    for (const k of this.known.values()) {
      const live = k.live
      if (live === null || live.over || live.stop !== null) continue
      const deps = this.depsOf(k)
      const text = JSON.stringify(deps)
      if (text === live.deps) continue
      live.deps = text
      for (const run of live.halves.values()) this.link.send(run.caller, { v: VERSION, kind: 'deps', deps })
    }
  }

  private checkIdle(): void {
    if (this.pumping !== null || this.waiters.length === 0) return
    for (const k of this.known.values()) {
      if (k.state === 'starting' || k.live?.stop || this.startable(k)) return
    }
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  // ---- the pump: stops in reverse graph order, then starts in graph order

  private pump(): void {
    if (this.pumping !== null) {
      this.again = true
      return
    }
    this.pumping = this.turn().finally(() => {
      this.pumping = null
      if (this.again) this.pump()
      else this.checkIdle()
    })
  }

  private async turn(): Promise<void> {
    do {
      this.again = false
      try {
        for (const id of [...this.planned.order].reverse()) {
          const k = this.known.get(id)
          if (k?.live && !this.runs(k)) await this.halt(k)
        }
        this.startAll()
      } catch {}
    } while (this.again)
  }

  // Resolves once the pump has nothing left to do
  private async pumped(): Promise<void> {
    while (this.pumping !== null) await this.pumping
  }

  // One host half at a time in order. Sandboxed plugins start only once the host tier has settled
  private startAll(): void {
    if (this.closing) return
    for (const id of this.planned.order) {
      const k = this.known.get(id)
      if (k === undefined || !this.startable(k)) continue
      if (k.place === 'host' ? this.hostStarting() : this.hostPending()) continue
      this.begin(k)
    }
  }

  private startable(k: Known): boolean {
    if (k.live !== null || !this.runs(k) || (k.place === 'host' && k.ran)) return false
    if (this.phase === 'controls' && !(k.from === 'install' && isSecurityControl(k.id))) return false
    return (k.read.manifest?.requires ?? []).every(id => this.known.get(id)?.state === 'ready')
  }

  private hostStarting(): boolean {
    return [...this.known.values()].some(k => k.place === 'host' && k.state === 'starting')
  }

  private hostPending(): boolean {
    return [...this.known.values()].some(k => k.place === 'host' && (k.state === 'starting' || this.startable(k)))
  }

  // ---- starting

  private begin(k: Known): void {
    const n = (this.minted.get(k.id) ?? 0) + 1
    this.minted.set(k.id, n)
    k.incarnations = n
    const live: Live = {
      n, halves: new Map(), exports: null, imported: false, readyTimer: null, stopTimer: null, stop: null, beat: null,
      with: [], over: false, deps: '', marked: false,
    }
    k.live = live
    k.state = 'starting'
    k.reason = null
    if (k.place === 'host') k.ran = true
    this.refresh()
    void this.launch(k, live)
  }

  private async launch(k: Known, live: Live): Promise<void> {
    try {
      if (k.updated !== null) await this.applyInstalled(k)
      if (live.over) return
      // Written before start and removed at ready, so a host half that freezes main here is held failed next boot. One
      // whose start ended before its module ran couldn't have frozen anything, so its marker goes
      if (k.place === 'host') {
        // The marker counts as on disk once its write settled, so a stop that came during the write leaves its removal
        // to here
        await this.tracked((async () => {
          await writeMarker(this.dataDir, k.id).catch(() => this.note('fault', { plugin: k.id, step: 'marker' }))
          live.marked = true
          if (live.over) await this.unmark(k, live)
        })())
        if (live.over) return
      }
      this.mint(k, live)
    } catch {
      if (!live.over) this.die(k, 'start-failed')
    }
  }

  // An app update to an install plugin: once plugin.updated has landed its cache is cleared and it hears the version
  // it replaced. A record that never lands leaves the marker as it was, so the next start tries again
  private async applyInstalled(k: Known): Promise<void> {
    const from = k.updated!
    const landing = await this.landing(k.id, 'plugin.updated', { plugin: k.id, from, to: k.listed!.version })
    if (landing === 'lost') return
    k.updated = null
    await this.clearSpace('cache', k.id).catch(() => this.note('fault', { plugin: k.id, step: 'cache' }))
    k.previousVersion = from
    await this.saveInstalled()
  }

  // Mints each half's port or handle and registers it with the carrier in the same step, starts the half from the
  // verified bytes and sends init down its way. ready must come within readyMs
  private mint(k: Known, live: Live): void {
    const manifest = k.read.manifest!
    const { host, worker } = manifest.entries
    live.readyTimer = setTimeout(() => {
      if (!live.over && k.live === live && k.state === 'starting') this.die(k, 'start-timeout')
    }, this.limitOf(k.id, 'readyMs'))
    live.readyTimer.unref?.()
    const caller = (half: HalfName): Caller => frozen({ kind: 'plugin', id: k.id, half, incarnation: live.n })

    if (host !== undefined) {
      const run: Run = { caller: caller('host'), ready: false, stopped: false }
      const box = mailbox()
      const way = this.link.handle(run.caller, message => box.put(message))
      live.halves.set('host', run)
      const started = this.runtime.startHost({
        id: k.id, incarnation: live.n, root: k.root, files: k.read.files, entry: host, link: { post: way.post, listen: box.listen },
      })
      Promise.resolve(started).then(exports => {
        if (live.over) return
        live.exports = exports ?? {}
        live.imported = true
        this.readied(k, live)
      }, () => {
        if (!live.over) this.die(k, 'start-failed')
      })
    } else {
      live.imported = true
    }

    if (worker !== undefined) {
      const run: Run = { caller: caller('worker'), ready: false, stopped: false }
      const { core, plugin } = this.runtime.channel(k.id)
      this.link.register(core, run.caller)
      live.halves.set('worker', run)
      const code = k.read.files.find(file => file.path === worker)!.bytes
      const drawer = this.grantsOf(k.id).some(granted => granted.type.startsWith('ui.'))
      const view = drawer ? { files: k.read.files, frames: { ...k.read.manifest?.entries.frames } } : {}
      this.runtime.startWorker({ id: k.id, incarnation: live.n, code, port: plugin, drawer, ...view })
    }

    const deps = this.depsOf(k)
    live.deps = JSON.stringify(deps)
    const init: Init = {
      v: VERSION, kind: 'init', id: k.id, incarnation: live.n, api: API_VERSION, deps, lastStop: k.lastStop,
      previousVersion: k.previousVersion,
    }
    // An install host half runs in main with Node, so the data folder is no secret from it: storage keeps its spaces
    // there and later host plugins their working folders. A worker never hears it
    for (const [half, run] of live.halves) {
      const own = half === 'host' && k.from === 'install' ? { ...init, dataDir: this.dataDir } : init
      this.link.send(run.caller, own)
    }
    // A plugin with no half to start, frames or a page only, is ready once checked
    this.readied(k, live)
  }

  private readied(k: Known, live: Live): void {
    if (live.over || k.live !== live || k.state !== 'starting') return
    if (!live.imported || [...live.halves.values()].some(run => !run.ready)) return
    if (live.readyTimer !== null) clearTimeout(live.readyTimer)
    live.readyTimer = null
    // A security control with no role to play would refuse everything while reading as up, so it fails here
    const role = roleOf[k.id]
    if (k.from === 'install' && role !== undefined && live.exports?.[role] === undefined) return this.die(k, 'no-role')
    // The gate has the StateView before it answers anything, the luoshu and history their folder and exec its view
    // of the grants. A throw marks that one failed
    if (k.id === 'gate' && k.from === 'install' && !this.pushTo(k)) return
    if (k.id === 'luoshu' && k.from === 'install' && !this.openLuoshu(k)) return
    if (k.id === 'history' && k.from === 'install' && !this.openHistory(k)) return
    if (k.id === 'exec' && k.from === 'install' && !this.pushExec(k)) return
    k.state = 'ready'
    k.reason = null
    k.previousVersion = null
    this.versions.delete(k.id)
    this.note('plugin.started', { plugin: k.id, incarnation: live.n })
    this.beat(k, live)
    void this.unmark(k, live)
    this.replan()
  }

  // ---- stopping

  // A planned stop of one incarnation: stop down every half, then the way ends once each answered stopped or the grace
  // ran out. The pump calls it in reverse graph order, so dependents stop first
  private halt(k: Known): Promise<void> {
    const live = k.live!
    if (live.stop !== null) return live.stop.done
    let end!: () => void
    const done = new Promise<void>(resolve => {
      end = resolve
    })
    live.stop = { done, end, reason: this.stopReason(k) }
    this.show(k)
    this.refresh()
    const graceMs = this.limitOf(k.id, 'stopGraceMs')
    for (const run of live.halves.values()) this.link.send(run.caller, { v: VERSION, kind: 'stop', graceMs })
    if (live.halves.size === 0) {
      this.finished(k, live)
    } else {
      live.stopTimer = setTimeout(() => this.finished(k, live), graceMs)
      live.stopTimer.unref?.()
    }
    return done
  }

  // The plugins that stop with this one: every running plugin that requires it, directly or through another
  private liveDependents(k: Known): string[] {
    const seen = new Set<string>([k.id])
    const out: string[] = []
    const queue = [k.id]
    while (queue.length > 0) {
      const id = queue.shift()!
      for (const other of this.known.values()) {
        if (seen.has(other.id) || !(other.read.manifest?.requires ?? []).includes(id)) continue
        seen.add(other.id)
        queue.push(other.id)
        if (other.live !== null) out.push(other.id)
      }
    }
    return out.sort()
  }

  // A planned stop ran in a main that wasn't frozen, so a start it ended before ready leaves no marker
  private finished(k: Known, live: Live): void {
    if (live.over) return
    const stop = live.stop
    const reason = stop?.reason ?? this.stopReason(k)
    void this.unmark(k, live)
    this.retire(k, live)
    k.lastStop = reason
    this.note('plugin.stopped', { plugin: k.id, incarnation: live.n, reason, with: live.with.join(',') })
    this.replan()
    this.release(k, live, 'stopped')
    stop?.end()
  }

  // A crash or a failed host half. The states change first, every dependent waiting, then the ways end, so no call is
  // answered before the dependents moved
  private die(k: Known, reason: string): void {
    const live = k.live
    if (live === null || live.over) return
    if (live.stop !== null) return this.finished(k, live)
    this.retire(k, live)
    const state = k.place === 'host' ? 'failed' : 'crashed'
    k.held = { kind: 'held', state, reason }
    k.lastStop = reason
    this.note(`plugin.${state}`, { plugin: k.id, incarnation: live.n, reason })
    this.replan()
    this.release(k, live, 'crashed')
    if (k.from === 'install' && isSecurityControl(k.id)) this.controlFailed(k.id, reason)
  }

  // A ping down the worker's port every heartbeatMs. heartbeatMisses unanswered in a row read unresponsive: calls to it
  // time out at once and its dependents keep running, nothing is closed. It reads ready again once it answers. Stopping
  // it is the watchdog's or the human's call. Host halves get none, a host half that hangs holds main itself
  private beat(k: Known, live: Live): void {
    const worker = live.halves.get('worker')
    if (worker === undefined) return
    const misses = this.limitOf(k.id, 'heartbeatMisses')
    const timer = setInterval(() => {
      const beat = live.beat
      if (beat === null || live.over) return
      if (beat.waiting) beat.misses++
      if (beat.misses >= misses && k.state === 'ready' && live.stop === null) {
        k.state = 'unresponsive'
        this.note('plugin.unresponsive', { plugin: k.id, incarnation: live.n })
        this.refresh()
      }
      beat.waiting = true
      this.link.send(worker.caller, { v: VERSION, kind: 'ping' })
    }, this.limitOf(k.id, 'heartbeatMs'))
    timer.unref?.()
    live.beat = { timer, misses: 0, waiting: false }
  }

  private retire(k: Known, live: Live): void {
    if (live.beat !== null) clearInterval(live.beat.timer)
    live.beat = null
    live.over = true
    if (live.readyTimer !== null) clearTimeout(live.readyTimer)
    if (live.stopTimer !== null) clearTimeout(live.stopTimer)
    live.readyTimer = null
    live.stopTimer = null
    if (k.live === live) k.live = null
  }

  // Ends the worker and revokes the incarnation's ways, so nothing it sends counts again
  private release(k: Known, live: Live, code: 'stopped' | 'crashed'): void {
    for (const run of live.halves.values()) {
      try {
        this.link.end(run.caller, code)
      } catch {}
    }
    if (live.halves.has('worker')) {
      try {
        this.runtime.terminate(k.id, live.n)
      } catch {}
    }
  }

  // ---- stops and restarts the watchdog or the human asked for

  // Stops a plugin and its dependents, dependents first. It stays stopped until a restart
  async stop(id: string, by: 'watchdog' | 'human'): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw { code: 'not-found' }
    if (k.held === null) k.held = { kind: 'held', state: 'stopped', reason: by }
    this.replan()
    await this.pumped()
  }

  // A new incarnation from the bytes already verified. A running one stops first with its dependents, which start again
  // once it is ready. Only a sandboxed plugin restarts within a run
  async restart(id: string, by: 'watchdog' | 'human'): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw { code: 'not-found' }
    if (k.place === 'host') throw { code: 'not-granted' }
    if (this.closing) throw { code: 'stopped' }
    if (k.live !== null) await this.stop(id, by)
    k.held = null
    this.replan()
    const verdict = this.verdictOf(k)
    if (verdict.kind === 'off') throw { code: 'switched-off' }
    if (verdict.kind !== 'start') throw { code: 'unavailable' }
    await this.pumped()
  }

  // ---- the state

  // A security request from a window: a narrowing change applies at once, a widening or destroying one waits for the
  // trusted window's Confirm. The carrier has checked the caller is a window
  request(input: unknown, from: Caller): Promise<RequestAnswer> {
    const parsed = changeSchema.safeParse(input)
    if (!parsed.success) return Promise.reject({ code: 'invalid' })
    return this.requests.request(parsed.data, from)
  }

  // The trusted window's Confirm of a held request, with what the human typed where the change asks for it
  confirm(id: string, options: { typed?: string }): Promise<void> {
    return this.requests.confirm(id, options)
  }

  cancel(id: string): Promise<void> {
    return this.requests.cancel(id)
  }

  pending(): PendingRequest[] {
    return this.requests.pending()
  }

  // The prompt behind the gate's ask: an item.on held for the item a plugin's call asked to use for the first time,
  // which the human opens from its notice. ask is the item's key as the gate gave it. Only a plugin's item whose first
  // use asks can be raised, one open per plugin within firstUseAsks
  readonly asks: Asks = {
    raise: (ask, access): string | AskRefusal => {
      const { caller } = access
      if (caller.kind !== 'plugin') return { code: 'not-granted' }
      const entry = this.known.get(caller.id)?.entry ?? null
      const item = entry?.firstUse?.find(asked => capabilityKey(asked) === ask)
      if (entry === null || item === undefined || !entry.granted.some(granted => capabilityKey(granted) === ask)) return { code: 'not-granted' }
      if (this.declinedAsks.has(`${caller.id}
${ask}`)) return { code: 'not-granted', reason: 'declined' }
      return this.requests.raise({ kind: 'item.on', plugin: caller.id, capability: item }, caller.id, this.link.limit(caller.id, 'firstUseAsks'))
    },
  }

  // Applies a change exactly as stored through the one StateStore. A write that fails applies nothing. Each applied
  // change raises the StateView by one. Requests reach it through the Confirm, tests and the loader's own reconcile
  // directly
  apply(input: Change): Promise<void> {
    return this.serial(() => this.applyNow(changeSchema.parse(input)))
  }

  // One change or update at a time, so no two read the state and write it back over each other
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => {})
    return run
  }

  private async applyNow(change: Change): Promise<void> {
    // The human chose in the stopped mode, so the next failure restarts hetu again
    if (this.phase === 'stopped') await clearFailedOnce(this.dataDir).catch(() => {})
    switch (change.kind) {
      case 'plugin.on':
      case 'plugin.off':
        return this.switchPlugin(change.plugin, change.kind === 'plugin.on')
      case 'plugin.approve':
        return this.approve(change.plugin)
      case 'plugin.remove':
        return this.remove(change.plugin)
      case 'plugin.restore':
        return this.restore(change.plugin)
      case 'plugin.update':
        return this.applyStaged(change.plugin)
      case 'devMode':
        return this.writeSwitches({ ...this.state.switches, devMode: toggled(this.state.switches.devMode, change.plugin, change.on) })
      case 'exec.anyCommand':
        return this.writeSwitches({
          ...this.state.switches, execAnyCommand: toggled(this.state.switches.execAnyCommand, change.plugin, change.on),
        })
      case 'skipVerification':
        return this.writeSwitches({ ...this.state.switches, skipVerification: change.on })
      case 'confirmOff':
        return this.writeSwitches({ ...this.state.switches, confirmOff: change.on })
      // Step 14 writes the change's own record before recording stops and after it starts again
      case 'recordNothing':
        return this.writeSwitches({ ...this.state.switches, recordNothing: change.on })
      case 'allowUnsigned':
        return this.writeSwitches({ ...this.state.switches, allowUnsigned: toggled(this.state.switches.allowUnsigned, change.hash, change.on) })
      case 'limit.set': {
        const { limits } = this.state.switches
        const all = bare({ ...limits.all })
        const plugins = bare({ ...limits.plugins })
        if (change.plugin === null) all[change.constant] = change.value
        else plugins[change.plugin] = bare({ ...plugins[change.plugin], [change.constant]: change.value })
        return this.writeSwitches({ ...this.state.switches, limits: { all, plugins } })
      }
      case 'luoshu.set': {
        await this.store.writeLuoshu({ folder: change.folder })
        this.state = { ...this.state, luoshu: { folder: change.folder } }
        // A luoshu not ready yet takes the folder when it is, and so does history. exec gets it with the bump
        const luoshu = this.known.get('luoshu')
        if (luoshu?.from === 'install' && luoshu.state === 'ready') this.openLuoshu(luoshu)
        const history = this.known.get('history')
        if (history?.from === 'install' && history.state === 'ready') this.openHistory(history)
        return this.bump()
      }
      case 'item.on':
      case 'item.off':
        return this.switchItem(change.plugin, change.capability, change.kind === 'item.on')
      case 'grant.widen':
      case 'grant.narrow':
        return this.grant(change.plugin, change.capability, change.kind === 'grant.widen')
      case 'plugin.clearStorage':
        return this.clearStorage(change.plugin)
      case 'plugin.reset':
        return this.reset(change.plugin)
    }
  }

  // A capability added to a folder plugin's entry or taken out with its switch. Adding one it holds changes nothing
  private async grant(id: string, capability: Capability, add: boolean): Promise<void> {
    const k = this.known.get(id)
    const entry = k?.from === 'folder' ? k.entry : null
    if (entry === null) throw new Error(`no plugin entry for ${id}`)
    const key = capabilityKey(capability)
    const has = entry.granted.some(granted => capabilityKey(granted) === key)
    if (add && has) return
    const granted = add ? [...entry.granted, capability] : entry.granted.filter(item => capabilityKey(item) !== key)
    const changed: Plugin = { ...entry, granted }
    if (entry.off !== undefined) changed.off = entry.off.filter(item => capabilityKey(item) !== key)
    // Classed whole as any other entry is, since one item's ask rests on every item and every link: a widened read makes
    // the plugin's own network ask. A widen is asked for on a Confirm, a narrow applies at once
    const change = this.changeOf(add ? 'widen' : 'narrow', id, changed, add)
    const next = change.own.entry!
    await this.settle(change.others, true)
    await this.store.writePlugin(id, next)
    this.putEntry(id, next)
    await this.settle(change.others, false)
    this.bump()
  }

  // A running plugin stops while what it keeps is cleared, then starts again as a new incarnation
  private async stoppedWhile<T>(k: Known, work: () => Promise<T>): Promise<T> {
    const running = k.live !== null
    if (running) {
      k.held = { kind: 'held', state: 'stopped', reason: 'update' }
      this.replan()
      await this.pumped()
    }
    try {
      return await work()
    } finally {
      if (running && k.held?.reason === 'update') k.held = null
      this.replan()
    }
  }

  private async clearStorage(id: string): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw new Error(`no plugin ${id}`)
    await this.stoppedWhile(k, () => this.clearSpace('storage', id))
  }

  // Recover's reset: storage, cache and start marker cleared. A folder plugin's entry goes, so it waits for approval
  // again with the code it has. An install plugin waits for Restart hetu, since a host half starts once per run and
  // the reset may follow a start that froze main
  private async reset(id: string): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw new Error(`no plugin ${id}`)
    await this.stoppedWhile(k, async () => {
      for (const kind of ['storage', 'cache'] as const) await this.clearSpace(kind, id)
      await removeMarker(this.dataDir, id)
      this.markers.delete(id)
      // A limit the human set for the plugin goes too, since one too low makes it fail again at every start
      const { limits } = this.state.switches
      if (Object.hasOwn(limits.plugins, id)) {
        const plugins = bare({ ...limits.plugins })
        delete plugins[id]
        await this.writeSwitches({ ...this.state.switches, limits: { all: limits.all, plugins } })
      }
      if (k.from === 'folder' && k.entry !== null) {
        const change = this.changeOf('reset', id, null, true)
        await this.settle(change.others, true)
        await this.store.removePlugin(id)
        delete this.state.plugins[id]
        await this.settle(change.others, false)
        this.entryChecks.set(id, 'absent')
        k.entry = null
        this.bump()
      }
    })
    if (k.from === 'install') k.held = { kind: 'held', state: 'stopped', reason: 'restart-hetu' }
    this.replan()
  }

  // The lists hold ids as plain strings here. The store parses the whole value against the switches' schema before it
  // writes, so what is kept after a write that worked has that shape
  private async writeSwitches(next: { [K in keyof Switches]: unknown }): Promise<void> {
    await this.store.writeSwitches(next)
    this.state = { ...this.state, switches: next as Switches }
    this.bump()
    this.replan()
  }

  // One applied change: a new StateView pushed to the gate, exec's view of the grants renewed with it and the carrier
  // told
  private bump(): void {
    this.n++
    const gate = this.known.get('gate')
    if (gate !== undefined && gate.from === 'install' && gate.state === 'ready') this.pushTo(gate)
    const exec = this.known.get('exec')
    if (exec !== undefined && exec.from === 'install' && exec.state === 'ready') this.pushExec(exec)
    this.refresh()
  }

  // One item a folder plugin was granted switched on or off. An install plugin's grants are its manifest, so it has
  // no entry to hold a switch
  private async switchItem(id: string, capability: Capability, on: boolean): Promise<void> {
    const k = this.known.get(id)
    const entry = k?.from === 'folder' ? k.entry : null
    if (k === undefined || entry === null) throw new Error(`no plugin entry for ${id}`)
    const key = capabilityKey(capability)
    const item = entry.granted.find(granted => capabilityKey(granted) === key)
    if (item === undefined) throw new Error(`${id} wasn't granted that item`)
    const others = (entry.off ?? []).filter(off => capabilityKey(off) !== key)
    const next: Plugin = { ...entry, off: on ? others : [...others, item] }
    // Switching on an item that asks is the human's Confirm of its first use too, which the entry records
    if (on && (entry.firstUse ?? []).some(asked => capabilityKey(asked) === key)) {
      next.firstUse = entry.firstUse!.filter(asked => capabilityKey(asked) !== key)
      if (!(entry.confirmed ?? []).some(done => capabilityKey(done) === key)) next.confirmed = [...entry.confirmed ?? [], item]
    }
    await this.store.writePlugin(id, next)
    this.putEntry(id, next)
    this.bump()
  }

  // Each plugin's grants as the gate judges them, copied so freezing them leaves the loader's own alone. A folder
  // plugin's come from its entry in the state, which boot loaded before the gate's first StateView and before the plugin
  // folder is scanned. An install plugin's come from its manifest, read before the host tier starts. An item the entry
  // switched off is off. An item in the entry's firstUse list asks at its first use, except while the human has the
  // capabilities plugin switched off, when nothing asks. An install plugin's items never ask
  private stateView(): StateView {
    const asks = this.classing() !== 'off'
    const plugins: Record<string, readonly GrantedItem[]> = Object.create(null)
    const items = (granted: readonly Capability[], switchedOff: readonly Capability[], asking: readonly Capability[] = []) => {
      const off = new Set(switchedOff.map(capabilityKey))
      const firstUse = new Set(asking.map(capabilityKey))
      return granted.map(capability => {
        const key = capabilityKey(capability)
        return { capability: structuredClone(capability), off: off.has(key), firstUse: firstUse.has(key) }
      })
    }
    // A plugin the human switched off holds nothing from the change on, so a call it makes in its stop grace passes on
    // no grant
    for (const [id, entry] of Object.entries(this.state.plugins)) {
      if (this.known.get(id)?.from === 'install' || !entry.enabled || entry.granted.length === 0) continue
      plugins[id] = items(entry.granted, entry.off ?? [], asks ? entry.firstUse ?? [] : [])
    }
    for (const k of this.known.values()) {
      const granted = k.from === 'install' && !isOne(this.state.switches.off, k.id) ? k.read.manifest?.capabilities ?? [] : []
      if (granted.length > 0) plugins[k.id] = items(granted, [])
    }
    return frozen({ n: this.n, foldCase: false, plugins, execAny: [...this.state.switches.execAnyCommand] })
  }

  // The folder in the state and hetu's own folders, which the luoshu refuses to reach into
  private opening(): Opening {
    return { folder: this.state.luoshu?.folder ?? null, dataDir: this.dataDir, installDir: this.installDir }
  }

  private openLuoshu(luoshu: Known): boolean {
    const target = luoshu.live?.exports?.luoshu
    if (target === undefined) return true
    try {
      target.open(this.trash === undefined ? this.opening() : { ...this.opening(), trash: this.trash })
      return true
    } catch {
      this.die(luoshu, 'state-changed')
      return false
    }
  }

  // History reads the notes it commits from the same folder
  private openHistory(history: Known): boolean {
    const target = history.live?.exports?.history
    if (target === undefined) return true
    try {
      target.open(this.opening())
      return true
    } catch {
      this.die(history, 'state-changed')
      return false
    }
  }

  // What exec checks a command against on its own, read from the StateView: each plugin's exec items that are on. Exec
  // keeps this list with the gate off, so an item the human switched off leaves it, or the command would run again
  // exactly when the gate isn't there to refuse it. With them the plugins the human let run any command and the folders
  // no command may run code from. Read-only
  private execView(): ExecView {
    const plugins: Record<string, ExecGrant[]> = Object.create(null)
    for (const [id, items] of Object.entries(this.stateView().plugins)) {
      const held: ExecGrant[] = []
      for (const { capability, off } of items) {
        if (capability.type === 'exec' && !off) held.push({ commands: capability.commands.map(command => [...command]), env: [...capability.env] })
      }
      if (held.length > 0) plugins[id] = held
    }
    return frozen({ plugins, any: [...this.state.switches.execAnyCommand], opening: this.opening() })
  }

  private pushExec(exec: Known): boolean {
    const target = exec.live?.exports?.exec
    if (target === undefined) return true
    try {
      target.stateChanged(this.execView())
      return true
    } catch {
      this.die(exec, 'state-changed')
      return false
    }
  }

  private pushTo(gate: Known): boolean {
    const target = gate.live?.exports?.gate
    if (target === undefined) return true
    try {
      target.stateChanged(this.stateView())
      return true
    } catch {
      this.die(gate, 'state-changed')
      return false
    }
  }

  private putEntry(id: string, entry: Plugin): void {
    this.state.plugins[id] = entry
    this.entryChecks.set(id, 'ok')
    const k = this.known.get(id)
    if (k !== undefined) k.entry = entry
  }

  private async switchPlugin(id: string, on: boolean): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw new Error(`no plugin ${id}`)
    if (k.from === 'install') {
      await this.writeSwitches({ ...this.state.switches, off: toggled(this.state.switches.off, id, !on) })
      // A switch-off is the way out of a start marker, so the half starts fresh once switched on again
      if (!on && k.held?.reason === 'marker') {
        await removeMarker(this.dataDir, id).catch(() => {})
        k.held = null
        this.replan()
      }
      return
    }
    if (k.entry === null) throw new Error(`no entry for ${id}`)
    const entry = { ...k.entry, enabled: on }
    await this.store.writePlugin(id, entry)
    this.putEntry(id, entry)
    // The human switching a plugin on is the human's restart of it
    if (on) k.held = null
    this.bump()
    this.replan()
  }

  // The entry from the one read the request was made on: its hash, version and the manifest's grants
  private async approve(id: string): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'folder' || k.entry !== null || this.status(k).kind !== 'found') {
      throw new Error(`nothing to approve for ${id}`)
    }
    const change = this.changeOf('approve', id, this.approval(k), true)
    const entry = change.own.entry!
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.putEntry(id, entry)
    await this.settle(change.others, false)
    this.bump()
    this.replan()
  }

  // The entry goes first so nothing can run, then the plugin stops with its dependents, then its code, storage and
  // cache. A first-party plugin leaves a tombstone, written before anything else
  private async remove(id: string): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'folder') throw new Error(`${id} is not a plugin-folder plugin`)
    const change = this.changeOf('remove', id, null, true)
    await this.settle(change.others, true)
    if (isOne(firstPartyIds, id) && !isOne(this.state.switches.removed, id)) {
      await this.writeSwitches({ ...this.state.switches, removed: [...this.state.switches.removed, id] })
    }
    await this.store.removePlugin(id)
    delete this.state.plugins[id]
    await this.settle(change.others, false)
    // What the human let this plugin do goes with it, so a plugin added later under the id asks again
    const { switches } = this.state
    const plugins = bare({ ...switches.limits.plugins })
    delete plugins[id]
    if (isOne(switches.execAnyCommand, id) || isOne(switches.devMode, id) || id in switches.limits.plugins) {
      await this.writeSwitches({
        ...switches,
        execAnyCommand: switches.execAnyCommand.filter(held => held !== id),
        devMode: switches.devMode.filter(held => held !== id),
        limits: { all: switches.limits.all, plugins },
      })
    }
    this.entryChecks.set(id, 'absent')
    k.entry = null
    k.held = { kind: 'held', state: 'stopped', reason: 'removed' }
    this.bump()
    this.replan()
    await this.pumped()
    await clear(folders.plugins(this.dataDir, id)).catch(() => this.note('fault', { plugin: id, step: 'remove' }))
    for (const kind of ['storage', 'cache'] as const) await this.clearSpace(kind, id).catch(() => this.note('fault', { plugin: id, step: 'remove' }))
    this.known.delete(id)
    this.replan()
  }

  // Copies the install's bytes again and clears the tombstone. Never over a community plugin holding the id
  private async restore(id: string): Promise<void> {
    const read = this.bundled.get(id)
    const listed = this.install?.plugins[id]
    if (read === undefined || listed === undefined || read.problem !== null || read.hash !== listed.hash) {
      throw new Error(`no install copy of ${id} to restore`)
    }
    const entry = this.state.plugins[id] ?? null
    if (entry !== null && entry.signer !== FIRST_PARTY_SIGNER) throw new Error(`${id} is held by another plugin`)
    if (isOne(this.state.switches.removed, id)) {
      await this.writeSwitches({ ...this.state.switches, removed: this.state.switches.removed.filter(other => other !== id) })
    }
    const k = this.known.get(id)
    if (k?.live) {
      k.held = { kind: 'held', state: 'stopped', reason: 'update' }
      this.replan()
      await this.pumped()
    }
    const copied = await this.copy(id, read, listed, 'restore', entry?.enabled ?? true, entry?.version ?? null)
    if (!copied) throw new Error('the restore record did not land')
    const now = this.know(id, 'folder', folders.plugins(this.dataDir, id), read, null, this.state.plugins[id])
    if (k !== undefined) now.lastStop = k.lastStop
    this.replan()
  }

  // ---- staged updates

  // An update staged beside the old version, resolved against the live graph before anything changes. One that closes
  // a cycle is refused, and so is a version that isn't newer, so an old release with a known hole can't be swapped
  // back in. Every other one waits for the human's Confirm, raised as plugin.update naming the running plugins it
  // stops, itself and its dependents included: only a class 0 update may load on its own and nothing reads a plugin's
  // class before the capabilities plugin does. The signer is checked against the pin once provenance exists. A
  // first-party copy changes only with the install
  update(id: string, dir: string): Promise<UpdateOutcome> {
    // No plugin starts once shutdown began, so an update has nothing to restart into
    if (this.closing) return Promise.reject({ code: 'stopped' })
    return this.serial(() => this.updateNow(id, dir))
  }

  private async updateNow(id: string, dir: string): Promise<UpdateOutcome> {
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'folder' || k.entry === null) return { outcome: 'refused', reason: 'missing' }
    if (isOne(firstPartyIds, id)) return { outcome: 'refused', reason: 'reserved-id' }
    const read = await readPlugin(dir, id, 'folder')
    if (read.problem !== null) return { outcome: 'refused', reason: read.problem }
    if (!isNewer(read.manifest!.version, k.entry.version)) return { outcome: 'refused', reason: 'not-newer' }
    const nodes: Node[] = [...this.known.values()].map(other => {
      const entry = { ...k.entry!, contentHash: read.hash!, version: read.manifest!.version }
      const next = other === k ? { ...k, read, entry, held: null } : other
      return { id: other.id, status: this.status(next), requires: next.read.manifest?.requires ?? [], rank: this.rank(other) }
    })
    const after = plan(nodes)
    const verdict = after.verdicts.get(id)!
    if (verdict.kind === 'refused' && verdict.reason === 'cycle') return { outcome: 'refused', reason: 'cycle' }
    const stopping = new Set([...this.known.values()]
      .filter(other => other.live !== null && after.verdicts.get(other.id)?.kind !== 'start')
      .map(other => other.id))
    // Applying stops the running incarnation with what requires it before the new one starts
    if (k.live !== null) for (const other of [id, ...this.liveDependents(k)]) stopping.add(other)
    const stops = [...stopping].sort()
    this.staged.set(id, { dir, read })
    // Only a class 0 update loads on its own, and only while the slot can say so, with no grant asked for that the
    // entry doesn't hold and none that always asks. Its record lands first as any update's does
    const holds = new Set(k.entry.granted.map(capabilityKey))
    const asksNothingNew = (read.manifest!.capabilities ?? []).every(item => holds.has(capabilityKey(item)))
    const alwaysAsks = k.entry.granted.some(item => isOne(askOnUpdateTypes, item.type))
    const now = this.decide({ id, before: k.entry, after: k.entry, cause: 'update', confirm: false })
    if (k.entry.class === 0 && asksNothingNew && !alwaysAsks && now.slot === 'on' && now.entry?.class === 0) {
      await this.applyStaged(id, false)
      return { outcome: 'applied' }
    }
    // A newer update replaces the staged one, so the request the human may have seen for the older one goes
    this.requests.withdraw(change => change.kind === 'plugin.update' && change.plugin === id)
    this.requests.raise({ kind: 'plugin.update', plugin: id }, null, MAX_PENDING)
    return { outcome: 'confirm', stops }
  }

  // Once plugin.updated has landed: the folder swapped, the entry written last, then the old incarnation stops with its
  // dependents and the new one starts. A crash between the swap and the entry leaves bytes the entry doesn't name,
  // which the next boot reads as a failed check. A failed write leaves the old incarnation running on the bytes it was
  // started from. The plugin keeps its old entry in memory until it runs the new bytes, so the old incarnation is never
  // judged against the new hash. Only a class 0 update that applies on its own has no Confirm
  private async applyStaged(id: string, confirm = true): Promise<void> {
    const staged = this.staged.get(id)
    const k = this.known.get(id)
    if (staged === undefined || k === undefined || k.entry === null) throw new Error(`no update staged for ${id}`)
    this.staged.delete(id)
    const { read } = staged
    const old = k.entry
    const to = read.manifest!.version
    const landing = await this.landing(id, 'plugin.updated', { plugin: id, from: old.version, to })
    if (landing === 'lost') throw new Error('the update record did not land')
    // The bytes that were hashed go in, staged again from memory, never the folder they were read from, which may have
    // changed while the Confirm waited. That folder goes once applied, when it sits in hetu's own staging
    await swapIn(this.dataDir, id, await stage(this.dataDir, id, read.files))
    const relative = path.relative(folders.staging(this.dataDir), staged.dir)
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) await clear(staged.dir).catch(() => {})
    const change = this.changeOf('update', id, { ...old, version: to, contentHash: read.hash! }, confirm)
    const entry = change.own.entry!
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.state.plugins[id] = entry
    this.entryChecks.set(id, 'ok')
    await this.settle(change.others, false)
    if (k.live !== null) {
      k.held = { kind: 'held', state: 'stopped', reason: 'update' }
      this.replan()
      await this.pumped()
    }
    if (old.version !== to) {
      await this.clearSpace('cache', id).catch(() => this.note('fault', { plugin: id, step: 'cache' }))
      k.previousVersion = old.version
    }
    k.entry = entry
    k.read = read
    k.place = placeOf(read, 'folder')
    if (k.held?.reason === 'update') k.held = null
    this.bump()
    this.replan()
  }

  // ---- helpers

  private runOf(caller: Caller): { k: Known, live: Live, run: Run } | null {
    if (caller?.kind !== 'plugin') return null
    const k = this.known.get(caller.id)
    const live = k?.live
    if (k === undefined || live === null || live === undefined || live.over || live.n !== caller.incarnation) return null
    const run = live.halves.get(caller.half as HalfName)
    return run === undefined ? null : { k, live, run }
  }

  private limitOf(id: string, name: FloorConstant): number {
    let value: number = floorConstants[name]
    try {
      const given = this.link.limit(id, name)
      if (Number.isSafeInteger(given) && given > 0) value = given
    } catch {}
    return Math.min(value, MAX_TIMER_MS)
  }

  // Nothing goes to the carrier while the human turned recording off. What waited on a record applies at once
  private record(event: string, fields: Record<string, string | number | boolean | null>): Promise<'landed' | 'muted' | 'lost'> {
    if (this.state.switches.recordNothing) return Promise.resolve('muted')
    try {
      return Promise.resolve(this.link.record(event, fields)).catch(() => 'lost' as const)
    } catch {
      return Promise.resolve('lost')
    }
  }

  // A record a change waits on, for at most the plugin's readyMs, so a log that can't write never holds a start or
  // the change queue behind it. Past that the wait gives up and the record counts as lost: the lane takes it out if
  // it still waits, so the log never shows a change that didn't apply. One whose write was under way may land late
  private async landing(plugin: string, event: string, fields: Record<string, string | number | boolean | null>): Promise<'landed' | 'muted' | 'lost'> {
    if (this.state.switches.recordNothing) return 'muted'
    const giveUp = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const due = new Promise<'lost'>(resolve => {
      timer = setTimeout(() => {
        giveUp.abort()
        resolve('lost')
      }, this.limitOf(plugin, 'readyMs'))
      timer.unref?.()
    })
    try {
      return await Promise.race([Promise.resolve(this.link.record(event, fields, giveUp.signal)).catch(() => 'lost' as const), due])
    } catch {
      return 'lost'
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  // Removes a host half's start marker once per incarnation, tracked until it settles
  private unmark(k: Known, live: Live): Promise<void> {
    if (!live.marked) return Promise.resolve()
    live.marked = false
    return this.tracked(removeMarker(this.dataDir, k.id).catch(() => this.note('fault', { plugin: k.id, step: 'marker' })))
  }

  // Marker work shutdown waits for. The work never rejects
  private tracked(work: Promise<void>): Promise<void> {
    this.markerWork.add(work)
    void work.finally(() => this.markerWork.delete(work))
    return work
  }

  private note(event: string, fields: Record<string, string | number | boolean | null>): void {
    void this.record(event, fields)
  }
}

