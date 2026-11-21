import type { StoppedMode } from '../../api/actions.ts'
import { withdrawnWith } from '../../api/changes.ts'
import { VERSION, type Caller } from '../../api/envelope.ts'
import { coreModuleIds, failSafeControls } from '../../api/ids.ts'
import { bindFailures, type DepState, type Init, type StopReason } from '../../api/lifecycle.ts'
import { API_VERSION } from '../../api/manifest.ts'
import { frozen } from '../../api/plain.ts'
import type { PluginState } from '../../api/policy-jobs.ts'
import { moduleRequires } from '../modules/header.ts'
import { clear, clearFailedOnce, clearStartMarker, writeFailedOnce } from './folders.ts'
import { plan, type Node, type Verdict } from './graph.ts'
import type { Beating } from '../heartbeat/header.ts'
import type { Failure } from '../runtime/header.ts'
import { MAX_PENDING } from './requests.ts'
import { type HalfName, type Run, type Live, type Known, isOne, isModule, ok, PluginsBase } from './base.ts'

// The lifecycle: the requires graph planned again on every change, each plugin's state, the pump that stops in reverse
// graph order and starts in graph order, starting and stopping incarnations, the stops the human asked for and the
// stopped mode
export abstract class PluginsLifecycle extends PluginsBase {
  // The install's step that records what started, which a plugin's ready calls
  protected abstract saveInstalled(): Promise<void>

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
  protected async enterStopped(mode: StoppedMode): Promise<void> {
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

  protected tell(failure: Failure): void {
    try {
      this.onFailure?.(failure)
    } catch {
      // A throw is the runtime's own fault. A stop already in place loses only its box or window, a relaunch is lost
      // and hetu runs on with the log failing
    }
  }

  // The human quit hetu: nothing failed, so the next failure restarts hetu again
  async cleanQuit(): Promise<void> {
    while (this.markerWork.size > 0) await Promise.all(this.markerWork)
    // A failed-once marker that stays only stops the next failure in the stopped mode, the safe side of a clean quit
    await clearFailedOnce(this.dataDir).catch(() => {})
  }

  // The human chose Try again: every start marker goes, so the next launch starts as usual and a start that hangs again
  // leaves a new one
  async triedAgain(): Promise<void> {
    // A marker that stays holds hetu in the fail-safe at the next launch again, the safe side of a Try again
    for (const id of failSafeControls(action => this.guardsFor(action))) await this.marking(clearStartMarker(this.dataDir, id)).catch(() => {})
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
      } catch {
        // A router not told answers down instead of stopped for what shutdown stops, the shutdown goes on the same
      }
      this.note('core.stopping', {})
      this.replan()
    }
    await this.pumped()
    this.modules.close()
    while (this.markerWork.size > 0) await Promise.all(this.markerWork)
  }

  // ---- the plan and its states

  // Judges every plugin, resolves the graph and sets each state. Synchronous, so a crash has moved every dependent to
  // waiting before the router answers a call. The stops and starts it calls for follow in the pump. Each core module is
  // a node too, ok while on, so a plugin requiring one runs only while it is
  protected replan(): void {
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
  protected show(k: Known): void {
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

  protected final(k: Known, verdict: Verdict): { state: PluginState, reason: string | null } {
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

  protected stopReason(k: Known): string {
    if (this.closing) return 'shutdown'
    if (k.held !== null) return k.held.reason
    const verdict = this.verdictOf(k)
    if (verdict.kind === 'refused' || verdict.kind === 'waiting') return verdict.reason
    if (verdict.kind === 'off') return 'off'
    return 'removed'
  }

  // Tells the router, records each policy job that changed and sends deps to every plugin whose own requirements changed
  protected refresh(): void {
    for (const id of this.expected()) {
      const now = this.policyJob(id)
      if (this.lastPolicyJobs.get(id) === now) continue
      this.lastPolicyJobs.set(id, now)
      this.note('policy-job.state', { policyJob: id, state: now })
    }
    try {
      this.link.changed()
    } catch {
      // The router hears of this change only with the next one, open calls with power aren't judged again before it
    }
    this.sendDeps()
    this.checkIdle()
  }

  // A plugin's own requires and plugin.call targets, as it may know them. A core module is ready while on
  protected depsOf(k: Known): Record<string, DepState> {
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

  protected sendDeps(): void {
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

  protected checkIdle(): void {
    if (this.pumping !== null || this.waiters.length === 0) return
    for (const k of this.known.values()) {
      if (k.state === 'starting' || k.live?.stop || this.startable(k)) return
    }
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  // ---- the pump: stops in reverse graph order, then starts in graph order

  protected pump(): void {
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

  protected async turn(): Promise<void> {
    do {
      this.again = false
      try {
        for (const id of [...this.planned.order].reverse()) {
          const k = this.known.get(id)
          if (k?.live && !this.runs(k)) await this.halt(k)
        }
        this.startAll()
      } catch {
        // A throw ends this pass with the plan half applied, a plugin to stop may run on and one to start waits, until
        // the next switch, stop, crash or install replans
      }
    } while (this.again)
  }

  // Resolves once the pump has nothing left to do
  protected async pumped(): Promise<void> {
    while (this.pumping !== null) await this.pumping
  }

  // In graph order, each once its requirements serve
  protected startAll(): void {
    if (this.closing) return
    for (const id of this.planned.order) {
      const k = this.known.get(id)
      if (k !== undefined && this.startable(k)) this.begin(k)
    }
  }

  protected startable(k: Known): boolean {
    if (k.live !== null || !this.runs(k)) return false
    return (k.read.manifest?.requires ?? []).every(id => this.serves(id))
  }

  // ---- starting

  protected begin(k: Known): void {
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

  protected async launch(k: Known, live: Live): Promise<void> {
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
  protected async applyInstalled(k: Known): Promise<void> {
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
  protected mint(k: Known, live: Live): void {
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

  protected readied(k: Known, live: Live): void {
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
  protected halt(k: Known): Promise<void> {
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
  protected liveDependents(k: Known): string[] {
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
  protected finished(k: Known, live: Live): void {
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
  protected die(k: Known, reason: StopReason): void {
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
  protected exited(k: Known, live: Live, killed: boolean): void {
    if (live.over || k.live !== live) return
    if (live.stop !== null) return this.finished(k, live)
    this.die(k, killed ? 'killed' : 'exited')
  }

  // The heartbeat's ask once a plugin missed its beats. A worker reads unresponsive until it answers: calls to it time out
  // at once and nothing is closed. A hung utility half still holds what it opened, so it is killed and reads crashed
  protected missed(plugin: Beating, worker: boolean): void {
    const found = this.runOf(plugin.caller)
    if (found === null || found.live.stop !== null) return
    if (!worker) return this.die(found.k, 'unresponsive')
    if (found.k.state !== 'ready') return
    found.k.state = 'unresponsive'
    this.note('plugin.unresponsive', { plugin: found.k.id, incarnation: found.live.n })
    this.refresh()
  }

  protected retire(k: Known, live: Live): void {
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
  protected release(k: Known, live: Live, code: 'stopped' | 'crashed'): void {
    this.requests.withdraw(change => withdrawnWith(change).includes(k.id))
    this.connects.ended(k.id)
    for (const run of live.halves.values()) {
      try {
        this.link.end(run.caller, code)
      } catch {
        // Its way left the router before the end could throw, a call it held that isn't stopped ends at its deadline
      }
    }
    if (live.halves.has('worker')) {
      try {
        this.runtime.terminate(k.id, live.n)
      } catch {
        // A worker that can't be ended runs on unheard, its ways were ended above
      }
    }
    if (k.place === 'utility' && live.halves.has('host')) {
      try {
        this.runtime.kill(k.id, live.n)
      } catch {
        // A child that can't be killed runs on unheard, its ways were ended above
      }
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
}
