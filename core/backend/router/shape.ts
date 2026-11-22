import { coreActions, coreTopics, ends, eventActions, providerActions, roleActions, type CoreFrom, type EventAction } from '../../api/actions.ts'
import { callEnvelope, type Caller, type ReasonCode, type RefusalCode } from '../../api/envelope.ts'
import { qualifiedName, serverOf } from '../../api/ids.ts'
import { frozen, measurePlain } from '../../api/plain.ts'
import { isOne, field, namespaceOf, pairOf, type Context, type Way, type Target, type Kind, type No, type Pending, type Shaped } from './context.ts'

// 2 shape and 3 floor: what a call is and who may make it, settled before anything is charged or asked

// The caller's own id and action, read only to answer a call the shape step refused. An action outside the grammar is
// never echoed or recorded
function readId(message: unknown): number | null {
  const id = field(message, 'id')
  return Number.isSafeInteger(id) && (id as number) >= 0 ? id as number : null
}

function readAction(message: unknown): string {
  const action = field(message, 'action')
  return qualifiedName.safeParse(action).success ? action as string : ''
}

// 2 shape: the strict envelope, args within the caller's cap, the schema of a core or provider action and a parent
// that names a live call delivered on this same way. A call under a parent takes the parent's onBehalf and can't set
// its own. What onBehalf holds is the root caller's own text, which the envelope holds to its length and to what a
// screen shows
export function shape(c: Context, way: Way, message: unknown): Shaped {
  const parsed = callEnvelope.safeParse(message)
  if (!parsed.success) {
    return { ok: false, id: readId(message), action: readAction(message), onBehalf: undefined, parent: null, no: { code: 'invalid' } }
  }
  const { id, action, parent: parentId } = parsed.data
  // Looked up first so a refused call's record still names its root. A call past its due time is as good as over,
  // though its timer hasn't run yet
  const named = parentId === undefined ? null : way.delivered.get(parentId) ?? null
  const parent = named !== null && !named.done && c.clock() < named.due ? named : null
  const onBehalf = parent !== null ? parent.onBehalf : parsed.data.onBehalf
  const refuse = (code: RefusalCode, reason?: ReasonCode): Shaped =>
    ({ ok: false, id, action, onBehalf, parent, no: reason ? { code, reason } : { code } })
  const measured = measurePlain(parsed.data.args, c.limits.of(way.plugin, 'argumentBytes'))
  if (!measured.ok) return refuse('invalid', measured.tooLarge ? 'too-large' : undefined)
  // One live call per id, or a reply and a cancel couldn't tell two apart
  if (way.made.has(id)) return refuse('invalid')

  const dot = action.indexOf('.')
  const target = targetOf(serverOf(action.slice(0, dot)), action, dot)
  if (target === null) return refuse('invalid')
  // The contract's schema for an action of the core or a role, a plugin's and a served part's arguments opaque
  const schema = target.kind === 'action' || target.kind === 'bus' || target.kind === 'provider' || target.kind === 'role'
    ? target.spec.args.safeParse(parsed.data.args)
    : null
  if (schema !== null && !schema.success) return refuse('invalid')
  const args = schema !== null ? schema.data : parsed.data.args

  // A role that names a label is refused without one, before anything is asked
  if (target.kind === 'role' && target.spec.onBehalf && onBehalf === undefined) return refuse('invalid')
  if (parentId !== undefined) {
    if (parent === null || parsed.data.onBehalf !== undefined) return refuse('invalid')
    if (parent.depth + 1 > c.limits.of(way.plugin, 'parentDepth')) return refuse('invalid')
  }
  return { ok: true, id, action, onBehalf, target, args, bytes: measured.bytes, parent }
}

// The route the namespace table gives the action's namespace, with the contract's entry for the action. null for an
// action the contract has no entry for in a namespace the core keeps
function targetOf(server: ReturnType<typeof serverOf>, action: string, dot: number): Target | null {
  if (server === undefined) return { kind: 'plugin', target: action.slice(0, dot), name: action.slice(dot + 1) }
  if (server.route === 'served') return { kind: 'served', part: server.part }
  if (server.route === 'bus') {
    const spec = eventActions[action]
    return spec === undefined ? null : { kind: 'bus', spec }
  }
  if (server.route === 'action') {
    const spec = coreActions[action]
    return spec === undefined ? null : { kind: 'action', part: server.part, spec, each: server.each === true }
  }
  if (server.route === 'role') {
    const spec = roleActions[action]
    return spec === undefined ? null : { kind: 'role', spec }
  }
  const spec = providerActions[action]
  return spec === undefined ? null : { kind: 'provider', provider: server.part, spec }
}

