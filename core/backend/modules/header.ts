import type { MovedFields } from '../../api/envelope.ts'
import type { CoreModuleId } from '../../api/ids.ts'
import type { GrantRiskClassifier } from '../../api/classes.ts'
import type { ExecView, Gate, GrantsSnapshot, Guard, Provider, StorageRole } from '../../api/policy-jobs.ts'
import type { FloodControl } from '../flood-control/header.ts'
import type { Heartbeat, HeartbeatCore, HeartbeatModule } from '../heartbeat/header.ts'
import type { Lock } from '../lock/header.ts'
import type { SecurityView } from '../security-view/header.ts'
import type { Exec } from '../providers/exec/header.ts'
import type { History } from '../providers/history/header.ts'
import type { Luoshu } from '../providers/luoshu/header.ts'

// What the core modules provide: the holder of the six the plugins manager and the router read, the states it reads
// them in and what each requires. Definitions only, the holder itself is modules.ts, which the join builds

// The holder of the six as the plugins manager and the router read it, each lookup null while its module isn't on.
// modules.ts implements it
export type CoreModules = {
  state(id: CoreModuleId): ModuleState
  reason(id: CoreModuleId): ModuleReason
  gate(): Gate | null
  grantRiskClassifier(): GrantRiskClassifier | null
  storage(): StorageRole | null
  provider(namespace: string): Provider | null
  guard(id: string): Guard | null
  floodControl(): FloodControl | null
  heartbeat(): Heartbeat | null
  securityView(): SecurityView | null
  start(off: readonly string[], handed: Handed): Promise<void>
  apply(off: readonly string[]): Promise<void>
  bumped(): boolean
  picked(): boolean
  close(): void
  stop(off: readonly string[]): void
}

// Why a module reads as it does, null while on or starting: its switch, a start that threw or ran out of time, a push
// that threw, shutdown or the stopped mode
export type ModuleReason = 'off' | 'start-failed' | 'state-changed' | 'shutdown' | 'stopped-mode' | null

// A module as the core reads it: starting until it is handed what it needs and while its start runs, on, off by the
// human's switch, failed (its last start threw or ran past readyMs, or its last push threw) or stopped (closed at
// shutdown or in the stopped mode). Failed clears once that start or push goes through again. Nothing stops and nothing
// restarts hetu for it
export type ModuleState = 'starting' | 'on' | 'off' | 'failed' | 'stopped'

// What a module.state record says of a change: started, failed, stopped (by its switch, at shutdown or in the stopped
// mode) or recovered from a failed start or push
export type ModuleChange = 'started' | 'failed' | 'stopped' | 'recovered'

// The topics luoshu publishes, each as luoshu.<topic>. A publish of any other reaches nobody
export const luoshuTopics = Object.freeze(['changed', 'outside'] as const)
// How the luoshu publishes a topic of its own, with what a change carries beside its path
export type LuoshuPublish = (topic: string, path: string, fields?: MovedFields) => void

// Storage as the core holds it: the provider, the clear the plugins manager runs in a space's turn and the data folder
// it opens on
export type StorageModule = Provider & StorageRole & { open(dataDir: string): void }

// The six as the join made them, with the folders they run on and the OS's bin the runtime gives, handed to the
// luoshu alone. The join makes the luoshu publishing through luoshuPublish
export type CoreModulesOptions = {
  // The human's switches as boot read them, so a module switched off reads off before the core modules start
  off?: readonly string[]
  dataDir: string
  installDir: string
  trash?: (absolute: string) => Promise<void>
  gate: Gate
  grantRiskClassifier: GrantRiskClassifier
  storage: StorageModule
  luoshu: Luoshu
  history: History
  exec: Exec
  floodControl: FloodControl
  heartbeat: HeartbeatModule
  securityView: SecurityView
  lock: Lock
}

// What the plugins manager hands the modules at start, read again at each push: the newest grants snapshot, exec's view
// of the grants, the notes folder picked, how long a module's start may take, where a fault goes, where each change
// of a module's state is told, what the core does at the heartbeat's ask and the start marker of each fail-safe
// control, written before its start and cleared once its start and first push returned
export type Handed = {
  grants(): GrantsSnapshot
  exec(): ExecView
  folder(): string | null
  readyMs(id: CoreModuleId): number
  fault(id: CoreModuleId, step: string): void
  changed(id: CoreModuleId, change: ModuleChange, reason: string | null): void
  heartbeat: HeartbeatCore
  starting(id: CoreModuleId): Promise<void>
  started(id: CoreModuleId): Promise<void>
}

// What each module requires, as its manifest said when it was a core plugin. History commits the notes the luoshu
// holds and the lock locks them, so each serves only while the luoshu does and the graph shows it waiting meanwhile.
// The lock's guard answers whatever the luoshu reads. Each list is frozen too, as frozen() would, since a header may
// import no function
export const moduleRequires: Readonly<Record<CoreModuleId, readonly CoreModuleId[]>> = Object.freeze({
  gate: Object.freeze([]),
  'grant-risk-classifier': Object.freeze([]),
  storage: Object.freeze([]),
  luoshu: Object.freeze([]),
  history: Object.freeze(['luoshu'] as const),
  exec: Object.freeze([]),
  'flood-control': Object.freeze([]),
  heartbeat: Object.freeze([]),
  recording: Object.freeze([]),
  'security-view': Object.freeze([]),
  lock: Object.freeze(['luoshu'] as const),
})

