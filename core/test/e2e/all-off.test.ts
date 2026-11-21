import { afterEach, describe, expect, it } from 'vitest'
import { coreModuleIds, corePluginIds } from '../../api/ids.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { cleanup, editorPage, launch, temp, until, visibleWindows } from './helpers.ts'

afterEach(cleanup)

// D-637, the page half of D-512's incomplete note taking app. Playwright sees no native box, so the test checks what
// each box hetu has leaves behind: the start's error box exits hetu, the stopped mode's box closes the editor first and
// holds main until the human closes it, and the stopped mode shows in core.status
describe('hetu with every core module and core plugin switched off', () => {
  it('opens the editor saying how to open a note, with no error box', async () => {
    const dataDir = await temp()
    await new StateStore(dataDir).writeSwitches({ ...defaultSwitches(), off: [...coreModuleIds, ...corePluginIds] })
    const app = await launch(dataDir)
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
    // main answers, so no modal box holds it, and the editor is still the one window
    expect(await visibleWindows(app)).toEqual(['hetu://editor/'])
    expect(app.process().exitCode).toBe(null)
  })
})
