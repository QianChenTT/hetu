import { describe, expect, it } from 'vitest'
import { changeEffect, type Change } from '../api/changes.ts'
import type { Caller } from '../api/envelope.ts'
import { createSecurityView } from '../backend/security-view/security-view.ts'

// The security view on its own: whether a change waits for the Confirm and whether a click counts
const view = createSecurityView()
const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const asked = (change: Change, from: Caller, confirmOff = false) => view.asked(change, changeEffect(change), from, confirmOff)

describe('the security view', () => {
  it('applies a narrowing change at once and holds every other one for the Confirm', () => {
    expect(asked({ kind: 'plugin.off', plugin: 'search' }, editor)).toBe('apply')
    expect(asked({ kind: 'plugin.on', plugin: 'security-view' }, editor)).toBe('apply')
    expect(asked({ kind: 'skipVerification', on: true }, editor)).toBe('hold')
    expect(asked({ kind: 'plugin.remove', plugin: 'search' }, trusted)).toBe('hold')
  })

  it('lands the record then applies what the trusted window asks for with confirmOff on, never what asks for typing', () => {
    expect(asked({ kind: 'skipVerification', on: true }, trusted, true)).toBe('land')
    expect(asked({ kind: 'skipVerification', on: true }, editor, true)).toBe('hold')
    expect(asked({ kind: 'plugin.off', plugin: 'gate' }, trusted, true)).toBe('hold')
    expect(asked({ kind: 'plugin.off', plugin: 'security-view' }, trusted, true)).toBe('hold')
  })

  it('counts a Confirm only once its request was first in line for the delay, with the word typed exactly', () => {
    const off: Change = { kind: 'plugin.off', plugin: 'recording' }
    expect(view.confirms(off, null, 'recording')).toBe('throttled')
    expect(view.confirms(off, { waited: 999, delayMs: 1000 }, 'recording')).toBe('throttled')
    expect(view.confirms(off, { waited: 1000, delayMs: 1000 }, 'log')).toBe('invalid')
    expect(view.confirms(off, { waited: 1000, delayMs: 1000 }, 'recording')).toBe('ok')
    expect(view.confirms({ kind: 'skipVerification', on: true }, { waited: 0, delayMs: 0 }, undefined)).toBe('ok')
  })

  it('asks for a security control\'s id to switch it off and for nothing else', () => {
    for (const id of ['gate', 'grant-risk-classifier', 'flood-control', 'recording', 'security-view']) {
      expect(view.mustType({ kind: 'plugin.off', plugin: id })).toBe(id)
    }
    expect(view.mustType({ kind: 'plugin.off', plugin: 'heartbeat' })).toBe(null)
    expect(view.mustType({ kind: 'plugin.on', plugin: 'gate' })).toBe(null)
    expect(view.mustType({ kind: 'skipVerification', on: true })).toBe(null)
  })
})
