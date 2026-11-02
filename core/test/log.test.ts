import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLog } from '../backend/events/log.ts'
import { HOLD_TIMEOUT, holdOpen, onWindows, release, releaseAfter, releaseAll } from './hold.ts'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const ZERO = '0'.repeat(64)
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

let dir: string
const eventsDir = () => path.join(dir, 'events')
const segmentFile = (n: number) => path.join(eventsDir(), `events-${n}.jsonl`)

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-log-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await releaseAll()
  await rm(dir, { recursive: true, force: true })
})

// FileHandle isn't exported, so its prototype comes from a handle opened once
async function fileHandleProto() {
  const handle = await open(path.join(dir, 'probe'), 'w')
  const proto = Object.getPrototypeOf(handle)
  await handle.close()
  await rm(path.join(dir, 'probe'))
  return proto
}

async function opened(options: { retryAfterMs?: number } = {}) {
  const log = new EventLog(dir, options)
  await log.open()
  return log
}

async function linesOf(n: number): Promise<string[]> {
  const text = await readFile(segmentFile(n), 'utf8')
  expect(text.endsWith('\n')).toBe(true)
  return text.slice(0, -1).split('\n')
}

const recordsOf = async (n: number) => (await linesOf(n)).map(line => JSON.parse(line))
const segments = async () => (await readdir(eventsDir())).sort()
const joined = (lines: string[]) => lines.map(line => `${line}\n`).join('')

async function put(n: number, content: string | Buffer) {
  await mkdir(eventsDir(), { recursive: true })
  await writeFile(segmentFile(n), content)
}

// A segment written by hand, so open is tried on files that EventLog did not write
function chain(first: number, count: number): string[] {
  const lines: string[] = []
  let prev = ZERO
  for (let seq = first; seq < first + count; seq++) {
    const line = JSON.stringify({ seq, prev, at: '2026-11-02T00:00:00.000Z', event: 'test.line', n: seq })
    lines.push(line)
    prev = sha256(line)
  }
  return lines
}

// Lines from the records given, each with the right prev and in append's key order, so only the record's shape is wrong
function chainOf(records: Record<string, unknown>[]): string[] {
  let prev = ZERO
  return records.map(({ seq, ...rest }) => {
    const line = JSON.stringify({ seq, prev, ...rest })
    prev = sha256(line)
    return line
  })
}
const good = (seq: number) => ({ seq, at: '2026-11-02T00:00:00.000Z', event: 'test.line' })

// One valid line after the given ones, the way a program that knows the format would add one
const after = (lines: string[]) => JSON.stringify({
  seq: lines.length + 1, prev: sha256(lines[lines.length - 1]), at: '2026-11-02T00:00:00.000Z', event: 'test.line', n: lines.length + 1,
})

function edit(line: string, from: string, to: string): string {
  if (!line.includes(from)) throw new Error(`test setup: ${from} is not in ${line}`)
  return line.replace(from, to)
}

async function fill(log: EventLog, count: number) {
  for (let n = 1; n <= count; n++) await log.append('test.line', { n })
}

async function expectBreakRecord(segment: number, seq: number, brokenSegment: number) {
  const records = await recordsOf(segment)
  expect(records).toHaveLength(1)
  expect(records[0]).toEqual({ seq, prev: ZERO, at: expect.any(String), event: 'log.chain-broken', segment: brokenSegment, brokenSeq: seq })
  expect(Object.keys(records[0])).toEqual(['seq', 'prev', 'at', 'event', 'segment', 'brokenSeq'])
}

// What can happen to a file of four lines and the first seq each way of looking reports as broken
// open: null where only a copy kept in memory can tell, the chain alone can't see the change
type Damage = { name: string, make: (lines: string[]) => string | Buffer | null, verify: number, open: number | null }
const damages: Damage[] = [
  { name: 'a middle line edited', make: l => joined([l[0], edit(l[1], '"n":2', '"n":9'), l[2], l[3]]), verify: 3, open: 3 },
  { name: 'the first line edited', make: l => joined([edit(l[0], '"n":1', '"n":9'), l[1], l[2], l[3]]), verify: 2, open: 2 },
  { name: 'the last line edited', make: l => joined([l[0], l[1], l[2], edit(l[3], '"n":4', '"n":9')]), verify: 4, open: null },
  { name: 'a middle line removed', make: l => joined([l[0], l[2], l[3]]), verify: 2, open: 2 },
  { name: 'two lines swapped', make: l => joined([l[0], l[2], l[1], l[3]]), verify: 2, open: 2 },
  { name: 'a blank line put in', make: l => joined([l[0], l[1], '', l[2], l[3]]), verify: 3, open: 3 },
  { name: 'the last line removed', make: l => joined([l[0], l[1], l[2]]), verify: 4, open: null },
  { name: 'a valid line added after the last', make: l => joined([...l, after(l)]), verify: 5, open: null },
  { name: 'torn bytes after the last line', make: l => `${joined(l)}{"seq":5,"prev":"ab`, verify: 5, open: 5 },
  { name: 'the last line without its newline', make: l => joined(l).slice(0, -1), verify: 4, open: 4 },
  { name: 'line endings turned into CRLF', make: l => joined(l).replaceAll('\n', '\r\n'), verify: 1, open: 1 },
  { name: 'the last line reformatted with a space', make: l => joined([l[0], l[1], l[2], edit(l[3], '"n":4', '"n": 4')]), verify: 4, open: 4 },
  { name: 'a key repeated in the last line', make: l => joined([l[0], l[1], l[2], edit(l[3], '}', ',"n":5}')]), verify: 4, open: 4 },
  { name: 'garbage in place of the last line', make: l => joined([l[0], l[1], l[2], 'not json']), verify: 4, open: 4 },
  // 0xE9 is a Windows-1252 letter, which is not valid UTF-8 where a plain letter should be
  { name: 'a Windows-1252 letter in the last line', make: l => Buffer.from(joined([l[0], l[1], l[2], edit(l[3], 'test.line', 'test.linéx')]), 'latin1'), verify: 4, open: 4 },
  { name: 'a byte order mark in front', make: l => Buffer.concat([BOM, Buffer.from(joined(l))]), verify: 1, open: 1 },
  { name: 'the whole file emptied', make: () => '', verify: 1, open: null },
  { name: 'the file deleted', make: () => null, verify: 1, open: null },
]

