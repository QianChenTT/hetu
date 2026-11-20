import { coreModuleIds, providers, type CoreModuleId } from '../../api/ids.ts'
import { defaultLimits, MAX_TIMER_MS } from '../../api/limits.ts'
import type { Gate, GrantRiskClassifier, Opening, Provider, StorageRole } from '../../api/policy-jobs.ts'
import type { FloodControl } from '../flood-control/header.ts'
import type { Beating, Heartbeat, HeartbeatModule } from '../heartbeat/header.ts'
import type { SecurityView } from '../security-view/header.ts'
import type { Exec } from '../providers/exec/header.ts'
import type { History } from '../providers/history/header.ts'
import type { Luoshu } from '../providers/luoshu/header.ts'
import {
  luoshuTopics, moduleRequires, type CoreModules as Holder, type CoreModulesOptions, type Handed, type ModuleChange, type ModuleReason,
  type ModuleState, type StorageModule,
} from './header.ts'

// The order the modules close in, the reverse of their start, so history closes before the luoshu it reads from and
// the gate closes last
const closing = [...coreModuleIds].reverse()

// The modules that run on through shutdown and the stopped mode until hetu ends, since they hold nothing open and the
// human's way back in needs them: flood control, recording, which writes the last records and the security view, which
// holds the stopped mode's choices for the Confirm
const lasting: ReadonlySet<CoreModuleId> = new Set(['flood-control', 'recording', 'security-view'])

const isModule = (id: string): id is CoreModuleId => (coreModuleIds as readonly string[]).includes(id)

// The one place the six core modules are held, made by the join. The router reads the gate and the providers through here and
// the plugins manager the grant risk classifier and storage's clear, each null while its module is off or failed. A
// module that throws is refused per call and stops nothing
export class CoreModules implements Holder {
  private readonly dataDir: string
  private readonly installDir: string
  private readonly trash: CoreModulesOptions['trash']
  private readonly gateOf: Gate
  private readonly classifierOf: GrantRiskClassifier
  private readonly storageOf: StorageModule
  private readonly luoshuOf: Luoshu
  private readonly historyOf: History
  private readonly execOf: Exec
  private readonly floodControlOf: FloodControl
  private readonly heartbeatOf: HeartbeatModule
  // The heartbeat as the plugins manager tells it, each thing kept from throwing: a throw skips that beat with a fault.
  // Made once, since it is told on every message heard from a plugin
  private readonly heartbeatTold: Heartbeat
  private readonly securityViewOf: SecurityView
  private off = new Set<string>()
  // The modules whose last start threw or ran out of time and those whose last push threw
  private readonly startFailed = new Set<CoreModuleId>()
  private readonly pushFailed = new Set<CoreModuleId>()
  // The modules whose start runs now and each module's latest start, so a start that ran out of time and finishes late
  // can tell it was not the latest
  private readonly beginning = new Set<CoreModuleId>()
  private readonly attempts = new Map<CoreModuleId, number>()
  // Why a module was stopped, by shutdown or by the stopped mode. A stopped module stays stopped for the run
  private readonly stoppedFor = new Map<CoreModuleId, 'shutdown' | 'stopped-mode'>()
  private handed: Handed | null = null
  // True while start runs: every module reads starting until all are started and handed what they need
  private booting = false
  // Shutdown began or the stopped mode: no module is started, handed anything or switched from then on
  private closed = false
  private halted = false

  constructor(options: CoreModulesOptions) {
    this.off = new Set(options.off ?? [])
    this.dataDir = options.dataDir
    this.installDir = options.installDir
    this.trash = options.trash
    this.gateOf = options.gate
    this.classifierOf = options.grantRiskClassifier
    this.storageOf = options.storage
    this.luoshuOf = options.luoshu
    this.historyOf = options.history
    this.execOf = options.exec
    this.floodControlOf = options.floodControl
    this.heartbeatOf = options.heartbeat
    const told = (step: keyof Heartbeat) => (plugin: Beating) => {
      try {
        this.heartbeatOf[step](plugin)
      } catch {
        this.fault('heartbeat', step)
      }
    }
    this.heartbeatTold = Object.freeze({ started: told('started'), heard: told('heard'), stopped: told('stopped') })
    this.securityViewOf = options.securityView
  }

  state(id: CoreModuleId): ModuleState {
    if (this.off.has(id)) return 'off'
    if (this.stoppedFor.has(id)) return 'stopped'
    if (this.handed === null || this.booting || this.beginning.has(id)) return 'starting'
    return this.startFailed.has(id) || this.pushFailed.has(id) ? 'failed' : 'on'
  }

  // Why a module reads as it does, null while on or starting: its switch, a start that threw or ran out of time, a push
  // that threw, shutdown or the stopped mode
  reason(id: CoreModuleId): ModuleReason {
    if (this.off.has(id)) return 'off'
    const stopped = this.stoppedFor.get(id)
    if (stopped !== undefined) return stopped
    if (this.handed === null || this.booting || this.beginning.has(id)) return null
    return this.startFailed.has(id) ? 'start-failed' : this.pushFailed.has(id) ? 'state-changed' : null
  }

