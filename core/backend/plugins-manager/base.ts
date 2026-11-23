import { roleActions, type CoreStatus, type StateKind, type StoppedMode } from '../../api/actions.ts'
import { changeEffect, IDENTITY_ASK_PAUSE_MS, type Change } from '../../api/changes.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { type Caller } from '../../api/envelope.ts'
import { defaultLimits, MAX_TIMER_MS, type LimitName } from '../../api/limits.ts'
import {
  coreModuleIds, guardableActions, guards as expectedGuards, isSecurityControl, providers, type CoreModuleId, type GuardableAction,
} from '../../api/ids.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import type { HumanLimits, Opening, PluginInfo, PluginState, PolicyJobState } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Booted, FileResult, Plugin, SecurityState, StateStore, Switches } from '../boot/header.ts'
import type { RouterDoor } from '../router/header.ts'
import { type CoreModules } from '../modules/header.ts'
import { clear, folders } from './folders.ts'
import { plan, type Plan, type Status, type Verdict } from './graph.ts'
import { Connects, type PairOf } from './connects.ts'
import type { Beating } from '../heartbeat/header.ts'
import type { Failure, Runtime } from '../runtime/header.ts'
import type { PluginsRecording, Staging, Stagings } from './header.ts'
import { Requests } from './requests.ts'
import { type Read } from './verify.ts'
import { infoOf } from './reads.ts'

export type PluginsManagerOptions = {
  // What boot handed over: the state to run with, its checks, the one StateStore and the data folder
  booted: Pick<Booted, 'state' | 'checks' | 'store' | 'dataDir'>
  installDir: string
  // The door's code as the build wrote it, door.js beside main.js, inside app.asar in a packaged build. null runs no
  // door, for the tests of the rest
  doorFile: string | null
  link: RouterDoor
  // Recording, which the plugins manager calls only while the human has it on
  recording: PluginsRecording
  runtime: Runtime
  // The core's own modules, which the plugins manager starts, hands each change and switches as the human does
  modules: CoreModules
  // The guards expected on an action. Defaults to core/api's list
  guardsFor?: (action: GuardableAction) => readonly string[]
  // Whether boot's event log takes appends, for the banner. The join passes the EventLog's health
  logWrites?: () => boolean
  // The log failed while hetu ran: the runtime quits with an error and starts hetu again, or opens only the trusted
  // window once the plugins manager stopped in the stopped mode
  onFailure?: (failure: Failure) => void
  // How long a request must be first in line before its Confirm counts. The input delay unless a test names another
  confirmDelayMs?: number
  // How long a Confirm waits for its record to land, 10 s unless a test names another
  confirmRecordMs?: number
  // The human set a limit for this plugin, or for all and so for each, once the value is written, for the runtime to pass
  // the plugin's limits as they are now to its running halves
  limited?: (plugin: string) => void
  // A clock no change of the wall clock moves, for how long a request is first in line and how long an ask for a pair
  // waits. performance.now unless a test names another
  clock?: () => number
  // The stagings the Install button made, which a plugin.install installs from. With none, every plugin.install
  // answers not-found
  stagings?: Stagings
}

// What an update staged beside the old version came to
export type UpdateOutcome =
  | { outcome: 'applied' }
  | { outcome: 'refused', reason: string }
  | { outcome: 'confirm', stops: readonly string[] }

// One row of the plugin list. from is where the code came from: door, which ships with hetu apart from
// the core modules, or the plugin folder, the names the trusted window's rows take
export type Listing = {
  id: string
  from: 'door' | 'folder'
  place: PluginInfo['place']
  state: PluginState
  reason: string | null
  incarnation: number
}

export type HalfName = 'host' | 'worker'
export type Held = { kind: 'held', state: 'crashed' | 'failed' | 'stopped', reason: string }
export type Run = { caller: Caller, ready: boolean, stopped: boolean }

// One incarnation. A planned stop keeps why and who stopped with it
export type Live = {
  readonly n: number
  readonly halves: Map<HalfName, Run>
  readyTimer: ReturnType<typeof setTimeout> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  stop: { done: Promise<void>, end: () => void, reason: string } | null
  // The incarnation as the heartbeat watches it, from its ready on
  beating: Beating | null
  // The running plugins that stop with this one, named when its stop is decided, since they stop before it does
  with: string[]
  over: boolean
  deps: string
}

