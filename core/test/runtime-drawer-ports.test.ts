import { describe, expect, it } from 'vitest'
import { DrawerPorts, withDrawers } from '../backend/runtime/drawer-ports.ts'

function ports() {
  const made: { port1: string, port2: string }[] = []
  const toWorker: unknown[][] = []
  const toPage: unknown[][] = []
  const ended: unknown[][] = []
  const drawers = new DrawerPorts<string>({
    channel: () => {
      const pair = { port1: `w${made.length}`, port2: `p${made.length}` }
      made.push(pair)
      return pair
    },
    toWorker: (id, incarnation, port) => void toWorker.push([id, incarnation, port]),
    toPage: (page, plugin, incarnation, port) => void toPage.push([page, plugin, incarnation, port]),
    endInPage: (page, plugin, incarnation) => void ended.push([page, plugin, incarnation]),
  })
  return { drawers, made, toWorker, toPage, ended }
}

describe("the drawer's ports in main", () => {
  it('makes one channel for each worker and editor page load, one end each', () => {
    const { drawers, toWorker, toPage } = ports()
    drawers.loaded('page-1')
    drawers.started('alpha', 1)
    expect(toWorker).toEqual([['alpha', 1, 'w0']])
    expect(toPage).toEqual([['page-1', 'alpha', 1, 'p0']])
  })

  it('makes none before the page is ready, then one for each worker running', () => {
    const { drawers, toWorker, toPage } = ports()
    drawers.started('alpha', 1)
    drawers.started('beta', 2)
    expect(toWorker).toEqual([])
    drawers.loaded('page-1')
    expect(toWorker).toEqual([['alpha', 1, 'w0'], ['beta', 2, 'w1']])
    expect(toPage).toEqual([['page-1', 'alpha', 1, 'p0'], ['page-1', 'beta', 2, 'p1']])
  })

  it('makes new pairs for a new load and none while no page is loaded', () => {
    const { drawers, toPage } = ports()
    drawers.loaded('page-1')
    drawers.started('alpha', 1)
    drawers.unloaded('page-1')
    drawers.started('beta', 1)
    expect(toPage).toHaveLength(1)
    drawers.loaded('page-2')
    expect(toPage.slice(1)).toEqual([['page-2', 'alpha', 1, 'p1'], ['page-2', 'beta', 1, 'p2']])
  })

  it('tells the page when a worker ends, and nothing for an incarnation it no longer holds', () => {
    const { drawers, ended, toWorker } = ports()
    drawers.loaded('page-1')
    drawers.started('alpha', 2)
    drawers.ended('alpha', 1)
    expect(ended).toEqual([])
    drawers.ended('alpha', 2)
    expect(ended).toEqual([['page-1', 'alpha', 2]])
    drawers.unloaded('page-1')
    drawers.loaded('page-2')
    expect(toWorker).toHaveLength(1)
  })

  it('ignores an unload of a page it no longer holds', () => {
    const { drawers, toPage } = ports()
    drawers.loaded('page-1')
    drawers.loaded('page-2')
    drawers.unloaded('page-1')
    drawers.started('alpha', 1)
    expect(toPage).toEqual([['page-2', 'alpha', 1, 'p0']])
  })
})

describe('the runtime side of worker starts', () => {
  it('tells the drawer ports only of workers started with drawer, and of each end', () => {
    const starts: string[] = []
    const ends: string[] = []
    const drawn: string[] = []
    const side = withDrawers(
      { start: start => void starts.push(start.id), terminate: (id, incarnation) => void ends.push(`${id}#${incarnation}`) },
      { started: (id, incarnation) => void drawn.push(`start ${id}#${incarnation}`), ended: (id, incarnation) => void drawn.push(`end ${id}#${incarnation}`) },
    )
    side.start({ id: 'alpha', incarnation: 1, code: Buffer.from(''), port: null, drawer: true })
    side.start({ id: 'beta', incarnation: 1, code: Buffer.from(''), port: null, drawer: false })
    side.terminate('alpha', 1)
    expect(starts).toEqual(['alpha', 'beta'])
    expect(ends).toEqual(['alpha#1'])
    expect(drawn).toEqual(['start alpha#1', 'end alpha#1'])
  })
})
