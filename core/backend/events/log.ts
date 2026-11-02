import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// Metadata only. A caller may hand over a field that sounds like note text by mistake, so those names are refused
// and the record's own names can't be overwritten
const refusedNames = new Set(['seq', 'prev', 'at', 'event', 'content', 'text', 'body', '__proto__'])
const eventName = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const segmentName = /^events-([1-9][0-9]*)\.jsonl$/
const ZERO = '0'.repeat(64)

export type Field = string | number | boolean | null
export type Verification = { ok: true } | { ok: false, seq: number }

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
// doesn't know hetu, not one that rewrites the whole chain
export class EventLog {
  private readonly dir: string
  private tail: Promise<unknown> = Promise.resolve()
  private tip: Tip | null = null
  private ok = false

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'events')
  }

  // False until open succeeds and after any failed write. Callers decide what to refuse meanwhile
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
  open(): Promise<void> {
    return this.serial(async () => {
      this.ok = false
      await mkdir(this.dir, { recursive: true })
      this.tip = await this.resume()
      this.ok = true
    })
  }

  private async resume(): Promise<Tip> {
    const numbers = (await readdir(this.dir))
      .flatMap(name => {
        const match = segmentName.exec(name)
        return match && Number.isSafeInteger(Number(match[1])) ? [Number(match[1])] : []
      })
      .sort((a, b) => a - b)
    const newest = numbers.at(-1)
    if (newest === undefined) return { segment: 1, first: 1, seq: 0, prev: ZERO }

    const found = await this.read(newest)
    // An empty segment after the first means a crash before the record of a break was written
    if (found && !found.broken && (found.lines > 0 || newest === 1)) {
      return { segment: newest, first: found.first ?? 1, seq: found.last ?? 0, prev: found.tip }
    }
    // The seq carries on from the last good line, looking back through earlier segments when the newest has none
    let last = found?.last ?? null
    for (let i = numbers.length - 2; last === null && i >= 0; i--) last = (await this.read(numbers[i]))?.last ?? null
    const seq = last ?? 0
    return this.write({ segment: newest + 1, first: seq + 1, seq, prev: ZERO }, 'log.chain-broken', { segment: newest, brokenSeq: seq + 1 })
  }

  // A segment that can't be read counts as broken
  private async read(segment: number): Promise<Walk | null> {
    try {
      return walk(await readFile(this.file(segment)))
    } catch {
      return null
    }
  }

  // Gives back the tip after the line is on disk, so a failed write leaves the old one as it was
  private async write(tip: Tip, event: string, fields: Record<string, Field>): Promise<Tip> {
    const seq = tip.seq + 1
    const line = JSON.stringify({ seq, prev: tip.prev, at: new Date().toISOString(), event, ...fields })
    const handle = await open(this.file(tip.segment), 'a')
    try {
      await handle.writeFile(`${line}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { ...tip, seq, prev: sha256(line) }
  }

  async append(event: string, fields: Record<string, Field> = {}): Promise<void> {
    const checked = checkFields(event, fields)
    await this.serial(async () => {
      if (!this.ok || this.tip === null) throw new Error('event log is not healthy')
      try {
        this.tip = await this.write(this.tip, event, checked)
      } catch (err) {
        // A half written line may be on disk, so nothing more is added until open has looked at the file again
        this.ok = false
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
        bytes = await readFile(this.file(tip.segment))
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
