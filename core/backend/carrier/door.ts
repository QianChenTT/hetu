import { ack as ackSchema, caller as callerSchema, kindOf, type Caller } from '../../api/envelope.ts'
import type { LimitName } from '../../api/limits.ts'
import { frozen } from '../../api/plain.ts'
import type { Port } from './header.ts'
import type { Admitted } from '../flood-control/header.ts'
import { keyOf, type Context, type Send, type Way } from './context.ts'
import { flooded, cancelled, stop } from './open-calls.ts'
import { call, answered } from './route.ts'

// 1 bind, the pipes: ports, host handles and the windows' way in, each message counted by flood control before it is
// read. A way that ends or dies takes its subscriptions and its calls with it

// Binds a plugin half to one end of a channel. The carrier starts the port, since a paused MessagePortMain emits
// nothing, close included
export function register(c: Context, port: Port, caller: Caller): void {
  const bound = bindable(c, caller)
  if (c.ports.has(port)) throw new Error('port already registered')
  c.ports.add(port)
  const way = addWay(c, bound, 'port', message => port.postMessage(message), () => port.close())
  port.on('message', message => receive(c, way, message, way.send!))
  // A message that couldn't be read still counts against the rate
  port.on('messageerror', () => receive(c, way, undefined, way.send!))
  port.on('close', () => portClosed(c, way))
  port.start()
}

// A host half's in-process way in, bound like a port. Messages are copied both ways as a port copies them, so a host
// half can't change one after the carrier has read it. They arrive in a later microtask as a port's would
export function handle(c: Context, caller: Caller, hear: Send): { post: Send } {
  const bound = bindable(c, caller)
  const way = addWay(c, bound, 'handle', message => {
    const copy = structuredClone(message)
    queueMicrotask(() => {
      try {
        const result: unknown = hear(copy)
        // An async receive fails later and an unhandled rejection would take main down
        if (result instanceof Promise) result.catch(() => {})
      } catch {}
    })
  }, null)
  return {
    post: message => {
      let copy: unknown
      try {
        copy = structuredClone(message)
      } catch {}
      queueMicrotask(() => receive(c, way, copy, way.send!))
    },
  }
}

// The way in for windows. check names the window that sent a message and runs before anything else, before any
// await. A sender it doesn't name is dropped unread. Step 12 gives the real check. answer must keep working after the
// reply, since the window's events go back on the answer of its newest subscribe
export function window<S>(c: Context, check: (sender: S) => Caller | null): (sender: S, message: unknown, answer: Send) => void {
  return (sender, message, answer) => {
    let named: unknown
    try {
      named = check(sender)
    } catch {
      return
    }
    const parsed = callerSchema.safeParse(named)
    if (!parsed.success || parsed.data.kind !== 'window' || c.closed) return
    const caller = frozen(parsed.data)
    const way = c.ways.get(keyOf(caller)) ?? addWay(c, caller, 'window', null, null)
    receive(c, way, message, reply => {
      try {
        answer(reply)
      } catch {}
    })
  }
}

// For the plugins manager: a planned stop or a revoked incarnation. Its subscriptions and credits go at once, calls delivered to
// the way answer code and the calls it made are given up. Not a crash, so nothing is reported
export function end(c: Context, caller: Caller, code: 'stopped' | 'crashed' = 'stopped'): void {
  const way = c.ways.get(keyOf(caller))
  if (way === undefined) return
  c.ways.delete(way.key)
  shut(way)
  c.bus.drop(way)
  for (const pending of [...way.delivered.values()]) stop(c, pending, code)
  for (const pending of [...way.made.values()]) stop(c, pending, 'stopped')
}

// For the plugins manager: a lifecycle message (init, deps, stop or ping) down a half's own way. A way that is gone or was
// never registered drops it. Nothing the core sends counts against the half's rate
export function send(c: Context, caller: Caller, message: unknown): void {
  const way = c.ways.get(keyOf(caller))
  if (way === undefined || !way.open || way.send === null) return
  way.send(message)
}

// For the plugins manager: a limit as the carrier enforces it for one plugin, so the plugins manager's start and stop
// deadlines follow the same values
export function limit(c: Context, plugin: string, name: LimitName): number {
  return c.limits.of(plugin, name)
}

// The records of the calls it stops stay queued for the flush after close, then recording takes nothing more in. What
// the log can't take by then is lost with the run and a count of it couldn't land either
export function close(c: Context): void {
  c.closed = true
  for (const way of [...c.ways.values()]) end(c, way.caller)
  c.recorded(recording => recording.close())
}

