import type { Caller } from '../../api/envelope.ts'
import type { Call, CallHead, GuardCall, Opening, Prepared, Provider, ProviderRefusal } from '../../api/policy-jobs.ts'
import { canonical, keyOf, type Canonical, type NotCanonical } from '../../lib/canonical.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_ROOT, type Lock, type LockOptions } from './header.ts'

export type { Lock } from './header.ts'

// One note's lock: its holder, the root whose count it takes and when it ends on the module's clock
type Held = { readonly holder: string, readonly root: string, readonly until: number }

const refused = (code: ProviderRefusal['code'], reason?: ProviderRefusal['reason']): ProviderRefusal => (reason === undefined ? { code } : { code, reason })

// A plugin by its id, a window by its role
function rootOf(root: Caller): string {
  if (root.kind === 'plugin') return JSON.stringify({ plugin: root.id })
  return root.kind === 'window' ? JSON.stringify({ window: root.role }) : JSON.stringify({ content: root.plugin })
}

// The chain's own: the root plugin with the whole onBehalf field, so each session holds its own locks, never a name in
// the arguments. A window's onBehalf names whose edits a save carries and makes no pair, so a window holds as itself
function holderOf(call: CallHead): string {
  return call.root.kind === 'plugin' ? JSON.stringify({ plugin: call.root.id, onBehalf: call.onBehalf ?? null }) : rootOf(call.root)
}

// Paths, expiry and holders in memory for the run, so a restart frees every lock. Expired locks go as they are read and
// nothing runs on a timer
export function createLock(options: LockOptions): Lock {
  const table = new Map<string, Held>()
  let opening: (Opening & { folder: string }) | null = null

  function live(key: string, now: number): Held | undefined {
    const held = table.get(key)
    if (held === undefined || held.until > now) return held
    table.delete(key)
    return undefined
  }
  // Whether another holder locks one of the keys
  const others = (keys: readonly string[], holder: string, now: number) =>
    keys.some(key => (live(key, now)?.holder ?? holder) !== holder)

  // All or none: one path another holder locks refuses the set with no word of who
  function set(call: Call, keys: readonly string[]): { ms: number } {
    const asked = (call.args as { ms?: unknown }).ms
    if (typeof asked !== 'number' || !Number.isSafeInteger(asked) || asked < 1) throw refused('invalid')
    const now = options.clock()
    const holder = holderOf(call)
    if (others(keys, holder, now)) throw refused('locked')
    const root = rootOf(call.root)
    let count = new Set(keys.filter(key => live(key, now) === undefined)).size
    for (const [key, held] of [...table]) if (held.root === root && live(key, now) !== undefined) count++
    if (count > MAX_LOCKS_PER_ROOT) throw refused('failed', 'quota')
    const ms = Math.min(asked, MAX_LOCK_MS)
    for (const key of keys) table.set(key, { holder, root, until: now + ms })
    return { ms }
  }

  // A plugin clears only its own chain's locks and hears the same whatever else holds the paths, since the clear needs
  // no grant. A window is the human, who may take any note over
  function clear(call: Call, keys: readonly string[]): null {
    const holder = call.caller.kind === 'window' ? null : holderOf(call)
    const now = options.clock()
    for (const key of keys) if (holder === null || live(key, now)?.holder === holder) table.delete(key)
    return null
  }

  // The caller's spellings of the paths any holder locks. The router let only a caller that reads them all ask
  function held(call: Call, keys: readonly string[]): { paths: string[] } {
    const spelled = (call.args as { paths: string[] }).paths
    const now = options.clock()
    return { paths: spelled.filter((_, i) => live(keys[i], now) !== undefined) }
  }

  // A name spelled with no dot that leads to a dot name is a missing one for a clear or a look, so the answer tells no
  // more than a missing name's. A set refuses it as the dot name
  function usable(action: string, found: Canonical | NotCanonical): Canonical | ProviderRefusal {
    if (found.ok) return found
    if (action !== 'lock.set' && found.code === 'not-granted' && found.absent !== undefined) return found.absent
    return refused(found.code)
  }

  const provider: Provider = {
    async prepare(call: Call): Promise<Prepared | ProviderRefusal> {
      if (opening === null) return refused('unavailable')
      const { folder, dataDir, installDir } = opening
      const paths = (call.args as { paths?: unknown } | null)?.paths
      if (!Array.isArray(paths)) return refused('invalid')
      // A plugin's clear has no gate before it, so a path canonical refuses is a missing name it leaves out, which no
      // lock holds. A refusal would tell a link out of the notes folder from a plain name
      const quiet = call.action === 'lock.clear' && call.caller.kind !== 'window'
      const relative: string[] = []
      for (const path of paths) {
        const target = usable(call.action, await canonical(folder, path as string, { dataDir, installDir }))
        if (!('ok' in target) && quiet) continue
        if (!('ok' in target)) return target
        relative.push(target.relative)
      }
      return { scope: { paths: relative } }
    },

    // One step with no await, so no guard or other lock call runs between the check and the change
    async perform(call: Call, prepared: Prepared): Promise<unknown> {
      if (opening === null) throw refused('unavailable')
      const keys = (prepared.scope.paths ?? []).map(keyOf)
      if (call.action === 'lock.set') return set(call, keys)
      if (call.action === 'lock.clear') return clear(call, keys)
      if (call.action === 'lock.held') return held(call, keys)
      throw refused('invalid')
    },
  }

  return {
    provider,
    // Every path a write, remove or move reaches, a move's both ends, against the table alone with no await. A call
    // with no paths is none the router makes, so it throws and the router counts it guard-down
    guard: {
      check(call: GuardCall): 'allow' | 'deny' {
        const paths = call.scope.paths
        if (!Array.isArray(paths)) throw new Error('a guard call with no paths')
        return others(paths.map(keyOf), holderOf(call), options.clock()) ? 'deny' : 'allow'
      },
    },
    role: {
      // Another folder or none frees every lock, since its paths name other notes
      open(next: Opening): void {
        if (opening?.folder !== next.folder) table.clear()
        opening = next.folder === null ? null : { ...next, folder: next.folder }
      },
    },
  }
}
