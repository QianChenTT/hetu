// The trusted window's steps the first-run journeys share: a press once main's delay ran out and the delay check every
// Confirm goes through
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { Dropped } from '../input.ts'
import { armed, until, type Instance } from '../instance.ts'
import { counted, type Logged } from '../log.ts'

export const EMITTED_FOCUS = 'emitted focus on the trusted window in the press\'s own task, to press inside its input delay'

// How long the trusted window must go without drawing before a press, and the most a press waits for that. Its draws
// after one change come a few ms apart, as after an install its two plugins starting redraw it about 10 ms apart
export const QUIET_MS = 250
const QUIET_WAIT_MS = 5000

// Waits until the page has added or removed no element for QUIET_MS. The trusted window draws itself whole on each
// change it hears, replacing every control, so a press during a draw goes to the copy that took the control's place
// (T-50's journey, 2026-11-28)
export async function settled(page: Page): Promise<void> {
  const quiet = await page.evaluate(([quietMs, waitMs]) => new Promise<boolean>(resolve => {
    const began = Date.now()
    let last = began
    const observer = new MutationObserver(() => { last = Date.now() })
    observer.observe(document.body, { childList: true, subtree: true })
    const timer = setInterval(() => {
      const now = Date.now()
      if (now - last < quietMs && now - began < waitMs) return
      clearInterval(timer)
      observer.disconnect()
      resolve(now - last >= quietMs)
    }, 25)
  }), [QUIET_MS, QUIET_WAIT_MS] as const)
  if (!quiet) throw new Error(`${page.url()} kept drawing for ${QUIET_WAIT_MS} ms, never ${QUIET_MS} ms without a draw to press in`)
}

// A press on a trusted window control once main's delay on the window ran out and the page stopped drawing. armed
// reads the harness's own record of main's restarts, since main's delay is held where no test reaches it, so a press
// main still drops says the delay never armed or restarted on something the record missed
export async function pressArmed(instance: Instance, target: Locator): Promise<void> {
  await armed(instance.app, target.page().url())
  await settled(target.page())
  await instance.click(target).catch((err: unknown) => {
    if (err instanceof Dropped) throw new Error(`the delay never armed: main still dropped the press after the harness read its delay as run out on ${target.page().url()}`)
    throw err
  })
}

// What the page says, for a failure to name what was on screen instead
export const shown = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800)

// Waits for a control to be drawn, failing with what the page shows instead
export async function drawn(target: Locator, what: string, ms = 10_000): Promise<void> {
  await until(async () => await target.count() === 1, what, ms).catch(async () => {
    throw new Error(`never saw ${what}. The trusted window shows: ${await shown(target.page())}`)
  })
}

// Whether a control is drawn, with whether it was disabled when first seen, read in the same poll that finds it so the
// page's delay since the draw has barely begun
export function firstSeen(target: Locator): { seen: () => Promise<boolean>, disabled: () => boolean | null } {
  let disabled: boolean | null = null
  return {
    seen: async () => {
      if (await target.count() !== 1) return false
      disabled ??= await target.isDisabled()
      return true
    },
    disabled: () => disabled,
  }
}

// The delay check of a control that waits it out, a Confirm or Install. Drawn just now, the page holds it disabled for
// the delay, read as soon as it is seen. drawnNow false skips that for one drawn while the window was behind, and
// drawnDisabled hands in a read taken earlier. Once the page lets it go, a press with focus emitted on the window in
// its own task, as the window gaining focus restarts main's delay, is dropped by main with nothing logged. A press
// after the delay is logged once and lands. Only the focus restart is pressed inside here: the show and load restarts
// need the window really shown, so they are on Han's screen list
export async function throughDelay(instance: Instance, target: Locator, records: Logged, landed: () => Promise<boolean>, what: string, drawnNow: boolean | { drawnDisabled: boolean | null } = true): Promise<void> {
  const first = firstSeen(target)
  await until(first.seen, what, 10_000).catch(async () => {
    throw new Error(`never saw ${what}. The trusted window shows: ${await shown(target.page())}`)
  })
  const disabled = typeof drawnNow === 'object' ? drawnNow.drawnDisabled : drawnNow ? first.disabled() : null
  if (drawnNow !== false) expect(disabled, `${what} drawn disabled for the delay`).toBe(true)
  await until(async () => await target.isEnabled(), `${what} let go by the page`)
  const before = await counted(instance.data, records)
  instance.harnessed(EMITTED_FOCUS)
  await expect(instance.click(target, { emit: 'focus' }), `a press on ${what} inside the delay`).rejects.toThrow(Dropped)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await counted(instance.data, records), `${records.event} logged for a press inside the delay`).toBe(before)
  expect(await landed(), `${what} landed from a press inside the delay`).toBe(false)

  await pressArmed(instance, target)
  await until(landed, `what ${what} does`)
  // The log is written beside what the press does, so it is read until it holds the record, then once more after
  await until(async () => await counted(instance.data, records) > before, `${records.event} logged`, 3000)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await counted(instance.data, records), `${records.event} logged for one press after the delay`).toBe(before + 1)
}
