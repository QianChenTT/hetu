import { START_HUNG, type CoreStatus, type HeldRequest, type ListedPlugin, type SecurityList } from '../../api/actions.ts'
import type { Change } from '../../api/changes.ts'
import { describeChange } from '../../api/describe.ts'
import { capabilityText } from '../../api/trusted.ts'
import { VERSION } from '../../api/envelope.ts'
import { coreModuleIds, failSafeControls, isSecurityControl } from '../../api/ids.ts'
import { type BindFailure } from '../../api/lifecycle.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import type { PluginTable } from '../../api/policy-jobs.ts'
import type { Plugin } from '../boot/header.ts'
import type { Served } from '../router/header.ts'
import { clearStartMarker, readFailedOnce, readStartMarkers, writeStartMarker } from './folders.ts'
import { type ConnectAsked } from './connects.ts'
import { viewsOf } from './reads.ts'
import { PluginsChanges } from './changes.ts'
import { type PluginsManagerOptions, type Listing, isModule, isOne } from './base.ts'

export { type Listing, type PluginsManagerOptions, type UpdateOutcome } from './base.ts'

// The plugins manager: what may run, where, when and as whom. It checks every plugin's bytes once before they run, places each
// by where its code came from, resolves the requires graph, mints every port and owns every lifecycle state. It starts
// the core modules, hands them each change and switches them as the human does. It runs no plugin code itself and
// decides no grant
export class PluginsManager extends PluginsChanges implements PluginTable {
  constructor(options: PluginsManagerOptions) {
    super(options)
    // Handed to the router through its door, which calls them and never names the plugins manager
    this.link.serve('plugins-manager', this.serve)
    this.link.asks(this.asks)
    this.link.onWayClosed((caller, reason) => this.crashed(caller, reason))
    this.link.onHeard((caller, kind) => this.heard(caller, kind))
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
      // The router's floor let only the plugin the root of a chain called through, under that call, so the pair is that
      // chain's: the root plugin and the field it set
      case 'core.identityAsk':
        return this.identityAsk(call, args.capabilities as Capability[])
      // The floor let only a plugin's host half on its utility port through, which asks about the pairs its plugin roots
      case 'core.identities':
        if (call.caller.kind !== 'plugin') throw { code: 'not-granted' }
        return this.identitiesOf(call.caller.id, args.fields as string[])
      // From a utility half too. The handle is the core's own and never an argument. Only the plugin that asked collects
      // the answer
      case 'core.consentAsk':
        if (call.caller.kind !== 'plugin') throw { code: 'not-granted' }
        return { handle: this.connects.ask(args as ConnectAsked, call.caller.id) }
      case 'core.consentAnswer':
        if (call.caller.kind !== 'plugin') throw { code: 'not-granted' }
        return { answer: this.connects.answer(args.handle as string, call.caller.id) }
      // Under the calling plugin's id, coalesced by reason with the counts added up. A throw in recording is that record
      // lost
      case 'core.refused':
        try {
          if (call.caller.kind === 'plugin') this.recording.coalesced(`${call.caller.id}.refused`, { reason: args.reason as string }, undefined, args.count as number)
        } catch {
          // The refusals the plugin reports go unrecorded, they happened in the plugin and this only counts them
        }
        return null
      case 'core.stop':
      case 'core.restart': {
        const k = this.known.get(args.plugin as string)
        if (k === undefined) throw { code: 'not-found' }
        if (k.place !== 'sandboxed' && k.place !== 'utility') throw { code: 'not-granted' }
        // The human stopped it from the trusted window, so only the trusted window starts it again
        const trusted = call.caller.kind === 'window' && call.caller.role === 'trusted'
        if (call.action === 'core.restart' && k.held?.state === 'stopped' && k.held.reason === 'human' && !trusted) throw { code: 'not-granted' }
        // A utility half is a door. Its restart cuts every call it made for a client in flight and can bring back a door
        // the core ended, so it is the human's in the trusted window alone, as its stop is. The place is the plugins
        // manager's to know, so the rule is here and not in the floor, which sees only that a window asked
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
  protected securityList(): SecurityList {
    const { switches } = this.state
    const modules: ListedPlugin[] = coreModuleIds.map(id => {
      const { state, reason } = this.moduleRow(id)
      return {
        id, from: 'core', place: 'core', state, reason,
        security: isSecurityControl(id), on: !isOne(switches.off, id), items: [], class: null,
      }
    })
    const listed: ListedPlugin[] = this.list().map(row => {
      const k = this.known.get(row.id)
      const entry = row.from === 'folder' ? k?.entry ?? null : null
      const off = new Set((entry?.off ?? []).map(capabilityKey))
      const asking = new Set((entry?.firstUse ?? []).map(capabilityKey))
      return {
        id: row.id, from: row.from, place: row.place, state: row.state, reason: row.reason,
        security: row.from === 'core' && isSecurityControl(row.id),
        on: row.from === 'core' ? !isOne(switches.off, row.id) : entry?.enabled ?? false,
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
        type: this.requests.typed(change),
        root: change.kind === 'identity.ask' ? change.root : change.kind === 'consent.ask' ? change.plugin : null,
        field: change.kind === 'identity.ask' || change.kind === 'consent.ask' ? change.field : null,
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
      identities: this.listedIdentities(),
      stopped: this.stoppedMode,
    }
  }

  // What an approval or an update would load, from the one read it was found or staged with: the version and every
  // grant an approval takes from the manifest, the versions an update goes from and to. A change to what one plugin
  // holds adds the classes it moves, from the state the change asks for, with the Confirm on screen
  protected what(change: Change): string[] {
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
    if (change.kind === 'plugin.remove' || change.kind === 'plugin.reset') {
      const k = this.known.get(change.plugin)
      return k?.from === 'folder' && k.entry !== null ? [...this.classes(change.kind === 'plugin.remove' ? 'remove' : 'reset', change.plugin, null, true).lines] : []
    }
    return []
  }

  // What a window's banner shows, from the plugins manager's own states and the state it runs with
  protected banner(): CoreStatus {
    const down = new Set(['crashed', 'failed', 'unresponsive'])
    const { switches } = this.state
    const policyJobs = this.policyJobs()
    return {
      policyJobs,
      crashed: [
        ...coreModuleIds.filter(id => this.modules.state(id) === 'failed'), ...this.list().filter(row => down.has(row.state)).map(row => row.id),
      ],
      devMode: [...switches.devMode],
      allowUnsigned: switches.allowUnsigned.length,
      skipVerification: switches.skipVerification,
      modulesOff: coreModuleIds.filter(id => !Object.hasOwn(policyJobs, id) && this.modules.state(id) === 'off'),
      logWrites: this.logWrites(),
      luoshuPicked: this.state.luoshu !== null,
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

  // In boot's order: the door's code read, the core modules started, the door started, every plugin-folder entry
  // classed again, the plugin folder scanned and its plugins started in graph order. core.ready closes it with every
  // policy job's state, unless a shutdown began on the way
  async start(): Promise<void> {
    await this.readDoor()
    this.failedBefore = await readFailedOnce(this.dataDir)
    // The controls that judge yes or no go first and alone. Only core modules hold a guard, so any other expected guard
    // the human hasn't switched off reads absent and stops hetu in the fail-safe before any module begins. Off is no step,
    // read from policyJob as the router reads it
    const controls = failSafeControls(action => this.guardsFor(action))
    // A start marker the run before left names the control whose start hung main, which goes to the fail-safe. One of a
    // control the human switched off is left from a clear that failed, holds nothing back and is cleared
    const markers = await readStartMarkers(this.dataDir, controls)
    const off = markers.filter(id => isOne(this.state.switches.off, id))
    // A marker that stays holds nothing back while its control is off and the next start clears it again
    for (const id of off) await this.marking(clearStartMarker(this.dataDir, id)).catch(() => {})
    const hung = markers.find(id => !off.includes(id))
    if (hung !== undefined) return this.enterStopped({ control: hung, why: 'start-failed', reason: START_HUNG, again: false })
    const guard = controls.find(id => !isModule(id) && this.policyJob(id) !== 'on' && this.policyJob(id) !== 'off')
    if (guard !== undefined) return this.enterStopped({ control: guard, why: 'start-failed', reason: this.policyJob(guard), again: false })
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
      starting: id => this.marking(writeStartMarker(this.dataDir, id)),
      started: id => this.marking(clearStartMarker(this.dataDir, id)),
    })
    // A control that judges yes or no and failed at start stops hetu in the stopped mode before any other module began
    // or any plugin runs, where the human quits, tries again or starts with it switched off. No restart marker is
    // written, so it never starts again on its own
    const failed = controls.filter(isModule).find(id => this.modules.state(id) === 'failed')
    if (failed !== undefined) return this.enterStopped({ control: failed, why: 'start-failed', reason: this.modules.reason(failed), again: false })
    this.phase = 'all'
    this.replan()
    await this.settled()
    // In the changes' turn, so no change writes an entry under the pass
    await this.serial(() => this.classAll('start'))
    this.classedAtStart = true
    await this.scan()
    this.replan()
    await this.settled()
    if (!this.closing) this.note('core.ready', { ...this.policyJobs() })
  }
}