// A plugin the plugins manager knows, or the door. read holds the bytes that run. held is what happened in this run that
// only a restart clears
export type Known = {
  readonly id: string
  readonly from: 'core' | 'folder'
  root: string
  entry: Plugin | null
  read: Read
  place: PluginInfo['place']
  state: PluginState
  reason: string | null
  held: Held | null
  live: Live | null
  incarnations: number
  lastStop: string | null
  previousVersion: string | null
}

export type Staged = { dir: string, read: Read }

export const FOLDER_RANK = 1000
// What Finder and Explorer leave in a folder the user only looked at
export const osFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
export const isOne = (list: readonly string[], value: string) => list.includes(value)
export const isModule = (id: string): id is CoreModuleId => isOne(coreModuleIds, id)
export const refused = (reason: string): Status => ({ kind: 'refused', reason })

export const ok: Status = { kind: 'ok' }

// Where the core runs a part, never what a manifest asks for: the door in a utility process of its own, every plugin
// sandboxed
export function placeOf(from: 'core' | 'folder'): PluginInfo['place'] {
  return from === 'core' ? 'utility' : 'sandboxed'
}

export function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
  const rest = list.filter(entry => entry !== item)
  return on ? [...rest, item] : rest
}

// A table with no prototype that can still be written, as the state's own limit tables are
export function bare<T extends object>(entries: T): T {
  return Object.assign(Object.create(null), entries)
}

// What every part of the plugins manager shares: the fields, what the core handed over, the small readers and writers
// every step uses and how a plugin's status is judged. The parts above it are the lifecycle, the pairs' state, the
// classes, the install, the changes and the plugins manager joining them
export abstract class PluginsBase {
  protected readonly link: RouterDoor
  protected readonly recording: PluginsRecording
  protected readonly runtime: Runtime
  protected readonly modules: CoreModules
  protected readonly store: StateStore
  protected readonly dataDir: string
  protected readonly installDir: string
  protected readonly doorFile: string | null
  protected readonly guardsFor: (action: GuardableAction) => readonly string[]
  protected readonly logWrites: () => boolean
  protected readonly entryChecks = new Map<string, FileResult>()
  // The kinds of state file that failed their check at boot, for the banner
  protected readonly suspect: StateKind[]
  protected readonly known = new Map<string, Known>()
  // Folder plugins and entries under ids no folder plugin may hold, kept apart so they never touch the install's own
  protected readonly strays = new Map<string, string>()
  protected readonly staged = new Map<string, Staged>()
  // Versions an update replaced in this run, passed on as previousVersion once the plugin is known
  protected readonly versions = new Map<string, string>()
  // The last incarnation minted per plugin, kept when a plugin is known again so no number repeats in a run
  protected readonly minted = new Map<string, number>()
  protected readonly lastPolicyJobs = new Map<string, PolicyJobState>()
  protected readonly waiters: (() => void)[] = []
  // Restart marker writes and start marker writes and clears under way, which shutdown and a clean Quit wait for, so
  // none is cut off when the process ends
  protected readonly markerWork = new Set<Promise<void>>()
  protected state: SecurityState
  protected planned: Plan = { verdicts: new Map(), order: [] }
  protected n = 1
  protected closing = false
  protected pumping: Promise<void> | null = null
  protected again = false
  protected queue: Promise<unknown> = Promise.resolve()
  protected readonly requests: Requests
  protected readonly onFailure: PluginsManagerOptions['onFailure']
  // The runtime's limited, which never throws here
  protected readonly limited: (plugin: string) => void
  // starting until the door's code is read and the core modules started, all from then on, stopped once a control
  // failed at start or the log failed
  protected phase: 'starting' | 'all' | 'stopped' = 'starting'
  protected stoppedMode: StoppedMode | null = null
  // What the run before restarted for, from the restart marker
  protected failedBefore: string | null = null
  protected failing = false
  // Items whose ask the human cancelled this run, by plugin and item, which answer declined until Restart hetu
  protected readonly declinedAsks = new Set<string>()
  // Pairs whose ask the human cancelled, by the root plugin's id and the field on two lines, with the time from which
  // each may ask again
  protected readonly askPaused = new Map<string, number>()
  // The connects utility halves ask for: the one waiting, the answers not yet collected and the client ids paused
  protected readonly connects: Connects
  protected readonly clock: () => number
  protected readonly stagings: Stagings | null
  // The pass at start has classed every entry, so the grant risk classifier switched on from here on classes them again
  protected classedAtStart = false

