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

export type Field = string | number | boolean | null
export type Verification = { ok: true } | { ok: false, seq: number }
// What open found before it wrote anything. lastSeq is 0 for a log with no good line, broken is set when open started
// a new segment because the newest one didn't check out
export type Opened = { lastSeq: number, broken: { segment: number, brokenSeq: number } | null }

// first is the seq the segment began with and prev is the hash of its last line or zeros before the first line
type Tip = { segment: number, first: number, seq: number, prev: string }
// last and tip are the seq and the hash of the last line that checked out. broken means a line after those did not
type Walk = { lines: number, first: number | null, last: number | null, tip: string, broken: boolean }

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

// The seq of a line that is exactly what append writes and follows the one before, otherwise null
function lineSeq(line: Buffer, prev: string, last: number | null): number | null {
  try {
    // ignoreBOM keeps a byte order mark in the text, where the parser refuses it
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)
    const record = JSON.parse(text)
    // Other spacing or a repeated key would read differently to another parser and no later line covers the last one
    if (JSON.stringify(record) !== text) return null
    const { seq } = record
    if (record.prev !== prev || typeof record.at !== 'string' || typeof record.event !== 'string') return null
    if (!Number.isSafeInteger(seq) || seq < 1) return null
    return last === null || seq === last + 1 ? seq : null
  } catch {
    return null
  }
}

// Takes lines from the top until one fails, comparing raw bytes. Nothing after a failure is trusted
function walk(bytes: Buffer): Walk {
  const walked: Walk = { lines: 0, first: null, last: null, tip: ZERO, broken: false }
  let start = 0
  while (start < bytes.length) {
    const end = bytes.indexOf(0x0a, start)
    // Bytes with no newline after them are a write that never finished
    const line = end === -1 ? null : bytes.subarray(start, end)
    const seq = line === null ? null : lineSeq(line, walked.tip, walked.last)
    if (line === null || seq === null) {
      walked.broken = true
      break
    }
    walked.lines++
    walked.first ??= seq
    walked.last = seq
    walked.tip = sha256(line)
    start = end + 1
  }
  return walked
}

// Append only, one line per event, each carrying the hash of the line before. The hash catches edits by a tool that
// doesn't know hetu, not one that rewrites the whole chain. Across a restart nothing covers the newest segment's last
// line, a cut at a line boundary or a deleted newest segment, the chain alone can't see those. The anchor for them is a
// copy kept off the machine, row 11
export class EventLog {
  private readonly dir: string
  private tail: Promise<unknown> = Promise.resolve()
  private tip: Tip | null = null
  private ok = false
  private tried = false
  private quietUntil = 0
  private readonly retryAfterMs: number

  // retryAfterMs is how long appends are refused at once after a failure before one looks at the file again, so a
  // file that stays locked costs one wait in the retry and not one per event
  constructor(stateDir: string, options: { retryAfterMs?: number } = {}) {
    this.dir = path.join(stateDir, 'events')
    this.retryAfterMs = options.retryAfterMs ?? 5000
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
  private async resume(before: Tip | null): Promise<{ tip: Tip, opened: Opened }> {
    const numbers = (await readdir(this.dir))
      .flatMap(name => {
        const match = segmentName.exec(name)
        // Below the largest safe integer, so the segment after it is one the next open can see too
        return match && Number(match[1]) < Number.MAX_SAFE_INTEGER ? [Number(match[1])] : []
      })
      .sort((a, b) => a - b)
    const newest = numbers.at(-1)
    if (newest === undefined && before === null) return { tip: { segment: 1, first: 1, seq: 0, prev: ZERO }, opened: { lastSeq: 0, broken: null } }

    const found = newest === undefined ? null : await this.read(newest)
    // An empty segment after the first means a crash before the record of a break was written
    if (newest !== undefined && found && !found.broken && (found.lines > 0 || newest === 1)) {
      const tip = { segment: newest, first: found.first ?? 1, seq: found.last ?? 0, prev: found.tip }
      const same = before === null || (tip.segment === before.segment && tip.seq === before.seq && tip.prev === before.prev)
      if (same) return { tip, opened: { lastSeq: tip.seq, broken: null } }
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
    const tip = await this.write({ segment: segment + 1, first: seq + 1, seq, prev: ZERO }, 'log.chain-broken', broken)
    return { tip, opened: { lastSeq: seq, broken } }
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
    return walk(bytes)
  }

  // Gives back the tip after the line is on disk, so a failed write leaves the old one as it was
  private async write(tip: Tip, event: string, fields: Record<string, Field>): Promise<Tip> {
    const seq = tip.seq + 1
    const line = JSON.stringify({ seq, prev: tip.prev, at: new Date().toISOString(), event, ...fields })
    // Nothing is written before the file opens, so a lock there is safe to wait out
    const file = this.file(tip.segment)
    await writable(file)
    const handle = await retried(() => open(file, 'a'), file)
    try {
      await handle.writeFile(`${line}\n`)
      await handle.sync()
    } catch (err) {
      // A new segment whose first line never landed is removed, or each failed retry on a full disk leaves another
      // empty segment behind and the next open blames the wrong one
      const empty = seq === tip.first && (await handle.stat().catch(() => null))?.size === 0
      await handle.close().catch(() => {})
      if (empty) await rm(file, { force: true }).catch(() => {})
      throw err
    }
    await handle.close()
    // The segment's first line made the file, which is only on disk once its folder is
    if (seq === tip.first) await syncDir(this.dir)
    return { ...tip, seq, prev: sha256(line) }
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
      const walked = walk(bytes)
      const last = walked.last ?? tip.first - 1
      if (walked.broken) return { ok: false, seq: last + 1 }
      if (last !== tip.seq) return { ok: false, seq: Math.min(last, tip.seq) + 1 }
      if (walked.tip !== tip.prev) return { ok: false, seq: tip.seq }
      return { ok: true }
    })
  }
}