  // Serving while on, so from its start until it is stopped. At shutdown the gate and the grant risk classifier are not
  // stopped and answer until the end
  private serving(id: CoreModuleId): boolean {
    return this.state(id) === 'on'
  }

  gate(): Gate | null {
    return this.serving('gate') ? this.gateOf : null
  }

  grantRiskClassifier(): GrantRiskClassifier | null {
    return this.serving('grant-risk-classifier') ? this.classifierOf : null
  }

  storage(): StorageRole | null {
    return this.serving('storage') ? this.storageOf : null
  }

  // Flood control and the security view have no start of their own, so each serves from the first call on unless the
  // human has it off, the stopped mode at start included
  floodControl(): FloodControl | null {
    return this.off.has('flood-control') ? null : this.floodControlOf
  }

  securityView(): SecurityView | null {
    return this.off.has('security-view') ? null : this.securityViewOf
  }

  heartbeat(): Heartbeat | null {
    return this.serving('heartbeat') ? this.heartbeatTold : null
  }

  // The provider serving a namespace, cache through storage. leases and net have no module and answer null. A module
  // serves only while what it requires does
  provider(namespace: string): Provider | null {
    const id = Object.hasOwn(providers, namespace) ? (providers as Readonly<Record<string, string>>)[namespace] : undefined
    if (id === undefined || !isModule(id) || !this.serving(id) || moduleRequires[id].some(other => !this.serving(other))) return null
    switch (id) {
      case 'storage':
        return this.storageOf
      case 'luoshu':
        return this.luoshuOf.provider
      case 'history':
        return this.historyOf.provider
      case 'exec':
        return this.execOf.provider
      default:
        return null
    }
  }

  // Once, as the plugins manager starts, after the install list passed and before any plugin starts: every module that
  // is on started one at a time, each start given readyMs, then each handed what it needs
  async start(off: readonly string[], handed: Handed): Promise<void> {
    if (this.handed !== null || this.halted) return
    this.off = new Set(off)
    const before = this.states()
    this.handed = handed
    this.booting = true
    try {
      // Shutdown or the stopped mode during the start starts nothing more
      for (const id of coreModuleIds) {
        if (this.closed) break
        if (!this.off.has(id)) await this.begin(id)
      }
      for (const id of coreModuleIds) this.push(id)
    } finally {
      this.booting = false
    }
    this.tell(before, null)
  }

  // The human's switches as they now stand. A module switched off is closed where it has a close and its lookups answer
  // null. One switched on again is started again where it has a start (given readyMs) and handed what it needs
  async apply(off: readonly string[]): Promise<void> {
    const was = this.off
    this.off = new Set(off)
    if (this.handed === null || this.closed) return
    for (const id of coreModuleIds) {
      if (this.closed) return
      if (was.has(id) === this.off.has(id)) continue
      // Read before the switch took, so the change is told from what the module was
      const before = new Map(this.states()).set(id, was.has(id) ? 'off' : this.startFailed.has(id) || this.pushFailed.has(id) ? 'failed' : 'on')
      if (this.off.has(id)) this.end(id)
      else {
        await this.begin(id)
        this.push(id)
      }
      this.tell(before, null, [id])
    }
  }

  // A new grants snapshot: the gate and exec are handed theirs. Answers whether a module's state changed with it
  bumped(): boolean {
    const before = this.states()
    this.push('gate')
    this.push('exec')
    return this.tell(before, null, ['gate', 'exec'])
  }

  // A new notes folder: the luoshu and history are handed it. Answers whether a module's state changed with it
  picked(): boolean {
    const before = this.states()
    this.push('luoshu')
    this.push('history')
    return this.tell(before, null, ['luoshu', 'history'])
  }

