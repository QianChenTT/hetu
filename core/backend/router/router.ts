import { moduleTopics, type Caller } from '../../api/envelope.ts'
import type { LimitName } from '../../api/limits.ts'
import { actionPathProblem, coreTopic } from '../../api/actions.ts'
import type { Part } from '../../api/ids.ts'
import { Bus } from './bus.ts'
import type { PluginTable } from '../../api/policy-jobs.ts'
import type { Asks, RouterDoor, RouterOptions, Heard, Port, Served, WayClosed } from './header.ts'
import { topicsOf, whoOf, Context } from './context.ts'
import { busState, listable, readable, recheck, rejudge, revokeAll } from './provide.ts'
import { register, handle, window, end, send, limit, close } from './door.ts'

// The one path every call and reply takes, with the floor rules in it. The caller always comes from the way in.
// Policy comes from the policy jobs it asks: the gate decides and the router enforces
export class Router implements RouterDoor {
  private readonly c: Context

  constructor(options: RouterOptions) {
    this.c = new Context(options, c => new Bus({
      state: () => busState(c),
      canList: (caller, path) => listable(c, caller, path),
      canRead: (caller, path) => readable(c, caller, path),
      recheck: (caller, topic) => recheck(c, caller, topic),
      limit: (plugin, name) => c.limits.of(plugin, name),
      // Coalesced, since a publisher's pace or a subscriber's own can make them
      // Shutdown takes the gate down on its way out, which is no failure, so the bus records nothing then
      dropped: (caller, why) => {
        if (!c.shutting) c.coalesced('events.dropped', { ...whoOf(caller), why })
      },
      // One record each, since a change of the gate or the grants makes them
      changed: (caller, change, topics) => {
        if (!c.shutting) c.recorded(recording => recording.coreRecord(`events.${change}`, { ...whoOf(caller), ...topicsOf(topics) }))
      },
    }))
  }

  // For the plugins manager, before it records core.stopping. The six policy job states have no stopping, so from here a policy job, guard
  // or provider that is down, for whatever reason, answers stopped where it would answer policy-down, guard-down or
  // unavailable. A gate that throws or a guard that answers late still answers as a fault. The bus keeps applying the
  // gate to the end, since a publish or a subscribe asks again first. It records no change to the subscriptions it
  // holds. Audit records keep queueing and the flush after close writes them
  stopping(): void {
    this.c.shutting = true
  }

  // Whether shutdown began, for a part the router hands calls to, so what is down there answers stopped as here
  shutting(): boolean {
    return this.c.shutting
  }

  // Recording saw the log's health change: windows read core.status again, which says whether the log takes appends
  status(): void {
    if (!this.c.closed && !this.c.shutting) this.c.bus.emit(coreTopic.status)
  }

  // hetu is about to quit, so windows that hear core.quitting can keep a draft within the grace main gives them
  quitting(): void {
    if (!this.c.closed) this.c.bus.emit(coreTopic.quitting)
  }

  // A core module's publish, as events.publish delivers one: <owner>.<topic> for a path, with the fields the contract's
  // moduleTopics gives the topic. A topic not there, fields that don't parse as its own or a path the contract's path
  // schema refuses, a dot segment among them, reaches nobody whatever the gate's state, since no shape step checks it
  // here. The topic's hears says whether a subscriber the gate lets list the path hears it or only one that reads it.
  // No manifest is read. No call carries it, so it makes no audit record of an events.publish
  publishCore(owner: string, topic: string, path: string, fields?: Record<string, unknown>): void {
    const named = `${owner}.${topic}`
    const spec = Object.hasOwn(moduleTopics, named) ? moduleTopics[named] : undefined
    if (this.c.closed || spec === undefined || actionPathProblem(path) !== null) return
    const parsed = spec.fields === null ? { success: fields === undefined, data: undefined } : spec.fields.safeParse(fields)
    if (!parsed.success) return
    this.c.bus.publish(named, path, { hears: spec.hears, ...(parsed.data === undefined ? {} : { fields: parsed.data }) })
  }

  // For the plugins manager, after it changed a policy job state, a plugin state or the grants snapshot. Once the gate's state or the
  // grants snapshot moved, the bus asks the gate again about every subscription it holds. Windows hear core.status, and
  // core.security once a new grants snapshot applied a security change. A new grants snapshot also has the gate judge
  // every open call with power again, stopping the ones it no longer lets on. The first grants snapshot the router
  // reads is where it starts, not a change. A grants snapshot it can't read is none, so it moves nothing
  changed(): void {
    if (this.c.closed || this.c.shutting) return
    this.c.bus.sync()
    this.c.bus.emit(coreTopic.status)
    const view = this.c.view()
    if (view === null || view === this.c.announced) return
    const first = this.c.announced === undefined
    this.c.announced = view
    if (first) return
    rejudge(this.c)
    this.c.bus.emit(coreTopic.security)
  }

  // For the plugins manager, when changed() threw: no open call with power was judged again, so each one a plugin holds
  // ends policy-down and each subscription of a plugin the gate holds ends (D-646)
  revokeAll(): void {
    if (!this.c.closed) revokeAll(this.c)
  }

  // The door's pipes, each in door.ts
  register(port: Port, caller: Caller): void {
    register(this.c, port, caller)
  }

  handle(caller: Caller, receive: (message: unknown) => void): { post: (message: unknown) => void } {
    return handle(this.c, caller, receive)
  }

  window<S>(check: (sender: S) => Caller | null): (sender: S, message: unknown, answer: (message: unknown) => void) => void {
    return window(this.c, check)
  }

  end(caller: Caller, code: 'stopped' | 'crashed' = 'stopped'): void {
    end(this.c, caller, code)
  }

  send(caller: Caller, message: unknown): void {
    send(this.c, caller, message)
  }

  limit(plugin: string, name: LimitName): number {
    return limit(this.c, plugin, name)
  }

  close(): void {
    close(this.c)
  }

  // What the plugins manager and the runtime hand in. The router calls them and never the part behind them
  read(table: PluginTable): void {
    this.c.table = table
  }

  serve(part: Part, served: Served): void {
    this.c.served.set(part, served)
  }

  asks(asks: Asks): void {
    this.c.asks = asks
  }

  onWayClosed(listener: WayClosed): void {
    this.c.wayClosed.push(listener)
  }

  onHeard(listener: Heard): void {
    this.c.heard.push(listener)
  }
}
