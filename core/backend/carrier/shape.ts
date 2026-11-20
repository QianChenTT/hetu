import { coreActions, coreTopics, ends, eventActions, providerActions, type EventAction } from '../../api/actions.ts'
import { agentLabel, callEnvelope, type Caller, type ReasonCode, type RefusalCode } from '../../api/envelope.ts'
import { qualifiedName, serverOf } from '../../api/ids.ts'
import { frozen, measurePlain } from '../../api/plain.ts'
import { agentDoor, agentHost, agentOwn } from '../../api/policy-jobs.ts'
import { no, isOne, field, namespaceOf, type Context, type Way, type Target, type Kind, type No, type Shaped } from './context.ts'

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
// its own
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
  // The contract's schema for an action of the core, a plugin's and a served part's arguments opaque
  const schema = target.kind === 'action' || target.kind === 'bus' || target.kind === 'provider' ? target.spec.args.safeParse(parsed.data.args) : null
  if (schema !== null && !schema.success) return refuse('invalid')
  const args = schema !== null ? schema.data : parsed.data.args

  if (parentId !== undefined) {
    if (parent === null || parsed.data.onBehalf !== undefined) return refuse('invalid')
    if (parent.depth + 1 > c.limits.of(way.plugin, 'parentDepth')) return refuse('invalid')
  }
  // A label is an agent's only down a chain that started at the door's own call with a label, the door known by the
  // way that call came on. The door's call is still mcp-http-handler's own. Any other call keeps a label as text that grants
  // nothing. A call from the door names the agent it is for in the agent label's form, so one with no label or another
  // is refused before mcp sees it
  const agent = parent?.lends
  const door = parent === null && action === agentDoor.action && isDoor(c, way)
  if (door && !agentLabel.safeParse(onBehalf).success) return refuse('invalid')
  // A label the human revoked is refused at the door with no word from mcp-http-handler, so a revoke holds while mcp-http-handler's token lives
  if (door && c.revoked(onBehalf as string)) return refuse('not-granted')
  return { ok: true, id, action, onBehalf, target, args, bytes: measured.bytes, parent, agent, lends: door ? onBehalf : agent }
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
  const spec = providerActions[action]
  return spec === undefined ? null : { kind: 'provider', provider: server.part, spec }
}

// 3 floor: who may call a core action, security.* included, the trusted window held to core actions,
// the agent host held to the door's calls past its own, an agent's chain held to the tool table and the free actions
// that skip the gate. Never asks the gate
export function floorOf(c: Context, way: Way, target: Target, args: unknown, agent: string | undefined): Kind | No {
  const { caller } = way
  const trusted = caller.kind === 'window' && caller.role === 'trusted'
  // The agent host reaches a provider but its own storage and a plugin but itself only for an agent whose call from
  // the door is live, so a plugin that reads for it can't read for no one
  const host = caller.kind === 'plugin' && caller.id === agentHost
  const beyond = target.kind === 'provider' ? !isOne(agentOwn, target.provider) : target.kind === 'plugin' && target.target !== agentHost
  if (host && beyond && agent === undefined) return { code: 'not-granted' }
  // A call for an agent from any plugin down the chain reaches its caller's own storage and cache and the provider
  // actions core/api's table marks as tools, whatever the agent or the caller holds. Marking an action in the table is
  // what opens it
  if (agent !== undefined && target.kind === 'provider' && target.spec.agent === undefined && !isOne(agentOwn, target.provider)) {
    return { code: 'not-granted' }
  }
  if (target.kind === 'action') {
    const { from } = target.spec
    const admitted = from === 'any'
      || (from === 'windows' && caller.kind === 'window')
      || (from === 'trusted' && trusted)
      || (from === 'http' && isDoor(c, way))
      // The agent host under a live call from the door, so the agent it asks for is that call's and no other
      || (from === 'agent' && host && agent !== undefined)
    // A from with no rule here refuses every caller
    if (!admitted) return { code: 'not-granted' }
    // Anything the trusted window sends inside its input delay counts for nothing, whatever the page did: a Confirm, and
    // with confirmOff on a request that applies at once. The reads the contract marks answer
    if (trusted && target.spec.reads !== true && !c.armed(caller)) return { code: 'throttled' }
    return { kind: 'action' }
  }
  if (target.kind === 'bus') {
    // A subscription outlives the call it was made under and what it delivers is filtered for the subscriber alone,
    // so the agent host subscribes to no topic but its own, under an agent's call or not
    const kind = eventsFloor(c, caller, target.spec, args)
    return host && 'kind' in kind && kind.kind === 'power' ? { code: 'not-granted' } : kind
  }
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

// mcp-http-handler's host half in its utility process: a way register made, so a port the plugins manager minted, bound to plugin mcp-http-handler's
// host half, with mcp-http-handler placed utility as the plugins manager reads it now. A worker of mcp-http-handler matches the id, the way and the
// place, so the half is named too. The incarnation is not compared: the plugins manager ends every way of an incarnation in
// release before it mints the next, so no way of an older one is left to call
function isDoor(c: Context, way: Way): boolean {
  const { caller } = way
  const half = way.via === 'port' && caller.kind === 'plugin' && caller.id === 'mcp-http-handler' && caller.half === 'host'
  return half && c.info('mcp-http-handler')?.place === 'utility'
}

// 3 floor for events.*, which keeps identity rather than limits, so it holds with the gate off too. A plugin publishes
// only the topics its manifest declared, from any of its halves. core.* comes only from the carrier and goes only to
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
  return { kind: 'power', capability: 'events.subscribe', scope: frozen({ topics: gated }) }
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