  constructor(options: PluginsManagerOptions) {
    const { booted } = options
    this.link = options.link
    this.recording = options.recording
    this.runtime = options.runtime
    this.modules = options.modules
    this.store = booted.store
    this.dataDir = booted.dataDir
    this.installDir = options.installDir
    this.doorFile = options.doorFile
    this.guardsFor = options.guardsFor ?? (action => expectedGuards[action])
    this.logWrites = options.logWrites ?? (() => true)
    this.onFailure = options.onFailure
    this.limited = plugin => {
      try {
        options.limited?.(plugin)
      } catch {
        // Halves that miss their new limits pace to the old ones, the router already counts against the new
      }
    }
    this.clock = options.clock ?? (() => performance.now())
    this.stagings = options.stagings ?? null
    this.state = booted.state
    for (const check of booted.checks) {
      if (check.check === 'plugin-entry' && check.id !== undefined) this.entryChecks.set(check.id, check.result as FileResult)
    }
    // A file in a later format is read no further but is no sign of tampering, as boot reads it
    const failed = new Set(booted.checks.filter(c => !['ok', 'absent', 'newer'].includes(c.result)).map(c => c.check))
    this.suspect = (['switches', 'luoshu', 'plugin-entry'] as const).filter(kind => failed.has(kind))
      .map(kind => (kind === 'plugin-entry' ? 'plugins' : kind))
    this.requests = new Requests({
      effect: change => changeEffect(change),
      // A notice of a class moved up and a connect change nothing when answered, so no state they read can go stale under
      // them. A connect's Confirm looks at the pair again instead. An ask for a pair reads that pair's items alone, held
      // in memory, so only a change to that pair stales it
      fingerprint: change => {
        if (change.kind === 'class.raised' || change.kind === 'consent.ask') return Promise.resolve(change.kind)
        if (change.kind === 'identity.ask') return Promise.resolve(`${change.kind}\n${change.root}\n${change.field}\n${this.pairCount(change)}`)
        if (change.kind === 'plugin.install') return this.installPrint(change)
        return this.store.fingerprint('plugin' in change ? change.plugin : null)
      },
      exclusive: work => this.serial(work),
      applyNow: (change, confirmed) => this.applyNow(change, confirmed),
      cancelled: change => {
        if (change.kind === 'class.raised') return this.answered(change.plugin)
        if (change.kind === 'identity.ask') this.askPaused.set(`${change.root}\n${change.field}`, this.clock() + IDENTITY_ASK_PAUSE_MS)
        if (change.kind === 'consent.ask') this.connects.cancelled(change)
        // Nobody installs from it any more
        if (change.kind === 'plugin.install') this.dropStaging(change.staged)
        return Promise.resolve()
      },
      record: (event, fields, signal) => this.record(event, fields, signal),
      view: () => this.modules.securityView(),
      fault: step => this.note('fault', { plugin: 'security-view', step }),
      confirmOff: () => this.state.switches.confirmOff,
      recording: this.recording,
      changed: () => this.refresh(),
      clock: () => this.clock(),
      delayMs: options.confirmDelayMs ?? INPUT_DELAY_MS,
      ...(options.confirmRecordMs !== undefined ? { recordMs: options.confirmRecordMs } : {}),
      declined: (plugin, change) => {
        if (change.kind === 'item.on') this.declinedAsks.add(`${plugin}
${capabilityKey(change.capability)}`)
      },
    })
    // A connect takes one place of its own and is found by the very change it raised, so one that reads the same as
    // another is never taken for it
    this.connects = new Connects({
      clock: () => this.clock(),
      held: change => this.requests.changes().some(one => one.change === change),
      raise: change => {
        const id = this.requests.raise(change, null, 1, 'consent.ask')
        return typeof id === 'string' && this.requests.changes().some(one => one.id === id && one.change === change)
      },
      inUse: pair => this.pairHeld(pair),
    })
  }

  // What the core staged under a handle, null for one it doesn't hold and with no stagings. One that throws counts as
  // gone, so the trusted window still draws and nothing installs from it
  protected heldStaging(handle: string): Staging | null {
    try {
      return this.stagings?.held(handle) ?? null
    } catch {
      return null
    }
  }

