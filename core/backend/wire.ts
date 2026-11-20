import { createHash } from 'node:crypto'
import type { Caller } from '../api/envelope.ts'
import { defaultLimits, type LimitName } from '../api/limits.ts'
import type { GuardableAction } from '../api/ids.ts'
import type { Booted } from './boot/header.ts'
import { Carrier } from './carrier/carrier.ts'
import type { Asks, CarrierOptions, Debug, Served } from './carrier/header.ts'
import { Limits } from './carrier/limits.ts'
import { createFloodControl } from './flood-control/flood-control.ts'
import { createHeartbeat } from './heartbeat/heartbeat.ts'
import type { Recording } from './recording/header.ts'
import { createRecording } from './recording/recording.ts'
import { createSecurityView } from './security-view/security-view.ts'
import type { CoreModules as Holder, CoreModulesOptions } from './modules/header.ts'
import { CoreModules, luoshuPublish } from './modules/modules.ts'
import { createGateActions } from './policy/gate/actions.ts'
import { createGate } from './policy/gate/gate.ts'
import { createGrantRiskClassifier } from './policy/grant-risk-classifier/grant-risk-classifier.ts'
import { createExec } from './providers/exec/exec.ts'
import { createHistory } from './providers/history/history.ts'
import { createLuoshu } from './providers/luoshu/luoshu.ts'
import { createStorage } from './providers/storage/store.ts'
import { PluginsManager } from './plugins-manager/plugins-manager.ts'
import type { Failure, Runtime } from './runtime/header.ts'

export type WireOptions = {
  booted: Booted
  installDir: string
  // Where the install list is when it isn't in the install folder
  listDir?: string
  runtime: Runtime
  // The guards expected on an action, the same list for the plugins manager and the carrier. Defaults to core/api's
  guardsFor?: (action: GuardableAction) => readonly string[]
  debug?: Debug
  asks?: Asks
  // The human set one of this plugin's constants, for the runtime to pass on
  limited?: (plugin: string) => void
  // The windows' own actions the runtime serves, opening the trusted window, Quit and Restart hetu, and whether the
  // trusted window is past its input delay
  windows?: { serve: Served, armed: (caller: Caller) => boolean }
  // The log failed while hetu ran, for the runtime to quit and start hetu again
  onFailure?: (failure: Failure) => void
  // How long a request must be first in line before its Confirm counts, the input delay unless a test names another
  confirmDelayMs?: number
  // The OS's bin, for the luoshu's remove
  trash?: (absolute: string) => Promise<void>
  // Core modules in place of the ones the core makes, for tests
  modules?: Partial<Pick<CoreModulesOptions, 'gate' | 'grantRiskClassifier' | 'storage' | 'luoshu' | 'history' | 'exec' | 'floodControl' | 'heartbeat' | 'securityView'>>
}

// The core modules made and held: each the real one unless a test hands its own, the luoshu publishing through publish
// for its two topics alone and flood control counting by limit, the fixed values unless one is handed
export function buildModules(options: Pick<CoreModulesOptions, 'dataDir' | 'installDir' | 'trash'> & Partial<CoreModulesOptions> & {
  publish: (topic: string, path: string) => void
  limit?: (plugin: string | null, name: LimitName) => number
}): CoreModules {
  const { publish, limit, ...given } = options
  return new CoreModules({
    ...given,
    gate: given.gate ?? createGate(),
    grantRiskClassifier: given.grantRiskClassifier ?? createGrantRiskClassifier(),
    storage: given.storage ?? createStorage(),
    luoshu: given.luoshu ?? createLuoshu({ publish: luoshuPublish(publish) }),
    history: given.history ?? createHistory(),
    exec: given.exec ?? createExec(),
    floodControl: given.floodControl ?? createFloodControl({
      limit: limit ?? ((_plugin, name) => defaultLimits[name]),
      clock: () => performance.now(),
    }),
    heartbeat: given.heartbeat ?? createHeartbeat(),
    securityView: given.securityView ?? createSecurityView(),
  })
}

