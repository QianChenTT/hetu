import type { CoreStatus, StateKind, StoppedMode } from '../../api/actions.ts'
import { changeEffect, IDENTITY_ASK_PAUSE_MS, type Change } from '../../api/changes.ts'
import { INPUT_DELAY_MS } from '../../api/trusted.ts'
import { type Caller } from '../../api/envelope.ts'
import { defaultLimits, MAX_TIMER_MS, type LimitName } from '../../api/limits.ts'
import {
  coreModuleIds, corePluginIds, firstPartyIds, guardableActions, guards as expectedGuards, isSecurityControl, providers,
  utilityIds, type CoreModuleId, type GuardableAction,
} from '../../api/ids.ts'
import { FIRST_PARTY_SIGNER, type InstallList, type Listed } from '../../api/install.ts'
import { frozen } from '../../api/plain.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import type { HumanLimits, Opening, PluginInfo, PluginState, PolicyJobState } from '../../api/policy-jobs.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Booted, FileResult, Plugin, SecurityState, StateStore, Switches } from '../boot/header.ts'
import type { RouterDoor } from '../router/header.ts'
import { type CoreModules } from '../modules/header.ts'
import { clear, folders, type Installed } from './folders.ts'
import { plan, type Plan, type Status, type Verdict } from './graph.ts'
import { Connects, type PairOf } from './connects.ts'
import type { Beating } from '../heartbeat/header.ts'
import type { Failure, Runtime } from '../runtime/header.ts'
import type { PluginsRecording } from './header.ts'
import { Requests } from './requests.ts'
import { type Read } from './verify.ts'
import { infoOf } from './reads.ts'

export type PluginsManagerOptions = {
  // What boot handed over: the state to run with, its checks, whether the tombstones are known, the one StateStore and
  // the data folder
  booted: Pick<Booted, 'state' | 'checks' | 'removedKnown' | 'store' | 'dataDir'>
  installDir: string
  // Where the install list is, the install folder unless the build keeps the list apart from the plugins, as a
  // packaged build does inside app.asar
  listDir?: string
  link: RouterDoor
  // Recording, which the plugins manager calls only while the human has it on
  recording: PluginsRecording
  runtime: Runtime
  // The core's own modules, which the plugins manager starts, hands each change and switches as the human does
  modules: CoreModules
  // The rules the install list's paths follow, the platform the install is on
  platform?: string
  // The guards expected on an action. Defaults to core/api's list, which is empty until #77
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
}

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

// A plugin the plugins manager knows. read holds the bytes that run. held is what happened in this run that only a restart
// clears. updated is the version an app update replaced, until its record lands
export type Known = {
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
  lastStop: string | null
  previousVersion: string | null
  updated: string | null
}

export type Staged = { dir: string, read: Read }

// The order core plugins start in, each after the core modules. A requirement still starts before its dependent
export const bootOrder = frozen(['net', 'mcp-http-handler'] as const)

export const FOLDER_RANK = 1000
// What Finder and Explorer leave in a folder the user only looked at
export const osFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
export const isOne = (list: readonly string[], value: string) => list.includes(value)
export const isModule = (id: string): id is CoreModuleId => isOne(coreModuleIds, id)
export const refused = (reason: string): Status => ({ kind: 'refused', reason })

export const ok: Status = { kind: 'ok' }

