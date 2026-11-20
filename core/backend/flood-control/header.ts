import type { LimitName } from '../../api/limits.ts'

// What flood control provides: the message rate and the flood cap of each way in, and the call ceiling of each caller.
// Definitions only, flood-control.ts implements them and the join makes the one the core modules hold

// A way in as flood control counts it. The object itself names the way, so each way keeps its own count, and plugin
// is whose limits apply, null for a window
export type Counted = { readonly plugin: string | null }

// Whose ceiling a call is charged to: the principal, a plugin across its halves and incarnations or one window load,
// and whose limits apply, null for a window
export type Charged = { readonly principal: string, readonly plugin: string | null }

// What one acquire took, handed back to release once
export type Held = { readonly principals: readonly string[], readonly bytes: number }

// A message's verdict before it is read: pass, drop with no reply or flood, which closes the way of a plugin
export type Admitted = 'pass' | 'drop' | 'flood'

// It counts and says yes or no. The carrier drops, closes and throttles. acquire is null for no: the caller or the root of
// its chain is past its calls or bytes in flight
export type FloodControl = {
  admit(way: Counted): Admitted
  acquire(caller: Charged, root: Charged, bytes: number): Held | null
  release(held: Held): void
}

// The limits as they apply to one plugin, or to a window for null, and a clock no change of the wall clock moves
export type FloodControlOptions = {
  limit(plugin: string | null, name: LimitName): number
  clock(): number
}
