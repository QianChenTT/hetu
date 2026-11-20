import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ActionResults, CoreStatus, HeldRequest, ListedAgent, ListedPlugin, PendingRequest, SecurityList, StateKind, StoppedMode,
} from '../../api/actions.ts'
import {
  AGENT_ASK_PAUSE_MS, agentAsk as agentAskChange, change as changeSchema, changeEffect, connectLabel, withdrawnWith, type AgentAsk, type Change,
  type ClassRaised,
} from '../../api/changes.ts'
import { describeChange } from '../../api/describe.ts'
import { capabilityText, INPUT_DELAY_MS } from '../../api/trusted.ts'
import { agentLabel, VERSION, type Caller } from '../../api/envelope.ts'
import { defaultLimits, MAX_TIMER_MS, type LimitName } from '../../api/limits.ts'
import {
  coreModuleIds, corePluginIds, firstPartyIds, guardableActions, guards as expectedGuards, isReservedId, isSecurityControl, pluginId,
  policyJobIds, providers, utilityIds, type CoreModuleId, type GuardableAction,
} from '../../api/ids.ts'
import {
  FIRST_PARTY_SIGNER, INSTALL_LIST, installList, isNewer, MAX_INSTALL_LIST_BYTES, type InstallList, type Listed,
} from '../../api/install.ts'
import { bindFailures, type BindFailure, type DepState, type Init, type StopReason } from '../../api/lifecycle.ts'
import { API_VERSION } from '../../api/manifest.ts'
import { frozen } from '../../api/plain.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import type {
  ExecGrant, ExecView, GrantedItem, HumanLimits, Opening, PluginInfo, PluginState, PluginTable, PolicyJobState,
  GrantsSnapshot,
} from '../../api/policy-jobs.ts'
import { agentDoor, agentHost } from '../../api/policy-jobs.ts'
import { checkedAnswer, highestClass, type ClassAnswer, type ClassCause, type ClassTable, type ClassVerdict } from '../../api/classes.ts'
import { retried } from '../../lib/disk.ts'
import type { Field } from '../../lib/event-log.ts'
import { parseStrict } from '../../lib/hashed-file.ts'
import type { Booted, FileResult, Plugin, SecurityState, StateStore, Switches } from '../boot/header.ts'
import { agentItems } from '../lib/agent-items.ts'
import type { AskRefusal, Asks, RouterDoor, Served } from '../router/header.ts'
import { moduleRequires, type CoreModules } from '../modules/header.ts'
import {
  clear, clearFailedOnce, firstPartyPath, folders, readFailedOnce, readInstalled, stage, swapIn, writeFailedOnce, writeInstalled,
  type Installed,
} from './folders.ts'
import { plan, type Node, type Plan, type Status, type Verdict } from './graph.ts'
import { Connects, type ConnectAsked } from './connects.ts'
import { cleared, handedBack, heardOut, marksOf, revoked, revokedAside, setAside } from './marks.ts'
import type { Beating } from '../heartbeat/header.ts'
import type { Failure, Runtime } from '../runtime/header.ts'
import type { PluginsRecording } from './header.ts'
import { MAX_PENDING, Requests, type RequestAnswer } from './requests.ts'
import { readPlugin, unread, type Read } from './verify.ts'
import { infoOf, viewsOf } from './reads.ts'

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
  // A clock no change of the wall clock moves, for how long a request is first in line and how long an agent's ask
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

type HalfName = 'host' | 'worker'
type Held = { kind: 'held', state: 'crashed' | 'failed' | 'stopped', reason: string }
type Run = { caller: Caller, ready: boolean, stopped: boolean }

// One incarnation. A planned stop keeps why and who stopped with it
type Live = {
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
  lastStop: string | null
  previousVersion: string | null
  updated: string | null
}

type Staged = { dir: string, read: Read }

// The grant risk classifier as classing reads it: on with its module serving, off once the human switched it off, down
// any other way
type Classing = 'on' | 'off' | 'down'

// What a class change comes to for one plugin: the entry stored, null once the plugin goes, whether its class, first-use
// list, confirmed record, mark or owed notice differ from the entry before and whether it rises and so is written before
// the change that causes it
type Decided = { readonly id: string, readonly entry: Plugin | null, readonly changed: boolean, readonly rises: boolean }

// A class change: the changed plugin, null in a pass, every other entry that comes out different, the lines its Confirm
// shows and for an update asked so whether it loads unasked
type Classed = { readonly own: Decided | null, readonly others: readonly Decided[], readonly lines: readonly string[], readonly unasked: boolean }

// The same items whatever their order, an item being its type with its scope
function sameItems(items: readonly Capability[], others: readonly Capability[] = []): boolean {
  const keys = new Set(others.map(capabilityKey))
  return items.length === others.length && items.every(item => keys.has(capabilityKey(item)))
}

// The order core plugins start in, each after the core modules. A requirement still starts before its dependent
export const bootOrder = frozen(['net', 'leases', 'mcp-http-handler', 'hidden-marks'] as const)

const FOLDER_RANK = 1000
// What Finder and Explorer leave in a folder the user only looked at
const osFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])
const isOne = (list: readonly string[], value: string) => list.includes(value)
const isModule = (id: string): id is CoreModuleId => isOne(coreModuleIds, id)
const refused = (reason: string): Status => ({ kind: 'refused', reason })

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

// Where the core runs a plugin, never what its manifest asks for: a core plugin core/api names runs its host entry
// in a utility process
function placeOf(id: string, read: Read, from: 'install' | 'folder'): PluginInfo['place'] {
  const entries = read.manifest?.entries
  if (entries === undefined) return from === 'install' ? 'host' : 'sandboxed'
  if (entries.host !== undefined) return from === 'install' && isOne(utilityIds, id) ? 'utility' : 'host'
  if (entries.worker === undefined && entries.page !== undefined) return 'page'
  return 'sandboxed'
}

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
  const rest = list.filter(entry => entry !== item)
  return on ? [...rest, item] : rest
}

// A table with no prototype that can still be written, as the state's own limit tables are
function bare<T extends object>(entries: T): T {
  return Object.assign(Object.create(null), entries)
}

type AgentItem = NonNullable<Plugin['agents']>[number]

// The agents' items an ask's Confirm writes: those held, then each asked item the label doesn't hold yet. The raise
// parses the same list, so an ask that waits is one its Confirm can write
function withAsked(held: readonly AgentItem[], change: AgentAsk): AgentItem[] {
  const items = [...held]
  for (const capability of change.capabilities) {
    const key = capabilityKey(capability)
    if (!items.some(item => item.agent === change.agent && capabilityKey(item.capability) === key)) items.push({ agent: change.agent, capability })
  }
  return items
}

