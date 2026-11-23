import { LIST_PAGE, providerActions, subscribeAction } from '../../api/actions.ts'
import type { CapabilityType } from '../../api/capabilities.ts'
import { token, type Caller, type RefusalCode } from '../../api/envelope.ts'
import { guardableActions, LOCK_GUARD } from '../../api/ids.ts'
import { frozen } from '../../api/plain.ts'
import { spaceOf } from '../../api/storage.ts'
import type { Access, GuardCall, Prepared, Scope } from '../../api/policy-jobs.ts'
import type { Paths } from './bus.ts'
import { no, isOne, field, refusalIn, type Context, type Pending, type Writable, type Kind, type No, type Outcome, type Asker } from './context.ts'
import { stop, result, thrown, finish, callOf, revoke } from './open-calls.ts'

// 5 precheck to 10 perform: the gate's answers, the guards and a provider's sequence from prepare to perform, with what
// the bus and a listing ask of the gate

// The canonical scope prepare gave, copied, so what the gate and the guards judge can't change under them. A provider
// canonicalises paths and nothing else: the access and the command come from the raw scope the router built, so a
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
// call with power passes, whatever the log's state, which decides nothing of a call, a call for a pair included
function gateOpen(c: Context): 'decide' | 'pass' | RefusalCode {
  const gate = c.policyJob('gate')
  if (gate === 'on') return 'decide'
  if (gate === 'starting') return 'starting'
  if (gate !== 'off') return c.down('policy-down')
  return 'pass'
}

// 5 precheck at the raw stage and 8 decide at the canonical one. Only an exact allow: true on the current grants snapshot
// lets a call on. A throw refuses this one call and is recorded. An ask, at the canonical stage only, becomes
// needs-confirm with the request the prompt holds, or not-granted with no prompt raised when prompt is false
export function judge(c: Context, pending: Pending, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt = true): No | null {
  if (stage === 'raw') setGate(pending, c.policyJob('gate'))
  return decideFor(c, pending, stage, capability, scope, prompt)
}