// What the carrier asks for: the gate, every provider and flood control from the core modules, no guard, since nothing
// that runs holds one. wireCore and the plugins manager's tests both build the carrier from it, so the tests run the
// wiring that ships
export function carrierOptions(modules: Holder, rest: Omit<CarrierOptions, 'gate' | 'guards' | 'providers' | 'floodControl'>): CarrierOptions {
  return {
    gate: () => modules.gate(),
    guards: () => null,
    providers: id => modules.provider(id),
    floodControl: () => modules.floodControl(),
    ...rest,
  }
}

// SHA-256 as hex, which recording is handed so it reaches no Node built-in
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// The core joined in its order: the core modules, recording over the one EventLog boot opened, the carrier asking the
// modules for the gate, the providers and flood control and handing each call's record to recording, then the plugins
// manager, which hands the carrier what it serves and listens for through the carrier's door. The carrier reads the
// plugins manager's table from here on and never calls the plugins manager
export function wireCore(options: WireOptions): { pluginsManager: PluginsManager, carrier: Carrier, modules: Holder, recording: Recording } {
  // The parts built after the ones that tell them something, read once they exist. The luoshu publishes only once
  // started, which is after the carrier is built
  const parts: { carrier: Carrier | null, pluginsManager: PluginsManager | null } = { carrier: null, pluginsManager: null }
  // The human's limits are the plugins manager's, read once it exists. Flood control counts by them as the carrier does
  const limits = new Limits(() => parts.pluginsManager?.limits() ?? { all: {}, plugins: {} })
  // The modules made here, the one place that builds the parts
  const modules = buildModules({
    off: options.booted.state.switches.off,
    dataDir: options.booted.dataDir,
    installDir: options.installDir,
    ...(options.trash !== undefined ? { trash: options.trash } : {}),
    ...options.modules,
    publish: (topic, path) => parts.carrier?.publishCore('luoshu', topic, path),
    limit: (plugin, name) => limits.of(plugin, name),
  })
  // The log failing is told to the plugins manager, which quits hetu to start it again. Windows hear the log's health
  // through the carrier
  const recording = createRecording({
    log: options.booted.log,
    off: () => modules.state('recording') === 'off',
    limit: name => limits.of(null, name),
    hash: sha256,
    noticed: () => parts.carrier?.status(),
    failed: () => parts.pluginsManager?.controlFailed('log', 'log-failing') ?? false,
  })
  // The gate's own actions and the gate's time each caller spends in a second, which listings spend too
  const gateActions = createGateActions({
    gate: () => modules.gate(),
    table: () => parts.pluginsManager,
    passes: () => recording.failing() !== true,
    limit: plugin => limits.of(plugin, 'filterMsPerSecond'),
    clock: () => performance.now(),
    fault: step => recording.coalesced('fault', { plugin: 'gate', step }),
  })
  const { windows } = options
  const carrier = new Carrier(carrierOptions(modules, {
    recording,
    gateTime: gateActions.time,
    ...(windows !== undefined ? { armed: windows.armed } : {}),
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  }))
  parts.carrier = carrier
  // The runtime serves the windows' own actions, since only it opens windows and dialogs, ends the process and serves
  // frames. Recording serves the log's reads and the gate its own two actions
  if (windows !== undefined) carrier.serve('runtime', windows.serve)
  carrier.serve('recording', call => recording.serve(call))
  carrier.serve('gate', gateActions.serve)
  const pluginsManager = new PluginsManager({
    booted: options.booted,
    installDir: options.installDir,
    ...(options.listDir !== undefined ? { listDir: options.listDir } : {}),
    link: carrier,
    recording,
    runtime: options.runtime,
    modules,
    logWrites: () => options.booted.log.healthy,
    ...(options.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
    ...(options.confirmDelayMs !== undefined ? { confirmDelayMs: options.confirmDelayMs } : {}),
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
    ...(options.limited !== undefined ? { limited: options.limited } : {}),
  })
  parts.pluginsManager = pluginsManager
  carrier.read(pluginsManager)
  if (options.asks !== undefined) carrier.asks(options.asks)
  return { pluginsManager, carrier, modules, recording }
}
