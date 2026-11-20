import { capabilityTypes, scopedUiTypes } from '../../api/capabilities.ts'
import { answer as answerSchema, calleeRefusalCodes, VERSION, type Caller, type RefusalCode } from '../../api/envelope.ts'
import { frozen } from '../../api/plain.ts'
import type { Served } from './header.ts'
import { hashOf, no, newId, isOne, keyOf, field, whoOf, topicsOf, joinTopics, type Context, type Send, type Way, type Pending, type Filtering, type Target, type Kind, type Outcome } from './context.ts'
import { charge, admitted, stop, result, thrown, finish, early, callOf } from './open-calls.ts'
import { gateOpen, judge, judgeAll, askable, provide, secondOf } from './provide.ts'
import { shape, floorOf } from './shape.ts'

// The entry of every call through its steps, then 6 route: core actions, the bus, the parts serving a namespace,
// providers and plugins

// The core actions the trusted window may send inside its input delay, since they only read
const trustedReads: ReadonlySet<string> = new Set(['core.self', 'core.status', 'security.list', 'log.segments', 'log.verify'])

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
  if (pending.lends !== undefined) {
    const open = gateOpen(c, pending.lends)
    if (open !== 'decide') return finish(c, pending, no(open as RefusalCode))
  }
  // A subscribe keeps its own precheck, since one made while the gate is down stands rather than being refused
  if (target.kind === 'events') return events(c, pending, args, kind)
  // 5 precheck, for calls with power only
  if (kind.kind === 'power') {
    const refused = judgeAll(c, pending, 'raw', kind, kind.scope)
    if (refused !== null) return finish(c, pending, { ok: false, ...refused })
  }
  // 6 route, then 7 to 10 by the route
  if (target.kind === 'core') return coreAction(c, pending, args)
  if (target.kind === 'served') return serve(c, pending, c.options.served?.[target.namespace], args)
  if (target.kind === 'provider') return provide(c, pending, target.provider, args, kind)
  return deliver(c, pending, target, args, kind)
}

// Core actions: the carrier serves the gate's two and hands the rest to recording, the plugins manager and the runtime
async function coreAction(c: Context, pending: Pending, args: unknown): Promise<void> {
  if (pending.action === 'gate.filterReadable') return finish(c, pending, filterReadable(c, pending.way, args))
  if (pending.action === 'gate.reach') return finish(c, pending, reach(c, args))
  if (pending.action === 'log.segments' || pending.action === 'log.verify') {
    const { recording } = c
    return serve(c, pending, recording === null ? undefined : call => recording.serve(call), args)
  }
  // Anything the trusted window sends inside its input delay counts for nothing, whatever the page did: a Confirm, and
  // with confirmOff on a request that applies at once. Its reads answer
  const { caller } = pending
  if (caller.kind === 'window' && caller.role === 'trusted' && !trustedReads.has(pending.action) && !c.armed(caller)) {
    return finish(c, pending, no('throttled'))
  }
  return serve(c, pending, c.options.core, args)
}

// What a plugin may do with one note through the editor bridge, which the drawer asks before it serves the plugin
// anything about the note: read it, write it, list its name and the ui items it holds, from the gate with the plugin as the caller at
// the canonical stage. A write whose item still asks at first use counts as none, since the bridge raises no prompt.
// Everything with the gate off while a record can still land, policy-down while it starts or is down, as for any call
function reach(c: Context, args: unknown): Outcome {
  const plugin = field(args, 'plugin') as string
  const path = field(args, 'path') as string | undefined
  const state = c.policyJob('gate')
  if (state === 'off') {
    const open = gateOpen(c)
    if (open !== 'pass') return no(open as RefusalCode)
    const verbs = capabilityTypes.filter(type => type.startsWith('ui.') && !isOne(scopedUiTypes, type))
    const any = path !== undefined
    return { ok: true, result: { read: any, edit: any, uiRead: any, list: any, verbs } }
  }
  const gate = state === 'on' ? c.holder(() => c.options.gate()) : null
  if (gate === null) return no(c.down('policy-down'))
  const caller: Caller = frozen({ kind: 'plugin', id: plugin, half: 'worker', incarnation: 1 })
  try {
    const held = gate.verbs(plugin, 'editor')
    const verbs = Array.isArray(held) ? held.filter(verb => typeof verb === 'string') : []
    if (path === undefined) return { ok: true, result: { read: false, edit: false, uiRead: false, list: false, verbs } }
    const read = gate.canRead(caller, path) === true
    const list = gate.canList(caller, path) === true
    // An edit through the editor needs ui.edit on the note, never luoshu.write. ui.read is a read the drawer serves
    // only for a note the human opened
    const allows = (action: string, capability: 'ui.edit' | 'ui.read') => {
      const decision = gate.decide(frozen({ stage: 'canonical', caller, action, capability, scope: frozen({ paths: [path] }) }))
      return 'allow' in decision && decision.allow === true
    }
    const edit = allows('editor.edit', 'ui.edit')
    const uiRead = allows('editor.read', 'ui.read')
    return { ok: true, result: { read, edit, uiRead, list, verbs } }
  } catch {
    c.fault('gate', 'reach')
    return no('policy-down')
  }
}

