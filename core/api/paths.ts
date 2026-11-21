import { isDotName } from './names.ts'

// The checks for a path as an action takes it, apart from zod so the SDK hands actionPathProblem to plugins

// The longest scope a grant may hold and the longest path the matcher takes. A longer path matches nothing
export const MAX_SCOPE_LENGTH = 512

// What a canonical path never holds: another system's separator, a stream name or a control character
const notInPath = /[\\:\p{Cc}]/u

// Why text has an empty, . or .. segment, or null. A scope and a path both refuse one
export function segmentsProblem(text: string): string | null {
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'an empty, . or .. segment'
  }
  return null
}

// Why a path can't be matched, or null. A canonical path holds one of these only when a link in the luoshu leads to a
// name on the disk that has it, and then the path matches nothing
export function pathProblem(path: string): string | null {
  if (typeof path !== 'string' || path === '') return 'empty'
  if (path.length > MAX_SCOPE_LENGTH) return `longer than ${MAX_SCOPE_LENGTH} characters`
  if (!path.isWellFormed()) return 'a lone surrogate'
  if (notInPath.test(path)) return 'a character a canonical path never holds'
  return segmentsProblem(path)
}

// Why a path no action takes, or null: a spelling no canonical path holds, or a dot segment, which names no note. The
// one definition of both, read by the path schema and by the core's own publish, which no schema checks.
// gate.filterReadable drops a path it names from its answer
export function actionPathProblem(value: string): string | null {
  return pathProblem(value) ?? (value.split('/').some(isDotName) ? 'a dot segment' : null)
}