// The plugins manager: what may run, where, when and as whom. It checks every plugin's bytes once before they run, places each
// by where its code came from, resolves the requires graph, mints every port and owns every lifecycle state. It starts
// the core modules, hands them each change and switches them as the human does. It runs no plugin code itself and
// decides no grant
export class PluginsManager implements PluginTable {
  private readonly link: RouterDoor
  private readonly recording: PluginsRecording
  private readonly runtime: Runtime
  private readonly modules: CoreModules
  private readonly store: StateStore
  private readonly dataDir: string
  private readonly installDir: string
  private readonly listDir: string
  private readonly platform: string
  private readonly guardsFor: (action: GuardableAction) => readonly string[]
  private readonly logWrites: () => boolean
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
  private readonly lastPolicyJobs = new Map<string, PolicyJobState>()
  private readonly waiters: (() => void)[] = []
  // Restart marker writes under way, which shutdown waits for, so none is cut off when the process ends
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
  private readonly onFailure: PluginsManagerOptions['onFailure']
  // The runtime's limited, which never throws here
  private readonly limited: (plugin: string) => void
  // starting until the install list is read and the core modules started, all from then on, stopped once the install
  // list or the log failed
  private phase: 'starting' | 'all' | 'stopped' = 'starting'
  private stoppedMode: StoppedMode | null = null
  // What the run before restarted for, from the restart marker
  private failedBefore: string | null = null
  private failing = false
  // Items whose ask the human cancelled this run, by plugin and item, which answer declined until Restart hetu
  private readonly declinedAsks = new Set<string>()
  // Agents whose ask the human cancelled, by label, with the time from which each may ask again
  private readonly askPaused = new Map<string, number>()
  // The connects mcp-http-handler asks for: the one waiting, the answers not yet collected and the client ids paused
  private readonly connects: Connects
  private readonly clock: () => number
  // The pass at start has classed every entry, so the grant risk classifier switched on from here on classes them again
  private classedAtStart = false

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
      // them. A connect's Confirm looks at the label again instead
      fingerprint: change => (change.kind === 'class.raised' || change.kind === 'agent.connect'
        ? Promise.resolve(change.kind) : this.store.fingerprint('plugin' in change ? change.plugin : null)),
      exclusive: work => this.serial(work),
      applyNow: (change, confirmed) => this.applyNow(change, confirmed),
      cancelled: change => {
        if (change.kind === 'class.raised') return this.answered(change.plugin)
        if (change.kind === 'agent.ask') this.askPaused.set(change.agent, this.clock() + AGENT_ASK_PAUSE_MS)
        if (change.kind === 'agent.connect') this.connects.cancelled(change)
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
        const id = this.requests.raise(change, null, 1, 'agent.connect')
        return typeof id === 'string' && this.requests.changes().some(one => one.id === id && one.change === change)
      },
      inUse: label => this.labelHeld(label),
    })
    // Handed to the router through its door, which calls them and never names the plugins manager
    this.link.serve('plugins-manager', this.serve)
    this.link.asks(this.asks)
    this.link.onWayClosed((caller, reason) => this.crashed(caller, reason))
    this.link.onHeard((caller, kind) => this.heard(caller, kind))
  }

  // ---- the router's seam

  // A policy job or guard role: the gate and the grant risk classifier as their core modules read, starting until the
  // modules are started, off only by the human's switch and failed while the module's last push threw or once the
  // stopped mode closed it. Nothing that runs holds a guard role, so each is absent
  policyJob(id: string): PolicyJobState {
    if (id !== 'gate' && id !== 'grant-risk-classifier') return 'absent'
    const state = this.modules.state(id)
    return state === 'stopped' ? 'failed' : state
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

  // For the router, which refuses the door's call for a revoked label before the agent host sees it: the marks on the
  // agent host's entry or in the switches while it has none
  revoked(label: string): boolean {
    const k = this.known.get(agentHost)
    return marksOf(k?.from === 'folder' ? k.entry : null, this.state.switches).includes(label)
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

  heard(caller: Caller, kind: 'ready' | 'pong' | 'stopped' | 'alive'): void {
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
    } else if ((kind === 'pong' || kind === 'alive') && live.beating !== null) {
      this.modules.heartbeat()?.heard(live.beating)
      if (k.state === 'unresponsive') {
        k.state = 'ready'
        this.refresh()
      }
    }
  }

  // ---- what else the core asks of the plugins manager

  // The core actions the router's core seam takes, each once the floor let its caller through
  readonly serve: Served = async call => {
    if (call.action === 'core.self') return call.caller
    if (call.action === 'core.status') return this.banner()
    if (call.action === 'core.views') return viewsOf(this.known.values())
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
      // The router's floor let only the agent host under a live call from the door through, so onBehalf is that call's agent
      case 'core.agentAsk':
        return this.agentAsk(call.onBehalf, args.capabilities as Capability[])
      // The floor let only mcp-http-handler's half on its utility port through
      case 'core.agents':
        return this.agentsFor(args.agents as string[], (args.heard as string[] | undefined) ?? [])
      // The floor let only mcp-http-handler's half on its utility port through. The handle is the core's own, never an argument
      case 'core.agentConnect':
        return { handle: this.connects.ask(args as ConnectAsked) }
      case 'core.agentConnected':
        return { answer: this.connects.answer(args.handle as string) }
      // Coalesced by reason with the counts added up. A throw in recording is that record lost
      case 'core.agentRefused':
        try {
          this.recording.coalesced('http.refused', { reason: args.reason as string }, undefined, args.count as number)
        } catch {}
        return null
      case 'core.stop':
      case 'core.restart': {
        const k = this.known.get(args.plugin as string)
        if (k === undefined) throw { code: 'not-found' }
        if (k.place !== 'sandboxed' && k.place !== 'utility') throw { code: 'not-granted' }
        // The human stopped it from the trusted window, so only the trusted window starts it again
        const trusted = call.caller.kind === 'window' && call.caller.role === 'trusted'
        if (call.action === 'core.restart' && k.held?.state === 'stopped' && k.held.reason === 'human' && !trusted) throw { code: 'not-granted' }
        // A utility half is the door. Its restart cuts every agent call in flight and can bring back a door the core
        // ended, so it is the human's in the trusted window alone, as its stop is. The place is the plugins manager's to know,
        // so the rule is here and not in the floor, which sees only that a window asked
        if (call.action === 'core.restart' && k.place === 'utility' && !trusted) throw { code: 'not-granted' }
        if (call.action === 'core.stop') await this.stop(k.id, 'human')
        else await this.restart(k.id, 'human')
        return null
      }
      // The calling half alone, which the router has checked is mcp-http-handler's in its utility process
      case 'core.bindFailed': {
        const found = this.runOf(call.caller)
        if (found === null) throw { code: 'not-found' }
        if (found.k.place !== 'utility') throw { code: 'not-granted' }
        this.die(found.k, args.reason as BindFailure)
        return null
      }
    }
    throw { code: 'unavailable' }
  }

  // What the trusted window draws. Ids, states and fixed reasons only, and each request in the core's own words. The core
  // modules are rows of their own, each with its switch and no items
  private securityList(): SecurityList {
    const { switches } = this.state
    const modules: ListedPlugin[] = coreModuleIds.map(id => {
      const { state, reason } = this.moduleRow(id)
      return {
        id, from: 'core', place: 'core', state, reason,
        security: isSecurityControl(id), firstParty: false, on: !isOne(switches.off, id), items: [], class: null,
      }
    })
    const listed: ListedPlugin[] = this.list().map(row => {
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
    const plugins = [...modules, ...listed].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.from < b.from ? -1 : 1))
    const requests: HeldRequest[] = this.requests.changes().map(({ id, change }) => {
      const { text, notes } = describeChange(change)
      return {
        id, kind: change.kind, plugin: 'plugin' in change ? change.plugin : null, text, notes: [...notes, ...this.what(change)],
        type: this.requests.typed(change), agent: change.kind === 'agent.ask' ? change.agent : change.kind === 'agent.connect' ? connectLabel(change) : null,
      }
    })
    return {
      plugins,
      switches: {
        devMode: [...switches.devMode], execAnyCommand: [...switches.execAnyCommand], skipVerification: switches.skipVerification,
        allowUnsigned: [...switches.allowUnsigned], confirmOff: switches.confirmOff,
      },
      limits: {
        all: { ...switches.limits.all },
        plugins: Object.fromEntries(Object.entries(switches.limits.plugins).map(([id, set]) => [id, { ...set }])),
      },
      luoshu: this.state.luoshu?.folder ?? null,
      requests,
      agents: this.listedAgents(),
      stopped: this.stoppedMode,
    }
  }

  // The agent host's agents from the state alone, its entry on or off or gone: each label holding items in the order the
  // entry first names it, then each revoked label. Nothing here says whether a token is live or what a client calls
  // itself
  private listedAgents(): ListedAgent[] {
    const k = this.known.get(agentHost)
    const entry = k?.from === 'folder' ? k.entry : null
    const listed = new Map<string, Capability[]>()
    for (const { agent, capability } of entry?.agents ?? []) listed.set(agent, [...listed.get(agent) ?? [], capability])
    return [
      ...[...listed].map(([agent, items]) => ({ agent, items, revoked: false })),
      ...marksOf(entry, this.state.switches).map(agent => ({ agent, items: [], revoked: true })),
    ]
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
        ...this.classes('approve', change.plugin, this.approval(k), true).lines,
      ]
    }
    if (change.kind === 'plugin.update') {
      const read = this.staged.get(change.plugin)?.read
      const to = read?.manifest?.version
      const entry = this.known.get(change.plugin)?.entry
      if (read === undefined || to === undefined || entry === undefined || entry === null) return []
      const after: Plugin = { ...entry, version: to, contentHash: read.hash! }
      return [`From ${entry.version} to ${to}`, ...this.classes('update', change.plugin, after, true).lines]
    }
    if (change.kind === 'grant.widen') {
      const entry = this.known.get(change.plugin)?.entry
      if (entry === undefined || entry === null) return []
      const after: Plugin = { ...entry, granted: [...entry.granted, change.capability] }
      return [...this.classes('widen', change.plugin, after, true).lines]
    }
    if (change.kind === 'plugin.restore') {
      const read = this.bundled.get(change.plugin)
      const listed = this.install?.plugins[change.plugin]
      if (read?.manifest === undefined || read.manifest === null || listed === undefined) return []
      const after = this.copied(change.plugin, read, listed, this.state.plugins[change.plugin]?.enabled ?? true, 'restore')
      return [...this.classes('restore', change.plugin, after, true).lines]
    }
    if (change.kind === 'plugin.remove' || change.kind === 'plugin.reset') {
      const k = this.known.get(change.plugin)
      return k?.from === 'folder' && k.entry !== null ? [...this.classes(change.kind === 'plugin.remove' ? 'remove' : 'reset', change.plugin, null, true).lines] : []
    }
    return []
  }

  // A plugin's storage or cache space cleared through storage while it is on, in the space's turn after the calls
  // already queued on it, so a set a stopping plugin queued can't land after the clear. With storage off or failed
  // nothing is queued and the folder goes directly
  private async clearSpace(kind: 'storage' | 'cache', id: string): Promise<void> {
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

  // ---- classes

  // What a plugin holds: a plugin-folder plugin's entry, a core plugin's manifest
  private grantsOf(id: string): readonly Capability[] {
    const k = this.known.get(id)
    if (k?.from === 'install') return k.read.manifest?.capabilities ?? []
    return this.state.plugins[id]?.granted ?? []
  }

  // The grant risk classifier as classing reads it: on while its module serves, off only once the human switched it off
  // and down for anything else, a failed module included
  private classing(): Classing {
    const state = this.policyJob('grant-risk-classifier')
    if (state === 'off') return 'off'
    return this.modules.grantRiskClassifier() !== null ? 'on' : 'down'
  }

  // What the classifier is handed: every plugin the plugins manager knows with what it holds and what its entry stores,
  // a core plugin with none, and the change to one plugin, copied so nothing the classifier does reaches the state
  private classTable(
    cause: ClassCause, id: string | null, granted: readonly Capability[] | null, confirm: boolean, requested?: readonly Capability[],
  ): ClassTable {
    const ids = new Set([...Object.keys(this.state.plugins), ...[...this.known.values()].filter(k => k.from === 'install').map(k => k.id)])
    const plugins = [...ids].map(other => {
      const entry = this.known.get(other)?.from === 'install' ? null : this.state.plugins[other] ?? null
      const stored = entry === null ? null
        : { class: entry.class, firstUse: entry.firstUse ?? [], unclassed: entry.unclassed === true, owed: entry.owed ?? null }
      return { id: other, granted: this.grantsOf(other), stored }
    })
    return frozen(structuredClone({ cause, change: id === null ? null : { id, granted }, confirm, plugins, ...(requested === undefined ? {} : { requested }) }))
  }

  // The classifier's answer once the shape check takes it. Null with the classifier not serving, for a throw and for an
  // answer the check refuses, each a fault
  private askClasses(table: ClassTable): ClassAnswer | null {
    const classifier = this.modules.grantRiskClassifier()
    if (classifier === null) return null
    let answer: unknown
    try {
      answer = classifier.classes(table)
    } catch {}
    const checked = checkedAnswer(table, answer)
    if (checked === null) this.note('fault', { plugin: 'grant-risk-classifier', step: 'classify' })
    return checked
  }

  // The one function every class change goes through, whatever causes it: a change to one plugin, which after is the
  // entry it leaves before it is classed, null once the plugin goes, or with id null a pass over every entry. The
  // classifier is handed the whole table and answers for every plugin the change moves. Without it the core can't tell
  // which plugins a change moves, so with the classifier switched off by the human or down every entry comes out of the
  // change as below. Switched off, a pass leaves each as stored and a change passes: the class the last one classed, the
  // entry marked as not classed and every item not confirmed listed, which the gate is handed only once the classifier
  // is on again. Down, a throw or an answer the check refuses, the class is not known and every item asks. Whether an
  // entry rises is read here from the class numbers stored, never from the classifier. requested is what an update's new
  // version asks for when the classifier is asked whether it loads unasked, which it never does while off or down
  private classes(cause: ClassCause, id: string | null, after: Plugin | null, confirm: boolean, requested?: readonly Capability[]): Classed {
    let classing = this.classing()
    if (id === null && classing === 'off') return { own: null, others: [], lines: [], unasked: false }
    const answer = classing === 'on' ? this.askClasses(this.classTable(cause, id, after?.granted ?? null, confirm, requested)) : null
    if (answer === null && classing === 'on') classing = 'down'
    const verdicts = new Map(answer?.plugins.map(verdict => [verdict.id, verdict]))
    const notice = { cause, by: id }
    const decide = (other: string, before: Plugin | null, next: Plugin) =>
      this.decided({ id: other, before, after: next, verdict: verdicts.get(other) ?? null, classing, confirm, notice,
        fresh: other === id && cause === 'update' && !confirm })
    const before = id === null ? null : this.state.plugins[id] ?? null
    const own = id === null ? null : after === null ? { id, entry: null, changed: before !== null, rises: false } : decide(id, before, after)
    const others: Decided[] = []
    for (const [other, entry] of Object.entries(this.state.plugins)) {
      if (other === id || this.known.get(other)?.from === 'install' || (answer !== null && !verdicts.has(other))) continue
      const decided = decide(other, entry, entry)
      if (decided.changed) others.push(decided)
    }
    const down = `The grant risk classifier is down, so the class is unknown and counted as ${highestClass}: every item asks at its first use`
    const lines = answer !== null ? answer.lines : classing === 'down' && after !== null ? [down] : []
    return { own, others, lines, unasked: answer?.unasked === true }
  }

  // One plugin's entry as a class change leaves it, from the classifier's verdict or, with none, from the fallback the
  // classifier's state names. A confirmed item stays confirmed while the plugin holds it, until new code applies with no
  // Confirm on screen. Down, every item asks, confirmed ones too, and an entry stored with no Confirm on screen keeps the
  // class it held as the class last shown in its mark, so a move up made while the class is not known is measured from it
  // once the class is known again. An entry marked as not classed held no class the human was shown
  private decided(change: {
    id: string, before: Plugin | null, after: Plugin, verdict: ClassVerdict | null, classing: Classing, confirm: boolean,
    notice: { cause: ClassCause, by: string | null }, fresh: boolean,
  }): Decided {
    const { id, before, after, verdict, classing, confirm, notice } = change
    const held = new Set(after.granted.map(capabilityKey))
    const confirmed = (change.fresh ? [] : before?.confirmed ?? []).filter(item => held.has(capabilityKey(item)))
    const known = new Set(confirmed.map(capabilityKey))
    const was = before?.owed
    const forgets = classing === 'down' && !confirm && was === undefined && before !== null && before.class !== null && before.unclassed !== true
    const n = verdict !== null ? verdict.class : classing === 'off' ? before?.class ?? null : null
    const asking = verdict !== null ? verdict.firstUse.filter(item => !known.has(capabilityKey(item)))
      : after.granted.filter(item => classing === 'down' || !known.has(capabilityKey(item)))
    const owed = verdict !== null ? verdict.owed ?? undefined : forgets ? { from: before.class, cause: notice.cause, by: notice.by } : was
    const next: Plugin = { ...after, class: n }
    delete next.firstUse
    delete next.confirmed
    delete next.unclassed
    delete next.owed
    if (asking.length > 0) next.firstUse = [...asking]
    if (confirmed.length > 0) next.confirmed = confirmed
    if (classing === 'off' || (classing === 'down' && after.unclassed === true)) next.unclassed = true
    if (owed !== undefined) next.owed = owed
    const listed = new Set((before?.firstUse ?? []).map(capabilityKey))
    const rank = (m: number | null | undefined) => m ?? highestClass
    const changed = before === null || n !== before.class || !sameItems(asking, before.firstUse) || !sameItems(confirmed, before.confirmed)
      || next.unclassed !== before.unclassed || JSON.stringify(owed) !== JSON.stringify(before.owed)
    const rises = asking.some(item => !listed.has(capabilityKey(item))) || (next.unclassed === true && before?.unclassed !== true)
      || rank(n) > rank(before?.class)
    return { id, entry: next, changed, rises }
  }

  // The plugins a change decided for
  private touched(change: Classed): string[] {
    return [...(change.own === null ? [] : [change.own]), ...change.others].map(decided => decided.id)
  }

  // A notice in the trusted window for each of these plugins whose entry owes one, from the class last shown to the one
  // it holds, naming the cause and the plugin whose change it was. Notices take places of their own. One that finds no
  // place stays owed and is raised again once a notice is answered or at the next start, and a notice that says what is
  // no longer owed goes. The class and its asks are stored already, so a notice holds nothing back
  private raiseOwed(ids: Iterable<string>): void {
    for (const id of ids) {
      const entry = this.state.plugins[id]
      const owed = entry?.owed
      // A class not known while the policy job is down: the notice held stays as it was until the class is known again
      if (owed !== undefined && entry!.class === null) continue
      const notice: ClassRaised | null = owed === undefined
        ? null : { kind: 'class.raised', plugin: id, from: owed.from, to: entry!.class!, cause: owed.cause, by: owed.by }
      this.requests.withdraw(held => held.kind === 'class.raised' && held.plugin === id
        && (notice === null || held.from !== notice.from || held.to !== notice.to || held.cause !== notice.cause || held.by !== notice.by))
      if (notice === null) continue
      if (typeof this.requests.raise(notice, null, MAX_PENDING, 'class.raised') !== 'string') this.note('fault', { plugin: id, step: 'class.raised' })
    }
  }

  // The human answered a plugin's notice, with Confirm or Cancel: its entry owes it no longer, and a notice that found
  // no place before can take the one freed
  private async answered(id: string): Promise<void> {
    const entry = this.state.plugins[id]
    if (entry?.owed !== undefined) {
      const next: Plugin = { ...entry }
      delete next.owed
      await this.store.writePlugin(id, next)
      this.putEntry(id, next)
    }
    this.raiseOwed([id])
    this.raiseOwed(Object.keys(this.state.plugins))
  }

  // An approval's entry before it is classed, from the one read the request was made on: its hash, version and the
  // manifest's grants
  private approval(k: Known): Plugin {
    const manifest = k.read.manifest!
    return { version: manifest.version, contentHash: k.read.hash!, signer: null, granted: manifest.capabilities ?? [], class: null, enabled: true }
  }

  // A first-party copy's entry before it is classed, with the human's item switches carried over. A newer version's copy
  // keeps the agents' items, so an update leaves each agent what the human gave it. A restore is Recover and drops them
  private copied(id: string, read: Read, listed: Listed, enabled: boolean, cause: 'copy' | 'restore'): Plugin {
    const granted = read.manifest!.capabilities ?? []
    const before = this.state.plugins[id] ?? null
    const off = carriedOff(before, granted)
    const agents = cause === 'copy' ? before?.agents : undefined
    // A revoked label stays marked either way, until mcp-http-handler says it ended the label's tokens
    const revoked = before?.revoked
    return {
      version: listed.version, contentHash: listed.hash, signer: FIRST_PARTY_SIGNER, granted, class: before?.class ?? null, enabled,
      ...(off.length > 0 ? { off } : {}), ...(agents !== undefined ? { agents } : {}), ...(revoked !== undefined ? { revoked } : {}),
    }
  }

  // Every plugin-folder entry classed again at start from the graph as it stands, before any plugin-folder plugin runs:
  // an app update can change what a core plugin holds with no change to any entry and an entry can be out of date.
  // Only an entry that comes out different is written. One that rises and can't be written still asks in the run, one
  // that lowers keeps its entry. The same pass runs once the human switches the grant risk classifier on again in the run.
  // A move up there that alerts gets its notice
  private async classAll(cause: 'start' | 'slot-on'): Promise<void> {
    let changed = false
    for (const decided of this.classes(cause, null, null, false).others) {
      const { id } = decided
      if (decided.entry === null) continue
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
    // Every notice an entry owes, a new one or one a run before never saw answered
    this.raiseOwed(Object.keys(this.state.plugins))
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

  // What a window's banner shows, from the plugins manager's own states and the state it runs with
  private banner(): CoreStatus {
    const down = new Set(['crashed', 'failed', 'unresponsive'])
    const { switches } = this.state
    return {
      policyJobs: Object.fromEntries(policyJobIds.map(id => [id, this.policyJob(id)])) as CoreStatus['policyJobs'],
      crashed: [
        ...coreModuleIds.filter(id => this.modules.state(id) === 'failed'), ...this.list().filter(row => down.has(row.state)).map(row => row.id),
      ],
      devMode: [...switches.devMode],
      allowUnsigned: switches.allowUnsigned.length,
      skipVerification: switches.skipVerification,
      modulesOff: coreModuleIds.filter(id => !isOne(policyJobIds, id) && this.modules.state(id) === 'off'),
      logWrites: this.logWrites(),
      luoshuPicked: this.state.luoshu !== null,
      page: this.list().filter(row => row.place === 'page' && row.state === 'ready').map(row => row.id),
      pending: this.pending(),
      stopped: this.stoppedMode,
      suspect: [...this.suspect],
    }
  }

  list(): Listing[] {
    const rows: Listing[] = [...this.known.values()].map(k => ({
      id: k.id, from: k.from, place: k.place, state: k.state, reason: k.reason, incarnation: k.live?.n ?? k.incarnations,
    }))
    for (const [id, reason] of this.strays) rows.push({ id, from: 'folder', place: 'sandboxed', state: 'refused', reason, incarnation: 0 })
    return rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.from < b.from ? -1 : 1))
  }

  // ---- boot

  // In boot's order: the install checked, the core modules started, the install's plugins started, the first-party
  // reconcile, every plugin-folder entry classed again, the plugin folder scanned and its plugins started in graph
  // order. core.ready closes it with every policy job's state, unless a shutdown began on the way
  async start(): Promise<void> {
    await this.readInstall()
    this.failedBefore = await readFailedOnce(this.dataDir)
    // An install list that can't be read counts as tampered, since it ships inside hetu's own files. The core modules
    // start only once it passed
    if (this.listResult === 'invalid') {
      return this.enterStopped({ control: 'install', why: 'tampered', reason: null, again: this.failedBefore !== null })
    }
    await this.modules.start(this.state.switches.off, {
      grants: () => this.grantsSnapshot(),
      exec: () => this.execView(),
      folder: () => this.state.luoshu?.folder ?? null,
      readyMs: id => this.limitOf(id, 'readyMs'),
      fault: (id, step) => this.note('fault', { plugin: id, step }),
      changed: (id, change, reason) => this.note('module.state', { module: id, state: change, reason }),
      heartbeat: {
        ping: plugin => this.link.send(plugin.caller, { v: VERSION, kind: 'ping' }),
        unresponsive: plugin => this.missed(plugin, true),
        kill: plugin => this.missed(plugin, false),
        limit: (plugin, name) => this.limitOf(plugin, name),
      },
    })
    this.phase = 'all'
    this.replan()
    await this.settled()
    await this.saveInstalled()
    await this.reconcile()
    // In the changes' turn, since a restore needs no plugin the scan found and could write an entry under the pass
    await this.serial(() => this.classAll('start'))
    this.classedAtStart = true
    await this.scan()
    this.replan()
    await this.settled()
    if (!this.closing) this.note('core.ready', Object.fromEntries(policyJobIds.map(id => [id, this.policyJob(id)])))
  }

  // The stopped mode hetu is in, null while it runs, and whether the native box shows it with quit only, since the
  // security view that holds its choices is off
  stopped(): StoppedMode | null {
    return this.stoppedMode
  }
  stoppedBox(): boolean {
    return this.modules.securityView() === null
  }

  // The stopped mode: every plugin stops and none starts, then the core modules close in the reverse of their start, the
  // gate last, so nothing acts while nothing can be recorded. Only the trusted window opens, with the human's three
  // choices
  private async enterStopped(mode: StoppedMode): Promise<void> {
    this.stoppedMode = mode
    this.phase = 'stopped'
    this.note('core.stopped', { control: mode.control, why: mode.why, reason: mode.reason, again: mode.again })
    this.replan()
    await this.pumped()
    this.modules.stop(this.state.switches.off)
    this.replan()
  }

  // The core's log failed while hetu ran, the one failure that stops hetu. The first time, the restart marker goes down and the runtime quits with an
  // error to start hetu again. When the run before already restarted for a failure, hetu stops in the stopped mode
  // instead, so a log failing again and again can't restart it forever. A marker that can't be written stops it too,
  // since nothing would then bound the restarts. One failure is enough, the ones after it change nothing. Answers
  // whether it took the failure, so a failure told while hetu starts or stops can be told again
  controlFailed(control: 'log', reason: 'log-failing'): boolean {
    if (this.closing || this.phase !== 'all' || this.failing) return false
    this.failing = true
    this.note('core.failed', { control, reason })
    const stop = (again: boolean) => {
      const mode: StoppedMode = { control, why: 'failed', reason, again }
      void this.enterStopped(mode).finally(() => this.tell({ action: 'stopped', mode, box: this.stoppedBox() }))
    }
    if (this.failedBefore !== null) {
      stop(true)
      return true
    }
    // Shutdown and a clean Quit wait for the write, so neither can cut it off or clear it first
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

  // Shutdown after the windows: every plugin in reverse graph order, then the core modules end what they run. The gate
  // and the grant risk classifier answer to the end. The router hears it first, so nothing stopped for shutdown reads
  // as down
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
    this.modules.close()
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
  }

  // The marker for the next run: every core plugin's version and hash, except one whose update hasn't applied yet,
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

  // Applies only once its record has landed, so the copy's core record is on disk before the entry widens anything. A
  // restore is asked for on a Confirm, a copy at start has none
  private async copy(id: string, read: Read, listed: Listed, cause: 'copy' | 'restore', enabled: boolean, previous: string | null, confirm = false): Promise<boolean> {
    const dir = await stage(this.dataDir, id, read.files)
    const landing = await this.landing(id, cause === 'restore' ? 'plugin.restored' : 'plugin.copied', { plugin: id, version: listed.version })
    if (landing === 'lost') {
      await clear(dir).catch(() => {})
      return false
    }
    await swapIn(this.dataDir, id, dir)
    if (previous !== null && previous !== listed.version) await this.clearSpace('cache', id).catch(() => {})
    const change = this.classes(cause, id, this.copied(id, read, listed, enabled, cause), confirm)
    const entry = this.withMarks(id, change.own!.entry!)
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.putEntry(id, entry)
    await this.marksHandedBack(id)
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
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
      id, from, root, listed, entry, read, place: placeOf(id, read, from), state: 'found', reason: null, held: null,
      live: null, incarnations: 0, lastStop: null, previousVersion: this.versions.get(id) ?? null,
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

  private isPolicyJob(id: string): boolean {
    return isOne(policyJobIds, id)
  }

  private expected(): string[] {
    const guards = guardableActions.flatMap(action => this.guardsFor(action))
    return [...new Set([...policyJobIds, ...guards])]
  }

  // Policy job holders, providers and guards fill roles only a host half in main could hold, and the core runs none
  private needsHost(id: string): boolean {
    return this.isPolicyJob(id) || isOne(Object.values(providers), id) || this.expected().includes(id)
  }

  // Policy job holders require nothing and can't be required. Core plugins require only core plugins and core modules
  private requiresProblem(k: Known): boolean {
    const requires = k.read.manifest?.requires ?? []
    if (this.isPolicyJob(k.id) && requires.length > 0) return true
    return requires.some(id => this.isPolicyJob(id) || (k.from === 'install' && !isOne(corePluginIds, id) && !isModule(id)))
  }

  // What the checks and this run make of a plugin, before the graph. The human's switch comes first, so a plugin the
  // human switched off reads off whatever its check said and a failed check never reads as off
  private status(k: Known): Status {
    return k.from === 'install' ? this.installStatus(k) : this.folderStatus(k)
  }

  // Dev mode on a core plugin loads its bytes unhashed, from the install and never from the plugin folder
  private installStatus(k: Known): Status {
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

  private moduleStatus(id: CoreModuleId): Status {
    const state = this.modules.state(id)
    if (state === 'on') return ok
    if (state === 'off') return { kind: 'off' }
    if (state === 'failed') return { kind: 'held', state: 'failed', reason: this.modules.reason(id) ?? 'start-failed' }
    return { kind: 'held', state: 'stopped', reason: this.modules.reason(id) ?? 'starting' }
  }

  // Whether a core module serves as the graph reads it: on, with what it requires serving too. History waits on the
  // luoshu. Before the first plan only its own state counts
  private moduleServes(id: CoreModuleId): boolean {
    const verdict = this.planned.verdicts.get(id)
    return this.modules.state(id) === 'on' && (verdict === undefined || verdict.kind === 'start')
  }

  // A core module's row as the graph reads it: waiting while a module it requires can't serve, else its own state
  private moduleRow(id: CoreModuleId): { state: PluginState, reason: string | null } {
    const state = this.modules.state(id)
    const verdict = this.planned.verdicts.get(id)
    if (state === 'on' && verdict?.kind === 'waiting') return { state: 'waiting', reason: verdict.reason }
    return { state: state === 'on' ? 'ready' : state, reason: state === 'on' ? null : this.modules.reason(id) }
  }

  // Whether a requirement can serve: a core module while it serves, a plugin once ready
  private serves(id: string): boolean {
    return isModule(id) ? this.moduleServes(id) : this.known.get(id)?.state === 'ready'
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
  // waiting before the router answers a call. The stops and starts it calls for follow in the pump. Each core module is
  // a node too, ok while on, so a plugin requiring one runs only while it is
  private replan(): void {
    const nodes: Node[] = [
      ...coreModuleIds.map(id => ({ id, status: this.moduleStatus(id), requires: moduleRequires[id], rank: -1 })),
      ...[...this.known.values()].map(k => ({ id: k.id, status: this.status(k), requires: k.read.manifest?.requires ?? [], rank: this.rank(k) })),
    ]
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
    // A plugin in its stop grace can still save
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
        return { state: 'found', reason: null }
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

  // Tells the router, records each policy job that changed and sends deps to every plugin whose own requirements changed
  private refresh(): void {
    for (const id of this.expected()) {
      const now = this.policyJob(id)
      if (this.lastPolicyJobs.get(id) === now) continue
      this.lastPolicyJobs.set(id, now)
      this.note('policy-job.state', { policyJob: id, state: now })
    }
    try {
      this.link.changed()
    } catch {}
    this.sendDeps()
    this.checkIdle()
  }

  // A plugin's own requires and plugin.call targets, as it may know them. A core module is ready while on
  private depsOf(k: Known): Record<string, DepState> {
    const granted = k.from === 'install' ? k.read.manifest?.capabilities ?? [] : k.entry?.granted ?? []
    const targets = granted.flatMap(item => (item.type === 'plugin.call' ? item.targets : []))
    const deps: Record<string, DepState> = {}
    for (const id of [...new Set([...(k.read.manifest?.requires ?? []), ...targets])].sort()) {
      if (isModule(id)) {
        deps[id] = this.moduleServes(id) ? 'ready' : this.modules.state(id) === 'starting' ? 'starting' : 'unavailable'
        continue
      }
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

  // In graph order, each once its requirements serve
  private startAll(): void {
    if (this.closing) return
    for (const id of this.planned.order) {
      const k = this.known.get(id)
      if (k !== undefined && this.startable(k)) this.begin(k)
    }
  }

  private startable(k: Known): boolean {
    if (k.live !== null || !this.runs(k)) return false
    return (k.read.manifest?.requires ?? []).every(id => this.serves(id))
  }

  // ---- starting

  private begin(k: Known): void {
    const n = (this.minted.get(k.id) ?? 0) + 1
    this.minted.set(k.id, n)
    k.incarnations = n
    const live: Live = { n, halves: new Map(), readyTimer: null, stopTimer: null, stop: null, beating: null, with: [], over: false, deps: '' }
    k.live = live
    k.state = 'starting'
    k.reason = null
    this.refresh()
    void this.launch(k, live)
  }

  private async launch(k: Known, live: Live): Promise<void> {
    try {
      if (k.updated !== null) await this.applyInstalled(k)
      if (live.over) return
      this.mint(k, live)
    } catch {
      if (!live.over) this.die(k, 'start-failed')
    }
  }

  // An app update to a core plugin: once plugin.updated has landed its cache is cleared and it hears the version
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

  // Mints each half's port and registers it with the router in the same step, starts the half from the verified bytes
  // and sends init down its way. ready must come within readyMs
  private mint(k: Known, live: Live): void {
    const manifest = k.read.manifest!
    const { host, worker } = manifest.entries
    live.readyTimer = setTimeout(() => {
      if (!live.over && k.live === live && k.state === 'starting') this.die(k, 'start-timeout')
    }, this.limitOf(k.id, 'readyMs'))
    live.readyTimer.unref?.()
    const caller = (half: HalfName): Caller => frozen({ kind: 'plugin', id: k.id, half, incarnation: live.n })

    if (host !== undefined && k.place === 'utility') {
      // Its own process on its own port, registered for its host half as a worker's is. Nothing of its module comes back
      // to main, so it holds no role
      const run: Run = { caller: caller('host'), ready: false, stopped: false }
      const { core, plugin } = this.runtime.channel(k.id, true)
      this.link.register(core, run.caller)
      live.halves.set('host', run)
      const code = k.read.files.find(file => file.path === host)!.bytes
      this.runtime.startUtility({ id: k.id, incarnation: live.n, code, port: plugin, exited: how => this.exited(k, live, how.killed) })
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
    for (const run of live.halves.values()) this.link.send(run.caller, init)
    // A plugin with no half to start, frames or a page only, is ready once checked
    this.readied(k, live)
  }

  private readied(k: Known, live: Live): void {
    if (live.over || k.live !== live || k.state !== 'starting') return
    if ([...live.halves.values()].some(run => !run.ready)) return
    if (live.readyTimer !== null) clearTimeout(live.readyTimer)
    live.readyTimer = null
    k.state = 'ready'
    k.reason = null
    k.previousVersion = null
    this.versions.delete(k.id)
    this.note('plugin.started', { plugin: k.id, incarnation: live.n })
    // The heartbeat watches the worker's half or the utility half, whose every message main hears answers a beat
    const pinged = live.halves.get(k.place === 'utility' ? 'host' : 'worker')
    live.beating = pinged === undefined ? null : frozen({ plugin: k.id, caller: pinged.caller, utility: k.place === 'utility' })
    if (live.beating !== null) this.modules.heartbeat()?.started(live.beating)
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

  // A planned stop ended, each half having answered stopped or the grace having run out
  private finished(k: Known, live: Live): void {
    if (live.over) return
    const stop = live.stop
    const reason = stop?.reason ?? this.stopReason(k)
    this.retire(k, live)
    k.lastStop = reason
    this.note('plugin.stopped', { plugin: k.id, incarnation: live.n, reason, with: live.with.join(',') })
    this.replan()
    this.release(k, live, 'stopped')
    stop?.end()
  }

  // A crash or a utility half whose bind failed, which crashed nothing. The states change first, every dependent
  // waiting, then the ways end, so no call is answered before the dependents moved
  private die(k: Known, reason: StopReason): void {
    const live = k.live
    if (live === null || live.over) return
    if (live.stop !== null) return this.finished(k, live)
    this.retire(k, live)
    const state = isOne(bindFailures, reason) ? 'failed' : 'crashed'
    k.held = { kind: 'held', state, reason }
    k.lastStop = reason
    this.note(`plugin.${state}`, { plugin: k.id, incarnation: live.n, reason })
    this.replan()
    this.release(k, live, 'crashed')
  }

  // A utility process ended. During a planned stop that is the stop ending. Otherwise it crashed, killed when the
  // runtime ended it and exited when it ended by itself, whatever its exit code said. An incarnation that is over
  // decides nothing
  private exited(k: Known, live: Live, killed: boolean): void {
    if (live.over || k.live !== live) return
    if (live.stop !== null) return this.finished(k, live)
    this.die(k, killed ? 'killed' : 'exited')
  }

  // The heartbeat's ask once a plugin missed its beats. A worker reads unresponsive until it answers: calls to it time out
  // at once and nothing is closed. A hung utility half still holds what it opened, so it is killed and reads crashed
  private missed(plugin: Beating, worker: boolean): void {
    const found = this.runOf(plugin.caller)
    if (found === null || found.live.stop !== null) return
    if (!worker) return this.die(found.k, 'unresponsive')
    if (found.k.state !== 'ready') return
    found.k.state = 'unresponsive'
    this.note('plugin.unresponsive', { plugin: found.k.id, incarnation: found.live.n })
    this.refresh()
  }

  private retire(k: Known, live: Live): void {
    if (live.beating !== null && !live.over) this.modules.heartbeat()?.stopped(live.beating)
    live.over = true
    if (live.readyTimer !== null) clearTimeout(live.readyTimer)
    if (live.stopTimer !== null) clearTimeout(live.stopTimer)
    live.readyTimer = null
    live.stopTimer = null
    if (k.live === live) k.live = null
  }

  // Ends the worker and revokes the incarnation's ways, so nothing it sends counts again. A request whose change is the
  // plugin's to use goes with it, so no Confirm applies one for a plugin that stopped
  private release(k: Known, live: Live, code: 'stopped' | 'crashed'): void {
    this.requests.withdraw(change => withdrawnWith(change).includes(k.id))
    if (k.id === agentDoor.plugin) this.connects.ended()
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
    if (k.place === 'utility' && live.halves.has('host')) {
      try {
        this.runtime.kill(k.id, live.n)
      } catch {}
    }
  }

  // ---- stops and restarts the human asked for

  // Stops a plugin and its dependents, dependents first. It stays stopped until a restart
  async stop(id: string, by: 'human'): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw { code: 'not-found' }
    if (k.held === null) k.held = { kind: 'held', state: 'stopped', reason: by }
    this.replan()
    await this.pumped()
  }

  // A new incarnation from the bytes already verified. A running one stops first with its dependents, which start again
  // once it is ready
  async restart(id: string, by: 'human'): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw { code: 'not-found' }
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

  // A security request from a window, which the security view decides. The router has checked the caller is a window
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

  // An agent's ask for items through the agent host, raised as a request only the core raises. The items the agent
  // holds already are left out and the rest put in key order, so the same ask in another order finds the request
  // waiting. One ask waits for a label at a time and a label whose ask the human cancelled waits AGENT_ASK_PAUSE_MS
  private agentAsk(label: string | undefined, capabilities: Capability[]): ActionResults['core.agentAsk'] {
    if (!agentLabel.safeParse(label).success) throw { code: 'invalid' }
    const agent = label!
    const entry = this.hostEntry()
    if (entry === null) throw { code: 'unavailable' }
    // A revoked authorization asks for nothing again, an agent comes back only as a new one with a new number
    if (marksOf(entry, this.state.switches).includes(agent)) throw { code: 'not-granted' }
    const paused = this.askPaused.get(agent)
    if (paused !== undefined && this.clock() < paused) throw { code: 'throttled' }
    const held = new Set((entry.agents ?? []).filter(item => item.agent === agent).map(item => capabilityKey(item.capability)))
    const wanted = new Map<string, Capability>()
    for (const capability of capabilities) if (!held.has(capabilityKey(capability))) wanted.set(capabilityKey(capability), capability)
    if (wanted.size === 0) return { asked: 'granted' }
    const keys = [...wanted.keys()].sort()
    const change: AgentAsk = { kind: 'agent.ask', plugin: agentHost, agent, capabilities: keys.map(key => wanted.get(key)!) }
    // Refused here what a Confirm could never write, so no ask waits in front of the human only to fail: an item with
    // no scope or the items every agent holds with these added past the entry's caps for one agent or for all
    if (!agentAskChange.safeParse(change).success) throw { code: 'invalid' }
    // A plugin.call target names a plugin hetu knows, so an ask can't put words of its choosing in the target's place
    const unknown = (capability: Capability) => capability.type === 'plugin.call' && capability.targets.some(target => !this.known.has(target))
    if (change.capabilities.some(unknown)) throw { code: 'not-found' }
    if (!agentItems.safeParse(withAsked(entry.agents ?? [], change)).success) throw { code: 'invalid', reason: 'too-large' }
    const waiting = this.requests.changes().find(({ change: one }) => one.kind === 'agent.ask' && one.agent === agent)?.change as AgentAsk | undefined
    if (waiting !== undefined && waiting.capabilities.map(capabilityKey).join('\n') !== keys.join('\n')) throw { code: 'throttled' }
    if (typeof this.requests.raise(change, null, MAX_PENDING, 'agent.ask') !== 'string') throw { code: 'throttled' }
    return { asked: 'waiting' }
  }

  // The agent host's entry while the host is a plugin-folder plugin the human has on, the one entry agents' items sit in
  private hostEntry(): Plugin | null {
    const k = this.known.get(agentHost)
    return k?.from === 'folder' && k.entry !== null && k.entry.enabled ? k.entry : null
  }

  // Applies a change exactly as stored through the one StateStore. A write that fails applies nothing. Each applied
  // change raises the grants snapshot by one. Requests reach it through the Confirm, tests and the plugins manager's own reconcile
  // directly
  apply(input: Change): Promise<void> {
    return this.serial(async () => {
      await this.applyNow(changeSchema.parse(input), true)
    })
  }

  // One change or update at a time, so no two read the state and write it back over each other
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work)
    this.queue = run.catch(() => {})
    return run
  }

  // confirm is whether the human clicked the change's Confirm, false for one Confirm-off or its narrowing applied at once
  private async applyNow(change: Change, confirm: boolean): Promise<void | 'unchanged'> {
    // The human chose in the stopped mode, so the next failure restarts hetu again
    if (this.phase === 'stopped') await clearFailedOnce(this.dataDir).catch(() => {})
    switch (change.kind) {
      case 'plugin.on':
      case 'plugin.off':
        return this.switchPlugin(change.plugin, change.kind === 'plugin.on')
      case 'plugin.approve':
        return this.approve(change.plugin, confirm)
      case 'plugin.remove':
        return this.remove(change.plugin, confirm)
      case 'plugin.restore':
        return this.restore(change.plugin, confirm)
      case 'plugin.update':
        return this.applyStaged(change.plugin, confirm)
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
      case 'allowUnsigned':
        return this.writeSwitches({ ...this.state.switches, allowUnsigned: toggled(this.state.switches.allowUnsigned, change.hash, change.on) })
      case 'limit.set': {
        const { limits } = this.state.switches
        const all = bare({ ...limits.all })
        const plugins = bare({ ...limits.plugins })
        if (change.plugin === null) all[change.constant] = change.value
        else plugins[change.plugin] = bare({ ...plugins[change.plugin], [change.constant]: change.value })
        await this.writeSwitches({ ...this.state.switches, limits: { all, plugins } })
        // A raise as well as a lowering, so a half paces itself to what the router now counts it against
        for (const id of change.plugin === null ? [...this.known.keys()] : [change.plugin]) this.limited(id)
        return
      }
      case 'luoshu.pick': {
        await this.store.writeLuoshu({ folder: change.folder })
        this.state = { ...this.state, luoshu: { folder: change.folder } }
        // The luoshu and history take the folder now, exec with the bump. One that is off takes it once switched on. A
        // module that failed or recovered on the folder moves what requires it
        return this.bump(this.modules.picked())
      }
      case 'item.on':
      case 'item.off':
        return this.switchItem(change.plugin, change.capability, change.kind === 'item.on')
      case 'grant.widen':
      case 'grant.narrow':
        return this.grant(change.plugin, change.capability, change.kind === 'grant.widen', confirm)
      case 'plugin.clearStorage':
        return this.clearStorage(change.plugin)
      case 'plugin.reset':
        return this.reset(change.plugin, confirm)
      // Answered: the class and its asks were stored when the notice was raised
      case 'class.raised':
        return this.answered(change.plugin)
      case 'agent.ask':
        return this.agentGrant(change)
      case 'agent.revoke':
        return this.agentRevoke(change.agent)
      // Hands mcp-http-handler its yes and changes no state
      case 'agent.connect':
        return this.connects.confirmed(change)
    }
  }

  // Whether the core holds the label already, from what it holds for the agent host and no list of its own: items on
  // the entry, a revoked mark or an ask waiting. A connect for such a label would hand a new authorization another's
  private labelHeld(label: string): boolean {
    const k = this.known.get(agentHost)
    const entry = k?.from === 'folder' ? k.entry : null
    return (entry?.agents ?? []).some(item => item.agent === label) || marksOf(entry, this.state.switches).includes(label)
      || this.requests.changes().some(({ change }) => change.kind === 'agent.ask' && change.agent === label)
  }

  // Every item of the label goes with its ask waiting, then the label is marked revoked until mcp-http-handler says it ended its
  // tokens, on the entry or in the switches while the agent host has none. Only that label: a label another one begins
  // with keeps its own. A label that holds nothing is marked only when the core saw it ask in this run, its ask waiting
  // or the pause after a Cancel still running, so the human can turn away an agent that only asks and no window can
  // fill the list with labels that never asked. Any other label that holds nothing changes nothing and answers unchanged
  private async agentRevoke(agent: string): Promise<void | 'unchanged'> {
    const k = this.known.get(agentHost)
    const entry = k?.from === 'folder' ? k.entry : null
    const waiting = (change: Change) => change.kind === 'agent.ask' && change.agent === agent
    const asked = this.requests.changes().some(({ change }) => waiting(change))
    this.requests.withdraw(waiting)
    const holds = (entry?.agents ?? []).some(item => item.agent === agent)
    const paused = this.askPaused.get(agent)
    const seen = asked || (paused !== undefined && this.clock() < paused)
    if (!holds && (!seen || marksOf(entry, this.state.switches).includes(agent))) return 'unchanged'
    if (entry === null) {
      const aside = revokedAside(this.state.switches, agent)
      await this.writeSwitches(aside.switches)
      return this.markDropped(aside.dropped, agent)
    }
    const next = revoked(entry, agent)
    await this.store.writePlugin(agentHost, next.entry)
    this.putEntry(agentHost, next.entry)
    this.bump()
    this.markDropped(next.dropped, agent)
  }

  // A mark dropped to make room for a newer one, recorded with the label whose revoke or hand back dropped it
  private markDropped(dropped: readonly string[], agent: string | null): void {
    for (const target of dropped) this.note('agent.markDropped', { target, for: agent })
  }

  // Before the agent host's entry goes in a Reset or a Remove: its marks held in the switches, so no revoked label is
  // taken as unknown while the host has no entry
  private async setMarksAside(id: string): Promise<void> {
    if (id !== agentHost) return
    const aside = setAside(this.state.switches, this.state.plugins[id] ?? null)
    if (aside === null) return
    await this.writeSwitches(aside.switches)
    this.markDropped(aside.dropped, null)
  }

  // The agent host's next entry with the marks the switches hold
  private withMarks(id: string, entry: Plugin): Plugin {
    if (id !== agentHost) return entry
    const back = handedBack(entry, this.state.switches)
    this.markDropped(back.dropped, null)
    return back.entry
  }

  // Once the agent host's entry holds the marks, the switches hold none
  private async marksHandedBack(id: string): Promise<void> {
    if (id !== agentHost) return
    const next = cleared(this.state.switches)
    if (next !== null) await this.writeSwitches(next)
  }

  // For mcp-http-handler, whether each label holds items, holds none or is revoked, after the marks of the labels mcp-http-handler heard went.
  // A mark goes only for a label marked, so a heard naming none writes nothing and stales no ask
  private agentsFor(agents: string[], heard: string[]): Promise<ActionResults['core.agents']> {
    return this.serial(async () => {
      const k = this.known.get(agentHost)
      let entry = k?.from === 'folder' ? k.entry : null
      const out = heardOut(entry, this.state.switches, heard)
      if (out.entry !== null) {
        await this.store.writePlugin(agentHost, out.entry)
        this.putEntry(agentHost, out.entry)
        entry = out.entry
      }
      if (out.switches !== null) await this.writeSwitches(out.switches)
      const marks = marksOf(entry, this.state.switches)
      return agents.map(agent => ({
        agent,
        holds: marks.includes(agent) ? 'revoked' : (entry?.agents ?? []).some(item => item.agent === agent) ? 'items' : 'none',
      }))
    })
  }

  // An agent's ask confirmed: its items added to that label's on the agent host's entry in one write through the entry's
  // own schema, so none are written when one can't be. No class moves, since no agent's item counts as the host's own
  private async agentGrant(change: AgentAsk): Promise<void> {
    const entry = this.hostEntry()
    if (entry === null) throw new Error('the agent host is not on')
    if (marksOf(entry, this.state.switches).includes(change.agent)) throw new Error('a revoked agent')
    const next: Plugin = { ...entry, agents: withAsked(entry.agents ?? [], change) }
    await this.store.writePlugin(agentHost, next)
    this.putEntry(agentHost, next)
    this.bump()
  }

  // A capability added to a folder plugin's entry or taken out with its switch. Adding one it holds changes nothing
  private async grant(id: string, capability: Capability, add: boolean, confirm: boolean): Promise<void> {
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
    const change = this.classes(add ? 'widen' : 'narrow', id, changed, confirm)
    const next = change.own!.entry!
    await this.settle(change.others, true)
    await this.store.writePlugin(id, next)
    this.putEntry(id, next)
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
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

  // Recover's reset: storage and cache cleared. A folder plugin's entry goes, so it waits for approval again with the
  // code it has. A core plugin waits for Restart hetu. A core module has no reset, its switch is the way out
  private async reset(id: string, confirm: boolean): Promise<void> {
    if (isModule(id)) throw new Error(`${id} is a core module`)
    const k = this.known.get(id)
    if (k === undefined) throw new Error(`no plugin ${id}`)
    await this.stoppedWhile(k, async () => {
      for (const kind of ['storage', 'cache'] as const) await this.clearSpace(kind, id)
      // A limit the human set for the plugin goes too, since one too low makes it fail again at every start
      const { limits } = this.state.switches
      if (Object.hasOwn(limits.plugins, id)) {
        const plugins = bare({ ...limits.plugins })
        delete plugins[id]
        await this.writeSwitches({ ...this.state.switches, limits: { all: limits.all, plugins } })
      }
      if (k.from === 'folder' && k.entry !== null) {
        const change = this.classes('reset', id, null, confirm)
        await this.settle(change.others, true)
        await this.setMarksAside(id)
        await this.store.removePlugin(id)
        delete this.state.plugins[id]
        await this.settle(change.others, false)
        this.raiseOwed(this.touched(change))
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

  // One applied change: a new grants snapshot pushed to the gate, exec's view of the grants renewed with it and the router
  // told. When a core module failed or recovered on the way, with this push or one just before it, the plan is made
  // again so what requires it waits or starts
  private bump(moved = false): void {
    this.n++
    const changed = this.modules.bumped() || moved
    if (changed) this.replan()
    else this.refresh()
  }

  // One item a folder plugin was granted switched on or off. A core plugin's grants are its manifest, so it has
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

  // Each plugin's grants as the gate judges them, copied so freezing them leaves the plugins manager's own alone. A folder
  // plugin's come from its entry in the state, which boot loaded before the gate's first grants snapshot and before the plugin
  // folder is scanned. A core plugin's come from its manifest, read before any plugin starts. An item the entry
  // switched off is off. An item in the entry's firstUse list asks at its first use, except while the human has the
  // grant risk classifier switched off, when nothing asks. A core plugin's items never ask
  private grantsSnapshot(): GrantsSnapshot {
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
    // Each agent's items by its label, from the agent host's entry while the human has the host on. None of them is the
    // host's own, so none switches off or asks at first use
    const agents: Record<string, GrantedItem[]> = Object.create(null)
    const host = this.state.plugins[agentHost]
    if (host?.enabled === true && this.known.get(agentHost)?.from !== 'install') {
      for (const { agent, capability } of host.agents ?? []) {
        if (!Object.hasOwn(agents, agent)) agents[agent] = []
        agents[agent].push({ capability: structuredClone(capability), off: false, firstUse: false })
      }
    }
    return frozen({ n: this.n, foldCase: false, plugins, execAny: [...this.state.switches.execAnyCommand], agents })
  }

  // The folder in the state and hetu's own folders, which no command exec runs may take code from
  private opening(): Opening {
    return { folder: this.state.luoshu?.folder ?? null, dataDir: this.dataDir, installDir: this.installDir }
  }

  // What exec checks a command against on its own, read from the grants snapshot: each plugin's exec items that are on. Exec
  // keeps this list with the gate off, so an item the human switched off leaves it, or the command would run again
  // exactly when the gate isn't there to refuse it. With them the plugins the human let run any command and the folders
  // no command may run code from. Read-only
  private execView(): ExecView {
    const plugins: Record<string, ExecGrant[]> = Object.create(null)
    for (const [id, items] of Object.entries(this.grantsSnapshot().plugins)) {
      const held: ExecGrant[] = []
      for (const { capability, off } of items) {
        if (capability.type === 'exec' && !off) held.push({ commands: capability.commands.map(command => [...command]), env: [...capability.env] })
      }
      if (held.length > 0) plugins[id] = held
    }
    return frozen({ plugins, any: [...this.state.switches.execAnyCommand], opening: this.opening() })
  }

  private putEntry(id: string, entry: Plugin): void {
    this.state.plugins[id] = entry
    this.entryChecks.set(id, 'ok')
    const k = this.known.get(id)
    if (k !== undefined) k.entry = entry
  }

  // A core module's switch is written, then the module is closed or started again with it, so the grants snapshot and
  // the plan that follow read it as the switch says. The grant risk classifier switched on again in the run classes
  // every entry at once
  private async switchPlugin(id: string, on: boolean): Promise<void> {
    if (isModule(id)) {
      const next = { ...this.state.switches, off: toggled(this.state.switches.off, id, !on) }
      await this.store.writeSwitches(next)
      this.state = { ...this.state, switches: next }
      await this.modules.apply(next.off)
      // The gate hears the switch at once, so with the classifier on again every item not yet classed asks from the
      // change on. The pass that classes every entry follows in the changes' turn, as it did once the classifier
      // started. One bump, so the grants snapshot grows by one for the change
      this.bump()
      // Flood control paces every running half's messages, so each paces itself as it now stands
      if (id === 'flood-control') for (const known of this.known.keys()) this.limited(known)
      // The heartbeat on watches every plugin that runs. Off, nothing reads unresponsive, so a call fails on its own deadline
      for (const k of id === 'heartbeat' ? this.known.values() : []) {
        if (on && k.live?.beating && !k.live.over) this.modules.heartbeat()?.started(k.live.beating)
        else if (!on && k.state === 'unresponsive') k.state = 'ready'
      }
      if (on && id === 'grant-risk-classifier' && this.classedAtStart) {
        void this.serial(() => this.classAll('slot-on')).catch(() => this.note('fault', { plugin: 'grant-risk-classifier', step: 'reclass' }))
      }
      this.replan()
      return
    }
    const k = this.known.get(id)
    if (k === undefined) throw new Error(`no plugin ${id}`)
    if (k.from === 'install') return this.writeSwitches({ ...this.state.switches, off: toggled(this.state.switches.off, id, !on) })
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
  private async approve(id: string, confirm: boolean): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'folder' || k.entry !== null || this.status(k).kind !== 'found') {
      throw new Error(`nothing to approve for ${id}`)
    }
    const change = this.classes('approve', id, this.approval(k), confirm)
    const entry = this.withMarks(id, change.own!.entry!)
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.putEntry(id, entry)
    await this.marksHandedBack(id)
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
    this.bump()
    this.replan()
  }

  // The entry goes first so nothing can run, then the plugin stops with its dependents, then its code, storage and
  // cache. A first-party plugin leaves a tombstone, written before anything else
  private async remove(id: string, confirm: boolean): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined || k.from !== 'folder') throw new Error(`${id} is not a plugin-folder plugin`)
    const change = this.classes('remove', id, null, confirm)
    await this.settle(change.others, true)
    if (isOne(firstPartyIds, id) && !isOne(this.state.switches.removed, id)) {
      await this.writeSwitches({ ...this.state.switches, removed: [...this.state.switches.removed, id] })
    }
    await this.setMarksAside(id)
    await this.store.removePlugin(id)
    delete this.state.plugins[id]
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
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
  private async restore(id: string, confirm: boolean): Promise<void> {
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
    const copied = await this.copy(id, read, listed, 'restore', entry?.enabled ?? true, entry?.version ?? null, confirm)
    if (!copied) throw new Error('the restore record did not land')
    const now = this.know(id, 'folder', folders.plugins(this.dataDir, id), read, null, this.state.plugins[id])
    if (k !== undefined) now.lastStop = k.lastStop
    this.replan()
  }

  // ---- staged updates

  // An update staged beside the old version, resolved against the live graph before anything changes. One that closes
  // a cycle is refused, and so is a version that isn't newer, so an old release with a known hole can't be swapped
  // back in. Every other one waits for the human's Confirm, raised as plugin.update naming the running plugins it
  // stops, itself and its dependents included, unless the grant risk classifier answers that it loads unasked. The signer is checked against the pin once provenance exists. A
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
    // An update loads on its own only when the grant risk classifier answers that it does, so never while it is off or
    // down. Its record lands first as any update's does
    if (this.classes('update', id, k.entry, false, read.manifest!.capabilities ?? []).unasked) {
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
    const change = this.classes('update', id, { ...old, version: to, contentHash: read.hash! }, confirm)
    const entry = change.own!.entry!
    await this.settle(change.others, true)
    await this.store.writePlugin(id, entry)
    this.state.plugins[id] = entry
    this.entryChecks.set(id, 'ok')
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
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
    k.place = placeOf(k.id, read, 'folder')
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

  private limitOf(id: string, name: LimitName): number {
    let value: number = defaultLimits[name]
    try {
      const given = this.link.limit(id, name)
      if (Number.isSafeInteger(given) && given > 0) value = given
    } catch {}
    return Math.min(value, MAX_TIMER_MS)
  }

  // Nothing goes to recording while the human has it off. What waited on a record applies at once. A record recording
  // threw on counts as one that did not land
  private record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<'landed' | 'muted' | 'lost'> {
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
  private async landing(plugin: string, event: string, fields: Record<string, string | number | boolean | null>): Promise<'landed' | 'muted' | 'lost'> {
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

  private note(event: string, fields: Record<string, string | number | boolean | null>): void {
    void this.record(event, fields)
  }
}