function bindable(c: Context, caller: Caller): Caller {
  const parsed = callerSchema.safeParse(caller)
  // Windows come through window() and content frames are reserved for #97
  if (!parsed.success || parsed.data.kind !== 'plugin') throw new Error('not a plugin caller')
  if (c.closed) throw new Error('carrier closed')
  const bound = frozen(parsed.data)
  if (c.ways.has(keyOf(bound))) throw new Error('caller already registered')
  return bound
}

function addWay(c: Context, caller: Caller, via: Way['via'], send: Send | null, close: (() => void) | null): Way {
  const plugin = caller.kind === 'plugin' ? caller.id : null
  const way: Way = {
    caller,
    key: keyOf(caller),
    principal: caller.kind === 'window' ? `window:${caller.role}:${caller.n}` : `plugin:${plugin}`,
    plugin,
    via,
    send: send === null ? null : message => {
      try {
        send(message)
      } catch {}
    },
    close,
    open: true,
    ownClose: false,
    counted: Object.freeze({ plugin }),
    made: new Map(),
    delivered: new Map(),
  }
  c.ways.set(way.key, way)
  return way
}

// 1 bind: the caller is the way's. Every message counts against the way's rate before it is read
function receive(c: Context, way: Way, message: unknown, answer: Send): void {
  if (!way.open || c.closed) return
  // Everything main hears from a utility half counts as alive, noted before the rate so one dropped for it or one
  // that can't be read counts too. A worker's messages pass its relay first, which drops some unheard, so a worker
  // keeps the heartbeat alone
  if (way.via === 'port' && way.caller.kind === 'plugin' && way.caller.half === 'host' && c.info(way.caller.id)?.place === 'utility') {
    c.tell(c.heard, way.caller, 'alive')
  }
  const verdict = admit(c, way)
  // Closing a window's way would lock the human out, so a window only ever drops
  if (verdict === 'flood' && way.via !== 'window') return flood(c, way)
  // One over the rate gets no reply
  if (verdict !== 'pass') return
  // A message that throws while it is read is dropped like one that can't be read
  try {
    const kind = kindOf(message)
    if (kind === 'call') void call(c, way, message, answer)
    else if (kind === 'reply') answered(c, way, message)
    else if (kind === 'cancel') cancelled(c, way, message)
    else if (kind === 'ack') acked(c, way, message)
    else if ((kind === 'ready' || kind === 'pong' || kind === 'stopped') && way.plugin !== null) {
      c.tell(c.heard, way.caller, kind)
    }
    // Anything else, another v and the kinds only the carrier sends included, is dropped unread
  } catch {}
}

// Flood control's verdict on one message, pass while it is off. A throw or an answer outside the list drops that one
// message, so a broken count never lets one through
function admit(c: Context, way: Way): Admitted {
  const flood = c.holder(() => c.options.floodControl())
  const verdict = flood === null ? 'pass' : flooded(c, 'admit', () => flood.admit(way.counted))
  return verdict === 'pass' || verdict === 'flood' ? verdict : 'drop'
}

// The flood cap closes the way and reports the plugin crashed with flood. The carrier marks its own close first,
// since a local close() emits close too
function flood(c: Context, way: Way): void {
  shut(way)
  dead(c, way, 'flood')
}

function portClosed(c: Context, way: Way): void {
  if (way.ownClose) return
  dead(c, way, 'closed')
}

function shut(way: Way): void {
  way.ownClose = true
  way.open = false
  try {
    way.close?.()
  } catch {}
}

// Its subscriptions and credits go first, so nothing the plugins manager changes on hearing of the crash is sent to the dead
// way. Every way-closed listener runs next, so the plugins manager moves dependents to waiting before the calls the
// plugin held answer crashed. The calls it made are given up and their callees told
function dead(c: Context, way: Way, reason: 'closed' | 'flood'): void {
  way.open = false
  if (c.ways.get(way.key) === way) c.ways.delete(way.key)
  c.bus.drop(way)
  c.tell(c.wayClosed, way.caller, reason)
  for (const pending of [...way.delivered.values()]) stop(c, pending, 'crashed')
  for (const pending of [...way.made.values()]) stop(c, pending, 'crashed')
}

// An ack names the way's own events, so a subscriber frees no credits but its own
function acked(c: Context, way: Way, message: unknown): void {
  const parsed = ackSchema.safeParse(message)
  if (parsed.success) c.bus.ack(way, parsed.data.seq)
}