  // A staging nobody installs from any more. One that can't be dropped installs nothing without a Confirm and goes at
  // the next start
  protected dropStaging(handle: string): void {
    try {
      this.stagings?.unstage(handle)
    } catch {
      // Left to the sweep at the next start
    }
  }

  // What a plugin.install's request is fingerprinted by, the changes' to say
  protected abstract installPrint(change: Extract<Change, { kind: 'plugin.install' }>): Promise<string>

  // ---- the router's seam

  // A policy job or guard role: a core module as it reads, starting until the modules are started, off only by the
  // human's switch and failed while the module's last push threw or once the stopped mode closed it. Only core modules
  // hold a guard role, so any other expected guard reads off by the human's switch, which the router skips and absent
  // otherwise
  policyJob(id: string): PolicyJobState {
    if (!isModule(id)) return isOne(this.state.switches.off, id) && this.expected().includes(id) ? 'off' : 'absent'
    const state = this.modules.state(id)
    return state === 'stopped' ? 'failed' : state
  }

  // A start marker's write or clear, kept among the marker work until it ends either way
  protected marking(work: Promise<void>): Promise<void> {
    // The caller gets work and its error, this copy only tells the marker work when it ended
    const ended = work.catch(() => {})
    this.markerWork.add(ended)
    void ended.then(() => this.markerWork.delete(ended))
    return work
  }

  view(): number {
    return this.n
  }

  plugin(id: string): PluginInfo | null {
    const k = this.known.get(id)
    return k === undefined ? null : infoOf(k)
  }

  // The one plugin serving a role: its grants hold the role's item, switched on, and it isn't refused or off, gate on or
  // off. null for none
  holderOf(action: string): string | null {
    const spec = Object.hasOwn(roleActions, action) ? roleActions[action] : undefined
    if (spec === undefined) return null
    const serving = [...this.known.values()].filter(k => {
      const held = this.grantsHeld(k).filter(item => item.type === spec.capability)
      const off = new Set((k.entry?.off ?? []).map(capabilityKey))
      const verdict = this.verdictOf(k).kind
      return held.some(item => !off.has(capabilityKey(item))) && verdict !== 'refused' && verdict !== 'off'
    })
    // The checks never leave two: a second plugin asking for a held role is refused role-taken before approval, a widen
    // to it is refused, an update keeps the entry's grants so it adds no item and two entries holding one are both
    // refused. Were two to serve, neither is named, so no plugin takes the role because it came first
    return serving.length === 1 ? serving[0].id : null
  }

  // What a plugin holds: a folder plugin's entry, none before approval. The door holds nothing
  protected grantsHeld(k: Known): readonly Capability[] {
    return k.from === 'core' ? [] : k.entry?.granted ?? []
  }

  // Whether another plugin holds a role these grants hold or ask for. An entry holds its role, on or off, until it is
  // removed
  protected roleTaken(id: string, granted: readonly Capability[]): boolean {
    const types = new Set(Object.values(roleActions).map(spec => spec.capability).filter(type => granted.some(item => item.type === type)))
    if (types.size === 0) return false
    return [...this.known.values()].some(other => other.id !== id && this.grantsHeld(other).some(item => types.has(item.type)))
  }

  limits(): HumanLimits {
    return this.state.switches.limits
  }