// 3 floor: who may call a core action or a role, security.* included, the trusted window held to core actions and the
// free actions that skip the gate. Never asks the gate
export function floorOf(c: Context, way: Way, target: Target, args: unknown, parent: Pending | null): Kind | No {
  const { caller } = way
  const trusted = caller.kind === 'window' && caller.role === 'trusted'
  if (target.kind === 'action' || target.kind === 'role') {
    if (!admits(way, target.spec.from, parent)) return { code: 'not-granted' }
    // Anything the trusted window sends inside its input delay counts for nothing, whatever the page did: a Confirm, and
    // with confirmOff on a request that applies at once. The reads the contract marks answer
    const reads = target.kind === 'action' && target.spec.reads === true
    if (trusted && !reads && !c.armed(caller)) return { code: 'throttled' }
    return { kind: target.kind }
  }
  if (target.kind === 'bus') return eventsFloor(c, caller, target.spec, args)
  // The trusted window holds core actions and the core topics only and never note content
  if (trusted) return { code: 'not-granted' }
  if (target.kind === 'served') return { kind: 'served' }
  if (target.kind === 'provider') {
    const { capability, scope, access, also } = target.spec
    if (capability === null) return { kind: 'free' }
    const paths = scope === 'path'
      ? [field(args, 'path') as string]
      : scope === 'paths' ? [...field(args, 'paths') as string[]] : scope === 'ends' ? ends.map(end => field(args, end) as string) : undefined
    // A command is canonical as written. access is the action's own, from core/api's table
    const command = scope === 'command' ? [...field(args, 'command') as string[]] : undefined
    return {
      kind: 'power',
      capability,
      scope: frozen({ ...(paths !== undefined ? { paths } : {}), ...(access !== undefined ? { access } : {}), ...(command !== undefined ? { command } : {}) }),
      ...(also !== undefined ? { also: frozen({ capability: also.capability, at: also.ends.map(end => ends.indexOf(end)) }) } : {}),
    }
  }
  // A plugin's own halves call each other freely
  if (caller.kind === 'plugin' && caller.id === target.target) return { kind: 'free' }
  return { kind: 'power', capability: 'plugin.call', scope: frozen({ target: target.target }) }
}

// Whether the caller is one the action's from names. A from with no rule here refuses every caller
function admits(way: Way, from: CoreFrom, parent: Pending | null): boolean {
  const { caller } = way
  return from === 'any'
    || (from === 'windows' && caller.kind === 'window')
    || (from === 'trusted' && caller.kind === 'window' && caller.role === 'trusted')
    || (from === 'door' && isDoor(way))
    || (from === 'pair' && rootCalled(parent))
}

// The port of the utility process the core started, as the plugins manager recorded it when it registered the port. No
// id, place or half the caller names counts. The incarnation is not compared: the plugins manager ends every way of an
// incarnation in release before it mints the next, so no way of an older one is left to call
function isDoor(way: Way): boolean {
  return way.via === 'utility'
}

// The plugin the root of a chain called, under that call, with the chain carrying a pair: the parent was delivered on
// the caller's own way and has no parent of its own. So the pair a part reads from the call is that chain's and no
// other
function rootCalled(parent: Pending | null): boolean {
  return parent !== null && parent.parent === null && pairOf(parent.root.caller, parent.onBehalf) !== undefined
}

// 3 floor for events.*, which keeps identity rather than limits, so it holds with the gate off too. A plugin publishes
// only the topics its manifest declared, from any of its halves. core.* comes only from the router and goes only to
// windows. The trusted window hears nothing else. Publishing, a plugin hearing its own topics, a window hearing core.*
// and unsubscribing skip the gate. A subscribe to anything else is judged under events.subscribe on those topics
function eventsFloor(c: Context, caller: Caller, spec: EventAction, args: unknown): Kind | No {
  if (spec.does === 'unsubscribe') return { kind: 'free' }
  if (spec.does === 'publish') {
    return caller.kind === 'plugin' && declares(c, caller.id, field(args, 'topic') as string) ? { kind: 'free' } : { code: 'not-granted' }
  }
  const topics = [...new Set(field(args, 'topics') as string[])]
  const core = topics.filter(topic => isOne(coreTopics, topic))
  if (caller.kind !== 'window' && core.length > 0) return { code: 'not-granted' }
  if (caller.kind === 'window' && caller.role === 'trusted' && core.length < topics.length) return { code: 'not-granted' }
  const own = (topic: string) => caller.kind === 'plugin' && namespaceOf(topic) === caller.id
  const gated = topics.filter(topic => !isOne(coreTopics, topic) && !own(topic))
  if (gated.length === 0) return { kind: 'free' }
  return { kind: 'power', capability: spec.capability, scope: frozen({ topics: gated }) }
}

// Whether the plugin's manifest declared the topic, published as <id>.<name>
function declares(c: Context, id: string, topic: string): boolean {
  if (namespaceOf(topic) !== id) return false
  try {
    const declared = c.info(id)?.topics
    return Array.isArray(declared) && declared.includes(topic.slice(id.length + 1))
  } catch {
    return false
  }
}

