import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runJscpd } from 'jscpd'
import { afterAll, describe, expect, it } from 'vitest'
import { type Clone, clonesOf, compare, type Duplicate, fromRepo, hashOf, keyOf, updated } from '../../scripts/check-copies.ts'

// the copies check's own parts and jscpd as .jscpd.json sets it up finding a block of four lines

const repo = path.join(import.meta.dirname, '..', '..')
const config = JSON.parse(readFileSync(path.join(repo, '.jscpd.json'), 'utf8'))
const root = path.join(path.sep, 'repo')
const side = (file: string, start: number, end: number) => ({ name: path.join(root, file), start, end })
const block = 'const view = viewOf(event.instance)\nif (view === undefined) return\nconst key = keyOf(view)\nshown(key)\n'

describe('the copies check itself', () => {
  it('hashes the lines with their whitespace collapsed', () => {
    expect(hashOf('a  =\n  b')).toBe(hashOf('a = b'))
    expect(hashOf('a = b')).not.toBe(hashOf('a = c'))
  })

  it('keys a clone by its files and lines, not by where they sit or which side jscpd names first', () => {
    const files: Record<string, string> = { 'a.ts': `${block}tail\n`, 'b.ts': `head\nhead\n// a comment\n${block}` }
    const text = (file: string) => files[file]
    const [one] = clonesOf([{ firstFile: side('a.ts', 1, 4), secondFile: side('b.ts', 4, 7) }], text, root)
    const [flipped] = clonesOf([{ firstFile: side('b.ts', 4, 7), secondFile: side('a.ts', 1, 4) }], text, root)
    files['b.ts'] = `head\n${block}`
    const [moved] = clonesOf([{ firstFile: side('a.ts', 1, 4), secondFile: side('b.ts', 2, 5) }], text, root)
    expect(one).toEqual({ files: ['a.ts', 'b.ts'], hash: hashOf(block), at: ['a.ts:1-4', 'b.ts:4-7'], judged: 'not yet' })
    expect(keyOf(flipped)).toBe(keyOf(one))
    expect(keyOf(moved)).toBe(keyOf(one))
    expect(moved.at).toEqual(['a.ts:1-4', 'b.ts:2-5'])
  })

  it('holds a fragment repeated between the same two files as one clone with every place', () => {
    const text = () => `${block}${block}${block}`
    const duplicates: Duplicate[] = [
      { firstFile: side('a.ts', 1, 4), secondFile: side('a.ts', 5, 8) },
      { firstFile: side('a.ts', 5, 8), secondFile: side('a.ts', 9, 12) },
    ]
    expect(clonesOf(duplicates, text, root)).toEqual([{ files: ['a.ts', 'a.ts'], hash: hashOf(block), at: ['a.ts:1-4', 'a.ts:5-8', 'a.ts:9-12'], judged: 'not yet' }])
  })

  it.skipIf(process.platform !== 'win32')('reads a path in its \\\\?\\ form', () => {
    expect(fromRepo('\\\\?\\C:\\repo\\core\\lib\\disk.ts', 'C:\\repo')).toBe('core/lib/disk.ts')
  })

  it('fails on a clone not listed and on a listed one no longer found and an update keeps each judgment', () => {
    const clone = (hash: string, judged = 'not yet'): Clone => ({ files: ['a.ts', 'b.ts'], hash, at: ['a.ts:1-4', 'b.ts:1-4'], judged })
    const allowed = [clone('kept', 'different meaning: a sample'), clone('gone')]
    const found = [clone('kept'), clone('new')]
    expect(compare(found, allowed)).toEqual({ added: [clone('new')], gone: [clone('gone')], unjudged: [] })
    expect(compare(found.slice(0, 1), allowed.slice(0, 1))).toEqual({ added: [], gone: [], unjudged: [] })
    expect(updated(found, allowed)).toEqual([clone('kept', 'different meaning: a sample'), clone('new', 'to judge')])
  })

  it('fails on a clone an update listed until a person judges it, while the baseline stays not yet', () => {
    const clone = (hash: string, judged: string): Clone => ({ files: ['a.ts', 'b.ts'], hash, at: ['a.ts:1-4', 'b.ts:1-4'], judged })
    const allowed = [clone('old', 'not yet'), clone('new', 'to judge')]
    const found = [clone('old', 'not yet'), clone('new', 'not yet')]
    expect(compare(found, allowed)).toEqual({ added: [], gone: [], unjudged: [clone('new', 'to judge')] })
    expect(compare(found, [allowed[0], clone('new', 'different meaning: a sample')]).unjudged).toEqual([])
  })
})

describe('jscpd as .jscpd.json sets it up', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hetu-copies-test-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const clonesIn = (files: Record<string, string>): number => {
    const scan = mkdtempSync(path.join(dir, 'scan-'))
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(scan, name), text)
    const settings = path.join(scan, 'settings.json')
    writeFileSync(settings, JSON.stringify({ format: config.format, minLines: config.minLines, minTokens: config.minTokens }))
    const out = path.join(scan, 'out')
    const ran = runJscpd(['--config', settings, '--no-gitignore', '--reporters', 'json,silent', '--output', out, scan], { encoding: 'utf8' })
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0)
    return JSON.parse(readFileSync(path.join(out, 'jscpd-report.json'), 'utf8')).duplicates.length
  }

  it('looks at shipped TypeScript only, in blocks of 4 lines', () => {
    expect(config.minLines).toBe(4)
    expect(config.format).toEqual(['typescript'])
    expect(config.path).toEqual(['core/api', 'core/lib', 'core/sdk', 'core/frontend', 'core/backend', 'core-plugins'])
    expect(config.ignore).toEqual(expect.arrayContaining(['**/test/**', '**/testing/**', 'core/sdk/build/**', '**/*.test.ts']))
  })

  // The copied lines between lines that differ, so the clone is those lines alone
  const pair = (copied: string) => ({
    'one.ts': `export function first(event: { instance: string }) {\n  let n = 1\n${copied}\n  n++\n  return n\n}\n`,
    'two.ts': `export const second = (event: { instance: string }) => {\n  let m = 'x'\n${copied}\n  return m\n}\n`,
  })

  it('finds a block of 4 lines of code copied into another file', () => {
    expect(clonesIn(pair(block.trimEnd()))).toBe(1)
  })

  it('leaves a block of 3 lines alone', () => {
    expect(clonesIn(pair(block.split('\n').slice(0, 3).join('\n')))).toBe(0)
  })
})

describe('copies-allowed.json', () => {
  const { clones } = JSON.parse(readFileSync(path.join(import.meta.dirname, 'copies-allowed.json'), 'utf8')) as { clones: Clone[] }

  it('gives every clone its two files, a hash, its places and a judgment', () => {
    for (const clone of clones) {
      expect(clone.files.length).toBe(2)
      expect(clone.hash).toMatch(/^[0-9a-f]{16}$/)
      expect(clone.at.length).toBeGreaterThanOrEqual(2)
      expect(clone.judged.length).toBeGreaterThan(0)
    }
    expect(new Set(clones.map(keyOf)).size).toBe(clones.length)
  })
})
