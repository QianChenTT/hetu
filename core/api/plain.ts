import { z } from 'zod'
import { isBadKey, MAX_DEPTH, type Measured, measurePlain, plainProblem } from './measure.ts'

export { isBadKey, MAX_DEPTH, type Measured, measurePlain, plainProblem }

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
