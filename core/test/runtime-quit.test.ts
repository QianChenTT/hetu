import { describe, expect, it } from 'vitest'
import { afterFailure, QUIT_GRACE_MS, quitInOrder, relaunch, relaunches, type FailureParts } from '../backend/runtime/quit.ts'

const never = () => new Promise<void>(() => {})
const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// The joined core's quit seams, writing down each call and when it settled
function parts(over: { shutdown?: () => Promise<void>, flush?: () => Promise<void>, close?: () => void, release?: () => Promise<void> } = {}) {
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
        flush: async () => {
          const n = ++flushes
          calls.push(`flush ${n}`)
          await (over.flush ?? (async () => {}))()
          calls.push(`flush ${n} done`)
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
    const { calls, parts: quit } = parts({ shutdown: () => later(10), flush: () => later(5) })
    const missed = await quitInOrder(quit, deadlines)
    expect(calls).toEqual([
      'shutdown', 'shutdown done', 'flush 1', 'flush 1 done', 'close', 'flush 2', 'flush 2 done',
      'release', 'release done',
    ])
    expect(missed).toEqual([])
  })

  it('goes on past a step that never settles once its deadline passes and says which', async () => {
    const { calls, parts: quit } = parts({ shutdown: never, flush: never })
    const started = Date.now()
    const missed = await quitInOrder(quit, deadlines)
    expect(calls).toEqual(['shutdown', 'flush 1', 'close', 'flush 2', 'release', 'release done'])
    expect(missed).toEqual(['shutdown: no answer in 50 ms', 'flush: no answer in 50 ms', 'flush: no answer in 50 ms'])
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

describe('starting again after a failure', () => {
  it('starts again, and in a packaged build always', () => {
    expect(relaunches({ packaged: false, env: {} })).toBe(true)
    expect(relaunches({ packaged: true, env: { HETU_NO_RELAUNCH: '1' } })).toBe(true)
  })

  // The end-to-end tests start the next run themselves, so no hetu runs outside them
  it('exits without starting again in a run from the source with HETU_NO_RELAUNCH set to 1', () => {
    expect(relaunches({ packaged: false, env: { HETU_NO_RELAUNCH: '1' } })).toBe(false)
  })

  it('gives windows a grace of two seconds to keep a draft', () => {
    expect(QUIT_GRACE_MS).toBe(2000)
  })
})

// Checkpoint B: main's handling of a failure ran only end to end, where hetu never starts itself again
describe('after a failure', () => {
  function parts(over: Partial<FailureParts> = {}) {
    const did: string[] = []
    const timers: { ms: number, run: () => void }[] = []
    const made: FailureParts = {
      quitting: () => false,
      announce: () => { did.push('announce') },
      quit: (code, again) => { did.push(`quit ${code} ${again}`) },
      showTrusted: () => { did.push('trusted') },
      closeEditors: () => { did.push('close editors') },
      packaged: false,
      env: {},
      later: (run, ms) => { timers.push({ ms, run }) },
      ...over,
    }
    return { made, did, timers }
  }

  it('tells the windows hetu is quitting, then quits with exit code 1 and starts again after the grace', () => {
    const { made, did, timers } = parts()
    afterFailure({ action: 'relaunch', control: 'gate', reason: 'state-changed' }, made)
    expect(did).toEqual(['announce'])
    expect(timers.map(timer => timer.ms)).toEqual([QUIT_GRACE_MS])
    timers[0].run()
    expect(did).toEqual(['announce', 'quit 1 true'])
  })

  it('quits without starting again where HETU_NO_RELAUNCH says so', () => {
    const { made, did, timers } = parts({ env: { HETU_NO_RELAUNCH: '1' } })
    afterFailure({ action: 'relaunch', control: 'log', reason: 'log-failing' }, made)
    timers[0].run()
    expect(did.at(-1)).toBe('quit 1 false')
  })

  it('does nothing more once hetu is already quitting', () => {
    const { made, did, timers } = parts({ quitting: () => true })
    afterFailure({ action: 'relaunch', control: 'gate', reason: 'state-changed' }, made)
    expect([did, timers]).toEqual([[], []])
  })

  it('opens the trusted window and closes the editors in the stopped mode, and quits nothing', () => {
    const { made, did, timers } = parts()
    afterFailure({ action: 'stopped', mode: { control: 'gate', why: 'failed', reason: 'state-changed', again: true } }, made)
    expect(did).toEqual(['trusted', 'close editors'])
    expect(timers).toEqual([])
  })
})
