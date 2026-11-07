import { describe, expect, it } from 'vitest'
import { quitInOrder, relaunch } from '../backend/runtime/quit.ts'

const never = () => new Promise<void>(() => {})
const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// The joined core's quit seams, writing down each call and when it settled
function parts(over: { shutdown?: () => Promise<void>, flushFloor?: () => Promise<void>, close?: () => void, release?: () => Promise<void> } = {}) {
  const calls: string[] = []
  let flushes = 0
  return {
    calls,
    parts: {
      loader: {
        shutdown: async () => {
          calls.push('shutdown')
          await (over.shutdown ?? (async () => {}))()
          calls.push('shutdown done')
        },
      },
      carrier: {
        flushFloor: async () => {
          const n = ++flushes
          calls.push(`flushFloor ${n}`)
          await (over.flushFloor ?? (async () => {}))()
          calls.push(`flushFloor ${n} done`)
        },
        close: () => {
          calls.push('close')
          over.close?.()
        },
      },
      release: async () => {
        calls.push('release')
        await (over.release ?? (async () => {}))()
        calls.push('release done')
      },
    },
  }
}

const deadlines = { shutdown: 50, flush: 50, release: 50 }

describe('quit', () => {
  it('runs shutdown, a flush, close, a flush and release, each waiting for the one before', async () => {
    const { calls, parts: quit } = parts({ shutdown: () => later(10), flushFloor: () => later(5) })
    const missed = await quitInOrder(quit, deadlines)
    expect(calls).toEqual([
      'shutdown', 'shutdown done', 'flushFloor 1', 'flushFloor 1 done', 'close', 'flushFloor 2', 'flushFloor 2 done',
      'release', 'release done',
    ])
    expect(missed).toEqual([])
  })

  it('goes on past a step that never settles once its deadline passes and says which', async () => {
    const { calls, parts: quit } = parts({ shutdown: never, flushFloor: never })
    const started = Date.now()
    const missed = await quitInOrder(quit, deadlines)
    expect(calls).toEqual(['shutdown', 'flushFloor 1', 'close', 'flushFloor 2', 'release', 'release done'])
    expect(missed).toEqual(['shutdown: no answer in 50 ms', 'flushFloor: no answer in 50 ms', 'flushFloor: no answer in 50 ms'])
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('goes on past a step that throws and says why', async () => {
    const { calls, parts: quit } = parts({
      shutdown: () => Promise.reject(new Error('broken')),
      close: () => {
        throw new Error('closed twice')
      },
    })
    const missed = await quitInOrder(quit, deadlines)
    expect(calls.at(-1)).toBe('release done')
    expect(missed).toEqual(['shutdown: broken', 'close: closed twice'])
  })

  it('relaunches by asking for a new instance first, then quitting the usual way', () => {
    const calls: string[] = []
    relaunch({ relaunch: () => calls.push('relaunch'), quit: () => calls.push('quit') })
    expect(calls).toEqual(['relaunch', 'quit'])
  })
})
