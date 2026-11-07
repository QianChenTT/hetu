// Deeper than any call needs, the same cap as core/api's
const MAX_DEPTH = 64
const badKeys = new Set(['__proto__', 'constructor', 'prototype'])

// Whether a value can cross as an argument or a result: plain objects with Object's prototype or none, arrays,
// strings, finite numbers, booleans, null and undefined, nothing reached twice and nothing deeper than 64. Every own
// key is walked, an array's named keys too, since a port copies them. The carrier refuses the rest anyway and some of
// it can't even be posted, so the SDK answers at once. A Proxy passes here and still can't be posted, which the
// Sender catches
export function isPlain(value: unknown): boolean {
  const seen = new Set<object>()
  const walk = (item: unknown, depth: number): boolean => {
    if (item === null || item === undefined) return true
    if (typeof item === 'string' || typeof item === 'boolean') return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || depth > MAX_DEPTH || seen.has(item)) return false
    seen.add(item)
    if (!Array.isArray(item)) {
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) return false
    }
    return Object.keys(item).every(key => !badKeys.has(key) && walk((item as Record<string, unknown>)[key], depth + 1))
  }
  return walk(value, 1)
}
