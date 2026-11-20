import type { EventAction } from '../../api/actions.ts'
import { answer as answerSchema, calleeRefusalCodes, VERSION, type RefusalCode } from '../../api/envelope.ts'
import { frozen } from '../../api/plain.ts'
import type { Served } from './header.ts'
import { no, newId, isOne, keyOf, field, whoOf, topicsOf, joinTopics, type Context, type Send, type Way, type Pending, type Target, type Kind } from './context.ts'
import { charge, admitted, stop, result, thrown, finish, early, callOf, liveOf } from './open-calls.ts'
import { gateOpen, judge, judgeAll, askable, provide } from './provide.ts'
import { shape, floorOf } from './shape.ts'

// The entry of every call through its steps, then 6 route by the namespace table: the parts handed in under their
// names, the bus, providers and plugins

// Nothing escapes: a call no step could take is dropped and one in flight fails
export async function call(c: Context, way: Way, message: unknown, answer: Send): Promise<void> {
  let pending: Pending | null = null
  // The room flood control charged, given back here when the call throws before it is in flight
  let release: (() => void) | null = null
  try {
    const started = c.now()
    const callId = newId()
    const shaped = shape(c, way, message)
    if (!shaped.ok) return early(c, way, answer, callId, shaped, shaped.no, started)
    const kind = floorOf(c, way, shaped.target, shaped.args, shaped.agent)
    if ('code' in kind) return early(c, way, answer, callId, shaped, kind, started)
    const charged = charge(c, way, shaped.parent, shaped.bytes)
    if (!('release' in charged)) return early(c, way, answer, callId, shaped, charged, started)
    release = charged.release
    pending = admitted(c, way, answer, callId, shaped, kind, started, release)
    await run(c, pending, shaped.target, shaped.args, kind)
  } catch (err) {
    if (pending === null) return release?.()
    c.debugOf(pending, null, err)
    finish(c, pending, no('failed'))
  }
}

async function run(c: Context, pending: Pending, target: Target, args: unknown, kind: Kind): Promise<void> {
  // A call for an agent goes on only while the gate is on, a free one or a core action with nothing to judge included,
  // so no call for an agent runs while the agent's grant can't be judged. The door's own call lends its label, so it is
  // refused here before mcp sees any of the agent's request. A call with power is judged at decideFor too
  if (pending.lends !== undefined && !lent(c, pending, pending.lends)) return
  // A subscribe keeps its own precheck, since one made while the gate is down stands rather than being refused
  if (target.kind === 'bus') return events(c, pending, target.spec, args, kind)
  // 5 precheck, for calls with power only
  if (kind.kind === 'power') {
    const refused = judgeAll(c, pending, 'raw', kind, kind.scope)
    if (refused !== null) return finish(c, pending, { ok: false, ...refused })
  }
  // 6 route, then 7 to 10 by the route
  if (target.kind === 'action' || target.kind === 'served') {
    return serve(c, pending, c.served.get(target.part), args, target.kind === 'action' && target.spec.live === true)
  }
  if (target.kind === 'provider') return provide(c, pending, target.provider, args, kind)
  return deliver(c, pending, target, args, kind)
}

// 6 route to the bus, then for a subscribe 5 precheck and 8 decide on the topics the gate holds, then 10 perform. A
// subscribe made while the gate can't be asked stands rather than being refused, so what a plugin subscribed to at
// start isn't lost. With the gate off it passes as any call with power does. A subscribe whose gated topics all
// stand used no power yet, so its audit record names only the topics that went live and coalesces like a free call.
// The standing ones go in an events.waiting record until asking again starts or ends them
function events(c: Context, pending: Pending, spec: EventAction, args: unknown, kind: Kind): void {
  const { way } = pending
  if (spec.does === 'publish') {
    const path = field(args, 'path') as string | undefined
    c.bus.publish(field(args, 'topic') as string, path)
    return finish(c, pending, { ok: true, result: null })
  }
  const topics = [...new Set(field(args, 'topics') as string[])]
  if (spec.does === 'unsubscribe') {
    c.bus.unsubscribe(way, topics)
    return finish(c, pending, { ok: true, result: null })
  }
  // The bus catches up with the gate first, so a standing subscription the gate now allows starts once
  c.bus.sync()
  if (!c.bus.fits(way, topics, c.limits.of(way.plugin, 'topicsPerHalf'))) return finish(c, pending, no('invalid', 'too-large'))
  const gated = kind.kind === 'power' ? kind.scope.topics ?? [] : []
  const down = gated.length > 0 && c.policyJob('gate') !== 'off' && !askable(c)
  if (kind.kind === 'power' && !down) {
    for (const stage of ['raw', 'canonical'] as const) {
      const refused = judge(c, pending, stage, kind.capability, kind.scope)
      if (refused !== null) return finish(c, pending, { ok: false, ...refused })
    }
    if (c.clock() >= pending.due) return stop(c, pending, 'timeout')
  }
  const free = new Set(topics.filter(topic => !gated.includes(topic)))
  const holder = {
    owner: way, caller: way.caller, plugin: way.plugin,
    // A window has no way to push on but the answer to its own call
    push: pending.answer,
    alive: () => way.open && c.ways.get(way.key) === way,
  }
  const standing = c.bus.subscribe(holder, topics, free, down)
  if (standing.length > 0) {
    const live = topics.filter(topic => !standing.includes(topic))
    pending.scope = live.length > 0 ? frozen({ topics: live }) : undefined
    if (!gated.some(topic => live.includes(topic))) pending.coalesce = true
    // Counted per half, since the topics are the plugin's to pick
    c.coalesced('events.waiting', { ...whoOf(way.caller), ...topicsOf(standing) }, { by: whoOf(way.caller), join: joinTopics })
  }
  finish(c, pending, { ok: true, result: { standing } })
}

