import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { retried, syncDir, writable } from '../disk.ts'

// Metadata only. A caller may hand over a field that sounds like note text by mistake, so those names are refused
// and the record's own names can't be overwritten. It catches mistakes under these names only, not note text under
// any other name
const refusedNames = new Set(['seq', 'prev', 'at', 'event', 'content', 'text', 'body', '__proto__'])
// A path is the longest value expected. Every open reads the newest segment back, so one huge value costs every start
const MAX_VALUE = 4096
const eventName = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const segmentName = /^events-([1-9][0-9]*)\.jsonl$/
const ZERO = '0'.repeat(64)
const hex64 = /^[0-9a-f]{64}$/
// One file holds one batch of work: a new one starts once hetu has been idle this long. A file has no size cap
const IDLE_GAP_MS = 2 * 60 * 60 * 1000

export type Field = string | number | boolean | null
export type Verification = { ok: true } | { ok: false, seq: number }
// What open found before it wrote anything. lastSeq is 0 for a log with no good line, broken is set when open started
// a new segment because the newest one didn't check out. unlinked is a newest segment that checks out but doesn't follow
// the file before it, which was cut, edited or deleted after the rotation
export type Opened = { lastSeq: number, broken: { segment: number, brokenSeq: number } | null, unlinked: number | null }

// One file as history reads it. start says how its first line begins: zeros begin a chain, continues follows the last
// line of the file before, unlinked follows neither. null when there is no good first line to tell. breaks are the line
// numbers in the file, from 1, that don't check out: a break at line n means line n or the one before it changed, or
// lines between them were taken out. The lines after a break still check against each other
export type Segment = {
  segment: number
  lines: number
  first: number | null
  last: number | null
  start: 'zero' | 'continues' | 'unlinked' | null
  breaks: number[]
}

// first is the seq the segment began with and prev is the hash of its last line or zeros before the first line. start
// is the prev its first line carries and at the time of its last line, which decides when to rotate
type Tip = { segment: number, first: number, seq: number, prev: string, start: string, at: string | null }
// last and tip are the seq and the hash of the last line that checked out, at its time and end the byte after it.
// start is the prev of the first line. broken means a line after those did not check out
type Walk = {
  lines: number, first: number | null, last: number | null, tip: string, start: string | null, at: string | null,
  end: number, broken: boolean,
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function checkFields(event: unknown, fields: unknown): Record<string, Field> {
  if (typeof event !== 'string' || !eventName.test(event)) throw new Error('event name is not lowercase words joined by dots or dashes')
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new Error('fields is not an object')
  const checked: Record<string, Field> = {}
  // Each value is read once and the copy is what gets written, so a getter can't pass the check and then change
  for (const [name, value] of Object.entries(fields)) {
    if (refusedNames.has(name.toLowerCase())) throw new Error(`field name is not allowed: ${name}`)
    const plain = value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
    if (!plain) throw new Error(`field ${name} is not a string, a finite number, a boolean or null`)
    if (typeof value === 'string' && value.length > MAX_VALUE) throw new Error(`field ${name} is longer than ${MAX_VALUE}`)
    checked[name] = value
  }
  return checked
}

// A line that is exactly what append writes and follows the one before, otherwise null. With prev null any hash is taken
// as the first line's prev, the link to the file before is checked on its own
function lineSeq(line: Buffer, prev: string | null, last: number | null): { seq: number, prev: string, at: string } | null {
  try {
    // ignoreBOM keeps a byte order mark in the text, where the parser refuses it
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)
    const record = JSON.parse(text)
    // Other spacing or a repeated key would read differently to another parser and no later line covers the last one
    if (JSON.stringify(record) !== text) return null
    const { seq } = record
    const linked = prev === null ? typeof record.prev === 'string' && hex64.test(record.prev) : record.prev === prev
    if (!linked || typeof record.at !== 'string' || typeof record.event !== 'string') return null
    if (!Number.isSafeInteger(seq) || seq < 1) return null
    return last === null || seq === last + 1 ? { seq, prev: record.prev, at: record.at } : null
  } catch {
    return null
  }
}