// Only during a live call delivered on this way. The paths the callee may read itself that the call's own caller may
// read too, every path with the gate off and policy-down while the gate is starting or failed. A path a callee read is
// taken as it is, a dot segment included, since a store from an older build may hold one: the gate's matcher matches
// no such path and with the gate off the callee gets back only what it gave. One message asks the gate up to twice per path, synchronously in main, and scopes shaped for the matcher's worst case make each ask
// slow. So the gate's time counts against the live call's caller, filterMsPerSecond each second, and one that floods
// a plugin with calls spends only its own. Past it the call answers throttled and the live call keeps how far it got,
// so the next try goes on from there and any call finishes within its deadline. That progress is dropped once the
// gate or the grants snapshot changed, so no answer from before a narrowing stands
// For a live call that acts for an agent, the paths the agent may read too, and none at all while the gate isn't on.
// The door's own call names mcp-http-handler as its caller, which reads nothing and passes the answer on to the agent, so there the
// agent's grant stands in for the caller's
function filterReadable(c: Context, way: Way, args: unknown): Outcome {
  const live = way.delivered.get(field(args, 'call') as string)
  const paths = field(args, 'paths') as string[]
  if (live === undefined || live.done) return no('invalid')
  const agent = live.lends
  const door = agent !== undefined && live.agent === undefined
  if (agent !== undefined) {
    const open = gateOpen(c, agent)
    if (open !== 'decide') return no(open as RefusalCode)
  }
  const state = c.policyJob('gate')
  if (state === 'off') return { ok: true, result: paths }
  const gate = state === 'on' ? c.holder(() => c.options.gate()) : null
  if (gate === null) return no(c.down('policy-down'))
  const budget = c.limits.of(live.way.plugin, 'filterMsPerSecond')
  const spent = secondOf(c, live.way.principal)
  const started = c.clock()
  if (spent.spent >= budget) return no('throttled')
  const view = c.view()
  const before = live.filtering
  live.filtering = null
  const progress: Filtering = before !== null && before.gate === gate && before.view === view && before.hash === hashOf(paths)
    ? before
    : { hash: '', gate, view, asked: 0, kept: [] }
  try {
    while (progress.asked < paths.length) {
      const path = paths[progress.asked]
      const kept = gate.canRead(way.caller, path, agent) === true && (door || gate.canRead(live.caller, path) === true)
      if (kept) progress.kept.push(progress.asked)
      progress.asked++
      if (progress.asked < paths.length && spent.spent + c.clock() - started >= budget) break
    }
  } catch {
    c.fault('gate', 'canRead')
    return no('policy-down')
  } finally {
    spent.spent += c.clock() - started
  }
  if (progress.asked < paths.length) {
    if (progress.hash === '') progress.hash = hashOf(paths)
    live.filtering = progress
    return no('throttled')
  }
  return { ok: true, result: progress.kept.map(at => paths[at]) }
}

// 6 route to the bus, then for a subscribe 5 precheck and 8 decide on the topics the gate holds, then 10 perform. A
// subscribe made while the gate can't be asked stands rather than being refused, so what a plugin subscribed to at
// start isn't lost. With the gate off it passes as any call with power does. A subscribe whose gated topics all
// stand used no power yet, so its audit record names only the topics that went live and coalesces like a free call.
// The standing ones go in an events.waiting record until asking again starts or ends them
function events(c: Context, pending: Pending, args: unknown, kind: Kind): void {
  const { way } = pending
  if (pending.action === 'events.publish') {
    const path = field(args, 'path') as string | undefined
    c.bus.publish(field(args, 'topic') as string, path)
    return finish(c, pending, { ok: true, result: null })
  }
  const topics = [...new Set(field(args, 'topics') as string[])]
  if (pending.action === 'events.unsubscribe') {
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

async function serve(c: Context, pending: Pending, served: Served | undefined, args: unknown): Promise<void> {
  if (served === undefined) return finish(c, pending, no('unavailable'))
  let given: unknown
  try {
    given = await served(callOf(pending, args))
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

