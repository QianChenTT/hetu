import type { MessagePortMain } from 'electron'
import { describe, expect, it } from 'vitest'
import { type Renderer, WorkerRenderer } from '../backend/runtime/workers.ts'

class FakePort {
  closed = false
  close(): void {
    this.closed = true
  }
}

// The hidden renderer as the runtime sees it: what was posted to its page, and the page and the process to drive
class FakeRenderer implements Renderer {
  posted: { channel: string, message: unknown, ports: unknown[] }[] = []
  destroyed = false
  private page: ((message: unknown) => void) | null = null
  private gone: ((reason: string) => void) | null = null

  post(channel: 'hetu:start' | 'hetu:terminate', message: unknown, ports: MessagePortMain[] = []): void {
    this.posted.push({ channel, message, ports })
  }

  onPage(listener: (message: unknown) => void): void {
    this.page = listener
  }

  onGone(listener: (reason: string) => void): void {
    this.gone = listener
  }

  destroy(): void {
    this.destroyed = true
  }

  says(message: unknown): void {
    this.page?.(message)
  }

  dies(reason: string): void {
    this.gone?.(reason)
  }
}

const LIMITS = { messagesPerSecond: 1000, floodFactor: 10, floodMs: 5000, textPerSecond: 100, resultBytes: 1 }

function runtime(readyMs = 1000, endingMs = 1000) {
  const renderers: FakeRenderer[] = []
  const records: { event: string, fields: Record<string, unknown> }[] = []
  const cutoffs: unknown[][] = []
  const workers = new WorkerRenderer({
    open: () => {
      const renderer = new FakeRenderer()
      renderers.push(renderer)
      return renderer
    },
    record: (event, fields) => records.push({ event, fields }),
    limits: id => ({ ...LIMITS, resultBytes: id.length }),
    cutoff: (id, incarnation, reason) => cutoffs.push([id, incarnation, reason]),
    readyMs,
    endingMs,
  })
  return { workers, renderers, records, cutoffs }
}

const start = (id = 'search', incarnation = 1) => {
  const port = new FakePort()
  return { start: { id, incarnation, code: Buffer.from(`// ${id}`), port: port as unknown as MessagePortMain }, port }
}

const starts = (renderer: FakeRenderer) => renderer.posted.filter(post => post.channel === 'hetu:start')