// Takes lines from the top until one fails, comparing raw bytes. Appends go on from the last good line, so nothing
// after a failure is taken as the tip. start is the prev the first line must carry, null for any hash
function walk(bytes: Buffer, start: string | null): Walk {
  const walked: Walk = { lines: 0, first: null, last: null, tip: ZERO, start: null, at: null, end: 0, broken: false }
  while (walked.end < bytes.length) {
    const end = bytes.indexOf(0x0a, walked.end)
    // Bytes with no newline after them are a write that never finished
    const line = end === -1 ? null : bytes.subarray(walked.end, end)
    const read = line === null ? null : lineSeq(line, walked.lines === 0 ? start : walked.tip, walked.last)
    if (line === null || read === null) {
      walked.broken = true
      break
    }
    walked.lines++
    walked.first ??= read.seq
    walked.start ??= read.prev
    walked.last = read.seq
    walked.at = read.at
    walked.tip = sha256(line)
    walked.end = end + 1
  }
  return walked
}

// Reads a whole file for history, going on past a line that doesn't check out. end is the hash of the last whole line,
// whatever it holds, for the link to the file after
function scan(bytes: Buffer): Omit<Segment, 'segment' | 'start'> & { start: string | null, end: string | null } {
  const scanned = { lines: 0, first: null as number | null, last: null as number | null, start: null as string | null, end: null as string | null, breaks: [] as number[] }
  let at = 0
  let last: number | null = null
  while (at < bytes.length) {
    const end = bytes.indexOf(0x0a, at)
    if (end === -1) {
      scanned.breaks.push(scanned.lines + 1)
      break
    }
    const line = bytes.subarray(at, end)
    scanned.lines++
    const read = lineSeq(line, scanned.lines === 1 ? null : scanned.end, last)
    if (read === null) scanned.breaks.push(scanned.lines)
    else {
      if (scanned.lines === 1) scanned.start = read.prev
      scanned.first ??= read.seq
      scanned.last = read.seq
    }
    last = read?.seq ?? null
    scanned.end = sha256(line)
    at = end + 1
  }
  return scanned
}

// Append only, one line per event, each carrying the hash of the line before. The hash catches edits by a tool that
// doesn't know hetu, not one that rewrites the whole chain. Across a restart nothing covers the newest segment's last
// line, a cut at a line boundary or a deleted newest segment, the chain alone can't see those. The anchor for them is a
// copy kept off the machine, threat 11. A new segment starts on the first append after an idle gap and its first line
// carries the hash of the last line before, so the chain goes on
export class EventLog {
  private readonly dir: string
  private tail: Promise<unknown> = Promise.resolve()
  private tip: Tip | null = null
  // The tip of a line being written, kept when its write throws, since the line may still have landed. Looking again
  // then takes it as this process's own line, not as a change made while hetu ran
  private pending: Tip | null = null
  private ok = false
  private tried = false
  private quietUntil = 0
  private readonly retryAfterMs: number
  private readonly idleGapMs: number

  // retryAfterMs is how long appends are refused at once after a failure before one looks at the file again, so a
  // file that stays locked costs one wait in the retry and not one per event. idleGapMs decides when a new segment
  // starts
  constructor(stateDir: string, options: { retryAfterMs?: number, idleGapMs?: number } = {}) {
    this.dir = path.join(stateDir, 'events')
    this.retryAfterMs = options.retryAfterMs ?? 5000
    this.idleGapMs = options.idleGapMs ?? IDLE_GAP_MS
  }

  // False until open succeeds and after a failure until an append or open has looked at the file again
  get healthy(): boolean {
    return this.ok
  }

  private file(segment: number) {
    return path.join(this.dir, `events-${segment}.jsonl`)
  }