  // Shutdown, once every plugin stopped: exec and history end what runs, the luoshu's watch ends and storage serves no
  // more, in that order. The gate, the grant risk classifier and the lasting modules answer to the end
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const id of closing) if (id !== 'gate' && id !== 'grant-risk-classifier' && !lasting.has(id)) this.halt(id, 'shutdown')
  }

  // The stopped mode, once every plugin stopped: every module closed in the reverse of its start, the gate last, so
  // nothing acts while nothing can be recorded. The lasting modules run on. Modules not yet started never start. off is
  // the human's switches as they stand, so a module switched off keeps reading off
  stop(off: readonly string[]): void {
    if (this.halted) return
    // Once shutdown began, the gate and the grant risk classifier answer to its end
    const shutdown = this.closed
    this.halted = true
    this.closed = true
    this.off = new Set(off)
    for (const id of closing) if (!lasting.has(id) && (!shutdown || (id !== 'gate' && id !== 'grant-risk-classifier'))) this.halt(id, 'stopped-mode')
  }

  private opening(): Opening {
    return { folder: this.handed?.folder() ?? null, dataDir: this.dataDir, installDir: this.installDir }
  }

  // A start that throws or runs past readyMs marks the module failed until a start goes through. hetu runs on
  // without it. History with no git to run is one, exec looking for a program on a path that stalls another. A start
  // that ran out of time and finishes late is closed again, unless a later start began meanwhile
  private async begin(id: CoreModuleId): Promise<void> {
    const attempt = (this.attempts.get(id) ?? 0) + 1
    this.attempts.set(id, attempt)
    this.beginning.add(id)
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = Promise.resolve().then(() => this.run(id)).then(() => 'ok' as const, () => 'threw' as const)
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), this.readyMs(id))
      timer.unref?.()
    })
    const outcome = await Promise.race([run, late])
    clearTimeout(timer)
    this.beginning.delete(id)
    if (outcome === 'ok') {
      this.startFailed.delete(id)
      // Stopped while it started: what the start opened is closed again
      if (this.stoppedFor.has(id)) this.end(id)
      return
    }
    this.startFailed.add(id)
    this.fault(id, outcome === 'late' ? 'start-timeout' : 'start')
    if (outcome === 'late') {
      void run.then(finished => {
        if (finished === 'ok' && this.attempts.get(id) === attempt) this.end(id)
      })
    }
  }

  private run(id: CoreModuleId): Promise<void> | void {
    if (id === 'storage') return this.storageOf.open(this.dataDir)
    if (id === 'history') return this.historyOf.start(this.dataDir)
    if (id === 'exec') return this.execOf.start(this.dataDir)
    if (id === 'heartbeat' && this.handed !== null) this.heartbeatOf.open(this.handed.heartbeat, step => this.fault('heartbeat', step))
  }

  // readyMs as the human set it for the module or for all, the default when it can't be read
  private readyMs(id: CoreModuleId): number {
    try {
      const ms = this.handed?.readyMs(id)
      if (typeof ms === 'number' && Number.isSafeInteger(ms) && ms > 0) return Math.min(ms, MAX_TIMER_MS)
    } catch {}
    return defaultLimits.readyMs
  }

  // What a module is handed on each change, to every module that is not off, so a failed one is tried again with the
  // next. A throw marks it failed until a push goes through
  private push(id: CoreModuleId): void {
    const handed = this.handed
    if (handed === null || this.closed || this.off.has(id)) return
    let step = 'stateChanged'
    try {
      if (id === 'gate') this.gateOf.stateChanged(handed.grants())
      else if (id === 'exec') this.execOf.role.stateChanged(handed.exec())
      else if (id === 'luoshu') {
        step = 'open'
        this.luoshuOf.role.open(this.trash === undefined ? this.opening() : { ...this.opening(), trash: this.trash })
      } else if (id === 'history') {
        step = 'open'
        this.historyOf.role.open(this.opening())
      } else return
      this.pushFailed.delete(id)
    } catch {
      this.pushFailed.add(id)
      this.fault(id, step)
    }
  }

  private end(id: CoreModuleId): void {
    try {
      if (id === 'luoshu') this.luoshuOf.close()
      else if (id === 'history') this.historyOf.close()
      else if (id === 'exec') this.execOf.close()
      else if (id === 'heartbeat') this.heartbeatOf.close()
    } catch {
      this.fault(id, 'close')
    }
  }

  // One module stopped for the run: closed where it has a close and was started, then told
  private halt(id: CoreModuleId, why: 'shutdown' | 'stopped-mode'): void {
    if (this.stoppedFor.has(id)) return
    const before = this.states()
    const ran = this.handed !== null && !this.off.has(id)
    this.stoppedFor.set(id, why)
    if (ran) this.end(id)
    this.tell(before, why, [id])
  }

  private states(): Map<CoreModuleId, ModuleState> {
    return new Map(coreModuleIds.map(id => [id, this.state(id)]))
  }

  // Tells each change of a module's state since before, among ids. Starting is no change of its own. A module that
  // goes from starting to off or stopped never ran. Answers whether any changed
  private tell(before: ReadonlyMap<CoreModuleId, ModuleState>, why: string | null, ids: readonly CoreModuleId[] = coreModuleIds): boolean {
    let any = false
    for (const id of ids) {
      const was = before.get(id)!
      const now = this.state(id)
      if (was === now || now === 'starting' || (was === 'starting' && (now === 'off' || now === 'stopped'))) continue
      any = true
      const change: ModuleChange = now === 'on' ? (was === 'failed' ? 'recovered' : 'started') : now === 'failed' ? 'failed' : 'stopped'
      const reason = now === 'failed' ? this.reason(id) : change === 'stopped' ? (now === 'off' ? 'off' : why) : null
      try {
        this.handed?.changed(id, change, reason)
      } catch {}
    }
    return any
  }

  private fault(id: CoreModuleId, step: string): void {
    try {
      this.handed?.fault(id, step)
    } catch {}
  }
}

// What the luoshu publishes through: only its two topics go out. A publish that throws never fails the write that
// made it. The join makes the luoshu with it
export function luoshuPublish(publish: (topic: string, path: string) => void): (topic: string, path: string) => void {
  return (topic, path) => {
    if (!(luoshuTopics as readonly string[]).includes(topic)) return
    try {
      publish(topic, path)
    } catch {}
  }
}
