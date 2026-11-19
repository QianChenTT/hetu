import { coreModuleIds, providers, type CoreModuleId } from '../api/ids.ts'
import { frozen } from '../api/plain.ts'
import type {
  ExecView, Gate, GrantRiskClassifier, GrantsSnapshot, Opening, Provider, StorageRole,
} from '../api/policy-jobs.ts'
import { createGate } from './policy/gate/gate.ts'
import { createGrantRiskClassifier } from './policy/grant-risk-classifier/grant-risk-classifier.ts'
import { createExec, type Exec } from './providers/exec/exec.ts'
import { createHistory, type History } from './providers/history/history.ts'
import { createLuoshu, type Luoshu } from './providers/luoshu/luoshu.ts'
import { createStorage } from './providers/storage/store.ts'

// A module as the core reads it: on, off by the human's switch or failed, its last start or its last push having
// thrown. Failed clears once that start or push goes through again. Nothing stops and nothing restarts hetu for it
export type ModuleState = 'on' | 'off' | 'failed'

// The topics luoshu publishes, each as luoshu.<topic>. A publish of any other reaches nobody
export const luoshuTopics = frozen(['changed', 'outside'] as const)

// Storage as the core holds it: the provider, the clear the plugins manager runs in a space's turn and the data folder
// it opens on
export type StorageModule = Provider & StorageRole & { open(dataDir: string): void }

export type CoreModulesOptions = {
  dataDir: string
  installDir: string
  // The OS's bin the runtime gives, handed to the luoshu alone
  trash?: (absolute: string) => Promise<void>
  // Publishes luoshu.<topic> for a path. The join points it at the carrier
  publish: (topic: string, path: string) => void
  // Instances in place of the ones the core makes, for tests
  gate?: Gate
  grantRiskClassifier?: GrantRiskClassifier
  storage?: StorageModule
  luoshu?: Luoshu
  history?: History
  exec?: Exec
}

// What the plugins manager hands the modules at start, read again at each push: the newest grants snapshot, exec's view
// of the grants, the notes folder picked and where a fault goes
export type Handed = {
  grants(): GrantsSnapshot
  exec(): ExecView
  folder(): string | null
  fault(id: CoreModuleId, step: string): void
}

const isModule = (id: string): id is CoreModuleId => (coreModuleIds as readonly string[]).includes(id)

// The one place the six core modules are made and held. The carrier reads the gate and the providers through here and
// the plugins manager the grant risk classifier and storage's clear, each null while its module is off or failed. A
// module that throws is refused per call and stops nothing
export class CoreModules {
  private readonly dataDir: string
  private readonly installDir: string
  private readonly trash: CoreModulesOptions['trash']
  private readonly gateOf: Gate
  private readonly classifierOf: GrantRiskClassifier
  private readonly storageOf: StorageModule
  private readonly luoshuOf: Luoshu
  private readonly historyOf: History
  private readonly execOf: Exec
  private off = new Set<string>()
  // The modules whose last start threw and those whose last push threw
  private readonly startFailed = new Set<CoreModuleId>()
  private readonly pushFailed = new Set<CoreModuleId>()
  private handed: Handed | null = null
  private closed = false

  constructor(options: CoreModulesOptions) {
    this.dataDir = options.dataDir
    this.installDir = options.installDir
    this.trash = options.trash
    this.gateOf = options.gate ?? createGate()
    this.classifierOf = options.grantRiskClassifier ?? createGrantRiskClassifier()
    this.storageOf = options.storage ?? createStorage()
    // Only luoshu's two topics go out. A publish that throws never fails the write that made it
    this.luoshuOf = options.luoshu ?? createLuoshu({
      publish: (topic, path) => {
        if (!(luoshuTopics as readonly string[]).includes(topic)) return
        try {
          options.publish(topic, path)
        } catch {}
      },
    })
    this.historyOf = options.history ?? createHistory()
    this.execOf = options.exec ?? createExec()
  }

  state(id: CoreModuleId): ModuleState {
    if (this.off.has(id)) return 'off'
    return this.startFailed.has(id) || this.pushFailed.has(id) ? 'failed' : 'on'
  }

  // Why a module reads as it does, null while on: its switch, a start that threw or a push that threw
  reason(id: CoreModuleId): 'off' | 'start-failed' | 'state-changed' | null {
    if (this.off.has(id)) return 'off'
    return this.startFailed.has(id) ? 'start-failed' : this.pushFailed.has(id) ? 'state-changed' : null
  }

  // Serving once started, while on and until shutdown closed it. The gate and the grant risk classifier answer until
  // the end
  private serving(id: CoreModuleId): boolean {
    return this.handed !== null && this.state(id) === 'on' && (!this.closed || id === 'gate' || id === 'grant-risk-classifier')
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

  // The provider serving a namespace, cache through storage. leases and net have no module and answer null. History
  // reads the notes it commits from luoshu's folder, so it serves only while luoshu does, as it waited on luoshu before
  provider(namespace: string): Provider | null {
    const id = Object.hasOwn(providers, namespace) ? (providers as Readonly<Record<string, string>>)[namespace] : undefined
    if (id === undefined || !isModule(id) || !this.serving(id)) return null
    switch (id) {
      case 'storage':
        return this.storageOf
      case 'luoshu':
        return this.luoshuOf.provider
      case 'history':
        return this.serving('luoshu') ? this.historyOf.provider : null
      case 'exec':
        return this.execOf.provider
      default:
        return null
    }
  }

  // Once, as the plugins manager starts and before anything else does: every module that is on started, then each
  // handed what it needs
  async start(off: readonly string[], handed: Handed): Promise<void> {
    this.off = new Set(off)
    this.handed = handed
    for (const id of coreModuleIds) if (!this.off.has(id)) await this.begin(id)
    for (const id of coreModuleIds) this.push(id)
  }

  // The human's switches as they now stand. A module switched off is closed where it has a close and its lookups answer
  // null. One switched on again is started again where it has a start and handed what it needs
  async apply(off: readonly string[]): Promise<void> {
    const before = this.off
    this.off = new Set(off)
    if (this.handed === null || this.closed) return
    for (const id of coreModuleIds) {
      if (!before.has(id) && this.off.has(id)) this.end(id)
      else if (before.has(id) && !this.off.has(id)) {
        await this.begin(id)
        this.push(id)
      }
    }
  }

  // A new grants snapshot: the gate and exec are handed theirs
  bumped(): void {
    this.push('gate')
    this.push('exec')
  }

  // A new notes folder: the luoshu and history are handed it
  picked(): void {
    this.push('luoshu')
    this.push('history')
  }

  // Shutdown, once every plugin stopped: the luoshu's watch ends and history and exec end what runs
  close(): void {
    this.closed = true
    for (const id of ['luoshu', 'history', 'exec'] as const) this.end(id)
  }

  private opening(): Opening {
    return { folder: this.handed?.folder() ?? null, dataDir: this.dataDir, installDir: this.installDir }
  }

  // A start that throws marks the module failed until a start goes through. History with no git to run is one
  private async begin(id: CoreModuleId): Promise<void> {
    try {
      if (id === 'storage') this.storageOf.open(this.dataDir)
      else if (id === 'history') await this.historyOf.start(this.dataDir)
      else if (id === 'exec') await this.execOf.start(this.dataDir)
      this.startFailed.delete(id)
    } catch {
      this.startFailed.add(id)
      this.fault(id, 'start')
    }
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
    } catch {
      this.fault(id, 'close')
    }
  }

  private fault(id: CoreModuleId, step: string): void {
    try {
      this.handed?.fault(id, step)
    } catch {}
  }
}
