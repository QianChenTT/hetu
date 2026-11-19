import type { Caller } from '../api/envelope.ts'
import type { LimitName } from '../api/limits.ts'
import type { GuardableAction } from '../api/ids.ts'
import type { Field } from '../lib/event-log.ts'
import type { Booted } from './boot/boot.ts'
import { Carrier } from './carrier/carrier.ts'
import type { Asks, CarrierOptions, Debug, Landing, Port, Served } from './carrier/seams.ts'
import { CoreModules, type CoreModulesOptions } from './modules.ts'
import { PluginsManager, type Failure } from './plugins-manager/plugins-manager.ts'
import type { CarrierLink, Runtime } from './plugins-manager/seams.ts'

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
  // watchdog.limit lowered one of this plugin's constants or the human set one, for the runtime to pass on
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
  modules?: Pick<CoreModulesOptions, 'gate' | 'grantRiskClassifier' | 'storage' | 'luoshu' | 'history' | 'exec'>
}

// The core actions the runtime serves, since only it opens windows and dialogs, ends the process and serves frames
const runtimeActions = new Set(['security.open', 'core.quit', 'core.relaunch', 'core.pickFolder', 'editor.frame', 'editor.frameGone'])

// The plugins manager needs its link before the carrier exists, since the carrier needs the plugins manager. Each call goes to the
// carrier once wireCore attached it. One made before that throws
export class LinkToCarrier implements CarrierLink {
  carrier: Carrier | null = null

  private get to(): Carrier {
    if (this.carrier === null) throw new Error('the carrier is not built yet')
    return this.carrier
  }

  register(port: Port, caller: Caller): void {
    this.to.register(port, caller)
  }

  end(caller: Caller, code?: 'stopped' | 'crashed'): void {
    this.to.end(caller, code)
  }

  send(caller: Caller, message: unknown): void {
    this.to.send(caller, message)
  }

  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing> {
    return this.to.record(event, fields, signal)
  }

  changed(): void {
    this.to.changed()
  }

  stopping(): void {
    this.to.stopping()
  }

  drain(ms: number): Promise<number> {
    return this.to.drain(ms)
  }

  resume(): void {
    this.to.resume()
  }

  limit(plugin: string, name: LimitName): number {
    return this.to.limit(plugin, name)
  }
}

// What the carrier asks for: the gate and every provider from the core modules, no guard and no watchdog, since nothing
// that runs holds either, and the core actions from the plugins manager's serve. wireCore and the plugins manager's tests
// both build the carrier from it, so the tests run the wiring that ships
export function carrierOptions(
  pluginsManager: PluginsManager,
  modules: CoreModules,
  rest: Omit<CarrierOptions, 'pluginsManager' | 'gate' | 'guards' | 'providers' | 'watchdog'>,
): CarrierOptions {
  return {
    pluginsManager,
    gate: () => modules.gate(),
    guards: () => null,
    providers: id => modules.provider(id),
    watchdog: () => null,
    core: pluginsManager.serve,
    asks: pluginsManager.asks,
    ...rest,
  }
}

// The core joined in its order: the link, the core modules publishing through it, then the plugins manager holding both,
// then the carrier asking the modules for the gate and the providers, then the link pointed at the carrier. The log is
// the one EventLog boot opened, which the carrier writes its core records and its audit queue through and serves
// log.segments and log.verify from
export function wireCore(options: WireOptions): { pluginsManager: PluginsManager, carrier: Carrier, modules: CoreModules } {
  const link = new LinkToCarrier()
  // The luoshu publishes only once started, which is after the carrier is attached
  const modules = new CoreModules({
    dataDir: options.booted.dataDir,
    installDir: options.installDir,
    ...(options.trash !== undefined ? { trash: options.trash } : {}),
    ...options.modules,
    publish: (topic, path) => link.carrier?.publishCore('luoshu', topic, path),
  })
  const pluginsManager = new PluginsManager({
    booted: options.booted,
    installDir: options.installDir,
    ...(options.listDir !== undefined ? { listDir: options.listDir } : {}),
    link,
    runtime: options.runtime,
    modules,
    logWrites: () => options.booted.log.healthy,
    ...(options.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
    ...(options.confirmDelayMs !== undefined ? { confirmDelayMs: options.confirmDelayMs } : {}),
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
    ...(options.limited !== undefined ? { limited: options.limited } : {}),
  })
  const { windows } = options
  const carrier = new Carrier(carrierOptions(pluginsManager, modules, {
    log: options.booted.log,
    core: call => (runtimeActions.has(call.action) ? windows?.serve(call) ?? Promise.reject({ code: 'unavailable' }) : pluginsManager.serve(call)),
    logFailed: () => pluginsManager.controlFailed('log', 'log-failing'),
    ...(windows !== undefined ? { armed: windows.armed } : {}),
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.asks !== undefined ? { asks: options.asks } : {}),
    ...(options.limited !== undefined ? { limited: options.limited } : {}),
  }))
  link.carrier = carrier
  return { pluginsManager, carrier, modules }
}
