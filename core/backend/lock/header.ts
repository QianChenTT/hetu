import type { Guard, Opening, Provider } from '../../api/policy-jobs.ts'

// What the lock module provides: note locks by path, holder and expiry, the provider serving lock.* and the guard that
// keeps every other holder's write, remove and move off a locked note. Definitions only, lock.ts implements them and
// the join makes the one the core modules hold

// The longest a lock is set for. A longer time asked is cut to this, so a holder that crashed or was switched off keeps
// a note locked no longer
export const MAX_LOCK_MS = 1_800_000 // 30 minutes

// The most live locks the chains under one root plugin hold at once, its pairs together, so no plugin fills main with
// locks by naming new fields
export const MAX_LOCKS_PER_ROOT = 1024

// The most live locks one client under a root plugin holds at once, its sessions together: the root with the field up
// to its first #, as a pair's grants are keyed, or the root plugin itself with no field. So one client opening more
// sessions takes no more of its root's count, and a new client name needs the human's Confirm
export const MAX_LOCKS_PER_CLIENT = 256

// How the core hands the module the notes folder, as it hands the luoshu its own. Another folder frees every lock
export type LockRole = { open(opening: Opening): void }

export type Lock = { readonly provider: Provider, readonly guard: Guard, readonly role: LockRole }

// A clock no change of the wall clock moves
export type LockOptions = { clock(): number }
