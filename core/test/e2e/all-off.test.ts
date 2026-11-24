import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { coreModuleIds, doorId } from '../../api/ids.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { cleanup, editorPage, launch, temp, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

// D-637, the page half of D-512's incomplete note taking app. Playwright sees no native box, so the test checks what
// each box hetu has leaves behind: the start's error box exits hetu, the stopped mode's box closes the editor first and
// holds main until the human closes it, and the stopped mode shows in core.status
describe('hetu with every core module and the door switched off', () => {
  it('opens the editor saying how to open a note, with no error box', async () => {
    const dataDir = await temp()
    await new StateStore(dataDir).writeSwitches({ ...defaultSwitches(), off: [...coreModuleIds, doorId] })
    const app = await launch(dataDir)
    // Each throw in the editor page, the ones at its start too, so listened for on every window from launch on
    const thrown: string[] = []
    const listen = (opened: Page) => opened.on('pageerror', error => {
      if (opened.url() === 'hetu://editor/') thrown.push(error.message)
    })
    for (const opened of app.windows()) listen(opened)
    app.on('window', listen)
    const page = await editorPage(app)
    const empty = page.locator('#empty')
    await until(() => empty.isVisible())
    expect(await empty.innerText()).toContain('Press Ctrl+P to open a note')
    // The banner draws from core.status, so the page read it and its settings load answered
    await until(async () => (await page.locator('#banner li').allTextContents()).includes('storage off'))
    const status = await page.evaluate(() => new Promise<unknown>(resolve => {
      const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
      bridge.listen(message => {
        const reply = message as { kind?: string, id?: number }
        if (reply.kind === 'reply' && reply.id === 1000) resolve(reply)
      })
      // The envelope holds args as a field every call carries, so a call without it is refused invalid
      bridge.send({ v: 1, kind: 'call', id: 1000, action: 'core.status', args: {} })
    }))
    expect(status).toMatchObject({ ok: true, result: { stopped: null } })
    // Only switches read as off and the luoshu to pick, no down: line for a plugin down and no line for a log that can't
    // write
    const expected = new Set([...coreModuleIds.flatMap(id => [`${id === 'luoshu' ? 'notes access' : id} off`, `${id}: off`]), 'No notes folder is picked yet'])
    expect((await page.locator('#banner li').allTextContents()).filter(line => !expected.has(line))).toEqual([])
    // main answered, so no modal box holds it. No layout is approved, so the trusted window opened over the editor on
    // its welcome guide
    expect((await visibleWindows(app)).sort()).toEqual(['hetu://editor/', 'hetu://trusted/'])
    expect(thrown).toEqual([])
  })
})