  // Overlapping appends would take the same seq and the same prev
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work)
    this.tail = run.catch(() => {})
    return run
  }

  // Continues the chain from the newest segment. A segment that doesn't check out is left as found and a new one
  // opens with a record of the break, so a damaged log never stops new events
  open(): Promise<Opened> {
    this.tried = true
    return this.serial(() => this.reopen())
  }

  private async reopen(): Promise<Opened> {
    this.ok = false
    try {
      await mkdir(this.dir, { recursive: true })
      const { tip, opened } = await this.resume(this.tip)
      this.tip = tip
      this.pending = null
      this.ok = true
      return opened
    } catch (err) {
      this.quietUntil = performance.now() + this.retryAfterMs
      throw err
    }
  }

  // before is the tip of the last line this process wrote, null at the first open. It is the anchor the chain alone
  // lacks: a newest segment that isn't the one written to, or ends at another seq or with another last line, was cut,
  // edited, deleted or put back while hetu ran. Every seq goes on from before, so none is used twice
  private async numbers(): Promise<number[]> {
    return (await readdir(this.dir))
      .flatMap(name => {
        const match = segmentName.exec(name)
        // Below the largest safe integer, so the segment after it is one the next open can see too
        return match && Number(match[1]) < Number.MAX_SAFE_INTEGER ? [Number(match[1])] : []
      })
      .sort((a, b) => a - b)
  }

  private async resume(before: Tip | null): Promise<{ tip: Tip, opened: Opened }> {
    const numbers = await this.numbers()
    const newest = numbers.at(-1)
    // Nothing written yet, or a first line that never landed and was removed, is still a new log
    if (newest === undefined && (before === null || before.seq < before.first)) {
      const tip = { segment: 1, first: 1, seq: 0, prev: ZERO, start: ZERO, at: null }
      return { tip, opened: { lastSeq: 0, broken: null, unlinked: null } }
    }

    const found = newest === undefined ? null : await this.read(newest)
    // An empty segment after the first means a crash before the record of a break was written
    if (newest !== undefined && found && !found.broken && (found.lines > 0 || newest === 1)) {
      const tip: Tip = {
        segment: newest, first: found.first ?? 1, seq: found.last ?? 0, prev: found.tip, start: found.start ?? ZERO, at: found.at,
      }
      const at = (other: Tip | null) => other !== null && tip.segment === other.segment && tip.seq === other.seq && tip.prev === other.prev
      if (at(before) || at(this.pending)) return { tip, opened: { lastSeq: tip.seq, broken: null, unlinked: null } }
      if (before === null) {
        // At the first open the newest segment is checked against the file before it once. A healthy rotation is the
        // only way a first line carries anything but zeros
        if (tip.start === ZERO || await this.follows(numbers.at(-2), tip)) {
          return { tip, opened: { lastSeq: tip.seq, broken: null, unlinked: null } }
        }
        const next = await this.write(tip, 'log.unlinked', { segment: newest })
        return { tip: next, opened: { lastSeq: tip.seq, broken: null, unlinked: newest } }
      }
    }
    // The last good seq, looking back through earlier segments when the newest has none
    let last = found?.last ?? null
    for (let i = numbers.length - 2; last === null && i >= 0; i--) last = (await this.read(numbers[i]))?.last ?? null
    // A last line this process wrote that is still there under another hash was edited, otherwise the first seq missing
    // or broken is the one after the last good line
    const edited = before !== null && newest === before.segment && found?.last === before.seq && found.tip !== before.prev
    const segment = Math.max(newest ?? 0, before?.segment ?? 0)
    const seq = Math.max(last ?? 0, before?.seq ?? 0)
    const broken = { segment, brokenSeq: edited ? before.seq : (last ?? 0) + 1 }
    const start = { segment: segment + 1, first: seq + 1, seq, prev: ZERO, start: ZERO, at: null }
    const tip = await this.write(start, 'log.chain-broken', broken)
    return { tip, opened: { lastSeq: seq, broken, unlinked: null } }
  }

  // Whether the segment before checks out whole and ends on the line the newest one's first line points at. A file that
  // can't be read for a lock or a permission says nothing about the chain, so the link counts as kept until next open
  private async follows(before: number | undefined, tip: Tip): Promise<boolean> {
    if (before === undefined) return false
    let found: Walk | null
    try {
      found = await this.read(before)
    } catch {
      return true
    }
    return found !== null && !found.broken && found.tip === tip.start && found.last === tip.first - 1
  }

  // A folder in a segment's place counts as broken. Any other read error is a lock or a permission and says nothing
  // about the chain, so it fails open instead of starting a segment that would reuse the seqs the file holds
  private async read(segment: number): Promise<Walk | null> {
    const file = this.file(segment)
    let bytes: Buffer
    try {
      bytes = await retried(() => readFile(file), file, 'read')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EISDIR' || (await stat(file).catch(() => null))?.isDirectory()) return null
      throw err
    }
    return walk(bytes, null)
  }

  // A segment with lines in it is left for a new one once the clock has moved past the idle gap since its last line.
  // The clock only picks the file, the chain doesn't depend on it
  private rotates(tip: Tip, at: string): boolean {
    if (tip.seq < tip.first || tip.at === null) return false
    return Date.parse(at) - Date.parse(tip.at) >= this.idleGapMs
  }

  // Gives back the tip after the line is on disk, so a failed write leaves the old one as it was
  private async write(tip: Tip, event: string, fields: Record<string, Field>): Promise<Tip> {
    const seq = tip.seq + 1
    const at = new Date().toISOString()
    const line = JSON.stringify({ seq, prev: tip.prev, at, event, ...fields })
    // The line is the same in either file, a rotation only moves where it goes
    const into = this.rotates(tip, at)
      ? { segment: tip.segment + 1, first: seq, seq: tip.seq, prev: tip.prev, start: tip.prev, at: tip.at }
      : tip
    // Nothing is written before the file opens, so a lock there is safe to wait out
    const file = this.file(into.segment)
    const next = { ...into, seq, prev: sha256(line), at }
    this.pending = next
    await writable(file)
    const handle = await retried(() => open(file, 'a'), file)
    try {
      await handle.writeFile(`${line}\n`)
      await handle.sync()
    } catch (err) {
      // A new segment whose first line never landed is removed, or each failed retry on a full disk leaves another
      // empty segment behind and the next open blames the wrong one
      const empty = seq === into.first && (await handle.stat().catch(() => null))?.size === 0
      await handle.close().catch(() => {})
      if (empty) await rm(file, { force: true }).catch(() => {})
      throw err
    }
    await handle.close()
    // The segment's first line made the file, which is only on disk once its folder is
    if (seq === into.first) await syncDir(this.dir)
    this.pending = null
    return next
  }

  async append(event: string, fields: Record<string, Field> = {}): Promise<void> {
    const checked = checkFields(event, fields)
    await this.serial(async () => {
      // After a failed open or write the file is looked at again, so a lock that has passed doesn't keep the log off.
      // A half written line then reads as a break. Until retryAfterMs has passed appends are refused at once
      if (!this.ok && this.tried && performance.now() >= this.quietUntil) await this.reopen()
      if (!this.ok || this.tip === null) throw new Error('event log is not healthy')
      try {
        this.tip = await this.write(this.tip, event, checked)
      } catch (err) {
        // A half written line may be on disk, so nothing more is added until the file has been looked at again
        this.ok = false
        this.quietUntil = performance.now() + this.retryAfterMs
        throw err
      }
    })
  }

  // The current segment only. The last line written in this process is checked too, since no later line covers it
  // and a cut tail or an edited last line would otherwise pass
  verify(): Promise<Verification> {
    return this.serial(async () => {
      const tip = this.tip
      if (tip === null) throw new Error('event log is not open')
      let bytes = Buffer.alloc(0)
      try {
        const file = this.file(tip.segment)
        bytes = await retried(() => readFile(file), file, 'read')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      const walked = walk(bytes, tip.start)
      const last = walked.last ?? tip.first - 1
      if (walked.broken) return { ok: false, seq: last + 1 }
      if (last !== tip.seq) return { ok: false, seq: Math.min(last, tip.seq) + 1 }
      if (walked.tip !== tip.prev) return { ok: false, seq: tip.seq }
      return { ok: true }
    })
  }

  // Every segment in order, each read whole. Checking a file as it is read costs little next to parsing it, so history
  // is checked where it is used and not by a separate pass. A chain runs from a zero start through the files that
  // continue it and a break ends it. Reads wait for appends called before them, so no line is read half written
  history(): Promise<Segment[]> {
    return this.serial(async () => {
      let numbers: number[]
      try {
        numbers = await this.numbers()
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const segments: Segment[] = []
      let before: { last: number | null, end: string | null } | null = null
      for (const segment of numbers) {
        const file = this.file(segment)
        let bytes: Buffer
        try {
          bytes = await retried(() => readFile(file), file, 'read')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EISDIR') throw err
          segments.push({ segment, lines: 0, first: null, last: null, start: null, breaks: [1] })
          before = null
          continue
        }
        const { start, end, ...scanned } = scan(bytes)
        const follows = before !== null && before.end === start && (before.last === null || scanned.first === null || scanned.first === before.last + 1)
        const kind = start === null ? null : start === ZERO ? 'zero' : follows ? 'continues' : 'unlinked'
        segments.push({ segment, ...scanned, start: kind })
        before = { last: scanned.last, end }
      }
      return segments
    })
  }
}