describe('records', () => {
  it('writes one JSON line per event, with seq, prev, at and event before the fields', async () => {
    const log = await opened()
    await log.append('note.written', { path: 'a.md', size: 3, fresh: true, parent: null, ratio: -1.5 })
    const [record] = await recordsOf(1)
    expect(Object.keys(record)).toEqual(['seq', 'prev', 'at', 'event', 'path', 'size', 'fresh', 'parent', 'ratio'])
    expect(record).toEqual({ seq: 1, prev: ZERO, at: expect.any(String), event: 'note.written', path: 'a.md', size: 3, fresh: true, parent: null, ratio: -1.5 })
  })

  it('puts the time of the write in at, as an ISO string in UTC', async () => {
    const log = await opened()
    const before = Date.now()
    await log.append('test.line')
    const stamp = Date.now()
    const [record] = await recordsOf(1)
    expect(record.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(Date.parse(record.at)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(record.at)).toBeLessThanOrEqual(stamp)
  })

  it('links each line to the sha256 of the raw bytes of the line before it, without the newline', async () => {
    const log = await opened()
    await fill(log, 3)
    const lines = await linesOf(1)
    const records = lines.map(line => JSON.parse(line))
    expect(records.map(r => r.seq)).toEqual([1, 2, 3])
    expect(records[0].prev).toBe(ZERO)
    expect(records[1].prev).toBe(sha256(lines[0]))
    expect(records[2].prev).toBe(sha256(lines[1]))
    expect(records[1].prev).not.toBe(sha256(`${lines[0]}\n`))
  })

  it('keeps every record on one line whatever its values hold', async () => {
    const log = await opened()
    const nasty = 'line one\nline two\r\n"quoted" \\ back \u2028 \ud83d\ude00 \ud800 end'
    await log.append('test.line', { nasty, other: 'plain' })
    await log.append('test.line', { n: 2 })
    expect((await readFile(segmentFile(1), 'utf8')).split('\n')).toHaveLength(3)
    const [first] = await recordsOf(1)
    expect(first.nasty).toBe(nasty)
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('takes an event with no fields', async () => {
    const log = await opened()
    await log.append('test.line')
    expect(Object.keys((await recordsOf(1))[0])).toEqual(['seq', 'prev', 'at', 'event'])
  })

  it('writes the values it checked, even from a getter that answers differently the second time', async () => {
    const log = await opened()
    let reads = 0
    const fields = { get tricky() { return reads++ === 0 ? 'fine' : { note: 'secret' } } }
    await log.append('test.line', fields as never)
    expect((await recordsOf(1))[0].tricky).toBe('fine')
  })

  it('keeps the values when the caller changes its object after the call', async () => {
    const log = await opened()
    const fields = { n: 1 }
    const pending = log.append('test.line', fields)
    fields.n = 99
    await pending
    expect((await recordsOf(1))[0].n).toBe(1)
  })
})

describe('refusing input', () => {
  const refused: [string, string, unknown][] = [
    ['an object value', 'test.line', { a: { note: 'x' } }],
    ['an array value', 'test.line', { a: [1] }],
    ['an undefined value', 'test.line', { a: undefined }],
    ['NaN', 'test.line', { a: NaN }],
    ['Infinity', 'test.line', { a: Infinity }],
    ['minus Infinity', 'test.line', { a: -Infinity }],
    ['a bigint', 'test.line', { a: 1n }],
    ['a function', 'test.line', { a: () => 1 }],
    ['a date', 'test.line', { a: new Date() }],
    ['a field named content', 'test.line', { content: 'secret note text' }],
    ['a field named text', 'test.line', { text: 'secret note text' }],
    ['a field named body', 'test.line', { body: 'secret note text' }],
    ['a field named Content', 'test.line', { Content: 'secret note text' }],
    ['a field named BODY', 'test.line', { BODY: 'secret note text' }],
    ['a field named seq', 'test.line', { seq: 7 }],
    ['a field named prev', 'test.line', { prev: ZERO }],
    ['a field named at', 'test.line', { at: 'yesterday' }],
    ['a field named event', 'test.line', { event: 'other.thing' }],
    ['a field named __proto__', 'test.line', JSON.parse('{"__proto__":"x"}')],
    ['fields that are null', 'test.line', null],
    ['fields that are an array', 'test.line', ['content']],
    ['fields that are a string', 'test.line', 'abc'],
    ['an empty event name', '', {}],
    ['an event name with a capital', 'Note.written', {}],
    ['an event name with a space', 'note written', {}],
    ['an event name with a newline', 'note\nwritten', {}],
    ['an event name that starts with a dot', '.note', {}],
    ['an event name that ends with a dot', 'note.', {}],
    ['an event name with a double dot', 'note..written', {}],
    ['an event name with a double dash', 'note--written', {}],
    ['an event name that starts with a digit', '1note', {}],
    ['a value longer than 4096', 'test.line', { path: 'x'.repeat(4097) }],
  ]

  it.each(refused)('refuses %s, writes nothing and keeps the log healthy', async (_name, event, fields) => {
    const log = await opened()
    await log.append('test.line', { n: 1 })
    const before = await readFile(segmentFile(1))
    await expect(log.append(event, fields as never)).rejects.toThrow()
    expect(await readFile(segmentFile(1))).toEqual(before)
    expect(log.healthy).toBe(true)
    await log.append('test.line', { n: 2 })
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2])
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('accepts event names made of lowercase words joined by dots and dashes', async () => {
    const log = await opened()
    for (const name of ['a', 'note.written', 'log.chain-broken', 'plugin.v2.loaded']) await log.append(name)
    expect((await recordsOf(1)).map(r => r.event)).toEqual(['a', 'note.written', 'log.chain-broken', 'plugin.v2.loaded'])
  })

  it('accepts a value of exactly 4096', async () => {
    const log = await opened()
    await log.append('test.line', { path: 'x'.repeat(4096) })
    expect((await recordsOf(1))[0].path).toHaveLength(4096)
  })

  it('accepts field names that merely contain a refused word', async () => {
    const log = await opened()
    await log.append('test.line', { contentHash: ZERO, textLength: 4, bodyBytes: 9 })
    expect(Object.keys((await recordsOf(1))[0]).slice(4)).toEqual(['contentHash', 'textLength', 'bodyBytes'])
  })
})

describe('opening', () => {
  it('makes the folders and writes nothing until the first event', async () => {
    const state = path.join(dir, 'deep', 'state')
    const log = new EventLog(state)
    await log.open()
    expect(log.healthy).toBe(true)
    expect(await readdir(path.join(state, 'events'))).toEqual([])
    await log.append('test.line')
    expect(await readdir(path.join(state, 'events'))).toEqual(['events-1.jsonl'])
  })

  it('says what it found: no records in a new log', async () => {
    expect(await new EventLog(dir).open()).toEqual({ lastSeq: 0, broken: null })
  })

  it('says what it found: the last seq of a good log', async () => {
    await put(1, joined(chain(1, 3)))
    expect(await new EventLog(dir).open()).toEqual({ lastSeq: 3, broken: null })
  })

  it('says what it found: the last seq of a later segment, not its number of lines', async () => {
    await put(1, joined(chain(1, 2)))
    await put(2, joined(chainOf([good(3), good(4)])))
    expect(await new EventLog(dir).open()).toEqual({ lastSeq: 4, broken: null })
  })

  it('says what it found: the break, before the record of it was written', async () => {
    await put(1, joined([...chain(1, 2), 'garbage']))
    expect(await new EventLog(dir).open()).toEqual({ lastSeq: 2, broken: { segment: 1, brokenSeq: 3 } })
  })

  it('says what it found: a break with no good line anywhere', async () => {
    await put(1, 'garbage\n')
    expect(await new EventLog(dir).open()).toEqual({ lastSeq: 0, broken: { segment: 1, brokenSeq: 1 } })
  })

  it('is not healthy before it is opened, and takes no events', async () => {
    const log = new EventLog(dir)
    expect(log.healthy).toBe(false)
    await expect(log.append('test.line')).rejects.toThrow()
    expect(await readdir(dir)).toEqual([])
  })

  it('takes an event that is appended right after open without waiting for it', async () => {
    const log = new EventLog(dir)
    const opening = log.open()
    const appending = log.append('test.line', { n: 1 })
    await opening
    await appending
    expect((await recordsOf(1)).map(r => r.n)).toEqual([1])
  })

  it('carries the chain on after a restart', async () => {
    const first = await opened()
    await fill(first, 3)
    const lines = await linesOf(1)
    const second = await opened()
    await second.append('test.line', { n: 4 })
    const records = await recordsOf(1)
    expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4])
    expect(records[3].prev).toBe(sha256(lines[2]))
    expect(await second.verify()).toEqual({ ok: true })
    expect(await segments()).toEqual(['events-1.jsonl'])
  })

  it('carries on from a log it did not write', async () => {
    const lines = chain(1, 3)
    await put(1, joined(lines))
    const log = await opened()
    await log.append('test.line', { n: 4 })
    const records = await recordsOf(1)
    expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4])
    expect(records[3].prev).toBe(sha256(lines[2]))
  })

  it('takes the newest segment by its number, not by its name', async () => {
    const nine = chain(1, 2)
    const ten = chain(3, 2)
    await put(9, joined(nine))
    await put(10, joined(ten))
    const log = await opened()
    await log.append('test.line', { n: 5 })
    expect((await recordsOf(10)).map(r => r.seq)).toEqual([3, 4, 5])
    expect(await linesOf(9)).toEqual(nine)
    expect(await segments()).toEqual(['events-10.jsonl', 'events-9.jsonl'])
  })

  it('ignores names that are not segments', async () => {
    await put(1, joined(chain(1, 3)))
    const others = ['events-007.jsonl', 'events-01.jsonl', 'events-2.jsonl.tmp', 'events-x.jsonl', 'events-3.json', 'notes.txt']
    for (const name of others) await writeFile(path.join(eventsDir(), name), 'garbage\n')
    const log = await opened()
    await log.append('test.line', { n: 4 })
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2, 3, 4])
    expect(await segments()).toEqual(['events-1.jsonl', ...others].sort())
    for (const name of others) expect(await readFile(path.join(eventsDir(), name), 'utf8')).toBe('garbage\n')
  })

  // The segment after the largest safe integer would round to a number no open can tell apart
  it.each(['events-99999999999999999999.jsonl', 'events-9007199254740991.jsonl'])('ignores %s, a number too big to count on from', async name => {
    await put(1, joined(chain(1, 3)))
    await writeFile(path.join(eventsDir(), name), 'garbage\n')
    const log = await opened()
    await log.append('test.line', { n: 4 })
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2, 3, 4])
    expect(await segments()).toEqual(['events-1.jsonl', name].sort())
  })

  it('takes the segment just below the largest safe integer', async () => {
    const name = 'events-9007199254740990.jsonl'
    await mkdir(eventsDir(), { recursive: true })
    await writeFile(path.join(eventsDir(), name), joined(chain(1, 2)))
    const log = await opened()
    await log.append('test.line', { n: 3 })
    expect((await readFile(path.join(eventsDir(), name), 'utf8')).trimEnd().split('\n')).toHaveLength(3)
  })

  it('goes on in a first segment that is empty', async () => {
    await put(1, '')
    const log = await opened()
    await log.append('test.line', { n: 1 })
    const [record] = await recordsOf(1)
    expect(record.seq).toBe(1)
    expect(record.prev).toBe(ZERO)
    expect(await segments()).toEqual(['events-1.jsonl'])
  })
})

