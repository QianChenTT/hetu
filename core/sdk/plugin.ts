import { floorConstants } from '../api/floor.ts'
import type { DepState } from '../api/lifecycle.ts'
import { VERSION } from '../api/version.ts'
import { Calls } from './calls.ts'
import { type Client, makeClient } from './client.ts'
import { attempt } from './refused.ts'
import { type Handler, type IncomingCall, Serving } from './serving.ts'
import { Sender, type Transport } from './transport.ts'

// What start and stop get: the calls, the plugin's own facts from init and the hooks around its life
export type PluginContext = Client & {
  readonly id: string
  readonly incarnation: number
  // Why the plugin last stopped or waited in this run, null on its first start
  readonly lastStop: string | null
  // The version an update replaced, until the new one reaches ready once
  readonly previousVersion: string | null
  // Whether one of its own requires or plugin.call targets is there: ready, or starting, which calls retry
  has(id: string): boolean
  // Runs when the core asks the plugin to stop, beside the spec's own stop, within the grace
  onStop(fn: () => void | Promise<void>): void
  // Serves <id>.<name>, an action the manifest declares under provides.actions
  provide(name: string, handler: Handler): void
  // The paths of these the call's own caller may read too, only while the call is live
  filterReadable(call: IncomingCall, paths: readonly string[]): Promise<string[]>
  readonly try: typeof attempt
}

export type PluginSpec = {
  start(ctx: PluginContext): void | Promise<void>
  stop?(ctx: PluginContext): void | Promise<void>
}

export type Plugin = { readonly kind: 'hetu-plugin', readonly spec: PluginSpec }

type Limit = 'messagesPerSecond' | 'callsInFlight' | 'callDeadlineMs'

// The limits the runtime knows the core holds the plugin to, which no message carries. Left out, the floor constants
export type RunOptions = { limits?: Partial<Record<Limit, number>> }

// What the stopped answer keeps back from the grace, so it lands before the loader ends the way
const STOP_MARGIN_MS = 250

export function definePlugin(spec: PluginSpec): Plugin {
  if (typeof spec?.start !== 'function') throw new TypeError('definePlugin needs a start function')
  return Object.freeze({ kind: 'hetu-plugin', spec })
}

type Phase = 'init' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped'

// One half of a plugin on its transport: init, start, ready, the heartbeat and the stop, with the calls inside
class Half {
  private readonly spec: PluginSpec
  private readonly post: (message: unknown) => void
  private readonly calls: Calls
  private phase: Phase = 'init'
  private deps: Record<string, unknown> = {}
  private readonly stops: (() => void | Promise<void>)[] = []
  private ctx: PluginContext | null = null
  private serving: Serving | null = null

  constructor(spec: PluginSpec, transport: Transport, options: RunOptions) {
    const limit = (name: Limit) => options.limits?.[name] ?? floorConstants[name]
    const sender = new Sender(message => transport.post(message), limit('messagesPerSecond'))
    this.spec = spec
    // Every message the half sends goes through the pacing, lifecycle answers included
    this.post = message => sender.send(message)
    this.calls = new Calls(sender, { callsInFlight: limit('callsInFlight'), callDeadlineMs: limit('callDeadlineMs') })
  }

  receive(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    const { v, kind } = message as { v?: unknown, kind?: unknown }
    if (v !== VERSION || typeof kind !== 'string') return
    // Nothing counts before init. Only the first init counts
    if (this.phase === 'init') {
      if (kind === 'init') this.init(message as Record<string, unknown>)
      return
    }
    if (kind === 'reply') this.calls.reply(message)
    else if (kind === 'deps') this.readDeps((message as { deps?: unknown }).deps)
    else if (kind === 'ping') this.post({ v: VERSION, kind: 'pong' })
    else if (kind === 'stop') void this.stop((message as { graceMs?: unknown }).graceMs)
    else if (kind === 'call') void this.serving!.deliver(message as Record<string, unknown>)
    else if (kind === 'cancel') this.serving!.cancel(message as Record<string, unknown>)
  }

  private init(message: Record<string, unknown>): void {
    const { id, incarnation, lastStop, previousVersion } = message
    if (typeof id !== 'string' || typeof incarnation !== 'number') return
    this.readDeps(message.deps)
    this.phase = 'starting'
    const request = (action: string, args: unknown, options?: Parameters<Calls['request']>[2]) => this.calls.request(action, args, options)
    const serving = new Serving(id, this.post, request)
    this.serving = serving
    const ctx: PluginContext = {
      ...makeClient(request),
      id,
      incarnation,
      lastStop: typeof lastStop === 'string' ? lastStop : null,
      previousVersion: typeof previousVersion === 'string' ? previousVersion : null,
      has: dep => {
        const state = this.deps[dep] as DepState | undefined
        return state === 'ready' || state === 'starting'
      },
      onStop: fn => { this.stops.push(fn) },
      provide: (name, handler) => serving.provide(name, handler),
      filterReadable: (call, paths) => serving.filterReadable(call, paths),
      try: attempt,
    }
    this.ctx = ctx
    void this.start(ctx)
  }

  private async start(ctx: PluginContext): Promise<void> {
    try {
      await this.spec.start(ctx)
    } catch (err) {
      // No ready goes out, so the loader's start-timeout ends the half
      this.phase = 'failed'
      console.error('hetu: start threw', err)
      return
    }
    if (this.phase !== 'starting') return
    this.phase = 'ready'
    this.post({ v: VERSION, kind: 'ready' })
  }

  private readDeps(deps: unknown): void {
    if (typeof deps === 'object' && deps !== null) this.deps = Object.assign(Object.create(null), deps)
  }

  // The spec's stop and every onStop run together. stopped goes out once they settle or the grace is nearly up,
  // whichever comes first. The calls still waiting then settle stopped
  private async stop(graceMs: unknown): Promise<void> {
    if (this.phase === 'stopping' || this.phase === 'stopped') return
    this.phase = 'stopping'
    const grace = typeof graceMs === 'number' && Number.isFinite(graceMs) ? Math.max(0, graceMs - STOP_MARGIN_MS) : 0
    const ctx = this.ctx!
    const work = [...(this.spec.stop === undefined ? [] : [() => this.spec.stop!(ctx)]), ...this.stops].map(async fn => {
      try {
        await fn()
      } catch (err) {
        console.error('hetu: stop threw', err)
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([Promise.all(work), new Promise(resolve => { timer = setTimeout(resolve, grace) })])
    clearTimeout(timer)
    this.phase = 'stopped'
    this.post({ v: VERSION, kind: 'stopped' })
    this.calls.close('stopped')
  }
}

// Runs a plugin on its transport. The runtime calls this, never the plugin
export function run(plugin: Plugin, transport: Transport, options: RunOptions = {}): void {
  const half = new Half(plugin.spec, transport, options)
  transport.listen(message => half.receive(message))
}
