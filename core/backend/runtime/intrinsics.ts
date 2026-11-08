// Run in main once, before the first host half loads. Freezes every built-in core/api decides with, each constructor
// and its prototype and the ones with no global name, and binds their global names for good, so a host half can't swap
// Array.prototype.includes, Set.prototype.has or Set itself to flip a decision, or add to a prototype. Freezing a
// prototype makes its data properties read-only, and assigning to an inherited read-only property fails even on code's
// own objects (the override mistake), so a few properties code commonly sets on its own objects become accessors whose
// setter defines the property on that object, as SES does. Not constructor: an accessor there takes V8's Array methods
// off their fast paths, 4 to 60 times slower, so assigning constructor on a plain object throws instead. Kept to itself,
// with nothing from outside, so the tests can run it in a fresh realm
export function freezeIntrinsics(): void {
  const global = globalThis as unknown as Record<string, unknown>
  const named = [
    'Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'WeakRef', 'FinalizationRegistry', 'Promise', 'RegExp', 'Date', 'Error', 'EvalError', 'RangeError', 'ReferenceError',
    'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array',
    'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
    'Float64Array', 'BigInt64Array', 'BigUint64Array', 'JSON', 'Math', 'Reflect', 'Atomics', 'Intl', 'Proxy', 'Iterator',
  ]
  // Bound for good with the built-ins, though they hold no prototype to freeze. The carrier copies with structuredClone
  const bound = [...named, 'structuredClone', 'globalThis']
  const generator = Object.getPrototypeOf(function* () {}) as object
  const asyncGenerator = Object.getPrototypeOf(async function* () {}) as object
  const asyncGeneratorPrototype = (asyncGenerator as { prototype: object }).prototype
  const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]()) as object
  const hidden: unknown[] = [
    Object.getPrototypeOf(Int8Array), Object.getPrototypeOf(Int8Array.prototype), arrayIterator,
    Object.getPrototypeOf(arrayIterator), Object.getPrototypeOf(new Map()[Symbol.iterator]()),
    Object.getPrototypeOf(new Set()[Symbol.iterator]()), Object.getPrototypeOf(''[Symbol.iterator]()),
    Object.getPrototypeOf(/x/[Symbol.matchAll]('x')), generator, (generator as { prototype: object }).prototype,
    asyncGenerator, asyncGeneratorPrototype, Object.getPrototypeOf(asyncGeneratorPrototype),
    Object.getPrototypeOf(async function () {}),
  ]
  // The iterator helpers' prototype, where the engine has them
  const values = [][Symbol.iterator]() as unknown as { map?: (fn: (x: unknown) => unknown) => object }
  if (typeof values.map === 'function') hidden.push(Object.getPrototypeOf(values.map(x => x)))
  const roots: object[] = []
  const add = (value: unknown) => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return
    roots.push(value)
    const prototype = (value as { prototype?: unknown }).prototype
    if (typeof prototype === 'object' && prototype !== null) roots.push(prototype)
  }
  for (const value of hidden) add(value)
  for (const name of named) add(global[name])
  // Intl's constructors and their prototypes, which hang off Intl rather than the global
  const intl = global.Intl as Record<string, unknown> | undefined
  if (intl !== undefined) for (const name of Object.getOwnPropertyNames(intl)) add(intl[name])
  // The properties code sets on its own objects, which would otherwise hit the override mistake
  const overridable = ['toString', 'valueOf', 'toLocaleString', 'name', 'message']
  const owns = Object.prototype.hasOwnProperty
  for (const root of roots) {
    if (Object.isFrozen(root)) continue
    for (const name of overridable) {
      const found = Object.getOwnPropertyDescriptor(root, name)
      if (found === undefined || !('value' in found) || !found.writable || !found.configurable) continue
      const value = found.value as unknown
      Object.defineProperty(root, name, {
        get() {
          return value
        },
        set(this: object, next: unknown) {
          if (this === root) throw new TypeError(`Cannot assign to read only property '${name}' of a frozen built-in`)
          if (owns.call(this, name)) (this as Record<string, unknown>)[name] = next
          else Object.defineProperty(this, name, { value: next, writable: true, enumerable: true, configurable: true })
        },
        enumerable: found.enumerable,
        configurable: false,
      })
    }
    Object.freeze(root)
  }
  for (const name of bound) {
    const found = Object.getOwnPropertyDescriptor(global, name)
    if (found === undefined || !('value' in found) || !found.configurable) continue
    Object.defineProperty(global, name, { value: found.value, writable: false, enumerable: found.enumerable, configurable: false })
  }
}
