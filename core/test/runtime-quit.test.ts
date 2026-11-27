import { describe, expect, it } from 'vitest'
import { afterFailure, closeQuits, Ending, QUIT_GRACE_MS, quitInOrder, relaunch, relaunches, stoppedBox, type FailureParts } from '../backend/runtime/quit.ts'

const never = () => new Promise<void>(() => {})
const later = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

// The joined core's quit seams, writing down each call and when it settled
function parts(over: { shutdown?: () => Promise<void>, flush?: () => Promise<void>, close?: () => void, release?: () => Promise<void> } = {}) {
  const calls: string[] = []
  let flushes = 0
  return {
    calls,
    parts: {
      pluginsManager: {
        shutdown: async () => {
          calls.push('shutdown')
          await (over.shutdown ?? (async () => {}))()
          calls.push('shutdown done')
        },
      },
      router: {
        close: () => {
          calls.push('close')
          over.close?.()
        },
      },
      recording: {
        flush: async () => {
          const n = ++flushes
          calls.push(`flush ${n}`)
          await (over.flush ?? (async () => {}))()
          calls.push(`flush ${n} done`)
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

describe('closing the editor window', () => {
  it('quits the way Quit does on every close, the trusted window open or not, so the page keeps its drafts first', () => {
    expect(closeQuits({ quitting: false, byMain: false })).toBe(true)
  })

  it('lets a close during a quit go on, so no second quit starts', () => {
    expect(closeQuits({ quitting: true, byMain: false })).toBe(false)
  })

  it('lets a close main makes itself go on, as the stopped mode leaving only the trusted window', () => {
    expect(closeQuits({ quitting: false, byMain: true })).toBe(false)
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

describe('how a run ends', () => {
  const quitting = () => {
    const cleared: string[] = []
    return { cleared, pluginsManager: { cleanQuit: async () => { cleared.push('cleared') } } }
  }

  it('clears the restart marker only on a clean Quit, which gives the windows their grace', async () => {
    const clean = quitting()
    const ending = new Ending()
    expect(ending.asked()).toBe(true)
    await ending.leave(clean.pluginsManager)
    expect(clean.cleared).toEqual(['cleared'])
  })

  it('keeps it after a failure with no grace and through Try again or Restart hetu', async () => {
    const failed = new Ending()
    failed.fail()
    const again = new Ending()
    again.relaunch()
    for (const ending of [failed, again]) {
      const kept = quitting()
      await ending.leave(kept.pluginsManager)
      expect(kept.cleared).toEqual([])
    }
    expect(failed.asked()).toBe(false)
    expect(again.asked()).toBe(true)
  })
})

// Main's handling of a failure ran only end to end, where hetu never starts itself again
describe('after a failure', () => {
  function parts(over: Partial<FailureParts> = {}) {
    const did: string[] = []
    const timers: { ms: number, run: () => void }[] = []
    const made: FailureParts = {
      quitting: () => false,
      announce: () => { did.push('announce') },
      quit: (code, again) => { did.push(`quit ${code} ${again}`) },
      ending: new Ending(),
      showTrusted: () => { did.push('trusted') },
      showBox: mode => {
        did.push(`box ${mode.control}`)
        return 'quit'
      },
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
    // A quit after a failure keeps the restart marker
    expect(made.ending.asked()).toBe(false)
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
    afterFailure({ action: 'stopped', mode: { control: 'log', why: 'failed', reason: 'log-failing', again: true }, box: false }, made)
    expect(did).toEqual(['trusted', 'close editors'])
    expect(timers).toEqual([])
  })

  it('shows the native box with quit only when the plugins manager says so, then quits with exit code 1 and starts nothing again', () => {
    const { made, did, timers } = parts()
    afterFailure({ action: 'stopped', mode: { control: 'log', why: 'failed', reason: 'log-failing', again: true }, box: true }, made)
    expect(did).toEqual(['close editors', 'box log', 'quit 1 false'])
    expect(timers).toEqual([])
  })

  it('offers Try again in the box for a control that failed at start and starts hetu again once chosen', async () => {
    const failed = { control: 'gate', why: 'start-failed', reason: 'state-changed', again: false } as const
    const retried = parts({ showBox: () => 'retry' })
    afterFailure({ action: 'stopped', mode: failed, box: true }, retried.made)
    expect(retried.did).toEqual(['close editors', 'quit 1 true'])
    // It keeps the restart marker
    const cleared: string[] = []
    await retried.made.ending.leave({ cleanQuit: async () => { cleared.push('cleared') } })
    expect(cleared).toEqual([])
    const left = parts({ showBox: () => 'retry', env: { HETU_NO_RELAUNCH: '1' } })
    afterFailure({ action: 'stopped', mode: failed, box: true }, left.made)
    expect(left.did).toEqual(['close editors', 'quit 1 false'])
    expect(stoppedBox(failed)).toEqual({
      title: 'hetu stopped',
      message: 'hetu stopped: gate failed at start',
      detail: 'The security view is off, so hetu can’t start with gate switched off. Try again starts hetu again',
      buttons: ['Quit', 'Try again'],
    })
  })

  it('names the cause in the box\'s words', () => {
    expect(stoppedBox({ control: 'log', why: 'failed', reason: 'log-failing', again: false })).toEqual({
      title: 'hetu stopped',
      message: 'hetu stopped: the event log can’t write',
      detail: 'The security view is off, so the choices that would start hetu again can’t be made. Free space or fix the data folder’s permissions, then start hetu',
      buttons: ['Quit'],
    })
    expect(stoppedBox({ control: 'install', why: 'tampered', reason: null, again: false }).message).toBe('hetu stopped: its install list doesn’t check out')
  })
})
