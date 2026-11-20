import { LIST_PAGE, providerActions } from '../../api/actions.ts'
import type { CapabilityType } from '../../api/capabilities.ts'
import { token, type Caller, type RefusalCode } from '../../api/envelope.ts'
import { guardableActions } from '../../api/ids.ts'
import { frozen } from '../../api/plain.ts'
import { spaceOf } from '../../api/storage.ts'
import type { Access, GuardCall, Prepared, Scope } from '../../api/policy-jobs.ts'
import type { Paths } from './bus.ts'
import { dotted, no, isOne, field, refusalIn, type Context, type Pending, type Kind, type No, type Outcome, type Asker } from './context.ts'
import { stop, result, thrown, finish, callOf } from './open-calls.ts'

// 5 precheck to 10 perform: the gate's answers, the guards and a provider's sequence from prepare to perform, with what
// the bus and a listing ask of the gate

// The canonical scope prepare gave, copied, so what the gate and the guards judge can't change under them. A provider
// canonicalises paths and nothing else: the access and the command come from the raw scope the carrier built, so a
// prepare can't turn a commit into a read or one command into another
function preparedIn(value: unknown, raw: Scope = {}): Prepared | null {
  const scope = field(value, 'scope')
  if (typeof scope !== 'object' || scope === null) return null
  const paths = field(scope, 'paths')
  const target = field(scope, 'target')
  const baseVersion = field(value, 'baseVersion')
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every(path => typeof path === 'string'))) return null
  if (target !== undefined && typeof target !== 'string') return null
  if (baseVersion !== undefined && typeof baseVersion !== 'string') return null
  return frozen({
    scope: {
      ...(paths !== undefined ? { paths: [...paths] } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(raw.access !== undefined ? { access: raw.access } : {}),
      ...(raw.command !== undefined ? { command: [...raw.command] } : {}),
    },
    ...(baseVersion !== undefined ? { baseVersion } : {}),
  })
}

// The gate policy job's state: decide asks the gate, pass skips it and a code refuses. With the gate off by the human a
// call with power passes while its record can still land and passes unrecorded once the human turned recording off.
// A call for an agent never passes: with the gate off nothing judges the agent's own grant, so it answers as a gate
// that is down. Once shutdown began a call for an agent answers stopped whatever the gate's state, so the door's call
// during a shutdown answers the same with the gate on as with it off
export function gateOpen(c: Context, agent?: string): 'decide' | 'pass' | RefusalCode {
  if (agent !== undefined && c.shutting) return 'stopped'
  const gate = c.policyJob('gate')
  if (gate === 'on') return 'decide'
  if (gate === 'starting') return 'starting'
  if (gate !== 'off' || agent !== undefined) return c.down('policy-down')
  if (!c.logFailing()) return 'pass'
  return c.down('policy-down')
}

// 5 precheck at the raw stage and 8 decide at the canonical one. Only an exact allow: true on the current grants snapshot
// lets a call on. A throw refuses this one call and is recorded. An ask, at the canonical stage only, becomes
// needs-confirm with the request the prompt holds, or not-granted with no prompt raised when prompt is false
export function judge(c: Context, pending: Pending, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt = true): No | null {
  if (stage === 'raw') pending.gate = c.policyJob('gate')
  return decideFor(c, pending, stage, capability, scope, prompt)
}

// A call's requirement and then its second one, when its action has one, on the paths at the places it names. A
// scope that lacks one of those places fails, since the second requirement would judge nothing
export function judgeAll(c: Context, pending: Pending, stage: Access['stage'], kind: Extract<Kind, { kind: 'power' }>, scope: Scope, prompt = true): No | null {
  const refused = judge(c, pending, stage, kind.capability, scope, prompt)
  if (refused !== null || kind.also === undefined) return refused
  const paths = kind.also.at.map(at => scope.paths?.[at])
  if (paths.length === 0 || !paths.every(path => typeof path === 'string')) return { code: 'failed' }
  return judge(c, pending, stage, kind.also.capability, frozen({ paths }), prompt)
}

