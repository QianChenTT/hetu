import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import type { AuditRecord } from '../api/slots.ts'
import { AuditWriter, auditFields, type AuditLog } from '../backend/carrier/audit.ts'
import { AuditQueue } from '../backend/carrier/records.ts'
import { EventLog } from '../lib/event-log.ts'

const alpha: Caller = { kind: 'plugin', id: 'alpha', half: 'worker', incarnation: 2 }
const editor: Caller = { kind: 'window', role: 'editor', n: 3 }
const AT = Date.parse('2026-11-07T12:00:00.000Z')

let dir: string
let log: EventLog
let queue: AuditQueue

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-audit-'))
  log = new EventLog(dir)
  await log.open()
  queue = new AuditQueue(() => 100)
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

function push(action: string, more: Partial<AuditRecord> = {}) {
  queue.push({ at: AT, caller: alpha, root: alpha, action, scope: { paths: ['notes/a.md'] }, code: null, ms: 4, gate: 'on', ...more }, false, AT)
}

const lines = async () => (await readFile(path.join(dir, 'events', 'events-1.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))

// A log in front of the real one that fails while failing is set, down or refusing as healthy says
function flaky(healthy: boolean | undefined) {
  const ids: (string | undefined)[] = []
  const sizes: number[] = []
  const state = { failing: true }
  const front: AuditLog = {
    appendMany: async (batch, options) => {
      ids.push(options?.id)
      sizes.push(batch.length)
      if (state.failing) throw new Error('EIO')
      await log.appendMany(batch, options)
    },
    history: () => log.history(),
    verify: () => log.verify(),
    ...(healthy !== undefined ? { healthy } : {}),
  }
  return { front, ids, sizes, state }
}

describe('a record as log fields', () => {
  // record is the queue's seq, which a reader uses to tell a record written twice from two calls, in this run's lines
  it('names the record, the caller and root as text, the scope as a JSON list and the time of the call apart from the line\'s', () => {
    const record: AuditRecord = {
      seq: 9, at: AT, caller: editor, onBehalf: 'agent', root: alpha, action: 'luoshu.read', scope: { paths: ['a.md', 'b c.md'] },
      code: 'not-granted', ms: 12, gate: 'off', count: 3,
    }
    expect(auditFields(record)).toEqual({
      record: 9, caller: 'window/editor#3', onBehalf: 'agent', root: 'alpha/worker#2', action: 'luoshu.read', paths: '["a.md","b c.md"]',
      pathCount: 2, code: 'not-granted', ms: 12, gate: 'off', count: 3, calledAt: '2026-11-07T12:00:00.000Z',
    })
    expect(auditFields({ ...record, scope: { target: 'search' }, onBehalf: undefined, code: null })).toMatchObject({ target: 'search', code: null })
    expect(auditFields({ ...record, scope: { topics: ['luoshu.changed'] } })).toMatchObject({ topics: '["luoshu.changed"]', topicCount: 1 })
  })

  it('keeps each value within 4096 characters, listing the paths that fit with how many there were', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `${'folder'.repeat(30)}/${i}.md`)
    const fields = auditFields({ seq: 1, at: AT, caller: alpha, root: alpha, action: 'leases.acquire', scope: { paths }, code: null, ms: 1, gate: 'on', count: 1 })
    expect((fields.paths as string).length).toBeLessThanOrEqual(4096)
    expect(JSON.parse(fields.paths as string)).toEqual(paths.slice(0, (JSON.parse(fields.paths as string) as string[]).length))
    expect(fields.pathCount).toBe(40)
    const long = auditFields({ seq: 1, at: AT, caller: alpha, onBehalf: 'x'.repeat(5000), root: alpha, action: 'a.b', code: null, ms: 1, gate: 'on', count: 1 })
    expect((long.onBehalf as string).length).toBe(4096)
  })
})

describe('the core\'s audit writer', () => {
  it('writes what the queue holds as audit.call lines in order, one batch under one id, and lets go of them once written', async () => {
    push('luoshu.read')
    push('luoshu.write')
    const ids: (string | undefined)[] = []
    const watched: AuditLog = {
      appendMany: (batch, options) => {
        ids.push(options?.id)
        return log.appendMany(batch, options)
      },
      history: () => log.history(),
      verify: () => log.verify(),
    }
    const writer = new AuditWriter(queue, watched)
    expect(await writer.write()).toBe('written')
    expect((await lines()).map(line => [line.event, line.action, line.record])).toEqual([
      ['audit.call', 'luoshu.read', 1], ['audit.call', 'luoshu.write', 2],
    ])
    expect(ids).toEqual(['audit:1-2'])
    expect(queue.size).toBe(0)
    expect(queue.oldest()).toBeNull()
    expect(await writer.write()).toBe('empty')
  })

  it('takes at most max records a batch', async () => {
    for (const n of [1, 2, 3, 4, 5]) push(`a.n${n}`)
    const { front, sizes, state } = flaky(true)
    state.failing = false
    const writer = new AuditWriter(queue, front, { max: 2 })
    await writer.flush()
    expect(sizes).toEqual([2, 2, 1])
    expect((await lines()).map(line => line.action)).toEqual(['a.n1', 'a.n2', 'a.n3', 'a.n4', 'a.n5'])
  })

  // A write can throw after its lines landed. The same batch under the same id lets the log write it once and any other
  // batch could hold a record that is already on disk
  it('after a failed append with the log down tries only that batch again under the same id, the records held meanwhile', async () => {
    push('a.one')
    push('a.two')
    const { front, ids, sizes, state } = flaky(false)
    const writer = new AuditWriter(queue, front)
    expect(await writer.write()).toBe('failed')
    push('a.three')
    expect(await writer.write()).toBe('failed')
    expect(queue.size).toBe(3)
    expect(queue.oldest()).not.toBeNull()
    state.failing = false
    expect(await writer.write()).toBe('written')
    expect(await writer.write()).toBe('written')
    expect(ids).toEqual(['audit:1-2', 'audit:1-2', 'audit:1-2', 'audit:3-3'])
    expect(sizes).toEqual([2, 2, 2, 1])
    expect((await lines()).map(line => line.action)).toEqual(['a.one', 'a.two', 'a.three'])
    expect(queue.size).toBe(0)
  })

  it('treats a log that names no health as down, so a failed batch is never let go unwritten', async () => {
    push('a.one')
    const { front, state } = flaky(undefined)
    const refused: number[] = []
    const writer = new AuditWriter(queue, front, { refused: count => refused.push(count) })
    expect(await writer.write()).toBe('failed')
    state.failing = false
    await writer.flush()
    expect(refused).toEqual([])
    expect((await lines()).map(line => line.action)).toEqual(['a.one'])
  })

  // A healthy log that refused a batch refused what it holds and trying it again would hold back every record after it
  it('lets go of a batch a healthy log refused, counts it and goes on with the next', async () => {
    push('a.one')
    push('a.two')
    const { front, state } = flaky(true)
    const refused: number[] = []
    const writer = new AuditWriter(queue, front, { max: 1, refused: count => refused.push(count) })
    expect(await writer.write()).toBe('dropped')
    expect(refused).toEqual([1])
    state.failing = false
    expect(await writer.write()).toBe('written')
    expect((await lines()).map(line => line.action)).toEqual(['a.two'])
    expect(queue.size).toBe(0)
  })

  it('keeps writing when the count of a refused batch throws', async () => {
    push('a.one')
    const { front } = flaky(true)
    const writer = new AuditWriter(queue, front, { refused: () => { throw new Error('boom') } })
    expect(await writer.write()).toBe('dropped')
    expect(queue.size).toBe(0)
  })

  it('writes one batch at a time, a write asked for meanwhile waiting on the one under way', async () => {
    push('a.one')
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const sizes: number[] = []
    const slow: AuditLog = {
      appendMany: async (batch, options) => {
        sizes.push(batch.length)
        await held
        await log.appendMany(batch, options)
      },
      history: () => log.history(),
      verify: () => log.verify(),
    }
    const writer = new AuditWriter(queue, slow)
    const first = writer.write()
    push('a.two')
    const second = writer.write()
    release()
    expect(await first).toBe('written')
    expect(await second).toBe('written')
    expect(sizes).toEqual([1])
    await writer.flush()
    expect(sizes).toEqual([1, 1])
    expect((await lines()).map(line => line.action)).toEqual(['a.one', 'a.two'])
  })

  it('flushes until the queue is empty and stops at a failure without throwing', async () => {
    for (const n of [1, 2, 3]) push(`a.n${n}`)
    const { front, sizes, state } = flaky(false)
    const writer = new AuditWriter(queue, front, { max: 1 })
    await expect(writer.flush()).resolves.toBeUndefined()
    expect(sizes).toEqual([1])
    state.failing = false
    await writer.flush()
    expect((await lines()).map(line => line.action)).toEqual(['a.n1', 'a.n2', 'a.n3'])
  })

  it('writes every everyMs once started and stops with stop, a flush still writing after it', async () => {
    vi.useFakeTimers()
    const batches: string[][] = []
    const quick: AuditLog = {
      appendMany: async batch => {
        batches.push(batch.map(({ fields }) => String(fields?.action)))
      },
      history: () => log.history(),
      verify: () => log.verify(),
    }
    const writer = new AuditWriter(queue, quick, { everyMs: 100 })
    writer.start()
    push('a.one')
    push('a.two')
    await vi.advanceTimersByTimeAsync(99)
    expect(batches).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(batches).toEqual([['a.one', 'a.two']])
    push('a.three')
    writer.stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(batches).toHaveLength(1)
    await writer.flush()
    expect(batches).toEqual([['a.one', 'a.two'], ['a.three']])
  })

  it('takes 256 records a batch every 100 ms by default', async () => {
    vi.useFakeTimers()
    const big = new AuditQueue(() => 1000)
    for (let n = 0; n < 300; n++) big.push({ at: AT, caller: alpha, root: alpha, action: 'a.b', code: null, ms: 1, gate: 'on' }, false, AT)
    const sizes: number[] = []
    const quick: AuditLog = {
      appendMany: async batch => {
        sizes.push(batch.length)
      },
      history: () => log.history(),
      verify: () => log.verify(),
    }
    const writer = new AuditWriter(big, quick)
    writer.start()
    await vi.advanceTimersByTimeAsync(100)
    expect(sizes).toEqual([256])
    await vi.advanceTimersByTimeAsync(100)
    expect(sizes).toEqual([256, 44])
    writer.stop()
  })
})