// A call for an agent goes on only while the gate can judge the agent. Otherwise the call ends with the gate's code
function lent(c: Context, pending: Pending, agent: string): boolean {
  const open = gateOpen(c, agent)
  if (open !== 'decide') finish(c, pending, no(open as RefusalCode))
  return open === 'decide'
}

// 6 route to a part handed in, then 10 perform by it. An action that names a live call goes on only while that call
// is open and was delivered on the caller's own way. The part gets a view of it. A live call that acts for an
// agent is let on only while the gate can judge the agent
async function serve(c: Context, pending: Pending, served: Served | undefined, args: unknown, names: boolean): Promise<void> {
  if (served === undefined) return finish(c, pending, no('unavailable'))
  const named = names ? pending.way.delivered.get(field(args, 'call') as string) : undefined
  if (names && (named === undefined || named.done)) return finish(c, pending, no('invalid'))
  if (named?.lends !== undefined && !lent(c, pending, named.lends)) return
  let given: unknown
  try {
    given = await served(callOf(pending, args, named === undefined ? undefined : liveOf(named)))
  } catch (err) {
    return thrown(c, pending, null, 'perform', err)
  }
  result(c, pending, null, given)
}

// 6 route to a plugin's declared <target>.<name>, then 8 decide and 10 perform by the callee. Only a caller that
// passed precheck learns here whether the target is there, starting or declares the action
function deliver(c: Context, pending: Pending, target: Extract<Target, { kind: 'plugin' }>, args: unknown, kind: Kind): void {
  const info = c.info(target.target)
  if (info?.state === 'starting') return finish(c, pending, no('starting'))
  // Calls to an unresponsive plugin time out at once
  if (info?.state === 'unresponsive') return finish(c, pending, no('timeout'))
  if (info === null || info.state !== 'ready') return finish(c, pending, no('unavailable'))
  const declared = Object.hasOwn(info.actions, target.name) ? info.actions[target.name] : undefined
  if (typeof declared !== 'object' || declared === null) return finish(c, pending, no('not-found'))
  const { caller } = pending
  const own = caller.kind === 'plugin' && caller.id === target.target
  const from = declared.from
  if (!own && from !== undefined && !(caller.kind === 'plugin' && Array.isArray(from) && from.includes(caller.id))) {
    return finish(c, pending, no('not-granted'))
  }
  const callee = c.ways.get(keyOf({ kind: 'plugin', id: target.target, half: info.serves, incarnation: info.incarnation }))
  if (callee === undefined || !callee.open || callee.send === null) return finish(c, pending, no('unavailable'))
  if (kind.kind === 'power') {
    const refused = judge(c, pending, 'canonical', kind.capability, kind.scope)
    if (refused !== null) return finish(c, pending, { ok: false, ...refused })
    pending.judged = { kind, scope: kind.scope }
  }
  if (c.clock() >= pending.due) return stop(c, pending, 'timeout')
  pending.callee = callee
  callee.delivered.set(pending.callId, pending)
  callee.send({
    v: VERSION, kind: 'call', callId: pending.callId, caller: pending.caller, action: pending.action, args,
    deadline: pending.deadline, ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
  })
}

// A callee's answer matches only a call delivered on this same way, so a reply on another port finds nothing
export function answered(c: Context, way: Way, message: unknown): void {
  const parsed = answerSchema.safeParse(message)
  const callId = parsed.success ? parsed.data.callId : field(message, 'callId')
  const pending = typeof callId === 'string' ? way.delivered.get(callId) : undefined
  if (pending === undefined || pending.done || pending.callee !== way) return
  if (!parsed.success) return finish(c, pending, no('failed'))
  // A plugin answers for itself, so a code that describes the core's state reaches the caller as failed
  if (!parsed.data.ok) {
    const { code, reason } = parsed.data.refusal
    if (!isOne(calleeRefusalCodes, code)) return finish(c, pending, no('failed'))
    return finish(c, pending, { ok: false, code, ...(reason === 'too-large' ? { reason } : {}) })
  }
  result(c, pending, way.plugin, parsed.data.result)
}

