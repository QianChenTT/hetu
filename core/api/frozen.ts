// Kept apart from zod, so the SDK and the floor constants load without it

// Host halves share these tables in the same process, so a slip there can't change what the core decides with them
export function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) frozen((value as Record<string, unknown>)[key])
  }
  return value
}

// A frozen table the core looks keys up in, with no prototype as state.ts's tables have none. A key naming one of
// Object's members or one a slip added to Object.prototype then finds nothing in place of an entry
export function table<T extends object>(entries: T): T {
  return frozen(Object.assign(Object.create(null), entries))
}