  // A plugin's storage or cache space cleared through storage while it is on, in the space's turn after the calls
  // already queued on it, so a set a stopping plugin queued can't land after the clear. With storage off or failed
  // nothing is queued and the folder goes directly
  protected async clearSpace(kind: 'storage' | 'cache', id: string): Promise<void> {
    const role = this.modules.storage()
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

  // ---- judging

  protected dev(id: string): boolean {
    return isOne(this.state.switches.devMode, id)
  }

  // Whether the human's switches let this plugin's bytes differ from what its entry or the list names
  protected loose(id: string): boolean {
    return this.dev(id) || this.state.switches.skipVerification
  }

  // The gate's and the grant risk classifier's states, each read from its module, as the banner and core.ready show them
  protected policyJobs(): CoreStatus['policyJobs'] {
    return { gate: this.policyJob('gate'), 'grant-risk-classifier': this.policyJob('grant-risk-classifier') }
  }

  // The policy jobs and every guard core/api expects, each recorded when its state moves
  protected expected(): string[] {
    const guards = guardableActions.flatMap(action => this.guardsFor(action))
    return [...new Set([...Object.keys(this.policyJobs()), ...guards])]
  }

  // A security control serving no provider namespace is required by nothing, the lock serving lock.* may be, as the
  // luoshu is. A core module requires nothing in the graph
  protected requiresProblem(k: Known): boolean {
    const requires = k.read.manifest?.requires ?? []
    if (isModule(k.id) && requires.length > 0) return true
    return requires.some(id => isSecurityControl(id) && !isOne(Object.values(providers), id))
  }

  // What the checks and this run make of a plugin, before the graph. The human's switch comes first, so a plugin the
  // human switched off reads off whatever its check said and a failed check never reads as off
  // allowing is a build judged as allowUnsigned would name it, the build an update's Confirm allows
  protected status(k: Known, allowing: string | null = null): Status {
    return k.from === 'core' ? this.doorStatus(k) : this.folderStatus(k, allowing)
  }

  // The door's code ships inside hetu's own files beside main.js, so no hash is kept apart to check it against. It is
  // off by the human's switch, as a core module is
  protected doorStatus(k: Known): Status {
    if (isOne(this.state.switches.off, k.id)) return { kind: 'off' }
    if (k.read.hash === null) return refused('missing')
    return k.held ?? ok
  }

  // No signer is taken until provenance lands, so an entry naming one is refused, the first-party signer an older build
  // wrote included, and runs only once the human approves the plugin again. A null signer loads only for a build
  // allowUnsigned names by the hash of the bytes read, or in dev mode, which is for a build with no fixed hash
  protected folderStatus(k: Known, allowing: string | null = null): Status {
    const { id, read, entry } = k
    if (entry === null) {
      const result = this.entryChecks.get(id) ?? 'absent'
      if (result === 'newer') return refused('newer')
      if (result !== 'ok' && result !== 'absent') return refused('entry')
      if (read.hash === null) return refused('missing')
      if (read.problem !== null) return refused(read.problem)
      // A role another entry holds raises no approval, so none can make a second holder
      if (this.roleTaken(id, read.manifest?.capabilities ?? [])) return refused('role-taken')
      return { kind: 'found' }
    }
    if (!entry.enabled) return { kind: 'off' }
    if (read.hash === null) return refused('missing')
    const dev = this.dev(id)
    if (!this.loose(id) && read.hash !== entry.contentHash) return refused('tampered')
    if (read.problem !== null) return refused(read.problem)
    if (entry.signer !== null) {
      return refused('signer')
    } else if (!dev && read.hash !== allowing && !isOne(this.state.switches.allowUnsigned, read.hash)) {
      return refused('unsigned')
    }
    // Two entries holding one role come only from an edited state and carry no order, so neither serves
    if (this.roleTaken(id, entry.granted)) return refused('role-taken')
    if (this.requiresProblem(k)) return refused('requires')
    return k.held ?? ok
  }

  protected moduleStatus(id: CoreModuleId): Status {
    const state = this.modules.state(id)
    if (state === 'on') return ok
    if (state === 'off') return { kind: 'off' }
    if (state === 'failed') return { kind: 'held', state: 'failed', reason: this.modules.reason(id) ?? 'start-failed' }
    return { kind: 'held', state: 'stopped', reason: this.modules.reason(id) ?? 'starting' }
  }

  // Whether a core module serves as the graph reads it: on, with what it requires serving too. History waits on the
  // luoshu. Before the first plan only its own state counts
  protected moduleServes(id: CoreModuleId): boolean {
    const verdict = this.planned.verdicts.get(id)
    return this.modules.state(id) === 'on' && (verdict === undefined || verdict.kind === 'start')
  }

  // A core module's row as the graph reads it: waiting while a module it requires can't serve, else its own state
  protected moduleRow(id: CoreModuleId): { state: PluginState, reason: string | null } {
    const state = this.modules.state(id)
    const verdict = this.planned.verdicts.get(id)
    if (state === 'on' && verdict?.kind === 'waiting') return { state: 'waiting', reason: verdict.reason }
    return { state: state === 'on' ? 'ready' : state, reason: state === 'on' ? null : this.modules.reason(id) }
  }

  // Whether a requirement can serve: a core module while it serves, a plugin once ready
  protected serves(id: string): boolean {
    return isModule(id) ? this.moduleServes(id) : this.known.get(id)?.state === 'ready'
  }

  // The door starts before every plugin
  protected rank(k: Known): number {
    return k.from === 'folder' ? FOLDER_RANK : 0
  }

  protected verdictOf(k: Known): Verdict {
    return this.planned.verdicts.get(k.id) ?? { kind: 'found' }
  }

  // Whether a plugin should be running now
  protected runs(k: Known): boolean {
    return !this.closing && this.phase !== 'stopped' && k.held === null && this.verdictOf(k).kind === 'start'
  }

  // One change or update at a time, so no two read the state and write it back over each other
  protected serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    // The caller gets run and its error, the queue only waits for it so one failed change never blocks the next
    this.queue = run.catch(() => {})
    return run
  }

