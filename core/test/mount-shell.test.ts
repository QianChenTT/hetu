import { describe, expect, it } from 'vitest'
import type { CoreStatus } from '../api/actions.ts'
import { bannerLines, Shell } from '../frontend/mount/shell.ts'

const calm: CoreStatus = {
  slots: { gate: 'on', capabilities: 'on', log: 'on', watchdog: 'on' },
  crashed: [],
  devMode: [],
  allowUnsigned: 0,
  skipVerification: false,
  recordNothing: false,
  luoshuPicked: true,
}

describe('the banner', () => {
  it('says nothing while every slot is on and nothing is weakened', () => {
    expect(bannerLines(calm)).toEqual([])
  })

  it('names each slot not on, the plugins down, each switch that weakens a check and a luoshu not picked', () => {
    expect(bannerLines({
      slots: { gate: 'off', capabilities: 'on', log: 'failed', watchdog: 'absent' },
      crashed: ['git', 'search'],
      devMode: ['notes'],
      allowUnsigned: 2,
      skipVerification: true,
      recordNothing: true,
      luoshuPicked: false,
    })).toEqual([
      'gate: off', 'log: failed', 'watchdog: absent', 'down: git, search', 'dev mode: notes', 'unsigned builds allowed: 2',
      'verification skipped', 'recording off', 'pick a luoshu folder',
    ])
  })
})

// The bridge the preload gives the page: what the page sent, and messages from the core to it
function bridge() {
  const sent: Record<string, unknown>[] = []
  let listener: ((message: unknown) => void) | null = null
  return {
    sent,
    bridge: { send: (message: unknown) => sent.push(message as Record<string, unknown>), listen: (next: (message: unknown) => void) => { listener = next } },
    hears: (message: unknown) => listener?.(message),
  }
}

describe('the shell', () => {
  it('subscribes to core.status, reads it and draws the banner, then reads it again on each event, acking it', async () => {
    const { sent, bridge: made, hears } = bridge()
    const drawn: string[][] = []
    new Shell(made, lines => drawn.push(lines)).start()
    expect(sent.map(message => message.action)).toEqual(['events.subscribe', 'core.status'])
    const status = sent[1]
    hears({ v: 1, kind: 'reply', id: status.id, ok: true, result: { ...calm, luoshuPicked: false } })
    await Promise.resolve()
    expect(drawn).toEqual([['pick a luoshu folder']])
    hears({ v: 1, kind: 'event', topic: 'core.status', seq: 7 })
    expect(sent.slice(2)).toEqual([{ v: 1, kind: 'ack', seq: 7 }, expect.objectContaining({ kind: 'call', action: 'core.status' })])
  })

  it('draws nothing from a refusal or a reply it didn\'t ask for', async () => {
    const { sent, bridge: made, hears } = bridge()
    const drawn: string[][] = []
    new Shell(made, lines => drawn.push(lines)).start()
    hears({ v: 1, kind: 'reply', id: sent[1].id, ok: false, refusal: { code: 'starting' } })
    hears({ v: 1, kind: 'reply', id: 999, ok: true, result: calm })
    hears(null)
    await Promise.resolve()
    expect(drawn).toEqual([])
  })
})