describe('a broken chain at open', () => {
  const openable = damages.flatMap(d => (d.open === null ? [] : [{ ...d, open: d.open }]))

  it.each(openable)('after $name it starts a new segment and says so first', async ({ make, open }) => {
    await put(1, make(chain(1, 4)) as string | Buffer)
    const damaged = await readFile(segmentFile(1))
    const log = await opened()
    expect(log.healthy).toBe(true)
    expect(await readFile(segmentFile(1))).toEqual(damaged)
    await expectBreakRecord(2, open, 1)
    expect(await segments()).toEqual(['events-1.jsonl', 'events-2.jsonl'])
  })

  it('goes on in the new segment, with the seq counting on and the chain starting over', async () => {
    const lines = chain(1, 4)
    await put(1, joined([lines[0], edit(lines[1], '"n":2', '"n":9'), lines[2], lines[3]]))
    const log = await opened()
    await log.append('test.line', { n: 4 })
    await log.append('test.line', { n: 5 })
    const [marker, four, five] = await recordsOf(2)
    const markerLine = (await linesOf(2))[0]
    expect([marker.seq, four.seq, five.seq]).toEqual([3, 4, 5])
    expect(marker.prev).toBe(ZERO)
    expect(four.prev).toBe(sha256(markerLine))
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('does not start another segment when the new one is reopened', async () => {
    const lines = chain(1, 4)
    await put(1, joined([lines[0], lines[1], 'not json']))
    await opened()
    const again = await opened()
    await again.append('test.line', { n: 3 })
    expect(await segments()).toEqual(['events-1.jsonl', 'events-2.jsonl'])
    const records = await recordsOf(2)
    expect(records.map(r => r.seq)).toEqual([3, 4])
    expect(records[0].event).toBe('log.chain-broken')
    expect(await again.verify()).toEqual({ ok: true })
  })

  it('keeps counting through a second break', async () => {
    const two = chain(3, 3)
    await put(1, joined(chain(1, 2)))
    await put(2, joined([two[0], edit(two[1], '"n":4', '"n":9'), two[2]]))
    await opened()
    await expectBreakRecord(3, 5, 2)
  })

  // Chained right but not what append writes. As the newest segment's last line after a restart these checks are all
  // that catches an edit, nothing covers that line otherwise
  const misshapen: [string, Record<string, unknown>][] = [
    ['an at that is a number', { seq: 3, at: 5, event: 'test.line' }],
    ['no at', { seq: 3, event: 'test.line' }],
    ['an event that is a number', { seq: 3, at: '2026-11-02T00:00:00.000Z', event: 7 }],
    ['no event', { seq: 3, at: '2026-11-02T00:00:00.000Z' }],
    ['a gap in seq', { ...good(4) }],
    ['a seq that repeats', { ...good(2) }],
    ['a seq that is a string', { ...good(3), seq: '3' }],
  ]

  it.each(misshapen)('breaks at a last line with %s', async (_name, third) => {
    await put(1, joined(chainOf([good(1), good(2), third])))
    await opened()
    await expectBreakRecord(2, 3, 1)
  })

  it.each([[0], [1.5], [-1], [2 ** 53]])('does not take a first line with seq %s', async seq => {
    await put(1, joined(chainOf([{ ...good(1), seq }])))
    await opened()
    await expectBreakRecord(2, 1, 1)
  })

  it('counts on from the earlier segment when the newest one has no good line', async () => {
    await put(1, joined(chain(1, 3)))
    await put(2, 'garbage\n')
    await opened()
    await expectBreakRecord(3, 4, 2)
  })

  it('counts on from the earlier segment when the newest one can not be read at all', async () => {
    await put(1, joined(chain(1, 3)))
    await mkdir(segmentFile(2))
    const log = await opened()
    expect(log.healthy).toBe(true)
    await expectBreakRecord(3, 4, 2)
  })

  it('starts again at seq 1 when nothing earlier is good either', async () => {
    await put(1, 'garbage\n')
    await put(2, 'garbage\n')
    await opened()
    await expectBreakRecord(3, 1, 2)
  })

  it('treats an empty newest segment after the first as a lost break and says so again', async () => {
    await put(1, joined(chain(1, 3)))
    await put(2, '')
    await opened()
    await expectBreakRecord(3, 4, 2)
    expect(await readFile(segmentFile(2), 'utf8')).toBe('')
  })

  it('does not lock anyone out, new events are written and verify clean', async () => {
    await put(1, 'garbage without a newline')
    const log = await opened()
    await log.append('test.line', { n: 1 })
    expect(log.healthy).toBe(true)
    expect((await recordsOf(2)).map(r => r.seq)).toEqual([1, 2])
    expect(await log.verify()).toEqual({ ok: true })
  })
})

describe('verify', () => {
  it('is ok for a log with nothing in it yet', async () => {
    const log = await opened()
    expect(log.healthy).toBe(true)
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('is ok for a log it wrote, before and after a restart', async () => {
    const log = await opened()
    await fill(log, 4)
    expect(await linesOf(1)).toHaveLength(4)
    expect(await log.verify()).toEqual({ ok: true })
    expect(await (await opened()).verify()).toEqual({ ok: true })
  })

  it.each(damages)('reports the first broken seq after $name', async ({ make, verify }) => {
    const log = await opened()
    await fill(log, 4)
    const content = make(await linesOf(1))
    if (content === null) await rm(segmentFile(1))
    else await writeFile(segmentFile(1), content)
    expect(await log.verify()).toEqual({ ok: false, seq: verify })
  })

  it('looks at the current segment only', async () => {
    const lines = chain(1, 4)
    await put(1, joined([lines[0], edit(lines[1], '"n":2', '"n":9'), lines[2], lines[3]]))
    const log = await opened()
    await log.append('test.line')
    expect(await segments()).toEqual(['events-1.jsonl', 'events-2.jsonl'])
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('does not take events still being written for a break', async () => {
    const log = await opened()
    const pending = Array.from({ length: 10 }, (_, n) => log.append('test.line', { n }))
    expect(await log.verify()).toEqual({ ok: true })
    await Promise.all(pending)
    expect(await linesOf(1)).toHaveLength(10)
  })

  it('answers only after every append called before it has landed', async () => {
    const log = await opened()
    const order: string[] = []
    const pending = Array.from({ length: 5 }, (_, n) => log.append('test.line', { n }).then(() => { order.push('append') }))
    const verified = log.verify().then(result => { order.push('verify'); return result })
    await Promise.all(pending)
    expect(await verified).toEqual({ ok: true })
    expect(order).toEqual([...Array(5).fill('append'), 'verify'])
  })

  it.each([
    ['deleted', () => rm(segmentFile(2))],
    ['emptied', () => writeFile(segmentFile(2), '')],
  ])('names the first seq of a segment that did not start at 1 when it is %s after a restart', async (_name, damage) => {
    await put(1, joined(chain(1, 2)))
    // A segment's first line points at zeros, the seq carries on from the one before
    await put(2, joined(chainOf([good(3), good(4)])))
    const log = await opened()
    await damage()
    expect(await log.verify()).toEqual({ ok: false, seq: 3 })
  })

  it('throws on a segment it can not read rather than reading it as empty', async () => {
    const log = await opened()
    await log.append('test.line')
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))
    await expect(log.verify()).rejects.toThrow()
  })

  it('refuses to answer before open', async () => {
    await expect(new EventLog(dir).verify()).rejects.toThrow()
  })
})

describe('overlapping appends', () => {
  it('gives each its own seq in the order called, with the chain intact', async () => {
    const log = await opened()
    await Promise.all(Array.from({ length: 20 }, (_, n) => log.append('test.line', { n })))
    const records = await recordsOf(1)
    expect(records.map(r => r.seq)).toEqual(Array.from({ length: 20 }, (_, n) => n + 1))
    expect(records.map(r => r.n)).toEqual(Array.from({ length: 20 }, (_, n) => n))
    expect(await log.verify()).toEqual({ ok: true })
  })

})

describe('a log that can not be written', () => {
  it('turns unhealthy, then the next append looks at the file again and goes on once the disk is fine', async () => {
    const log = await opened({ retryAfterMs: 0 })
    await log.append('test.line', { n: 1 })
    const first = await readFile(segmentFile(1))
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))

    await expect(log.append('test.line', { n: 2 })).rejects.toThrow()
    expect(log.healthy).toBe(false)

    await rm(segmentFile(1), { recursive: true })
    await writeFile(segmentFile(1), first)
    await log.append('test.line', { n: 2 })
    expect(log.healthy).toBe(true)
    const records = await recordsOf(1)
    expect(records.map(r => r.seq)).toEqual([1, 2])
    expect(records[1].prev).toBe(sha256((await linesOf(1))[0]))
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('stays unhealthy and refuses while the disk is still in the way', async () => {
    const log = await opened({ retryAfterMs: 0 })
    await log.append('test.line', { n: 1 })
    await rm(eventsDir(), { recursive: true })
    await writeFile(eventsDir(), 'in the way')
    await expect(log.append('test.line', { n: 2 })).rejects.toThrow()
    await expect(log.append('test.line', { n: 3 })).rejects.toThrow()
    expect(log.healthy).toBe(false)
  })

  it('reads a half written line as a break when it looks again after a failed write', async () => {
    const log = await opened({ retryAfterMs: 0 })
    await fill(log, 2)
    const kept = await readFile(segmentFile(1))
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))
    await expect(log.append('test.line', { n: 3 })).rejects.toThrow()
    await rm(segmentFile(1), { recursive: true })
    await writeFile(segmentFile(1), Buffer.concat([kept, Buffer.from('{"seq":3,"pr')]))
    await log.append('test.line', { n: 3 })
    expect(await segments()).toEqual(['events-1.jsonl', 'events-2.jsonl'])
    expect((await recordsOf(2)).map(r => [r.seq, r.event])).toEqual([[3, 'log.chain-broken'], [4, 'test.line']])
  })

  it('refuses at once during the quiet window after a failure, then looks at the file again', async () => {
    const log = await opened({ retryAfterMs: 300 })
    await log.append('test.line', { n: 1 })
    const first = await readFile(segmentFile(1))
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))
    await expect(log.append('test.line', { n: 2 })).rejects.toThrow()
    await rm(segmentFile(1), { recursive: true })
    await writeFile(segmentFile(1), first)
    await expect(log.append('test.line', { n: 2 })).rejects.toThrow(/not healthy/)
    await new Promise(resolve => setTimeout(resolve, 350))
    await log.append('test.line', { n: 2 })
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2])
  })

  it('looks at the file again after an open that failed, once the quiet window has passed', async () => {
    await writeFile(eventsDir(), 'in the way')
    const log = new EventLog(dir, { retryAfterMs: 0 })
    await expect(log.open()).rejects.toThrow()
    await rm(eventsDir())
    await log.append('test.line', { n: 1 })
    expect(log.healthy).toBe(true)
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1])
  })

  // In one process the tip of the last line written is known, so what the chain alone can't see after a restart is
  // seen here
  // A failed append, so the next one looks at the file again, then whatever a tool did to it meanwhile
  async function failOnce(log: EventLog, segment: number, change: () => Promise<void>) {
    const kept = await readFile(segmentFile(segment))
    await rm(segmentFile(segment))
    await mkdir(segmentFile(segment))
    await expect(log.append('test.line', { n: 0 })).rejects.toThrow()
    await rm(segmentFile(segment), { recursive: true })
    await writeFile(segmentFile(segment), kept)
    await change()
  }

  // The cases where the segment still checks out and the ones where it no longer does, which went by a different path
  it.each([
    ['cut back to its first line', (lines: string[]) => joined([lines[0]]), 2],
    ['its last line edited', (lines: string[]) => joined([lines[0], lines[1], edit(lines[2], '"n":3', '"n":9')]), 3],
    ['cut in the middle of a line', (lines: string[]) => `${lines[0]}\n${lines[1].slice(0, 20)}`, 2],
    ['turned into CRLF', (lines: string[]) => joined(lines).replaceAll('\n', '\r\n'), 1],
    ['its middle line edited', (lines: string[]) => joined([lines[0], edit(lines[1], '"n":2', '"n":9'), lines[2]]), 3],
    ['its last line respaced', (lines: string[]) => joined([lines[0], lines[1], edit(lines[2], '"n":3', '"n": 3')]), 3],
  ])('notices a segment %s while it was away, and uses no seq twice', async (_name, change, brokenSeq) => {
    const log = await opened({ retryAfterMs: 0 })
    await fill(log, 3)
    const lines = await linesOf(1)
    await failOnce(log, 1, () => writeFile(segmentFile(1), change(lines)))
    await log.append('test.line', { n: 4 })
    const records = await recordsOf(2)
    expect(records[0]).toMatchObject({ seq: 4, event: 'log.chain-broken', segment: 1, brokenSeq })
    expect(records[1]).toMatchObject({ seq: 5, event: 'test.line', n: 4 })
    expect(records).toHaveLength(2)
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('says what it found when an open looks again after a cut', async () => {
    const log = await opened({ retryAfterMs: 0 })
    await fill(log, 3)
    const lines = await linesOf(1)
    await failOnce(log, 1, () => writeFile(segmentFile(1), joined([lines[0]])))
    expect(await log.open()).toEqual({ lastSeq: 3, broken: { segment: 1, brokenSeq: 2 } })
    expect((await recordsOf(2))[0]).toMatchObject({ seq: 4, event: 'log.chain-broken' })
  })

  it.each([
    ['deleted', () => rm(segmentFile(2))],
    ['emptied', () => writeFile(segmentFile(2), '')],
  ])('notices the newest segment %s while it was away, and goes on after it', async (_name, change) => {
    await put(1, joined(chain(1, 3)))
    await put(2, joined(chainOf([good(4), good(5)])))
    const log = await opened({ retryAfterMs: 0 })
    await failOnce(log, 2, change)
    await log.append('test.line', { n: 6 })
    const records = await recordsOf(3)
    expect(records[0]).toMatchObject({ seq: 6, event: 'log.chain-broken', segment: 2, brokenSeq: 4 })
    expect(records[1]).toMatchObject({ seq: 7, event: 'test.line', n: 6 })
    expect(await log.verify()).toEqual({ ok: true })
  })

  it('notices the whole log folder gone while it was away, and keeps counting', async () => {
    const log = await opened({ retryAfterMs: 0 })
    await fill(log, 2)
    await failOnce(log, 1, () => rm(eventsDir(), { recursive: true }))
    await log.append('test.line', { n: 3 })
    expect(await segments()).toEqual(['events-2.jsonl'])
    expect((await recordsOf(2)).map(r => [r.seq, r.event, r.segment, r.brokenSeq])).toEqual([
      [3, 'log.chain-broken', 1, 1],
      [4, 'test.line', undefined, undefined],
    ])
  })

  it('keeps the quiet window 5 seconds by default, on a clock the wall clock can not move', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const log = await opened()
    await fill(log, 1)
    const kept = await readFile(segmentFile(1))
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))
    await expect(log.append('test.line', { n: 2 })).rejects.toThrow()
    await rm(segmentFile(1), { recursive: true })
    await writeFile(segmentFile(1), kept)
    now = 5999
    await expect(log.append('test.line', { n: 2 })).rejects.toThrow(/not healthy/)
    now = 6000
    await log.append('test.line', { n: 2 })
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2])
  })

  it('starts the quiet window after an open that failed too', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await writeFile(eventsDir(), 'in the way')
    const log = new EventLog(dir)
    await expect(log.open()).rejects.toThrow()
    await rm(eventsDir())
    await expect(log.append('test.line')).rejects.toThrow(/not healthy/)
    now = 6000
    await log.append('test.line')
    expect(log.healthy).toBe(true)
  })

  it('leaves no empty segment behind for each failed retry on a full disk, and blames the segment that broke', async () => {
    const log = await opened({ retryAfterMs: 0 })
    await fill(log, 2)
    await writeFile(segmentFile(1), Buffer.concat([await readFile(segmentFile(1)), Buffer.from('{"seq":3,"pr')]))
    const full = vi.spyOn(await fileHandleProto(), 'writeFile').mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }))
    for (let n = 0; n < 4; n++) await expect(log.append('test.line', { n })).rejects.toThrow()
    expect(await segments()).toEqual(['events-1.jsonl'])
    full.mockRestore()
    await log.append('test.line', { n: 9 })
    expect((await recordsOf(2)).map(r => [r.seq, r.event, r.segment])).toEqual([[3, 'log.chain-broken', 1], [4, 'test.line', undefined]])
  })

  it('does not count a failed event, the next one takes its seq', async () => {
    const log = await opened()
    await fill(log, 2)
    const kept = await readFile(segmentFile(1))
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))
    await expect(log.append('test.line', { n: 3 })).rejects.toThrow()
    await rm(segmentFile(1), { recursive: true })
    await writeFile(segmentFile(1), kept)
    await log.open()
    await log.append('test.line', { n: 3 })
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2, 3])
  })

  it('turns unhealthy when the first event of a log can not be written', async () => {
    const log = await opened()
    await rm(eventsDir(), { recursive: true })
    await writeFile(eventsDir(), 'in the way')
    await expect(log.append('test.line')).rejects.toThrow()
    expect(log.healthy).toBe(false)
  })

  it('rejects open and stays unhealthy when the folder can not be made', async () => {
    await writeFile(eventsDir(), 'in the way')
    const log = new EventLog(dir)
    await expect(log.open()).rejects.toThrow()
    expect(log.healthy).toBe(false)
    await expect(log.append('test.line')).rejects.toThrow()
  })

  it('turns unhealthy when a reopen fails after the log was healthy', async () => {
    const log = await opened()
    expect(log.healthy).toBe(true)
    await rm(eventsDir(), { recursive: true })
    await writeFile(eventsDir(), 'in the way')
    await expect(log.open()).rejects.toThrow()
    expect(log.healthy).toBe(false)
    await expect(log.append('test.line')).rejects.toThrow()
  })
})

