import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import type { AuditRecord } from '../api/slots.ts'
import { auditFields, lendAudit, type AuditLog } from '../backend/carrier/audit.ts'
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
  await rm(dir, { recursive: true, force: true })
})

function push(action: string, more: Partial<AuditRecord> = {}) {
  queue.push({ at: AT, caller: alpha, root: alpha, action, scope: { paths: ['notes/a.md'] }, code: null, ms: 4, gate: 'on', ...more }, false, AT)
}

const lines = async () => (await readFile(path.join(dir, 'events', 'events-1.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))

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

describe('the audit handle', () => {
  it('writes the records it handed out as audit.call lines, the core\'s own copy of each, whatever the plugin did to its copy', async () => {
    push('luoshu.read')
    push('luoshu.write')
    const { handle } = lendAudit(queue, log)
    const taken = handle.next(10)
    expect(taken.map(record => record.action)).toEqual(['luoshu.read', 'luoshu.write'])
    taken[0].action = 'forged.action'
    await handle.append(taken)
    expect((await lines()).map(line => [line.event, line.action, line.caller])).toEqual([
      ['audit.call', 'luoshu.read', 'alpha/worker#2'], ['audit.call', 'luoshu.write', 'alpha/worker#2'],
    ])
    expect(await handle.verify()).toEqual({ ok: true })
    expect((await handle.history())[0]).toMatchObject({ segment: 1, lines: 2, breaks: [] })
  })

  it('writes only the records the plugin chose, and lets go of every record taken up to seq with ack', async () => {
    push('a.one')
    push('a.two')
    push('a.three')
    const { handle } = lendAudit(queue, log)
    const taken = handle.next(10)
    await handle.append([taken[1]])
    handle.ack(taken[2].seq)
    expect(queue.size).toBe(0)
    expect((await lines()).map(line => line.action)).toEqual(['a.two'])
    // Acknowledged, so no longer the plugin's to write
    await expect(handle.append([taken[0]])).rejects.toThrow()
  })

  it('refuses a batch holding a record it never handed out or one written already, writing none of it', async () => {
    push('a.one')
    push('a.two')
    const { handle } = lendAudit(queue, log)
    const [one, two] = handle.next(1).concat(handle.next(1))
    await handle.append([one])
    await expect(handle.append([two, one])).rejects.toThrow()
    await expect(handle.append([two, { ...two, seq: 99 }])).rejects.toThrow()
    await expect(handle.append([two, two])).rejects.toThrow()
    expect((await lines()).map(line => line.action)).toEqual(['a.one'])
    await handle.append([two])
    expect((await lines()).map(line => line.action)).toEqual(['a.one', 'a.two'])
  })

  it('refuses a record a batch still being written holds', async () => {
    push('a.one')
    const { handle } = lendAudit(queue, log)
    const [one] = handle.next(1)
    const first = handle.append([one])
    await expect(handle.append([one])).rejects.toThrow()
    await first
    expect((await lines()).map(line => line.action)).toEqual(['a.one'])
  })

  it('lets a batch the log refused be written again', async () => {
    push('a.one')
    const failing: AuditLog = { appendMany: async () => { throw new Error('disk full') }, history: () => log.history(), verify: () => log.verify() }
    const lent = lendAudit(queue, failing)
    const [one] = lent.handle.next(1)
    await expect(lent.handle.append([one])).rejects.toThrow('disk full')
    const again = lendAudit(queue, log)
    // A new lend hands out only what is next, so the same lend writes it once the log takes it
    expect(again.handle.next(1)).toEqual([])
    failing.appendMany = batch => log.appendMany(batch)
    await lent.handle.append([one])
    expect((await lines()).map(line => line.action)).toEqual(['a.one'])
  })

  it('throws from every method once revoked', async () => {
    push('a.one')
    const { handle, revoke } = lendAudit(queue, log)
    const [one] = handle.next(1)
    revoke()
    expect(() => handle.next(1)).toThrow()
    expect(() => handle.ack(one.seq)).toThrow()
    await expect(handle.append([one])).rejects.toThrow()
    await expect(handle.history()).rejects.toThrow()
    await expect(handle.verify()).rejects.toThrow()
    expect(queue.size).toBe(1)
  })

  it('takes a whole number of records from next, at most the queue\'s bound', () => {
    push('a.one')
    const { handle } = lendAudit(queue, log)
    expect(() => handle.next(1.5)).toThrow()
    expect(() => handle.next(-1)).toThrow()
    expect(handle.next(Number.MAX_SAFE_INTEGER)).toHaveLength(1)
  })

  // A write can throw after its lines landed. The same batch under the same id lets the log write it once, and any other
  // batch could hold a record that is already on disk
  it('names each batch to the log, and after a failed append takes only that batch again until it is written or acknowledged', async () => {
    push('a.one')
    push('a.two')
    push('a.three')
    const ids: (string | undefined)[] = []
    let failing = true
    const flaky: AuditLog = {
      appendMany: async (batch, options) => {
        ids.push(options?.id)
        if (failing) throw new Error('EIO')
        await log.appendMany(batch, options)
      },
      history: () => log.history(),
      verify: () => log.verify(),
    }
    const { handle } = lendAudit(queue, flaky)
    const [one, two, three] = handle.next(3)
    await expect(handle.append([one, two])).rejects.toThrow('EIO')
    await expect(handle.append([one])).rejects.toThrow()
    await expect(handle.append([three])).rejects.toThrow()
    failing = false
    await handle.append([one, two])
    expect(ids).toEqual([ids[0], ids[0]])
    expect(ids[0]).toEqual(expect.any(String))
    await handle.append([three])
    expect((await lines()).map(line => line.action)).toEqual(['a.one', 'a.two', 'a.three'])
  })

  it('lets a failed batch go once the log plugin acknowledges past it', async () => {
    push('a.one')
    push('a.two')
    let failing = true
    const flaky: AuditLog = {
      appendMany: async (batch, options) => {
        if (failing) throw new Error('EIO')
        await log.appendMany(batch, options)
      },
      history: () => log.history(),
      verify: () => log.verify(),
    }
    const { handle } = lendAudit(queue, flaky)
    const [one, two] = handle.next(2)
    await expect(handle.append([one])).rejects.toThrow('EIO')
    handle.ack(one.seq)
    failing = false
    await handle.append([two])
    expect((await lines()).map(line => line.action)).toEqual(['a.two'])
  })

  it('takes records in the order it handed them out, never one below a record already written', async () => {
    push('a.one')
    push('a.two')
    push('a.three')
    const { handle } = lendAudit(queue, log)
    const [one, two, three] = handle.next(3)
    await expect(handle.append([two, one])).rejects.toThrow()
    await handle.append([two])
    await expect(handle.append([one])).rejects.toThrow()
    await handle.append([three])
    expect((await lines()).map(line => line.record)).toEqual([two.seq, three.seq])
  })

  it('counts the records the log plugin acknowledges without writing', async () => {
    for (const action of ['a.one', 'a.two', 'a.three']) push(action)
    const skipped: number[] = []
    const { handle } = lendAudit(queue, log, count => { skipped.push(count) })
    const taken = handle.next(3)
    await handle.append([taken[1]])
    handle.ack(taken[2].seq)
    handle.ack(taken[2].seq)
    expect(skipped).toEqual([2])
  })
})
