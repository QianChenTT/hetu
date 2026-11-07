import { z } from 'zod'

// Keys that reach Object's own members once a consumer merges the value or looks a key up
const badKeys = new Set(['__proto__', 'constructor', 'prototype'])
// Deeper than any call or manifest needs, so code that walks a value by recursion can't run out of stack
export const MAX_DEPTH = 64

// A function rather than the set itself, so code sharing the process can't take a key off the list
export function isBadKey(key: string): boolean {
  return badKeys.has(key)
}

// UTF-8 length without TextEncoder, which core/api's globals don't have. A surrogate counts 2, so a pair counts the 4
// bytes UTF-8 needs for one
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800 || (unit >= 0xd800 && unit <= 0xdfff)) bytes += 2
    else bytes += 3
  }
  return bytes
}

// The size of plain data within maxBytes, or why the value isn't plain data within maxBytes. tooLarge tells the size
// cap from the other problems
export type Measured = { ok: true, bytes: number } | { ok: false, problem: string, tooLarge: boolean }

// Plain data is what JSON holds plus undefined: objects with Object's prototype or none, arrays, strings, finite
// numbers, booleans and null. Anything else is refused, a port or a class instance included. So is an object reached
// twice, which lets a small message stand for a huge one. Size is the UTF-8 bytes of every key and string plus 8 for
// every value and array slot, counted as the walk goes. An array pays for its slots before any is walked and an object
// stops at its first key past the cap, though all of an object's keys are listed before its size is known. A stack
// instead of recursion, so nesting can't overflow the call stack
export function measurePlain(value: unknown, maxBytes: number): Measured {
  const refuse = (problem: string): Measured => ({ ok: false, problem, tooLarge: false })
  const tooLarge: Measured = { ok: false, problem: `larger than ${maxBytes} bytes`, tooLarge: true }
  const seen = new Set<object>()
  const stack: [unknown, number][] = [[value, 0]]
  let bytes = 0
  while (stack.length > 0) {
    const [next, depth] = stack.pop()!
    bytes += 8
    if (typeof next === 'string') {
      bytes += utf8Length(next)
    } else if (typeof next === 'number') {
      if (!Number.isFinite(next)) return refuse('a number that is not finite')
    } else if (typeof next === 'object' && next !== null) {
      if (seen.has(next)) return refuse('an object reached twice')
      seen.add(next)
      const isArray = Array.isArray(next)
      const proto = Object.getPrototypeOf(next)
      if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return refuse('not plain data')
      if (depth >= MAX_DEPTH) return refuse(`nested deeper than ${MAX_DEPTH}`)
      // Holes count too, a sparse array is cheap to send and long to loop over
      if (isArray) bytes += 8 * (next as unknown[]).length
      if (bytes > maxBytes) return tooLarge
      for (const key of Object.keys(next)) {
        if (badKeys.has(key)) return refuse(`the key ${key}`)
        bytes += utf8Length(key)
        if (bytes > maxBytes) return tooLarge
        stack.push([(next as Record<string, unknown>)[key], depth + 1])
      }
    } else if (next !== null && next !== undefined && typeof next !== 'boolean') {
      return refuse('not plain data')
    }
    if (bytes > maxBytes) return tooLarge
  }
  return { ok: true, bytes }
}

// Why a value isn't plain data within maxBytes, or null
export function plainProblem(value: unknown, maxBytes: number): string | null {
  const measured = measurePlain(value, maxBytes)
  return measured.ok ? null : measured.problem
}

// An opaque value checked as plain data, for arguments and results the core passes on unread
export function plainData(maxBytes: number) {
  return z.unknown().superRefine((value, ctx) => {
    const problem = plainProblem(value, maxBytes)
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
  })
}

// The schema runs only on plain data within maxBytes. A record would otherwise drop a __proto__ key without a word and
// keep constructor
export function plain<T extends z.ZodType>(schema: T, maxBytes: number) {
  return plainData(maxBytes).pipe(schema)
}

export { frozen, table } from './frozen.ts'