describe('durability', () => {
  // Folders can't be synced from Node on Windows, elsewhere the folder is synced when a segment's first line makes it
  it('syncs every line to disk before append resolves', async () => {
    const sync = vi.spyOn(await fileHandleProto(), 'sync')
    const log = await opened()
    await log.append('test.line')
    await log.append('test.line')
    expect(sync).toHaveBeenCalledTimes(onWindows ? 2 : 3)
  })
})

describe.runIf(onWindows)('a segment another program holds open', { timeout: HOLD_TIMEOUT }, () => {
  it('waits out a lock at open and goes on in the same segment', async () => {
    await put(1, joined(chain(1, 3)))
    const holder = await holdOpen(segmentFile(1), 'None')
    const [found] = await Promise.all([new EventLog(dir).open(), releaseAfter(holder, 300)])
    expect(found).toEqual({ lastSeq: 3, broken: null })
    expect(await segments()).toEqual(['events-1.jsonl'])
  })

  it('fails open rather than calling a locked segment broken, so no seq is used twice', async () => {
    await put(1, joined(chain(1, 3)))
    const holder = await holdOpen(segmentFile(1), 'None')
    const log = new EventLog(dir)
    try {
      await expect(log.open()).rejects.toThrow()
    } finally {
      await release(holder)
    }
    expect(log.healthy).toBe(false)
    expect(await segments()).toEqual(['events-1.jsonl'])
  }, 15_000)

  it('waits out a lock on a read-only segment it reads, a read is not blocked by the attribute', async () => {
    await put(1, joined(chain(1, 3)))
    await chmod(segmentFile(1), 0o444)
    const holder = await holdOpen(segmentFile(1), 'None')
    const [found] = await Promise.all([new EventLog(dir).open(), releaseAfter(holder, 300)])
    expect(found).toEqual({ lastSeq: 3, broken: null })
    await chmod(segmentFile(1), 0o666)
  })

  it('clears a read-only attribute a restore left on the segment, without waiting', async () => {
    const log = await opened()
    await log.append('test.line', { n: 1 })
    await chmod(segmentFile(1), 0o444)
    const started = Date.now()
    await log.append('test.line', { n: 2 })
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2])
  })

  it('costs one wait, not one per event, while a reader keeps holding it', async () => {
    const log = await opened()
    await log.append('test.line', { n: 1 })
    const reader = await holdOpen(segmentFile(1), 'Read')
    const started = Date.now()
    try {
      for (let n = 2; n <= 5; n++) await expect(log.append('test.line', { n })).rejects.toThrow()
    } finally {
      await release(reader)
    }
    expect(Date.now() - started).toBeLessThan(4500)
    expect(log.healthy).toBe(false)
  }, 15_000)

  it('waits out a short lock when it verifies', async () => {
    const log = await opened()
    await log.append('test.line', { n: 1 })
    const holder = await holdOpen(segmentFile(1), 'None')
    const [result] = await Promise.all([log.verify(), releaseAfter(holder, 300)])
    expect(result).toEqual({ ok: true })
  })

  it('waits out a reader that keeps it from being written', async () => {
    const log = await opened()
    await log.append('test.line', { n: 1 })
    const reader = await holdOpen(segmentFile(1), 'Read')
    await Promise.all([log.append('test.line', { n: 2 }), releaseAfter(reader, 300)])
    expect(log.healthy).toBe(true)
    expect((await recordsOf(1)).map(r => r.seq)).toEqual([1, 2])
  })
})
