import { describe, expect, it } from 'vitest'
import type { CoreStatus } from '../api/actions.ts'
import { bannerLines, noticeText, Shell, type Notice } from '../frontend/mount/shell.ts'

const calm: CoreStatus = {
  slots: { gate: 'on', capabilities: 'on', watchdog: 'on' },
  crashed: [],
  devMode: [],
  allowUnsigned: 0,
  skipVerification: false,
  recordNothing: false,
  logWrites: true,
  luoshuPicked: true,
  pending: [],
  stopped: null,
}

describe('the banner', () => {
  it('says nothing while every slot is on and nothing is weakened', () => {
    expect(bannerLines(calm)).toEqual([])
  })

  it('names each slot not on, the plugins down, each switch that weakens a check and a luoshu not picked', () => {
    expect(bannerLines({
      slots: { gate: 'off', capabilities: 'on', watchdog: 'absent' },
      crashed: ['git', 'search'],
      devMode: ['notes'],
      allowUnsigned: 2,
      skipVerification: true,
      recordNothing: true,
      logWrites: false,
      luoshuPicked: false,
      pending: [],
      stopped: null,
    })).toEqual([
      'gate: off', 'watchdog: absent', 'down: git, search', 'dev mode: notes', 'unsigned builds allowed: 2',
      'verification skipped', 'recording off', "the log can't write", 'pick a luoshu folder',
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

describe('the notices', () => {
  // The notice names the plugin whose call raised it, so a prompt a plugin drew can't pass for the core's
  it('names the plugin a request waits for, or the change when none is named', () => {
    // The id in quotes, since an id like hetu-needs-this-click-confirm reads as a sentence
    expect(noticeText({ id: 'r1', kind: 'item.on', plugin: 'search' })).toBe('The plugin "search" asks to use something for the first time')
    expect(noticeText({ id: 'r2', kind: 'plugin.approve', plugin: 'alpha' })).toBe('New plugin found: "alpha"')
    expect(noticeText({ id: 'r3', kind: 'plugin.update', plugin: 'alpha' })).toBe('An update for "alpha" is waiting')
    expect(noticeText({ id: 'r4', kind: 'skipVerification', plugin: null })).toBe('A security change is waiting: skipVerification')
    expect(noticeText({ id: 'r5', kind: 'plugin.off', plugin: 'gate' })).toBe('A security change is waiting: plugin.off "gate"')
  })
})

describe('the shell', () => {
  function started(now = { at: 0 }) {
    const made = bridge()
    const drawn: { lines: string[], notices: Notice[] }[] = []
    const shell = new Shell(made.bridge, (lines, notices) => drawn.push({ lines, notices }), () => now.at)
    shell.start()
    return { ...made, drawn, shell, now }
  }

  it('subscribes to core.status and core.quitting, reads the status and draws the banner, then reads it again on each core.status, acking each event', async () => {
    const { sent, drawn, hears } = started()
    expect(sent.map(message => [message.action, message.args])).toEqual([
      ['events.subscribe', { topics: ['core.status', 'core.quitting'] }], ['core.status', undefined],
    ])
    hears({ v: 1, kind: 'reply', id: sent[1].id, ok: true, result: { ...calm, luoshuPicked: false } })
    expect(drawn).toEqual([{ lines: ['pick a luoshu folder'], notices: [] }])
    hears({ v: 1, kind: 'event', topic: 'core.status', seq: 7 })
    expect(sent.slice(2)).toEqual([{ v: 1, kind: 'ack', seq: 7 }, expect.objectContaining({ kind: 'call', action: 'core.status' })])
    hears({ v: 1, kind: 'event', topic: 'core.quitting', seq: 8 })
    expect(sent.slice(4)).toEqual([{ v: 1, kind: 'ack', seq: 8 }])
  })

  it('draws nothing from a refusal or a reply it didn’t ask for', () => {
    const { sent, drawn, hears } = started()
    hears({ v: 1, kind: 'reply', id: sent[1].id, ok: false, refusal: { code: 'starting' } })
    hears({ v: 1, kind: 'reply', id: 999, ok: true, result: calm })
    hears(null)
    expect(drawn).toEqual([])
  })

  it('draws a notice for each request waiting', () => {
    const { sent, drawn, hears } = started()
    hears({ v: 1, kind: 'reply', id: sent[1].id, ok: true, result: { ...calm, pending: [{ id: 'r1', kind: 'item.on', plugin: 'search' }] } })
    expect(drawn[0].notices).toEqual([{ id: 'r1', text: 'The plugin "search" asks to use something for the first time' }])
  })

  // A plugin can time its call under a click, so the click that lands as the notice appears opens nothing
  it('opens the trusted window from a notice only once the notice has been on screen for the input delay', () => {
    const { sent, hears, shell, now } = started()
    now.at = 5000
    hears({ v: 1, kind: 'reply', id: sent[1].id, ok: true, result: { ...calm, pending: [{ id: 'r1', kind: 'item.on', plugin: 'search' }] } })
    now.at = 5999
    shell.open('r1')
    expect(sent.slice(2)).toEqual([])
    now.at = 6000
    shell.open('r1')
    expect(sent.slice(2)).toEqual([expect.objectContaining({ action: 'security.open', args: { requestId: 'r1' } })])
  })

  it('opens nothing for a notice it never drew', () => {
    const { sent, shell } = started()
    shell.open('r9')
    expect(sent.slice(2)).toEqual([])
  })

  it('opens the plugin list from its own button at once', () => {
    const { sent, shell } = started()
    shell.open()
    expect(sent.slice(2)).toEqual([expect.objectContaining({ action: 'security.open', args: undefined })])
  })
})
