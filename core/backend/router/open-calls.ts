import { cancel as cancelSchema, VERSION, type Refusal, type RefusalCode } from '../../api/envelope.ts'
import { MAX_TIMER_MS } from '../../api/limits.ts'
import { frozen, measurePlain } from '../../api/plain.ts'
import type { Call, LiveCall } from '../../api/policy-jobs.ts'
import type { Charged, Held } from '../flood-control/header.ts'
import { no, pairOf, refusalIn, type Context, type Send, type Way, type Root, type Pending, type Kind, type No, type Outcome, type About, type Shaped } from './context.ts'

// 4 ceiling and the life of an open call: its deadline, cancel, stop and finish, the one exit of every call, where
// 11 record happens

// A step of flood control, undefined with a fault recorded when it throws, which no answer of its is
export function flooded(c: Context, step: string, run: () => unknown): unknown {
  try {
    return run()
  } catch {
    c.fault('flood-control', step)
    return undefined
  }
}

// 4 ceiling: flood control's yes or no on the call's bytes, charged to the caller and to the root of its parent
// links. With flood control off nothing is charged. A no is throttled. A throw, or an acquire of the wrong shape, fails
// the call, as a provider's throw does
export function charge(c: Context, way: Way, parent: Pending | null, bytes: number): { release: (() => void) | null } | No {
  const flood = c.holder(() => c.options.floodControl())
  if (flood === null) return { release: null }
  const root = parent?.root ?? way
  const charged = (one: Root | Way): Charged => Object.freeze({ principal: one.principal, plugin: one.plugin })
  const held = flooded(c, 'acquire', () => flood.acquire(charged(way), charged(root), bytes))
  if (held === null) return { code: 'throttled' }
  if (typeof held !== 'object') return { code: 'failed' }
  return { release: () => flooded(c, 'release', () => flood.release(held as Held)) }
}

// The call in flight once the ceiling took it, its deadline shrinking along parent
export function admitted(c: Context,
  way: Way, answer: Send, callId: string, shaped: Extract<Shaped, { ok: true }>, kind: Kind, started: number, release: (() => void) | null,
): Pending {
  const { parent, target } = shaped
  const root: Root = parent?.root ?? { principal: way.principal, plugin: way.plugin, caller: way.caller }
  // The root call is the root plugin's own and judged on its own items. Every call under it is judged for the pair too
  const pair = parent === null ? undefined : pairOf(root.caller, shaped.onBehalf)
  // Never past the longest delay a timer takes, so a raised deadline can't fire at once and stays a safe integer
  const ownDeadline = started + Math.min(c.limits.of(way.plugin, 'callDeadlineMs'), MAX_TIMER_MS)
  // Shrinks along parent, so no sub-call outlives the call it serves
  const deadline = Math.min(ownDeadline, parent?.deadline ?? ownDeadline)
  const left = Math.max(0, deadline - c.now())
  const pending: Pending = {
    callId, id: shaped.id, way, answer, caller: way.caller, onBehalf: shaped.onBehalf, pair,
    action: shaped.action, parent, root, depth: (parent?.depth ?? 0) + 1, deadline, due: c.clock() + left, release,
    children: new Set(), callee: null, timer: null, done: false, started, gate: c.policyJob('gate'),
    // A path is the caller's own text until prepare gives the canonical one, so a call refused before that records
    // no path. A plugin call's target is already the plugin's id
    scope: kind.kind === 'power' && kind.scope.paths === undefined ? kind.scope : undefined,
    refusedScope: undefined,
    coalesce: target.kind === 'action'
      ? !target.each
      : target.kind === 'provider' ? !target.spec.write : kind.kind === 'free',
    live: null,
    ended: new AbortController(),
    judged: null,
    revoked: null,
    performing: false,
  }
  way.made.set(pending.id, pending)
  parent?.children.add(pending)
  pending.timer = setTimeout(() => stop(c, pending, 'timeout'), left)
  pending.timer.unref?.()
  return pending
}

// A cancel names a call this way made. Its sub-calls are cancelled with it and their late replies dropped
export function cancelled(c: Context, way: Way, message: unknown): void {
  const parsed = cancelSchema.safeParse(message)
  if (!parsed.success) return
  const pending = way.made.get(parsed.data.id)
  if (pending !== undefined) stop(c, pending, 'stopped')
}

// Ends a call early with its whole tree of sub-calls. Each callee is told, so its answer is no longer read
export function stop(c: Context, pending: Pending, code: RefusalCode): void {
  if (pending.done) return
  for (const child of [...pending.children]) stop(c, child, code)
  if (pending.callee?.open) pending.callee.send?.({ v: VERSION, kind: 'cancel', callId: pending.callId })
  finish(c, pending, no(code))
}

// 10 perform's result, within the cap of the plugin that made it, past which the call fails with too-large
export function result(c: Context, pending: Pending, producer: string | null, result: unknown): void {
  if (pending.done) return
  const measured = measurePlain(result, c.limits.of(producer, 'resultBytes'))
  if (!measured.ok) return finish(c, pending, no('failed', measured.tooLarge ? 'too-large' : undefined))
  finish(c, pending, { ok: true, result })
}