// Where the core runs a plugin, never what its manifest asks for: a core plugin core/api names runs its host entry
// in a utility process
export function placeOf(id: string, read: Read, from: 'install' | 'folder'): PluginInfo['place'] {
  const entries = read.manifest?.entries
  if (entries === undefined) return from === 'install' ? 'host' : 'sandboxed'
  if (entries.host !== undefined) return from === 'install' && isOne(utilityIds, id) ? 'utility' : 'host'
  return 'sandboxed'
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
  protected readonly listDir: string
  protected readonly platform: string
  protected readonly guardsFor: (action: GuardableAction) => readonly string[]
  protected readonly logWrites: () => boolean
  protected readonly entryChecks = new Map<string, FileResult>()
  // The kinds of state file that failed their check at boot, for the banner
  protected readonly suspect: StateKind[]
  protected readonly known = new Map<string, Known>()
  // Folder plugins and entries under ids no folder plugin may hold, kept apart so they never touch the install's own
  protected readonly strays = new Map<string, string>()
  protected readonly bundled = new Map<string, Read>()
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
  protected removedKnown: boolean
  protected install: InstallList | null = null
  protected listResult: 'unread' | 'ok' | 'absent' | 'invalid' = 'unread'
  protected installed: Installed = Object.create(null)
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
  // starting until the install list is read and the core modules started, all from then on, stopped once the install
  // list or the log failed
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
    this.listDir = options.listDir ?? options.installDir
    this.platform = options.platform ?? process.platform
    this.guardsFor = options.guardsFor ?? (action => expectedGuards[action])
    this.logWrites = options.logWrites ?? (() => true)
    this.onFailure = options.onFailure
    this.limited = plugin => {
      try {
        options.limited?.(plugin)
      } catch {}
    }
    this.clock = options.clock ?? (() => performance.now())
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
      // A notice of a class moved up and a connect change nothing when answered, so no state they read can go stale under
      // them. A connect's Confirm looks at the pair again instead. An ask for a pair reads that pair's items alone, held
      // in memory, so only a change to that pair stales it
      fingerprint: change => {
        if (change.kind === 'class.raised' || change.kind === 'consent.ask') return Promise.resolve(change.kind)
        if (change.kind === 'identity.ask') return Promise.resolve(`${change.kind}\n${change.root}\n${change.field}\n${this.pairCount(change)}`)
        return this.store.fingerprint('plugin' in change ? change.plugin : null)
      },
      exclusive: work => this.serial(work),
      applyNow: (change, confirmed) => this.applyNow(change, confirmed),
      cancelled: change => {
        if (change.kind === 'class.raised') return this.answered(change.plugin)
        if (change.kind === 'identity.ask') this.askPaused.set(`${change.root}\n${change.field}`, this.clock() + IDENTITY_ASK_PAUSE_MS)
        if (change.kind === 'consent.ask') this.connects.cancelled(change)
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

  // ---- the router's seam

  // A policy job or guard role: a core module as it reads, starting until the modules are started, off only by the
  // human's switch and failed while the module's last push threw or once the stopped mode closed it. Nothing that runs
  // holds a guard role, so an expected guard reads off by the human's switch, which the router skips and absent otherwise
  policyJob(id: string): PolicyJobState {
    if (!isModule(id)) return isOne(this.state.switches.off, id) && this.expected().includes(id) ? 'off' : 'absent'
    const state = this.modules.state(id)
    return state === 'stopped' ? 'failed' : state
  }

  // A start marker's write or clear, kept among the marker work until it ends either way
  protected marking(work: Promise<void>): Promise<void> {
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

  // A core module's id, a provider and a guard name roles only a host half in main could hold. The core runs none
  protected needsHost(id: string): boolean {
    return isModule(id) || isOne(Object.values(providers), id) || this.expected().includes(id)
  }

  // A security control is required by nothing and a core module requires nothing in the graph. Core plugins require only
  // core plugins and core modules
  protected requiresProblem(k: Known): boolean {
    const requires = k.read.manifest?.requires ?? []
    if (isModule(k.id) && requires.length > 0) return true
    return requires.some(id => isSecurityControl(id) || (k.from === 'install' && !isOne(corePluginIds, id) && !isModule(id)))
  }

  // What the checks and this run make of a plugin, before the graph. The human's switch comes first, so a plugin the
  // human switched off reads off whatever its check said and a failed check never reads as off
  protected status(k: Known): Status {
    return k.from === 'install' ? this.installStatus(k) : this.folderStatus(k)
  }

  // Dev mode on a core plugin loads its bytes unhashed, from the install and never from the plugin folder
  protected installStatus(k: Known): Status {
    const listed = k.listed!
    if (isOne(this.state.switches.off, k.id)) return { kind: 'off' }
    const loose = this.loose(k.id)
    if (k.read.hash === null) return refused('missing')
    if (!loose && k.read.hash !== listed.hash) return refused('tampered')
    if (k.read.problem !== null) return refused(k.read.problem)
    const manifest = k.read.manifest!
    if (!loose && manifest.version !== listed.version) return refused('invalid')
    if (this.needsHost(k.id)) return refused('place')
    // A host entry runs only in a utility process, for the ids core/api places there, and those run only as it, never
    // as a worker in its place
    if ((manifest.entries.host !== undefined) !== isOne(utilityIds, k.id)) return refused('place')
    if (this.requiresProblem(k)) return refused('requires')
    return k.held ?? ok
  }

  // A first-party id loads only as the install's own copy: the reserved signer in its entry and its bytes equal to the
  // install's, which dev mode alone lets differ. A null signer loads only for a build allowUnsigned names by the hash
  // of the bytes read, or in dev mode, which is for a build with no fixed hash
  protected folderStatus(k: Known): Status {
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

  protected rank(k: Known): number {
    if (k.from === 'folder') return FOLDER_RANK
    const at = (bootOrder as readonly string[]).indexOf(k.id)
    return at === -1 ? FOLDER_RANK - 1 : at
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
    } catch {}
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

  // What a plugin holds: a plugin-folder plugin's entry, a core plugin's manifest
  protected grantsOf(id: string): readonly Capability[] {
    const k = this.known.get(id)
    if (k?.from === 'install') return k.read.manifest?.capabilities ?? []
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
