import type { Caller } from '../api/envelope.ts'
import type { FloorConstant } from '../api/floor.ts'
import type { GuardableAction } from '../api/ids.ts'
import type { Field } from '../lib/event-log.ts'
import type { Booted } from './boot/boot.ts'
import { Carrier } from './carrier/carrier.ts'
import type { Asks, Debug, Landing, Port } from './carrier/seams.ts'
import { Loader } from './loader/loader.ts'
import type { CarrierLink, Runtime } from './loader/seams.ts'

export type WireOptions = {
  booted: Booted
  installDir: string
  runtime: Runtime
  // The guards expected on an action, the same list for the loader and the carrier. Defaults to core/api's
  guardsFor?: (action: GuardableAction) => readonly string[]
  debug?: Debug
  asks?: Asks
}

// The loader needs its link before the carrier exists, since the carrier needs the loader. Each call goes to the
// carrier once wireCore attached it, and one made before that throws
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

  record(event: string, fields: Record<string, Field>): Promise<Landing> {
    return this.to.record(event, fields)
  }

  changed(): void {
    this.to.changed()
  }

  stopping(): void {
    this.to.stopping()
  }

  limit(plugin: string, name: FloorConstant): number {
    return this.to.limit(plugin, name)
  }
}

// The core joined in step 6's order: the link, then the loader holding it, then the carrier asking the loader for
// every slot, guard and provider, then the link pointed at the carrier. The log is the one EventLog boot opened
export function wireCore(options: WireOptions): { loader: Loader, carrier: Carrier } {
  const link = new LinkToCarrier()
  const loader = new Loader({
    booted: options.booted,
    installDir: options.installDir,
    link,
    runtime: options.runtime,
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
  })
  const carrier = new Carrier({
    loader,
    gate: () => loader.role('gate', 'gate'),
    guards: id => loader.role(id, 'guard'),
    providers: id => loader.role(id, 'provider'),
    watchdog: () => loader.role('watchdog', 'watchdog'),
    log: options.booted.log,
    core: loader.serve,
    ...(options.guardsFor !== undefined ? { guardsFor: options.guardsFor } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.asks !== undefined ? { asks: options.asks } : {}),
  })
  link.carrier = carrier
  return { loader, carrier }
}