// The gate's answer for a call or for a subscription the bus asks about again. An ask raises the prompt for both,
// since a live subscription is its item in use. Every judgement of a call comes here, so a call for an agent is
// judged against the agent's own grant beside the caller's at each one and passes at none while the gate isn't on
function decideFor(c: Context, asker: Asker, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt = true): No | null {
  const open = gateOpen(c, asker.agent)
  if (open === 'pass') return null
  if (open !== 'decide') return { code: open }
  const gate = c.holder(() => c.options.gate())
  if (gate === null) return { code: c.down('policy-down') }
  const access: Access = frozen({
    stage, caller: asker.caller, ...(asker.onBehalf !== undefined ? { onBehalf: asker.onBehalf } : {}),
    ...(asker.agent !== undefined ? { agent: asker.agent } : {}), action: asker.action, capability, scope,
  })
  let allow: unknown, view: unknown, code: unknown, ask: unknown
  try {
    const decision = gate.decide(access) as unknown
    if (typeof decision !== 'object' || decision === null) return { code: 'not-granted' }
    // Each field once, so a getter can't answer one way to a check and another to the next
    const fields = decision as Record<string, unknown>
    allow = fields.allow
    view = fields.view
    code = fields.code
    ask = fields.ask
  } catch (err) {
    c.fault('gate', stage === 'raw' ? 'precheck' : 'decide')
    c.debugOf(asker, 'gate', err)
    return { code: 'policy-down' }
  }
  const current = c.view()
  if (current === null) return { code: c.down('policy-down') }
  // An answer with no view isn't an answer at all. One on an older view is stale
  if (!Number.isSafeInteger(view)) return { code: 'not-granted' }
  if (view !== current) return { code: 'stale' }
  if (allow === true) return null
  if (stage === 'canonical' && allow === undefined && typeof ask === 'string') {
    if (!prompt) return { code: 'not-granted' }
    const request = raise(c, ask, access)
    if (typeof request === 'string') return { code: 'needs-confirm', request }
    return request ?? { code: 'not-granted' }
  }
  return { code: allow === false && code === 'switched-off' ? 'switched-off' : 'not-granted' }
}

// A request id in the grammar, or one of the refusals the prompt may give. Anything else refuses not-granted
function raise(c: Context, ask: string, access: Access): string | No | null {
  try {
    const request = c.options.asks?.raise(ask, access)
    if (token.safeParse(request).success) return request as string
    if (request === null || typeof request !== 'object') return null
    if (request.code === 'throttled') return { code: 'throttled' }
    if (request.code === 'not-granted') return request.reason === 'declined' ? { code: 'not-granted', reason: 'declined' } : { code: 'not-granted' }
    return null
  } catch {
    return null
  }
}

// What the bus delivers paths under. The key holds everything a subscription the gate holds depends on, so the bus
// asks again whenever it moves. canList is true with the gate off by the human whatever the log, since deliveries
// are never logged, as filterReadable passes every path then. A gate that can't be asked is down
export function busState(c: Context): { key: string, paths: Paths, view: number | null } {
  const state = c.policyJob('gate')
  const view = c.view()
  const paths: Paths = state === 'off' ? 'all' : askable(c) ? 'ask' : 'none'
  return { key: `${state} ${paths} ${view}`, paths, view }
}

// The gate can be asked: its policy job is on, there is a holder and the grants snapshot can be read. Otherwise every answer
// would be policy-down, so the bus holds paths back and a subscribe stands
export function askable(c: Context): boolean {
  return c.policyJob('gate') === 'on' && c.holder(() => c.options.gate()) !== null && c.view() !== null
}

// canList on every delivery of a path and on each name a listing found: only an exact true counts and a throw is a no
// that is recorded
export function listable(c: Context, caller: Caller, path: string): boolean {
  const gate = c.holder(() => c.options.gate())
  if (gate === null) return false
  try {
    return gate.canList(caller, path) === true
  } catch {
    c.fault('gate', 'canList')
    return false
  }
}

// A subscription asked about again, at both stages as a subscribe is. No answer, a throw or one on an older
// grants snapshot included, is down, so the bus holds the subscription back and asks again rather than ending it on a fault.
// An ask is the item's first use: the prompt holds a request for the human, or can't for now, and the subscription
// waits for the Confirm. A declined ask refuses
export function recheck(c: Context, caller: Caller, topic: string): 'allow' | 'refuse' | 'down' | 'ask' {
  const asker: Asker = { caller, onBehalf: undefined, action: 'events.subscribe' }
  const scope: Scope = frozen({ topics: [topic] })
  for (const stage of ['raw', 'canonical'] as const) {
    const refused = decideFor(c, asker, stage, 'events.subscribe', scope)
    if (refused === null) continue
    if (refused.code === 'needs-confirm' || refused.code === 'throttled') return 'ask'
    const none = refused.code === 'starting' || refused.code === 'policy-down' || refused.code === 'stale'
    return none ? 'down' : 'refuse'
  }
  return 'allow'
}