// A thrown refusal keeps its code. Anything else is failed, with its text for debug only. plugin is the provider whose
// step threw, null for a part the core serves
export function thrown(c: Context, pending: Pending, plugin: string | null, step: 'prepare' | 'perform', err: unknown): void {
  if (pending.done) return
  const refused = refusalIn(err)
  if (refused !== null) return finish(c, pending, { ok: false, ...refused })
  c.debugOf(pending, plugin, err)
  if (plugin !== null) c.fault(plugin, step)
  finish(c, pending, no('failed'))
}

// Every call ends here once. The reply never waits on the record. Its live sub-calls stop with it, so none still waits
// on a callee after the call answers. What a callee already did stays done. A callee that keeps working after it
// answers makes its own calls
export function finish(c: Context, pending: Pending, outcome: Outcome): void {
  if (pending.done) return
  pending.done = true
  for (const child of [...pending.children]) stop(c, child, 'stopped')
  if (pending.timer !== null) clearTimeout(pending.timer)
  pending.ended.abort(outcome.ok ? 'answered' : outcome.code)
  pending.release?.()
  pending.way.made.delete(pending.id)
  pending.parent?.children.delete(pending)
  pending.callee?.delivered.delete(pending.callId)
  if (pending.way.open) {
    const head = { v: VERSION, kind: 'reply', id: pending.id, callId: pending.callId }
    pending.answer(outcome.ok
      ? { ...head, ok: true, result: outcome.result }
      : { ...head, ok: false, refusal: refusalOf(pending.action, outcome) })
  }
  // 11 record
  const code = outcome.ok ? null : outcome.code
  const scope = !outcome.ok && pending.refusedScope !== undefined ? pending.refusedScope : pending.scope
  c.recordCall({
    at: pending.started, caller: pending.caller,
    ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
    root: pending.root.caller, action: pending.action,
    ...(scope !== undefined ? { scope } : {}),
    code, ms: c.now() - pending.started, gate: pending.gate,
  }, pending.coalesce || code !== null)
}

// A call refused before the ceiling took it, answered when its id could be read. Its record names onBehalf and the
// root of a live parent once the envelope parsed
export function early(c: Context, way: Way, answer: Send, callId: string, about: About, refused: No, started: number): void {
  if (about.id !== null && way.open) {
    answer({ v: VERSION, kind: 'reply', id: about.id, callId, ok: false, refusal: refusalOf(about.action, refused) })
  }
  c.recordCall({
    at: started, caller: way.caller, ...(about.onBehalf !== undefined ? { onBehalf: about.onBehalf } : {}),
    root: about.parent?.root.caller ?? way.caller, action: about.action, code: refused.code, ms: c.now() - started,
    gate: c.policyJob('gate'),
  }, true)
}

function refusalOf(action: string, refused: No): Refusal {
  return {
    code: refused.code,
    action,
    ...(refused.reason !== undefined ? { reason: refused.reason } : {}),
    ...(refused.request !== undefined ? { request: refused.request } : {}),
  }
}

// Frozen but for the signal, which freezing would keep from aborting
export function callOf(pending: Pending, args: unknown, live?: LiveCall): Call {
  return Object.freeze({
    ...frozen({
      callId: pending.callId, caller: pending.caller, root: pending.root.caller,
      ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
      ...(pending.parent !== null ? { parent: pending.parent.callId } : {}),
      action: pending.action, args, deadline: pending.deadline, ...(live !== undefined ? { live } : {}),
    }),
    signal: pending.ended.signal,
  })
}

// A call a new grants snapshot no longer covers, with every call under it revoked the same way. A plugin callee is sent
// cancel and the caller answered code at once, as is a call not yet in perform. A provider in perform hears the call's
// signal and the call answers code once its perform ends, thrown or not, so a single write that finishes lands and
// its result is dropped. A call under it still in perform is no longer its sub-call, so the call answering doesn't
// stop it
export function revoke(c: Context, pending: Pending, code: RefusalCode): void {
  if (pending.done || pending.revoked !== null) return
  for (const child of [...pending.children]) {
    revoke(c, child, code)
    if (!child.done) pending.children.delete(child)
  }
  if (!pending.performing) return stop(c, pending, code)
  pending.revoked = code
  pending.ended.abort(code)
}

// The view of a live call a part gets with an action that names it, the same object for the call's life. pair is the
// one its chain carries, the root call's included, which its own judgements leave out
export function liveOf(pending: Pending): LiveCall {
  if (pending.live === null) {
    const pair = pairOf(pending.root.caller, pending.onBehalf)
    pending.live = frozen({
      caller: pending.caller, principal: pending.way.principal, plugin: pending.way.plugin, root: pending.root.caller,
      ...(pending.onBehalf !== undefined ? { onBehalf: pending.onBehalf } : {}),
      ...(pair !== undefined ? { pair } : {}),
      open: () => !pending.done,
    })
  }
  return pending.live
}