describe('the hidden renderer for workers', () => {
  it('opens one renderer and holds starts until its page says ready, then sends each with its port', () => {
    const { workers, renderers } = runtime()
    const first = start('search')
    const second = start('git')
    workers.start(first.start)
    workers.start(second.start)
    expect(renderers).toHaveLength(1)
    expect(starts(renderers[0])).toEqual([])
    renderers[0].says({ kind: 'ready' })
    expect(starts(renderers[0])).toEqual([
      { channel: 'hetu:start', message: { id: 'search', incarnation: 1, code: Buffer.from('// search'), limits: { ...LIMITS, resultBytes: 6 } }, ports: [first.start.port] },
      { channel: 'hetu:start', message: { id: 'git', incarnation: 1, code: Buffer.from('// git'), limits: { ...LIMITS, resultBytes: 3 } }, ports: [second.start.port] },
    ])
  })

  it('resolves whenReady once the page says ready, or false once readyMs passed', async () => {
    const ready = runtime()
    const waiting = ready.workers.whenReady()
    ready.renderers[0].says({ kind: 'ready' })
    expect(await waiting).toBe(true)
    const late = runtime(30)
    expect(await late.workers.whenReady()).toBe(false)
    expect(late.records).toEqual([{ event: 'renderer.late', fields: { ms: 30 } }])
  })

  it('ends a running worker through the page and drops a queued one, closing its port', () => {
    const { workers, renderers } = runtime()
    const queued = start('git')
    workers.start(queued.start)
    workers.terminate('git', 1)
    expect(queued.port.closed).toBe(true)
    renderers[0].says({ kind: 'ready' })
    expect(starts(renderers[0])).toEqual([])
    workers.start(start('search').start)
    workers.terminate('search', 1)
    expect(renderers[0].posted.at(-1)).toEqual({ channel: 'hetu:terminate', message: { id: 'search', incarnation: 1 }, ports: [] })
  })

  it('records a renderer gone with the plugins it held and opens a new one for the next start', () => {
    const { workers, renderers, records } = runtime()
    workers.start(start('search').start)
    renderers[0].says({ kind: 'ready' })
    workers.start(start('git').start)
    const queuedBehind = start('files')
    renderers[0].dies('crashed')
    expect(records).toEqual([{ event: 'renderer.gone', fields: { reason: 'crashed', plugins: 'git,search' } }])
    workers.start(queuedBehind.start)
    expect(renderers).toHaveLength(2)
    expect(starts(renderers[1])).toEqual([])
    renderers[1].says({ kind: 'ready' })
    expect(starts(renderers[1]).map(post => (post.message as { id: string }).id)).toEqual(['files'])
  })

  it('names a plugin ended just before the renderer died, since its port closes first and the loader ends it then', async () => {
    const { workers, renderers, records } = runtime(1000, 40)
    workers.start(start('search').start)
    workers.start(start('git').start)
    renderers[0].says({ kind: 'ready' })
    workers.terminate('search', 1)
    renderers[0].dies('crashed')
    expect(records).toEqual([{ event: 'renderer.gone', fields: { reason: 'crashed', plugins: 'git,search' } }])
    workers.start(start('files').start)
    renderers[1].says({ kind: 'ready' })
    workers.terminate('files', 1)
    await new Promise(resolve => setTimeout(resolve, 80))
    renderers[1].dies('crashed')
    expect(records.at(-1)).toEqual({ event: 'renderer.gone', fields: { reason: 'crashed', plugins: '' } })
  })

  it('closes the ports of starts still queued when the renderer dies before its page was ready', () => {
    const { workers, renderers } = runtime()
    const queued = start('search')
    workers.start(queued.start)
    renderers[0].dies('launch-failed')
    expect(queued.port.closed).toBe(true)
  })

  it('records a running worker\'s error count and ignores anything else the page says', () => {
    const { workers, renderers, records } = runtime()
    workers.start(start('search').start)
    renderers[0].says({ kind: 'ready' })
    renderers[0].says({ kind: 'errors', id: 'search', incarnation: 1, count: 3 })
    renderers[0].says({ kind: 'errors', id: 'search', incarnation: 2, count: 3 })
    renderers[0].says({ kind: 'errors', id: 'search', incarnation: 1, count: -1 })
    renderers[0].says({ kind: 'errors', id: 'git', incarnation: 1, count: 1 })
    renderers[0].says({ kind: 'other' })
    renderers[0].says(null)
    expect(records).toEqual([{ event: 'worker.errors', fields: { plugin: 'search', incarnation: 1, count: 3 } }])
  })

  it('hands a cutoff from the page to the loader once, for a running worker, and has nothing left to end', () => {
    const { workers, renderers, cutoffs } = runtime()
    workers.start(start('search').start)
    renderers[0].says({ kind: 'ready' })
    renderers[0].says({ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'other' })
    renderers[0].says({ kind: 'cutoff', id: 'git', incarnation: 1, reason: 'flood' })
    expect(cutoffs).toEqual([])
    renderers[0].says({ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'malformed' })
    renderers[0].says({ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'flood' })
    expect(cutoffs).toEqual([['search', 1, 'malformed']])
    workers.terminate('search', 1)
    expect(renderers[0].posted.filter(post => post.channel === 'hetu:terminate')).toEqual([])
  })

  it('ends the renderer at close and refuses later starts by closing their ports', () => {
    const { workers, renderers } = runtime()
    workers.start(start('search').start)
    workers.close()
    expect(renderers[0].destroyed).toBe(true)
    const late = start('git')
    workers.start(late.start)
    expect(late.port.closed).toBe(true)
    expect(renderers).toHaveLength(1)
  })
})
