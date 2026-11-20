import path from 'node:path'
import type { PendingRequest } from '../../api/actions.ts'
import { change as changeSchema, type Change } from '../../api/changes.ts'
import { type Caller } from '../../api/envelope.ts'
import { firstPartyIds } from '../../api/ids.ts'
import { FIRST_PARTY_SIGNER, isNewer } from '../../api/install.ts'
import { frozen } from '../../api/plain.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import type { ExecGrant, ExecView, GrantedItem, GrantsSnapshot } from '../../api/policy-jobs.ts'
import { agentHost } from '../../api/policy-jobs.ts'
import type { Plugin, StateStore } from '../boot/header.ts'
import { clear, clearFailedOnce, folders, stage, swapIn } from './folders.ts'
import { plan, type Node } from './graph.ts'
import { cleared } from './marks.ts'
import { MAX_PENDING, Requests, type RequestAnswer } from './requests.ts'
import { readPlugin, type Read } from './verify.ts'
import { PluginsInstall } from './install.ts'
import { type UpdateOutcome, type Known, isOne, isModule, refused, placeOf, toggled, bare } from './base.ts'

// The changes: the queue of held requests, applying a change the human confirmed or that narrows and the staged
// updates, each written through the state store
export abstract class PluginsChanges extends PluginsInstall {
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

  // Applies a change exactly as stored through the one StateStore. A write that fails applies nothing. Each applied
  // change raises the grants snapshot by one. Requests reach it through the Confirm, tests and the plugins manager's own reconcile
  // directly
  apply(input: Change): Promise<void> {
    return this.serial(async () => {
      await this.applyNow(changeSchema.parse(input), true)
    })
  }

  // confirm is whether the human clicked the change's Confirm, false for one Confirm-off or its narrowing applied at once
  protected async applyNow(change: Change, confirm: boolean): Promise<void | 'unchanged'> {
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

  // A capability added to a folder plugin's entry or taken out with its switch. Adding one it holds changes nothing
  protected async grant(id: string, capability: Capability, add: boolean, confirm: boolean): Promise<void> {
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
  protected async stoppedWhile<T>(k: Known, work: () => Promise<T>): Promise<T> {
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

  protected async clearStorage(id: string): Promise<void> {
    const k = this.known.get(id)
    if (k === undefined) throw new Error(`no plugin ${id}`)
    await this.stoppedWhile(k, () => this.clearSpace('storage', id))
  }

  // Recover's reset: storage and cache cleared. A folder plugin's entry goes, so it waits for approval again with the
  // code it has. A core plugin waits for Restart hetu. A core module has no reset, its switch is the way out
  protected async reset(id: string, confirm: boolean): Promise<void> {
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

  // One item a folder plugin was granted switched on or off. A core plugin's grants are its manifest, so it has
  // no entry to hold a switch
  protected async switchItem(id: string, capability: Capability, on: boolean): Promise<void> {
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
  protected grantsSnapshot(): GrantsSnapshot {
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

  // What exec checks a command against on its own, read from the grants snapshot: each plugin's exec items that are on. Exec
  // keeps this list with the gate off, so an item the human switched off leaves it, or the command would run again
  // exactly when the gate isn't there to refuse it. With them the plugins the human let run any command and the folders
  // no command may run code from. Read-only
  protected execView(): ExecView {
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

  // A core module's switch is written, then the module is closed or started again with it, so the grants snapshot and
  // the plan that follow read it as the switch says. The grant risk classifier switched on again in the run classes
  // every entry at once
  protected async switchPlugin(id: string, on: boolean): Promise<void> {
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
  protected async approve(id: string, confirm: boolean): Promise<void> {
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
  protected async remove(id: string, confirm: boolean): Promise<void> {
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
  protected async restore(id: string, confirm: boolean): Promise<void> {
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

  protected async updateNow(id: string, dir: string): Promise<UpdateOutcome> {
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
  protected async applyStaged(id: string, confirm = true): Promise<void> {
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
}