// 6 route to a provider, then 7 prepare, 8 decide, 9 guard and 10 perform. The provider is the core module serving
// the namespace, null while that module is off or failed, which answers unavailable. The provider's lock, held from
// prepare, goes back through release when the call stops before perform
export async function provide(c: Context, pending: Pending, id: string, args: unknown, kind: Kind): Promise<void> {
  const listing = providerActions[pending.action]?.filter === 'list'
  const unlisted = listing ? listingRefused(c, pending) : null
  if (unlisted !== null) return finish(c, pending, no(unlisted))
  const provider = c.holder(() => c.options.providers(id))
  if (provider === null) return finish(c, pending, no(c.down('unavailable')))
  const lister = listing ? listerOf(c, pending) : null
  // Set once the gate and the guards let the call on, so a judge asked before then answers no
  let cleared: Prepared | null = null
  const judge = kind.kind === 'power' ? (paths: readonly string[]) => judgeAgain(c, pending, kind, cleared, paths) : undefined
  const call = frozen({
    ...callOf(pending, args), ...(lister === null ? {} : { canList: lister.canList }), ...(judge === undefined ? {} : { judge }),
  })
  let given: unknown
  try {
    given = await provider.prepare(call)
  } catch (err) {
    return thrown(c, pending, id, 'prepare', err)
  }
  const prepared = preparedIn(given, kind.kind === 'power' ? kind.scope : undefined)
  const release = () => {
    if (prepared === null) return
    try {
      provider.release?.(call, prepared)
    } catch {}
  }
  if (pending.done) return release()
  if (prepared === null) return finish(c, pending, { ok: false, ...(refusalIn(given) ?? { code: 'failed' }) })
  pending.scope = prepared.scope

  // Nothing awaits from here to perform, and perform gets the frozen copy the gate and the guards judge, never the
  // object prepare gave, which could answer another path when read again
  const refused = judged(c, pending, kind, prepared, true)
  if (refused !== null) {
    release()
    return finish(c, pending, { ok: false, ...refused })
  }
  cleared = prepared
  // A gate or a guard that ran past the deadline leaves the call no time to act in
  if (c.clock() >= pending.due) {
    release()
    return stop(c, pending, 'timeout')
  }

  let performed: unknown
  try {
    performed = await provider.perform(call, prepared)
  } catch (err) {
    if (id === 'storage' && refusalIn(err)?.code === 'tampered') tampered(c, pending, args)
    lister?.charge()
    return thrown(c, pending, id, 'perform', err)
  }
  if (lister !== null) {
    lister.charge()
    return finish(c, pending, listed(c, lister, performed))
  }
  result(c, pending, id, performed)
}

// 8 decide on a call with power and 9 guard, for the call's first judgement and for every second ask, so the two
// can't judge a call differently. Each end the caller named stays one end, so the second requirement judges the end
// it was asked about
function judged(c: Context, pending: Pending, kind: Kind, prepared: Prepared, prompt: boolean): No | null {
  if (kind.kind === 'power') {
    const reshaped = kind.also !== undefined && prepared.scope.paths?.length !== kind.scope.paths?.length
    const refused = reshaped ? { code: 'failed' as const } : judgeAll(c, pending, 'canonical', kind, prepared.scope, prompt)
    if (refused !== null) return refused
  }
  const guarded = guard(c, pending, prepared)
  return guarded === null ? null : { code: guarded }
}

// A provider's second ask, when a look at the disk after the first judgement reads a path otherwise: the paths it
// would act on now, one for each path prepare gave, judged as the first were. Never once the call has ended. No prompt
// is raised from here, so an item that still asks at first use answers not-granted. A call let on acts on these
// paths, so its record names them. A call that ends refused after a refused one records the paths refused, with the
// code the provider passes on, in place of the paths judged before. One that fails on its shape names nothing new
function judgeAgain(c: Context, pending: Pending, kind: Extract<Kind, { kind: 'power' }>, prepared: Prepared | null, paths: readonly string[]): No | null {
  if (prepared === null || pending.done) return { code: 'not-granted' }
  const given = prepared.scope.paths
  if (!Array.isArray(paths) || given === undefined || paths.length !== given.length || !paths.every(path => typeof path === 'string')) return { code: 'failed' }
  const now: Prepared = frozen({ ...prepared, scope: { ...prepared.scope, paths: [...paths] } })
  const refused = judged(c, pending, kind, now, false)
  if (refused !== null) {
    pending.refusedScope = now.scope
    return refused
  }
  pending.scope = now.scope
  pending.refusedScope = undefined
  return null
}

