import { z } from 'zod'
import { MAX_NAME_LENGTH } from './ids.ts'

// The manifest's version grammar: three whole numbers and no ranges, since everything in v1 ships together
export const pluginVersion = z.string()
  .max(MAX_NAME_LENGTH, { abort: true })
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/)

// Whether version a is later than version b, both in the manifest's grammar
export function isNewer(a: string, b: string): boolean {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i]
  }
  return false
}
