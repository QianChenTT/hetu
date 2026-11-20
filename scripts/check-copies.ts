// every block of four lines or more repeated in shipped code, as jscpd finds it with .jscpd.json, is a clone a
// person judges: the same meaning becomes one definition, a different meaning is marked allowed. Run as
// `node scripts/check-copies.ts`, it fails on a clone core/test/copies-allowed.json doesn't hold and on an entry there
// that no clone matches any more and lists each. `--update` writes the file again from today's clones, keeping each
// entry's judgment, a new clone judged "not yet"
//
// .jscpd.json: shipped TypeScript only, blocks of 4 lines (minLines) and 20 tokens (minTokens). A clone must meet both
// and jscpd's default of 50 tokens would skip most 4-line blocks. A line of hetu's code is 5 to 10 tokens, so 4 lines of
// code clear 20. Under 20 the 81 more matches jscpd found at 10 were comment lines between declarations, closing
// braces and short rows of the action table
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runJscpd } from 'jscpd'

const repo = path.join(import.meta.dirname, '..')
const allowedFile = path.join(repo, 'core', 'test', 'copies-allowed.json')

// One side of a clone as jscpd's JSON report gives it
export interface Side {
  name: string
  start: number
  end: number
}

export interface Duplicate {
  firstFile: Side
  secondFile: Side
}

// A clone as copies-allowed.json holds it. The key is the two files and a hash of the copied lines with their
// whitespace collapsed, so lines moving above it leave it the same. at is where it sat at the last update, there to read
// only. judged is a person's call, why the copies may stay. "not yet" marks the baseline of 2026-11-19, which no one has
// judged. A clone found after it is listed "to judge", which fails the check until a person writes why it may stay
export interface Clone {
  files: [string, string]
  hash: string
  at: string[]
  judged: string
}

export const keyOf = (clone: Pick<Clone, 'files' | 'hash'>) => `${clone.files[0]} ${clone.files[1]} ${clone.hash}`

export function hashOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

// A path from the report, absolute and on Windows maybe in its \\?\ form, as a path from the repo with forward slashes
export function fromRepo(name: string, root = repo): string {
  return path.relative(root, name.replace(/^\\\\\?\\/, '')).split(path.sep).join('/')
}

// Lines start to end of a file's text, counted from 1
const linesOf = (text: string, start: number, end: number) => text.split('\n').slice(start - 1, end).join('\n')

// The report's duplicates as clones, one per key, a fragment repeated more than twice between the same files being one
// judgment with its places all listed. The hash is the lower of the two sides' own lines' hashes, which differ when
// only a comment or a line's start differs, so the key doesn't hang on which side jscpd names first
export function clonesOf(duplicates: readonly Duplicate[], text: (file: string) => string, root = repo): Clone[] {
  const byKey = new Map<string, Clone>()
  for (const { firstFile, secondFile } of duplicates) {
    const sides = [firstFile, secondFile].map(side => {
      const file = fromRepo(side.name, root)
      return { file, start: side.start, place: `${file}:${side.start}-${side.end}`, hash: hashOf(linesOf(text(file), side.start, side.end)) }
    }).sort((a, b) => byCode(a.file, b.file) || a.start - b.start)
    const clone: Clone = { files: [sides[0].file, sides[1].file], hash: [sides[0].hash, sides[1].hash].sort()[0], at: [], judged: 'not yet' }
    const held = byKey.get(keyOf(clone)) ?? clone
    for (const { place } of sides) if (!held.at.includes(place)) held.at.push(place)
    byKey.set(keyOf(clone), held)
  }
  return sorted([...byKey.values()])
}

// By code point, the same on every system, where localeCompare follows the system's locale
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function sorted(clones: Clone[]): Clone[] {
  return clones.sort((a, b) => byCode(keyOf(a), keyOf(b)))
}

// What fails: each clone found that the allowed list doesn't hold, each allowed entry no clone matches any more and
// each entry still "to judge"
export function compare(found: readonly Clone[], allowed: readonly Clone[]): { added: Clone[], gone: Clone[], unjudged: Clone[] } {
  const allowedKeys = new Set(allowed.map(keyOf))
  const foundKeys = new Set(found.map(keyOf))
  return {
    added: found.filter(clone => !allowedKeys.has(keyOf(clone))),
    gone: allowed.filter(clone => !foundKeys.has(keyOf(clone))),
    unjudged: allowed.filter(clone => clone.judged === TO_JUDGE),
  }
}

export const TO_JUDGE = 'to judge'

// The list written again from what was found, each entry keeping the judgment it had and a new one "to judge"
export function updated(found: readonly Clone[], allowed: readonly Clone[]): Clone[] {
  const judged = new Map(allowed.map(clone => [keyOf(clone), clone.judged]))
  return sorted(found.map(clone => ({ ...clone, judged: judged.get(keyOf(clone)) ?? TO_JUDGE })))
}

function detect(): Clone[] {
  const out = mkdtempSync(path.join(tmpdir(), 'hetu-copies-'))
  try {
    const ran = runJscpd(['--config', path.join(repo, '.jscpd.json'), '--absolute', '--no-colors', '--reporters', 'json,silent', '--output', out], { cwd: repo, encoding: 'utf8' })
    if (ran.error !== undefined || ran.status !== 0) {
      throw new Error(`jscpd failed with ${ran.error?.message ?? `exit ${ran.status}`}\n${ran.stdout}${ran.stderr}`)
    }
    const report = JSON.parse(readFileSync(path.join(out, 'jscpd-report.json'), 'utf8')) as { duplicates: Duplicate[] }
    return clonesOf(report.duplicates, file => readFileSync(path.join(repo, file), 'utf8'))
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

function read(): Clone[] {
  try {
    return (JSON.parse(readFileSync(allowedFile, 'utf8')) as { clones: Clone[] }).clones
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

const about = 'The clones jscpd finds in shipped code, checked by scripts/check-copies.ts. A person judges each: '
  + 'the same meaning becomes one definition, a different meaning stays here with judged saying why. "not yet" is the '
  + 'baseline of 2026-11-19, not judged. A clone found after it is "to judge" and fails the check until judged. The key is files and hash, at only says where it sat at the last --update'

if (import.meta.main) {
  const found = detect()
  const allowed = read()
  if (process.argv.includes('--update')) {
    const clones = updated(found, allowed)
    writeFileSync(allowedFile, `${JSON.stringify({ about, clones }, null, 2)}\n`)
    console.log(`copies-allowed.json holds ${clones.length} clones, ${clones.filter(clone => clone.judged === 'not yet').length} not yet judged`)
  } else {
    const { added, gone, unjudged } = compare(found, allowed)
    for (const clone of added) console.log(`new clone: ${clone.at.join(' and ')}`)
    for (const clone of gone) console.log(`listed and no longer found: ${clone.at.join(' and ')} (${clone.hash})`)
    for (const clone of unjudged) console.log(`listed and not judged: ${clone.at.join(' and ')} (${clone.hash}), judged says "${TO_JUDGE}"`)
    if (added.length > 0 || gone.length > 0 || unjudged.length > 0) {
      console.log('Make each new clone one definition, or run `node scripts/check-copies.ts --update` and judge it in core/test/copies-allowed.json')
      process.exit(1)
    }
    console.log(`${found.length} clones, each in core/test/copies-allowed.json`)
  }
}
