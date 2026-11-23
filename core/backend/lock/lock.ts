import { grantKeyOf, type Caller, type LockFields } from '../../api/envelope.ts'
import type { Call, CallHead, GuardCall, Opening, Prepared, Provider, ProviderRefusal } from '../../api/policy-jobs.ts'
import { canonical, keyOf, type Canonical, type NotCanonical } from '../../lib/canonical.ts'
import { MAX_LOCK_MS, MAX_LOCKS_PER_CLIENT, MAX_LOCKS_PER_ROOT, type Lock, type LockOptions } from './header.ts'

export type { Lock } from './header.ts'

// One note's lock: its holder, the root and the client whose counts it takes, when it ends on the module's clock
// (endsAt), the end lock.changed last told in whole milliseconds of wall time (until) and the canonical path its first
// set named, which lock.changed tells
type Held = {
  readonly holder: string, readonly root: string, readonly client: string, readonly endsAt: number, readonly until: number, readonly path: string
}

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

// Whose count a lock takes: the root plugin with the field up to its first #, as a pair's grants are keyed, so every
// session of one client counts together. With no field the root plugin is a client of its own, a window itself
function clientOf(call: CallHead): string {
  if (call.root.kind !== 'plugin') return rootOf(call.root)
  return JSON.stringify({ plugin: call.root.id, client: call.onBehalf === undefined ? null : grantKeyOf(call.onBehalf) })
}

// Paths, expiry and holders in memory for the run, so a restart frees every lock. Expired locks go as they are read and
// nothing runs on a timer, so an expiry is told only once a check, a lock action or another folder meets it
export function createLock(options: LockOptions): Lock {
  const table = new Map<string, Held>()
  let opening: (Opening & { folder: string }) | null = null
  const wall = options.wall ?? (() => Date.now())

  // Told once the step that noticed it ended, or at once where no lock action or guard step runs. A publish that throws
  // loses its event and never fails the step
  function tell(path: string, change: LockFields, atOnce = false): void {
    const { publish } = options
    if (publish === undefined) return
    const told = () => {
      try {
        publish(path, change)
      } catch {
        // The lock is already set or gone, only the event is lost
      }
    }
    if (atOnce) told()
    else queueMicrotask(told)
  }
  // The end in wall time, read now, so it says when the lock ends whatever the wall clock does later
  const tellLocked = (entry: Held) => tell(entry.path, { locked: true, until: entry.until })
  const tellUnlocked = (entry: Held, atOnce = false) => tell(entry.path, { locked: false, until: null }, atOnce)
  // Each lock told unlocked at once, an expired one not yet told included, then none is held
  function unlockAll(): void {
    for (const entry of table.values()) tellUnlocked(entry, true)
    table.clear()
  }

  function live(key: string, now: number): Held | undefined {
    const entry = table.get(key)
    if (entry === undefined || entry.endsAt > now) return entry
    table.delete(key)
    tellUnlocked(entry)
    return undefined
  }
  // Whether another holder locks one of the keys
  const others = (keys: readonly string[], holder: string, now: number) =>
    keys.some(key => (live(key, now)?.holder ?? holder) !== holder)

  // All or none: one path another holder locks refuses the set with no word of who. Each lock it sets or moves the end
  // of is told, once for a note two spellings name
  function set(call: Call, paths: readonly string[]): { ms: number } {
    const keys = paths.map(keyOf)
    const asked = (call.args as { ms?: unknown }).ms
    if (typeof asked !== 'number' || !Number.isSafeInteger(asked) || asked < 1) throw refused('invalid')
    const now = options.clock()
    const holder = holderOf(call)
    if (others(keys, holder, now)) throw refused('locked')
    const root = rootOf(call.root)
    const client = clientOf(call)
    const fresh = new Set(keys.filter(key => live(key, now) === undefined)).size
    let ofRoot = fresh
    let ofClient = fresh
    for (const [key, entry] of [...table]) {
      if (entry.root !== root || live(key, now) === undefined) continue
      ofRoot++
      if (entry.client === client) ofClient++
    }
    if (ofRoot > MAX_LOCKS_PER_ROOT || ofClient > MAX_LOCKS_PER_CLIENT) throw refused('failed', 'quota')
    const ms = Math.min(asked, MAX_LOCK_MS)
    const endsAt = now + ms
    // The end in wall time, read once, so the paths of one set tell one end whatever the wall clock does later
    const until = Math.round(wall() + ms)
    for (const [i, key] of keys.entries()) {
      // Every lock left is live and the caller's own. A renewal to the end already told, in whole milliseconds, moves
      // the end on the module's clock and tells nothing, as does a second spelling of a note in one set
      const was = table.get(key)
      const entry = { holder, root, client, endsAt, until, path: was?.path ?? paths[i] }
      table.set(key, entry)
      if (was?.until !== until) tellLocked(entry)
    }
    return { ms }
  }

  // A plugin clears only its own chain's locks and hears the same whatever else holds the paths, since the clear needs
  // no grant. A window is the human, who may take any note over. Each lock it clears is told
  function clear(call: Call, paths: readonly string[]): null {
    const holder = call.caller.kind === 'window' ? null : holderOf(call)
    const now = options.clock()
    for (const key of paths.map(keyOf)) {
      const entry = live(key, now)
      if (entry === undefined || (holder !== null && entry.holder !== holder)) continue
      table.delete(key)
      tellUnlocked(entry)
    }
    return null
  }

  // One entry for each path asked about that any holder locks, in the order asked, the path as the caller spelled it
  // with when its lock ends in wall time read now, so a plugin that missed lock.changed events rebuilds its locks and
  // timers. The router let only a caller that reads them all ask
  function held(call: Call, keys: readonly string[]): { locks: { path: string, until: number }[] } {
    const spelled = (call.args as { paths: string[] }).paths
    const now = options.clock()
    const at = wall()
    const locks: { path: string, until: number }[] = []
    for (const [i, path] of spelled.entries()) {
      const entry = live(keys[i], now)
      if (entry !== undefined) locks.push({ path, until: Math.round(at + entry.endsAt - now) })
    }
    return { locks }
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
      const paths = prepared.scope.paths ?? []
      if (call.action === 'lock.set') return set(call, paths)
      if (call.action === 'lock.clear') return clear(call, paths)
      if (call.action === 'lock.held') return held(call, paths.map(keyOf))
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
      // Another folder or none frees every lock, since its paths name other notes. Each is told unlocked at once, an
      // expired one not yet told included, while the grants that applied to the old folder's notes still stand
      open(next: Opening): void {
        if (opening?.folder !== next.folder) unlockAll()
        opening = next.folder === null ? null : { ...next, folder: next.folder }
      },
      release(): void {
        unlockAll()
      },
    },
  }
}
