import type { MessagePortMain } from 'electron'
import { describe, expect, it } from 'vitest'
import { type Renderer, WorkerRenderer, WorkerRenderers } from '../backend/runtime/workers.ts'

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

  post(channel: 'hetu:start' | 'hetu:terminate' | 'hetu:limits', message: unknown, ports: MessagePortMain[] = []): void {
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

const LIMITS = { messagesPerSecond: 1000, floodFactor: 10, floodMs: 5000, bytesPerSecond: 100, resultBytes: 1 }

function runtime(endingMs = 1000) {
  const renderers: FakeRenderer[] = []
  const records: { event: string, fields: Record<string, unknown> }[] = []
  const cutoffs: unknown[][] = []
  const samples: unknown[] = []
  const workers = new WorkerRenderer({
    open: () => {
      const renderer = new FakeRenderer()
      renderers.push(renderer)
      return renderer
    },
    record: (event, fields) => records.push({ event, fields }),
    limits: id => ({ ...LIMITS, resultBytes: id.length }),
    cutoff: (id, incarnation, reason) => cutoffs.push([id, incarnation, reason]),
    sample: sample => samples.push(sample),
    endingMs,
  })
  return { workers, renderers, records, cutoffs, samples }
}

const start = (id = 'search', incarnation = 1) => {
  const port = new FakePort()
  return { start: { id, incarnation, code: Buffer.from(`// ${id}`), port: port as unknown as MessagePortMain, drawer: false }, port }
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
    // Its hidden window goes with it, so a run doesn't gather dead windows
    expect(renderers[0].destroyed).toBe(true)
    workers.start(queuedBehind.start)
    expect(renderers).toHaveLength(2)
    expect(starts(renderers[1])).toEqual([])
    renderers[1].says({ kind: 'ready' })
    expect(starts(renderers[1]).map(post => (post.message as { id: string }).id)).toEqual(['files'])
  })

  it('names a plugin ended just before the renderer died, since its port closes first and the loader ends it then', async () => {
    const { workers, renderers, records } = runtime(40)
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

  it('hands the watchdog a running worker\'s errors and drops and ignores anything else the page says', () => {
    const { workers, renderers, records, samples } = runtime()
    workers.start(start('search').start)
    renderers[0].says({ kind: 'ready' })
    const caller = { kind: 'plugin', id: 'search', half: 'worker', incarnation: 1 }
    renderers[0].says({ kind: 'errors', id: 'search', incarnation: 1, count: 3 })
    renderers[0].says({ kind: 'dropped', id: 'search', incarnation: 1, count: 7 })
    renderers[0].says({ kind: 'errors', id: 'search', incarnation: 2, count: 3 })
    renderers[0].says({ kind: 'errors', id: 'search', incarnation: 1, count: -1 })
    renderers[0].says({ kind: 'dropped', id: 'git', incarnation: 1, count: 1 })
    renderers[0].says({ kind: 'other' })
    renderers[0].says(null)
    expect(samples).toEqual([{ kind: 'errors', caller, count: 3 }, { kind: 'dropped', caller, count: 7 }])
    expect(records).toEqual([])
  })

  it('sends a plugin\'s limits again to each of its running workers when they change', () => {
    const { workers, renderers } = runtime()
    workers.start(start('search').start)
    workers.start(start('git').start)
    renderers[0].says({ kind: 'ready' })
    workers.limited('search')
    workers.limited('files')
    expect(renderers[0].posted.filter(post => post.channel === 'hetu:limits')).toEqual([
      { channel: 'hetu:limits', message: { id: 'search', incarnation: 1, limits: { ...LIMITS, resultBytes: 6 } }, ports: [] },
    ])
  })

  it('hands a cutoff from the page to the loader and the watchdog once, for a running worker, and has nothing left to end', () => {
    const { workers, renderers, cutoffs, samples } = runtime()
    workers.start(start('search').start)
    renderers[0].says({ kind: 'ready' })
    renderers[0].says({ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'other' })
    renderers[0].says({ kind: 'cutoff', id: 'git', incarnation: 1, reason: 'flood' })
    expect(cutoffs).toEqual([])
    renderers[0].says({ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'malformed' })
    renderers[0].says({ kind: 'cutoff', id: 'search', incarnation: 1, reason: 'flood' })
    expect(cutoffs).toEqual([['search', 1, 'malformed']])
    expect(samples).toEqual([{ kind: 'cutoff', caller: { kind: 'plugin', id: 'search', half: 'worker', incarnation: 1 }, reason: 'malformed' }])
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

describe('a renderer per community plugin', () => {
  function routed(idleMs = 20) {
    const made: { group: string, workers: WorkerRenderer, renderers: FakeRenderer[] }[] = []
    const records: { event: string, fields: Record<string, unknown> }[] = []
    const router = new WorkerRenderers(group => {
      const renderers: FakeRenderer[] = []
      const workers = new WorkerRenderer({
        open: () => {
          const renderer = new FakeRenderer()
          renderers.push(renderer)
          return renderer
        },
        record: (event, fields) => records.push({ event, fields }),
        limits: () => LIMITS,
        cutoff: () => {},
        sample: () => {},
      })
      made.push({ group, workers, renderers })
      return workers
    }, idleMs)
    return { router, made, records }
  }

  const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('gives each community plugin a renderer of its own and the first-party plugins one between them', () => {
    const { router, made } = routed()
    for (const id of ['search', 'git', 'hello', 'notes']) router.start(start(id).start)
    expect(made.map(group => group.group)).toEqual(['first-party', 'hello', 'notes'])
    expect(made.map(group => group.renderers.length)).toEqual([1, 1, 1])
  })

  it('closes a community plugin\'s renderer a moment after it holds nothing, and keeps the first-party one', async () => {
    const { router, made } = routed()
    router.start(start('hello').start)
    router.start(start('search').start)
    for (const group of made) group.renderers[0].says({ kind: 'ready' })
    router.terminate('hello', 1)
    router.terminate('search', 1)
    expect(made.map(group => group.renderers[0].destroyed)).toEqual([false, false])
    await later(40)
    expect(made.map(group => group.renderers[0].destroyed)).toEqual([true, false])
    // The next start of that plugin opens a new one
    router.start(start('hello', 2).start)
    expect(made.map(group => group.group)).toEqual(['hello', 'first-party', 'hello'])
  })

  it('records a renderer that died just as its last plugin ended, since the loader ends the plugin when its port closes', async () => {
    const { router, made, records } = routed()
    router.start(start('hello').start)
    made[0].renderers[0].says({ kind: 'ready' })
    router.terminate('hello', 1)
    made[0].renderers[0].dies('crashed')
    expect(records).toEqual([{ event: 'renderer.gone', fields: { reason: 'crashed', plugins: 'hello' } }])
  })

  it('keeps an emptied renderer that gets a start before it closes', async () => {
    const { router, made } = routed()
    router.start(start('hello').start)
    made[0].renderers[0].says({ kind: 'ready' })
    router.terminate('hello', 1)
    router.start(start('hello', 2).start)
    await later(40)
    expect(made).toHaveLength(1)
    expect(made[0].renderers[0].destroyed).toBe(false)
  })

  it('sends a lowered limit to the plugin\'s own renderer and closes every renderer at the end', () => {
    const { router, made } = routed()
    router.start(start('hello').start)
    router.start(start('search').start)
    for (const group of made) group.renderers[0].says({ kind: 'ready' })
    router.limited('hello')
    expect(made.map(group => group.renderers[0].posted.filter(post => post.channel === 'hetu:limits').length)).toEqual([1, 0])
    router.close()
    expect(made.map(group => group.renderers[0].destroyed)).toEqual([true, true])
  })
})
