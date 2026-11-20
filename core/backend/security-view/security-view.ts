import type { Change } from '../../api/changes.ts'
import { isSecurityControl } from '../../api/ids.ts'
import type { SecurityView } from './header.ts'

// The security view: a narrowing change applies at once and every other change waits for the trusted window's Confirm,
// unless the human has confirmOff on and the trusted window itself asked. A change that asks for typing waits for it
// even then, since confirmOff skips the click and not the proof of attention. A Confirm counts once its request has
// been first in line for the input delay, so a click aimed at the request before can't land on the next one drawn in
// its place, and with the word typed exactly
export function createSecurityView(): SecurityView {
  return {
    asked(change, effect, from, confirmOff) {
      if (effect === 'narrows') return 'apply'
      const trusted = from.kind === 'window' && from.role === 'trusted'
      return trusted && confirmOff && mustType(change) === null ? 'land' : 'hold'
    },

    confirms(change, inLine, typed) {
      if (inLine === null || inLine.waited < inLine.delayMs) return 'throttled'
      const word = mustType(change)
      return word !== null && typed !== word ? 'invalid' : 'ok'
    },

    mustType,
  }
}

// What the human types to prove attention before the Confirm counts: a security control's id to switch it off,
// recording's included, the moments protection goes away. Every other Confirm has the input delay alone, so typing
// doesn't become a habit
function mustType(change: Change): string | null {
  return change.kind === 'plugin.off' && isSecurityControl(change.plugin) ? change.plugin : null
}
