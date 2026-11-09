import { z } from 'zod'

// The longest scope a grant may hold and the longest path the matcher takes. A longer path matches nothing
export const MAX_SCOPE_LENGTH = 512

const STAR = 0x2a
const DOT = 0x2e
// Glob syntax in other matchers, refused so a scope can't read one way on the approval screen and another in the gate
const notInScope = /[\\:?[\]{}()!#]/u
// What a canonical path never holds: another system's separator, a stream name or a control character
const notInPath = /[\\:\p{Cc}]/u
// Control characters and the bidi embeddings, overrides and isolates, which could hide text on the approval screen or
// show it there in another order. Zero-width characters and the line separators are left to the screens, which show
// them (#74)
const hiding = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u

// Whether text holds a character that could hide on the approval screen. A function, so code sharing the process
// can't recompile the pattern
export function hidesOnScreen(text: string): boolean {
  return hiding.test(text)
}

function segmentsProblem(text: string): string | null {
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'an empty, . or .. segment'
  }
  return null
}

// Why a scope is outside the grammar, or null for one inside. Segments split on /, a * matches within one segment and
// ** is a whole segment that matches any number of segments. Nothing else is syntax, every other character is literal
export function scopeProblem(scope: string): string | null {
  if (typeof scope !== 'string' || scope === '') return 'empty'
  if (scope.length > MAX_SCOPE_LENGTH) return `longer than ${MAX_SCOPE_LENGTH} characters`
  if (!scope.isWellFormed()) return 'a lone surrogate'
  if (notInScope.test(scope) || hidesOnScreen(scope)) return 'a character outside the grammar'
  // Grants are NFC and paths are compared as they are, never normalised on one side only
  if (scope.normalize('NFC') !== scope) return 'not NFC'
  const segments = segmentsProblem(scope)
  if (segments !== null) return segments
  for (const segment of scope.split('/')) {
    if (segment.includes('**') && segment !== '**') return '** inside a segment'
    // Windows drops them, so the name shown wouldn't be the name on disk
    if (segment.endsWith('.') || segment.endsWith(' ')) return 'a trailing dot or space'
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

// ASCII letters fold and nothing else does. JavaScript's own case mapping folds the Kelvin sign into k and ß into ss,
// names NTFS keeps apart, so a grant would reach a file the grant doesn't name
function sameUnit(a: number, b: number, foldCase: boolean): boolean {
  if (a === b) return true
  if (!foldCase || (a ^ b) !== 0x20) return false
  const lower = a | 0x20
  return lower >= 0x61 && lower <= 0x7a
}

// HFS+ skips these code points when comparing names, so .g\u200cit opens .git there or becomes .git in a folder that
// has none. git's protectHFS skips the same set
const ignorable = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

// The text with the code points HFS+ skips taken out
export function withoutIgnorable(text: string): string {
  return text.replace(ignorable, '')
}

// Whether a segment names .git on some volume: any ASCII case, with what HFS+ skips taken out. The matcher and the
// canonicaliser both ask this one check
export function isGitName(segment: string): boolean {
  const name = withoutIgnorable(segment)
  return name.length === 4 && [...'.git'].every((char, i) => sameUnit(name.charCodeAt(i), char.charCodeAt(0), true))
}

// One path segment against one scope segment. A * matches any run of characters but never a leading dot. Greedy with
// a return to the last *, so the cost stays within the product of the two lengths, no regex and no recursion
function segmentMatches(pattern: string, segment: string, foldCase: boolean): boolean {
  if (pattern.charCodeAt(0) === STAR && segment.charCodeAt(0) === DOT) return false
  let p = 0
  let s = 0
  let star = -1
  let mark = 0
  while (s < segment.length) {
    if (p < pattern.length && pattern.charCodeAt(p) === STAR) {
      star = p++
      mark = s
    } else if (p < pattern.length && sameUnit(pattern.charCodeAt(p), segment.charCodeAt(s), foldCase)) {
      p++
      s++
    } else if (star !== -1) {
      p = star + 1
      s = ++mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern.charCodeAt(p) === STAR) p++
  return p === pattern.length
}

// The same walk one level up, with ** for * and segments for characters. ** first matches nothing and takes one more
// segment each time the rest fails, never a dot segment
function segmentsMatch(patterns: string[], segments: string[], foldCase: boolean): boolean {
  let p = 0
  let s = 0
  let star = -1
  let mark = 0
  while (s < segments.length) {
    if (p < patterns.length && patterns[p] === '**') {
      star = p++
      mark = s
    } else if (p < patterns.length && segmentMatches(patterns[p], segments[s], foldCase)) {
      p++
      s++
    } else if (star !== -1 && segments[mark].charCodeAt(0) !== DOT) {
      p = star + 1
      s = ++mark
    } else {
      return false
    }
  }
  while (p < patterns.length && patterns[p] === '**') p++
  return p === patterns.length
}

// Whether a path lies inside a scope. Both must be in their grammar or nothing matches. foldCase is for a volume that
// ignores case, which the matcher can't see from here. A path with a .git segment matches no scope at all
export function scopeMatches(scope: string, path: string, options: { foldCase: boolean }): boolean {
  if (scopeProblem(scope) !== null || pathProblem(path) !== null) return false
  const segments = path.split('/')
  if (segments.some(isGitName)) return false
  return segmentsMatch(scope.split('/'), segments, options.foldCase)
}

// Whether a path lies inside any of the scopes, each scope's grammar checked once here and not on every match, so a
// gate can compile its grants once per StateView. A scope outside the grammar is left out and matches nothing.
// Answers as scopeMatches does against each scope in turn
export function compileScopes(scopes: readonly string[], options: { foldCase: boolean }): (path: string) => boolean {
  const compiled = scopes.filter(scope => scopeProblem(scope) === null).map(scope => scope.split('/'))
  const { foldCase } = options
  return path => {
    if (compiled.length === 0 || pathProblem(path) !== null) return false
    const segments = path.split('/')
    if (segments.some(isGitName)) return false
    return compiled.some(patterns => segmentsMatch(patterns, segments, foldCase))
  }
}

// A scope as grants hold one, refused at write and at load when outside the grammar
export const scope = z.string().superRefine((value, ctx) => {
  const problem = scopeProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})
