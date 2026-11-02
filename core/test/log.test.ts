import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../backend/events/log.ts'

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
  await rm(dir, { recursive: true, force: true })
})

async function opened() {
  const log = new EventLog(dir)
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
  it('turns unhealthy, refuses events after that even when the disk is fine again, and recovers on open', async () => {
    const log = await opened()
    await log.append('test.line', { n: 1 })
    const first = await readFile(segmentFile(1))
    await rm(segmentFile(1))
    await mkdir(segmentFile(1))

    await expect(log.append('test.line', { n: 2 })).rejects.toThrow()
    expect(log.healthy).toBe(false)

    await rm(segmentFile(1), { recursive: true })
    await writeFile(segmentFile(1), first)
    await expect(log.append('test.line', { n: 2 })).rejects.toThrow(/not healthy/)
    expect(await readFile(segmentFile(1))).toEqual(first)

    await log.open()
    expect(log.healthy).toBe(true)
    await log.append('test.line', { n: 2 })
    const records = await recordsOf(1)
    expect(records.map(r => r.seq)).toEqual([1, 2])
    expect(records[1].prev).toBe(sha256((await linesOf(1))[0]))
    expect(await log.verify()).toEqual({ ok: true })
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