// 9 guard: every expected guard on the action, in core/api's order, unless the human switched it off. A GuardCall
// carries no arguments. The answer is timed once it returns and a late one counts as guard-down
function guard(c: Context, pending: Pending, prepared: Prepared): RefusalCode | null {
  if (!isOne(guardableActions, pending.action)) return null
  for (const id of c.guardsFor(pending.action)) {
    const state = c.policyJob(id)
    if (state === 'off') continue
    const guard = state === 'on' ? c.holder(() => c.options.guards(id)) : null
    if (guard === null) return c.down('guard-down')
    const call: GuardCall = frozen({
      callId: pending.callId, caller: pending.caller,
      ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
      action: pending.action, scope: prepared.scope,
      ...(prepared.baseVersion !== undefined ? { baseVersion: prepared.baseVersion } : {}),
    })
    const asked = c.clock()
    let answer: unknown
    try {
      answer = guard.check(call)
    } catch (err) {
      c.fault(id, 'guard')
      c.debugOf(pending, id, err)
      return 'guard-down'
    }
    if (c.clock() - asked > c.limits.of(id, 'guardAnswerMs')) {
      c.fault(id, 'guard-late')
      return 'guard-down'
    }
    if (answer === 'deny') return 'guard-refused'
    if (answer !== 'allow') return 'guard-down'
  }
  return null
}

// A stored key failed its hash line. The plugin decides what to do with it. A plugin can trigger this, so it is one
// record per space each second, naming the first key and then the last with the count
function tampered(c: Context, pending: Pending, args: unknown): void {
  const space = spaceOf(pending.caller)
  const key = field(args, 'key')
  if (space === null || typeof key !== 'string') return
  c.coalesced('storage.tampered', { space, key }, { by: { space }, join: (_held, next) => next })
}

// What a listing's provider gets to filter with, and the charge for the whole listing. canList asks the gate for the
// caller and the agent it acts for, every name passing with the gate off by the human and none for an agent then. A
// throw counts as a no and fails the listing. The whole listing, the walk and the gate's time alike, counts against
// the caller's second as filterReadable's does
function listerOf(c: Context, pending: Pending): { canList: (path: string) => boolean, threw: () => boolean, charge: () => void } {
  const off = c.policyJob('gate') === 'off'
  const gate = off ? null : c.holder(() => c.options.gate())
  const { agent } = pending
  let threw = false
  const started = c.clock()
  let charged = false
  return {
    canList: path => {
      if (dotted(path)) return false
      if (off) return agent === undefined
      if (gate === null || threw) return false
      try {
        return gate.canList(pending.caller, path, agent) === true
      } catch {
        threw = true
        return false
      }
    },
    threw: () => threw,
    charge: () => {
      if (charged) return
      charged = true
      secondOf(c, pending.way.principal).spent += c.clock() - started
    },
  }
}

// A listing's page as the provider gave it, checked again before the caller sees it: at most LIST_PAGE names, each
// one the caller may list, and a next that is null or the page's last name. Anything else fails, so a provider that
// filters wrongly leaks no name, not even as where the next page starts
function listed(c: Context, lister: { canList: (path: string) => boolean, threw: () => boolean }, result: unknown): Outcome {
  if (lister.threw()) {
    c.fault('gate', 'canList')
    return no('policy-down')
  }
  const paths = field(result, 'paths')
  const next = field(result, 'next')
  if (!Array.isArray(paths) || paths.length > LIST_PAGE || !paths.every(path => typeof path === 'string')) return no('failed')
  if (next !== null && next !== paths.at(-1)) return no('failed')
  if (!paths.every(path => lister.canList(path))) return no(lister.threw() ? 'policy-down' : 'failed')
  return { ok: true, result: { paths: [...paths], next } }
}

// Before a listing is made: refused while the gate can't be asked, and throttled once the caller spent its second,
// so a flood of listings costs main at most one listing past the budget each second
function listingRefused(c: Context, pending: Pending): RefusalCode | null {
  if (c.policyJob('gate') === 'off') return null
  if (!askable(c)) return c.down('policy-down')
  return secondOf(c, pending.way.principal).spent >= c.limits.of(pending.way.plugin, 'filterMsPerSecond') ? 'throttled' : null
}

// The gate's time spent on behalf of one principal in the current second of the carrier's clock
export function secondOf(c: Context, principal: string): { second: number, spent: number } {
  const now = c.clock()
  let spent = c.filtered.get(principal)
  if (spent === undefined || now - spent.second >= 1000 || now < spent.second) {
    spent = { second: now, spent: 0 }
    c.filtered.set(principal, spent)
  }
  return spent
}