// 8 decide for a call delivered to a plugin, which no guard judges, recording what the gate let on so a new grants
// snapshot judges it again
export function judgeDelivery(c: Context, pending: Pending, kind: Extract<Kind, { kind: 'power' }>): No | null {
  const refused = judge(c, pending, 'canonical', kind.capability, kind.scope)
  if (refused === null) setJudged(pending, { kind, scope: kind.scope })
  return refused
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
// since a live subscription is its item in use. Every judgement of a call comes here, so a call for a pair is judged
// against the pair's items beside the caller's at each one
function decideFor(c: Context, asker: Asker, stage: Access['stage'], capability: CapabilityType, scope: Scope, prompt = true): No | null {
  const open = gateOpen(c)
  if (open === 'pass') return null
  if (open !== 'decide') return { code: open }
  const gate = c.holder(() => c.options.gate())
  if (gate === null) return { code: c.down('policy-down') }
  const { pair } = asker
  const access: Access = frozen({
    stage, caller: asker.caller, root: asker.root.caller, ...(asker.onBehalf !== undefined ? { onBehalf: asker.onBehalf } : {}),
    ...(pair !== undefined ? { pair } : {}), action: asker.action, capability, scope,
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
    const request = c.asks?.raise(ask, access)
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
// asks again whenever it moves. canList is true with the gate off by the human, as filterReadable passes every path
// then. A gate that can't be asked is down
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

// The gate asked about one path: no gate is a no, only an exact true counts and a throw is a no recorded under the
// method's name
function gateSays(c: Context, method: 'canList' | 'canRead', caller: Caller, path: string): boolean {
  const gate = c.holder(() => c.options.gate())
  if (gate === null) return false
  try {
    return gate[method](caller, path) === true
  } catch {
    c.fault('gate', method)
    return false
  }
}

// canList on every delivery of a path and on each name a listing found
export function listable(c: Context, caller: Caller, path: string): boolean {
  return gateSays(c, 'canList', caller, path)
}

// canRead on every delivery of a path only a reader hears
export function readable(c: Context, caller: Caller, path: string): boolean {
  return gateSays(c, 'canRead', caller, path)
}

// A subscription asked about again, at both stages as a subscribe is. No answer, a throw or one on an older
// grants snapshot included, is down, so the bus holds the subscription back and asks again rather than ending it on a fault.
// An ask is the item's first use: the prompt holds a request for the human or can't for now, while the subscription
// waits for the Confirm. A declined ask refuses
export function recheck(c: Context, caller: Caller, topic: string): 'allow' | 'refuse' | 'down' | 'ask' {
  const asker: Asker = { caller, root: { caller }, onBehalf: undefined, action: subscribeAction.action }
  const scope: Scope = frozen({ topics: [topic] })
  for (const stage of ['raw', 'canonical'] as const) {
    const refused = decideFor(c, asker, stage, subscribeAction.capability, scope)
    if (refused === null) continue
    if (refused.code === 'needs-confirm' || refused.code === 'throttled') return 'ask'
    const none = refused.code === 'starting' || refused.code === 'policy-down' || refused.code === 'stale'
    return none ? 'down' : 'refuse'
  }
  return 'allow'
}

// 6 route to a provider, then 7 prepare, 8 decide, 9 guard and 10 perform. The provider is the core module serving
// the namespace, null while that module is off or failed, which answers unavailable. The provider's latch, held from
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
  // Frozen one level, since callOf froze the rest and the signal must stay able to abort
  const call = Object.freeze({
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
    } catch {
      // What prepare set aside stays the provider's to clean up. The call won't perform and its answer doesn't wait on
      // release
    }
  }
  if (pending.done) return release()
  if (prepared === null) return finish(c, pending, { ok: false, ...(refusalIn(given) ?? { code: 'failed' }) })
  setScope(pending, prepared.scope)

  // Nothing awaits from here to perform. Perform gets the frozen copy the gate and the guards judge, never the object
  // prepare gave, which could answer another path when read again
  const refused = judged(c, pending, kind, prepared, true)
  if (refused !== null) {
    release()
    return finish(c, pending, { ok: false, ...refused })
  }
  cleared = prepared
  if (kind.kind === 'power') setJudged(pending, { kind, scope: prepared.scope })
  // A gate or a guard that ran past the deadline leaves the call no time to act in
  if (c.clock() >= pending.due) {
    release()
    return stop(c, pending, 'timeout')
  }

  let performed: unknown
  setPerforming(pending, true)
  try {
    performed = await provider.perform(call, prepared)
  } catch (err) {
    if (refusalIn(err)?.code === 'tampered') tampered(c, pending, id, args)
    lister?.charge()
    if (pending.revoked !== null) return finish(c, pending, no(pending.revoked))
    return thrown(c, pending, id, 'perform', err)
  }
  lister?.charge()
  // A result that comes after the revoke is dropped, a write that landed included and the caller hears why
  if (pending.revoked !== null) return finish(c, pending, no(pending.revoked))
  if (lister !== null) return finish(c, pending, listed(c, lister, performed))
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
// would act on now, one for each path prepare gave, judged as the first were. Never once the call has ended or was
// revoked, which answers with the revoke's code. No prompt
// is raised from here, so an item that still asks at first use answers not-granted. A call let on acts on these
// paths, so its record names them. A call that ends refused after a refused one records the paths refused, with the
// code the provider passes on, in place of the paths judged before. One that fails on its shape names nothing new
function judgeAgain(c: Context, pending: Pending, kind: Extract<Kind, { kind: 'power' }>, prepared: Prepared | null, paths: readonly string[]): No | null {
  if (prepared === null || pending.done) return { code: 'not-granted' }
  if (pending.revoked !== null) return { code: pending.revoked }
  const given = prepared.scope.paths
  if (!Array.isArray(paths) || given === undefined || paths.length !== given.length || !paths.every(path => typeof path === 'string')) return { code: 'failed' }
  const now: Prepared = frozen({ ...prepared, scope: { ...prepared.scope, paths: [...paths] } })
  const refused = judged(c, pending, kind, now, false)
  if (refused !== null) {
    setRefusedScope(pending, now.scope)
    return refused
  }
  setScope(pending, now.scope)
  setRefusedScope(pending, undefined)
  setJudged(pending, { kind, scope: now.scope })
  return null
}

// 8 decide again, for every open call with power the gate let on, on the frozen copy it judged, once a new grants
// snapshot applied. No prompt is raised. A refused call is revoked as stale, or as policy-down when the gate can't
// judge it, so a gate that throws stops what it can't judge. A call not yet judged is judged on the newest grants
// snapshot when it gets there. A widened grant stops nothing. With the gate off by the human nothing is judged again,
// so every open call runs to its end
export function rejudge(c: Context): void {
  if (c.policyJob('gate') === 'off') return
  for (const pending of withPower(c)) {
    const refused = judgeAll(c, pending, 'canonical', pending.judged.kind, pending.judged.scope, false)
    if (refused !== null) revoke(c, pending, revokedAs(refused.code))
  }
}

// What a call judged again is revoked as: policy-down when the gate can't judge it, stale for every other refusal
function revokedAs(code: RefusalCode): RefusalCode {
  return code === 'policy-down' ? 'policy-down' : 'stale'
}

// When the plugins manager's change threw, no open call was judged again on its grants snapshot. So every open call
// with power a plugin holds is revoked as policy-down and every live subscription of a plugin the gate holds ends,
// whether or not its own grant changed, as a control that crashed in use refuses all (D-646). A window's grants are
// fixed, so its calls end only when the gate isn't on, answered as rejudge answers them then (D-649). A window's
// subscriptions are left to the bus's next sync, as rejudge leaves them, and anything with no power runs on. With the
// gate off by the human nothing is judged, so nothing ends. A call whose end throws is recorded and the rest still end,
// the subscriptions included
export function revokeAll(c: Context): void {
  const open = gateOpen(c)
  if (open === 'pass') return
  const windows = open === 'decide' ? null : revokedAs(open)
  try {
    for (const pending of withPower(c)) {
      const code = pending.caller.kind === 'plugin' ? c.down('policy-down') : windows
      if (code === null) continue
      try {
        revoke(c, pending, code)
      } catch {
        c.fault('router', 'revokeAll')
      }
    }
  } finally {
    c.bus.endGated(caller => caller.kind === 'plugin')
  }
}

// Every open call with power the gate let on, read as it goes, so one a revoke before it ended is passed by
function* withPower(c: Context): Generator<Pending & { readonly judged: NonNullable<Pending['judged']> }> {
  for (const way of [...c.ways.values()]) {
    for (const pending of [...way.made.values()]) {
      if (!pending.done && pending.judged !== null) yield pending as Pending & { readonly judged: NonNullable<Pending['judged']> }
    }
  }
}

// 9 guard: every expected guard on the action, in core/api's order, unless the human switched it off. A GuardCall
// carries no arguments. The answer is timed once it returns and a late one counts as guard-down. The lock guard's deny
// answers locked
function guard(c: Context, pending: Pending, prepared: Prepared): RefusalCode | null {
  if (!isOne(guardableActions, pending.action)) return null
  for (const id of c.guardsFor(pending.action)) {
    const state = c.policyJob(id)
    if (state === 'off') continue
    const guard = state === 'on' ? c.holder(() => c.options.guards(id)) : null
    if (guard === null) return c.down('guard-down')
    const call: GuardCall = frozen({
      callId: pending.callId, caller: pending.caller, root: pending.root.caller,
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
    if (answer === 'deny') return id === LOCK_GUARD ? 'locked' : 'guard-refused'
    if (answer !== 'allow') return 'guard-down'
  }
  return null
}

// A stored key failed its hash line, as the part serving the namespace said. The plugin decides what to do with it. A
// plugin can trigger this, so it is one record per space each second, naming the first key and then the last with the
// count
function tampered(c: Context, pending: Pending, part: string, args: unknown): void {
  const space = spaceOf(pending.caller)
  const key = field(args, 'key')
  if (space === null || typeof key !== 'string') return
  c.coalesced(`${part}.tampered`, { space, key }, { by: { space }, join: (_held, next) => next })
}

// What a listing's provider gets to filter with and the charge for the whole listing. canList asks the gate for the
// caller and the pair the call is judged for, every name passing with the gate off by the human. A throw counts as a no
// and fails the listing. The whole listing, the walk and the gate's time alike, counts against the caller's second of
// the gate's time as gate.filterReadable's does
function listerOf(c: Context, pending: Pending): { canList: (path: string) => boolean, threw: () => boolean, charge: () => void } {
  const off = c.policyJob('gate') === 'off'
  const gate = off ? null : c.holder(() => c.options.gate())
  const { pair } = pending
  let threw = false
  const started = c.clock()
  let charged = false
  return {
    canList: path => {
      if (off) return true
      if (gate === null || threw) return false
      try {
        return gate.canList(pending.caller, path, pair) === true
      } catch {
        threw = true
        return false
      }
    },
    threw: () => threw,
    charge: () => {
      if (charged) return
      charged = true
      c.gateCharge(pending.way.principal, c.clock() - started)
    },
  }
}

// A listing's page as the provider gave it, checked again before the caller sees it: at most LIST_PAGE names, each
// one the caller may list, with a next that is null or the page's last name. Anything else fails, so a provider that
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

// Before a listing is made: refused while the gate can't be asked or its count of the gate's time throws, throttled
// once the caller spent its second. So a flood of listings costs main at most one listing past the budget each second
function listingRefused(c: Context, pending: Pending): RefusalCode | null {
  if (c.policyJob('gate') === 'off') return null
  if (!askable(c)) return c.down('policy-down')
  return c.gateSpent(pending.way.principal, pending.way.plugin)
}

// The fields of an open call this file owns, written only here but scope, which route.ts sets on a subscribe (D-632)
function setGate(pending: Pending, gate: Pending['gate']): void {
  (pending as Writable<Pending>).gate = gate
}

// What the call is recorded as covering
export function setScope(pending: Pending, scope: Pending['scope']): void {
  (pending as Writable<Pending>).scope = scope
}

function setRefusedScope(pending: Pending, refusedScope: Pending['refusedScope']): void {
  (pending as Writable<Pending>).refusedScope = refusedScope
}

function setJudged(pending: Pending, judged: Pending['judged']): void {
  (pending as Writable<Pending>).judged = judged
}

function setPerforming(pending: Pending, performing: boolean): void {
  (pending as Writable<Pending>).performing = performing
}
