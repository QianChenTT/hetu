import type { Caller } from './envelope.ts'
import { table } from './frozen.ts'

const MiB = 1024 * 1024

// What one caller may keep in each of its two spaces. Fixed here and not a human limit, since the storage plugin never
// reads the state. One value is already held under argumentBytes. A set past either answers failed with quota
export const quotas = table({
  storage: { bytes: 16 * MiB, keys: 1024 },
  cache: { bytes: 64 * MiB, keys: 1024 },
} as const)

// The folder a caller's space has under storage/ and under cache/: a plugin's id, the folder the loader clears for it,
// or window. and the role for a window. A plugin id holds no dot, so a window's can't be a plugin's. Content callers
// have none until #97 designs them
export function spaceOf(caller: Caller): string | null {
  if (caller.kind === 'plugin') return caller.id
  if (caller.kind === 'window') return `window.${caller.role}`
  return null
}
