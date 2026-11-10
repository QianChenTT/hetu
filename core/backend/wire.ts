import type { Caller } from '../api/envelope.ts'
import type { FloorConstant } from '../api/floor.ts'
import type { GuardableAction } from '../api/ids.ts'
import type { Field } from '../lib/event-log.ts'
import type { Booted } from './boot/boot.ts'
import { Carrier } from './carrier/carrier.ts'
import type { Asks, CarrierOptions, Debug, Landing, Port, Served } from './carrier/seams.ts'
import { Loader, type Failure } from './loader/loader.ts'
import type { CarrierLink, Runtime } from './loader/seams.ts'

export type WireOptions = {
  booted: Booted
  installDir: string
  // Where the install list is when it isn't in the install folder
  listDir?: string
  runtime: Runtime
  // The guards expected on an action, the same list for the loader and the carrier. Defaults to core/api's
  guardsFor?: (action: GuardableAction) => readonly string[]
  debug?: Debug
  asks?: Asks
  // watchdog.limit lowered one of this plugin's constants, for the runtime to pass on
  limited?: (plugin: string) => void
  // The windows' own actions the runtime serves, opening the trusted window, Quit and Restart hetu, and whether the
  // trusted window is past its input delay
  windows?: { serve: Served, armed: (caller: Caller) => boolean }
  // A security control or the log failed while hetu ran, for the runtime to quit and start hetu again
  onFailure?: (failure: Failure) => void
  // How long a request must be first in line before its Confirm counts, the input delay unless a test names another
  confirmDelayMs?: number
}

// The core actions the runtime serves, since only it opens windows and dialogs, ends the process and serves frames
const runtimeActions = new Set(['security.open', 'core.quit', 'core.relaunch', 'core.pickFolder', 'editor.frame', 'editor.frameGone'])

// The loader needs its link before the carrier exists, since the carrier needs the loader. Each call goes to the
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

  handle(caller: Caller, receive: (message: unknown) => void): { post: (message: unknown) => void } {
    return this.to.handle(caller, receive)
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

  limit(plugin: string, name: FloorConstant): number {
    return this.to.limit(plugin, name)
  }
}

// What the carrier asks the loader for: every slot, guard and provider from the loader's roles and the watchdog's core
// actions from its serve. wireCore and the loader's tests both build the carrier from it, so the tests run the wiring
// that ships
export function carrierOptions(
  loader: Loader,
  rest: Omit<CarrierOptions, 'loader' | 'gate' | 'guards' | 'providers' | 'watchdog'>,
): CarrierOptions {
  return {
    loader,
    gate: () => loader.role('gate', 'gate'),
    guards: id => loader.role(id, 'guard'),
    providers: id => loader.role(id, 'provider'),
    watchdog: () => loader.role('watchdog', 'watchdog'),
    core: loader.serve,
    asks: loader.asks,
    ...rest,
  }
}

// The core joined in its order: the link, then the loader holding it, then the carrier asking the loader for
// every slot, guard and provider, then the link pointed at the carrier. The log is the one EventLog boot opened, which
// the carrier writes its floor records and its audit queue through and serves log.history and log.verify from
export function wireCore(options: WireOptions): { loader: Loader, carrier: Carrier } {
  const link = new LinkToCarrier()
  const loader = new Loader({
    booted: options.booted,
    installDir: options.installDir,
    ...(options.listDir !== undefined ? { listDir: options.listDir } : {}),
    link,
    runtime: options.runtime,
    logWrites: () => options.booted.log.healthy,
    ...(options.onFailure !== undefined ? { onFailure: options.onFailure } : {}),
    ...(options.confirmDelayMs !== undefined ? { confirmDelayMs: options.confirmDelayMs } : {}),
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
  })
  const { windows } = options
  const carrier = new Carrier(carrierOptions(loader, {
    log: options.booted.log,
    core: call => (runtimeActions.has(call.action) ? windows?.serve(call) ?? Promise.reject({ code: 'unavailable' }) : loader.serve(call)),
    logFailed: () => loader.controlFailed('log', 'log-failing'),
    ...(windows !== undefined ? { armed: windows.armed } : {}),
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.asks !== undefined ? { asks: options.asks } : {}),
    ...(options.limited !== undefined ? { limited: options.limited } : {}),
  }))
  link.carrier = carrier
  return { loader, carrier }
}
