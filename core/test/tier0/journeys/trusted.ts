// The trusted window's steps the first-run journeys share: a press once main's delay ran out, the security log's
// records and the delay check every Confirm goes through
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect } from 'vitest'
import { Dropped } from '../input.ts'
import { armed, until, type Instance } from '../instance.ts'

export const EMITTED_FOCUS = 'emitted focus on the trusted window to press inside its input delay'

export type Logged = { event: string, kind?: string, target?: string }
// The security log's records, read from the data folder the way an audit reads it
export async function logged(instance: Instance): Promise<Logged[]> {
  const text = await readFile(path.join(instance.data, 'events', 'events-1.jsonl'), 'utf8').catch(() => '')
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Logged)
}
export const counted = async (instance: Instance, wanted: Logged) =>
  (await logged(instance)).filter(record => record.event === wanted.event && record.kind === wanted.kind && (wanted.target === undefined || record.target === wanted.target)).length

// A press on a trusted window control once main's delay on the window ran out
export async function pressArmed(instance: Instance, target: Locator): Promise<void> {
  await armed(instance.app, target.page().url())
  await instance.click(target)
}

// What the page says, for a failure to name what was on screen instead
export const shown = async (page: Page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 800)

// Waits for a control to be drawn, failing with what the page shows instead
export async function drawn(target: Locator, what: string, ms = 10_000): Promise<void> {
  await until(async () => await target.count() === 1, what, ms).catch(async () => {
    throw new Error(`never saw ${what}. The trusted window shows: ${await shown(target.page())}`)
  })
}

// The delay check of a control that waits it out, a Confirm or Install. Drawn just now, the page holds it disabled for
// the delay, which drawnNow false skips for one drawn while the window was behind. Once the page lets it go, main's
// own delay is restarted as the window gaining focus restarts it, and a press then is dropped by main with nothing
// logged. A press after the delay is logged once and lands
export async function throughDelay(instance: Instance, target: Locator, records: Logged, landed: () => Promise<boolean>, what: string, drawnNow = true): Promise<void> {
  await drawn(target, what)
  if (drawnNow) expect(await target.isDisabled(), `${what} drawn disabled for the delay`).toBe(true)
  await until(async () => await target.isEnabled(), `${what} let go by the page`)
  const before = await counted(instance, records)
  await instance.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL() === 'hetu://trusted/') window.emit('focus')
  })
  instance.harnessed(EMITTED_FOCUS)
  await expect(instance.click(target), `a press on ${what} inside the delay`).rejects.toThrow(Dropped)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await counted(instance, records), `${records.event} logged for a press inside the delay`).toBe(before)
  expect(await landed(), `${what} landed from a press inside the delay`).toBe(false)

  await pressArmed(instance, target)
  await until(landed, `what ${what} does`)
  // The log is written beside what the press does, so it is read until it holds the record, then once more after
  await until(async () => await counted(instance, records) > before, `${records.event} logged`, 3000)
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await counted(instance, records), `${records.event} logged for one press after the delay`).toBe(before + 1)
}