  // The lists hold ids as plain strings here. The store parses the whole value against the switches' schema before it
  // writes, so what is kept after a write that worked has that shape
  protected async writeSwitches(next: { [K in keyof Switches]: unknown }): Promise<void> {
    await this.store.writeSwitches(next)
    this.state = { ...this.state, switches: next as Switches }
    this.bump()
    this.replan()
  }

  // One applied change: a new grants snapshot pushed to the gate, exec's view of the grants renewed with it and the router
  // told. When a core module failed or recovered on the way, with this push or one just before it, the plan is made
  // again so what requires it waits or starts
  protected bump(moved = false): void {
    this.n++
    const changed = this.modules.bumped() || moved
    if (changed) this.replan()
    else this.refresh()
  }

  // The folder in the state and hetu's own folders, which no command exec runs may take code from
  protected opening(): Opening {
    return { folder: this.state.luoshu?.folder ?? null, dataDir: this.dataDir, installDir: this.installDir }
  }

  protected putEntry(id: string, entry: Plugin): void {
    this.state.plugins[id] = entry
    this.entryChecks.set(id, 'ok')
    const k = this.known.get(id)
    if (k !== undefined) k.entry = entry
  }

  // ---- helpers

  protected runOf(caller: Caller): { k: Known, live: Live, run: Run } | null {
    if (caller?.kind !== 'plugin') return null
    const k = this.known.get(caller.id)
    const live = k?.live
    if (k === undefined || live === null || live === undefined || live.over || live.n !== caller.incarnation) return null
    const run = live.halves.get(caller.half as HalfName)
    return run === undefined ? null : { k, live, run }
  }

  protected limitOf(id: string, name: LimitName): number {
    let value: number = defaultLimits[name]
    try {
      const given = this.link.limit(id, name)
      if (Number.isSafeInteger(given) && given > 0) value = given
    } catch {
      // A limit the router can't give is the default, as for one the human never set
    }
    return Math.min(value, MAX_TIMER_MS)
  }

  // Nothing goes to recording while the human has it off. What waited on a record applies at once. A record recording
  // threw on counts as one that did not land
  protected record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<'landed' | 'muted' | 'lost'> {
    if (this.modules.state('recording') === 'off') return Promise.resolve('muted')
    try {
      return Promise.resolve(this.recording.record(event, fields, signal)).catch(() => 'lost' as const)
    } catch {
      return Promise.resolve('lost')
    }
  }

  // A record a change waits on, for at most the plugin's readyMs, so a log that can't write never holds a start or
  // the change queue behind it. Past that the wait gives up and the record counts as lost: the lane takes it out if
  // it still waits, so the log never shows a change that didn't apply. One whose write was under way may land late
  protected async landing(plugin: string, event: string, fields: Record<string, string | number | boolean | null>): Promise<'landed' | 'muted' | 'lost'> {
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
      return await Promise.race([this.record(event, fields, giveUp.signal), due])
    } catch {
      return 'lost'
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  protected note(event: string, fields: Record<string, string | number | boolean | null>): void {
    void this.record(event, fields)
  }

  // What a plugin holds: a plugin-folder plugin's entry. The door holds nothing
  protected grantsOf(id: string): readonly Capability[] {
    if (this.known.get(id)?.from === 'core') return []
    return this.state.plugins[id]?.granted ?? []
  }

  // Steps of the parts above, which the constructor's closures and the readers here call
  protected abstract replan(): void
  protected abstract refresh(): void
  protected abstract pairHeld(pair: PairOf): boolean
  protected abstract pairCount(pair: PairOf): number
  protected abstract applyNow(change: Change, confirm: boolean): Promise<void | 'unchanged'>
  protected abstract answered(id: string): Promise<void>
}
