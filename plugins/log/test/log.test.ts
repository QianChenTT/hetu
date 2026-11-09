import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Call } from 'hetu-core/api/slots.ts'
import type { AuditHandle, AuditRecord } from 'hetu-core/api/slots.ts'
import { BATCH, createLog, PULL_MS } from '../src/log.ts'

afterEach(() => {
  vi.useRealTimers()
})

// A handle as the core lends it: next takes records not yet taken, append writes or throws while the log can't, ack
// lets go of the records taken up to seq
function lent() {
  const waiting: AuditRecord[] = []
  const batches: number[][] = []
  const acks: number[] = []
  let seq = 0
  let taken = 0
  const state = { failing: false, hold: null as Promise<void> | null, nexts: 0 }
  const handle: AuditHandle = {
    next(max) {
      state.nexts++
      const out = waiting.slice(taken, taken + max)
      taken += out.length
      return out.map(record => ({ ...record }))
    },
    async append(batch) {
      if (state.hold !== null) await state.hold
      if (state.failing) throw new Error('the log can\'t write')
      batches.push(batch.map(record => record.seq))
    },
    ack(upTo) {
      acks.push(upTo)
    },
    history: async () => [{ segment: 1, lines: 3, first: 1, last: 3, start: 'zero', breaks: [] }],
    verify: async () => ({ ok: true }),
  }
  const push = (count: number) => {
    for (let i = 0; i < count; i++) {
      waiting.push({ seq: ++seq, at: 0, caller: { kind: 'window', role: 'editor', n: 0 }, root: { kind: 'window', role: 'editor', n: 0 }, action: 'a.b', code: null, ms: 1, gate: 'on', count: 1 })
    }
  }
  return { handle, push, batches, acks, state }
}

const call = (action: string): Call => ({ callId: 'c1', caller: { kind: 'window', role: 'editor', n: 0 }, action, args: null, deadline: Date.now() + 1000 })

describe('writing the records', () => {
  it('writes every waiting record in batches and acknowledges each batch once it is written', async () => {
    const log = createLog()
    const made = lent()
    log.role.attach(made.handle)
    made.push(BATCH * 2 + 10)
    await log.drain()
    expect(made.batches.map(batch => batch.length)).toEqual([BATCH, BATCH, 10])
    expect(made.acks).toEqual([BATCH, BATCH * 2, BATCH * 2 + 10])
  })

  it('keeps a batch the log refused and writes it first once the log takes it again, acknowledging nothing before', async () => {
    const log = createLog()
    const made = lent()
    log.role.attach(made.handle)
    made.push(3)
    made.state.failing = true
    await expect(log.drain()).rejects.toThrow()
    expect(made.acks).toEqual([])
    made.push(2)
    made.state.failing = false
    await log.drain()
    expect(made.batches).toEqual([[1, 2, 3], [4, 5]])
    expect(made.acks).toEqual([3, 5])
  })

  it('pulls on its own once started, skips a pull while one is still writing, and drains once more at stop', async () => {
    vi.useFakeTimers()
    const log = createLog()
    const made = lent()
    log.role.attach(made.handle)
    log.start()
    made.push(2)
    await vi.advanceTimersByTimeAsync(PULL_MS)
    expect(made.batches).toEqual([[1, 2]])
    let release!: () => void
    made.state.hold = new Promise(resolve => {
      release = resolve
    })
    made.push(1)
    await vi.advanceTimersByTimeAsync(PULL_MS * 5)
    release()
    made.state.hold = null
    await vi.advanceTimersByTimeAsync(0)
    expect(made.batches).toEqual([[1, 2], [3]])
    // Two looks per pull that wrote something, so the pulls skipped while one wrote never ran
    expect(made.state.nexts).toBe(4)
    made.push(1)
    await log.stop()
    expect(made.batches).toEqual([[1, 2], [3], [4]])
    made.push(1)
    await vi.advanceTimersByTimeAsync(PULL_MS * 3)
    expect(made.batches).toHaveLength(3)
  })

  it('does nothing before it holds a handle', async () => {
    const log = createLog()
    await log.drain()
    await expect(log.provider.perform(call('log.history'), { scope: {} })).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('reading the log', () => {
  it('serves log.history and log.verify through its handle', async () => {
    const log = createLog()
    log.role.attach(lent().handle)
    const prepared = await log.provider.prepare(call('log.history'))
    expect(prepared).toEqual({ scope: {} })
    expect(await log.provider.perform(call('log.history'), { scope: {} })).toEqual([{ segment: 1, lines: 3, first: 1, last: 3, start: 'zero', breaks: [] }])
    expect(await log.provider.perform(call('log.verify'), { scope: {} })).toEqual({ ok: true })
    await expect(log.provider.perform(call('log.other'), { scope: {} })).rejects.toMatchObject({ code: 'not-found' })
  })
})
