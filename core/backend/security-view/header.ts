import type { Change, ChangeEffect } from '../../api/changes.ts'
import type { Caller } from '../../api/envelope.ts'

// What the security view provides: it sits in the path of every security change a window asks for and decides whether
// the change waits for the trusted window's Confirm, and whether a click on that Confirm counts. Definitions only,
// security-view.ts implements them. The plugins manager keeps the queue, the stale check, record-before-apply and
// applying

// What a change a window asked for comes to: applies at once with its record after, its record lands first and then
// it applies, or it waits for the Confirm
export type Asked = 'apply' | 'land' | 'hold'

// Whether a Confirm counts: yes, too soon or not first in line, or the word typed doesn't match
export type Confirmed = 'ok' | 'throttled' | 'invalid'

// How long the request has been first in line, null while it isn't, and how long it must be before a click counts
export type InLine = { waited: number, delayMs: number } | null

export type SecurityView = {
  // effect is the core's reading of the change's structure. confirmOff is the human's knob, which skips the second
  // click for a change the trusted window itself asks for
  asked(change: Change, effect: ChangeEffect, from: Caller, confirmOff: boolean): Asked
  confirms(change: Change, inLine: InLine, typed: string | undefined): Confirmed
  // The word the human types before the Confirm counts, null for none
  mustType(change: Change): string | null
}
