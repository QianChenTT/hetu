import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { ROUTES, heard, mark } from './input.ts'
import { start, until } from './instance.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const notes = { 'a.md': '# a\n\nbody a\n', 'b.md': '# b\n\nbody b\n', 'c.md': '# c\n\nbody c\n' }
const explorerOf = (editor: Page) => editor.frames().find(frame => frame.url().includes('file-explorer.views'))

// The Files row of a note, once the explorer drew it
async function filesRow(editor: Page, name: string) {
  await until(() => explorerOf(editor) !== undefined, 'the explorer frame')
  const row = explorerOf(editor)!.locator('[role=treeitem]', { hasText: new RegExp(`^${name}`) })
  await until(async () => await row.count() === 1, `the ${name} row`)
  return row
}
const title = (editor: Page) => editor.locator('#title').innerText()
const shown = (editor: Page) => editor.locator('#editors > .editor:not([hidden]) .cm-content')

describe('main\'s input route on the driven build', () => {
  it('opens a note to the front from a click on its Files row, main hearing the press, and records the route', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const since = await mark(instance.app)
    await instance.click(await filesRow(editor, 'b'))
    await until(async () => (await title(editor)) === 'b.md', 'b.md in the note bar')
    expect(await shown(editor).innerText()).toContain('body b')
    // The press and release main heard, on the editor window, which main pushes to the page as hetu:press
    const presses = (await heard(instance.app, since)).filter(input => input.kind === 'mouse')
    expect(presses.map(input => [input.url, input.type])).toEqual([['hetu://editor/', 'mouseDown'], ['hetu://editor/', 'mouseUp']])
    const focus = await instance.focus()
    expect(focus.main.find(window => window.url === 'hetu://editor/')!.focusedFrame).toContain('file-explorer.views')
    expect(focus.pages.find(page => page.url === 'hetu://editor/')!.frames.find(frame => frame.url.includes('file-explorer.views'))!.active).toMatch(/treeitem/)
    const record = await instance.quit()
    expect(record.input).toEqual([ROUTES.mouse])
  })

  it('never reaches a plugin frame with sendInputEvent\'s mouse, which main hears all the same', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const row = await filesRow(editor, 'c')
    const box = (await row.boundingBox())!
    const since = await mark(instance.app)
    await instance.app.evaluate(({ webContents }, [x, y]) => {
      const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
      for (const type of ['mouseDown', 'mouseUp'] as const) contents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
    }, [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] as const)
    await until(async () => (await heard(instance.app, since)).filter(input => input.kind === 'mouse').length === 2, 'main to hear the press')
    // Time for an open the frame would have asked for
    await tick(1500)
    expect(await title(editor)).toBe('No note open')
  })

  it('saves on ⌘S through main\'s route with focus in a plugin frame, and not on Playwright\'s press, which main never hears', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const row = await filesRow(editor, 'a')
    await instance.click(row)
    await until(async () => (await title(editor)) === 'a.md', 'a.md in the note bar')
    await instance.click(shown(editor))
    await instance.keys(editor, 'XY')
    await until(async () => (await title(editor)) === 'a.md (unsaved)', 'the note marked unsaved')
    // Focus into the Files frame, where a key goes to the frame before the page
    await instance.click(row)
    await until(async () => ((await instance.focus()).main.find(window => window.url === 'hetu://editor/')!.focusedFrame ?? '').includes('file-explorer.views'), 'focus in the Files frame')
    const disk = () => readFile(path.join(instance.notes, 'a.md'), 'utf8')

    let since = await mark(instance.app)
    await instance.playwrightPress(editor, 'ControlOrMeta+s')
    await tick(1000)
    expect((await heard(instance.app, since)).filter(input => input.kind === 'key')).toEqual([])
    expect(await disk()).toBe(notes['a.md'])
    expect(await title(editor)).toBe('a.md (unsaved)')

    since = await mark(instance.app)
    await instance.press(editor, 'Mod+S')
    await until(async () => (await disk()).includes('XY'), 'the save on disk')
    const keys = (await heard(instance.app, since)).filter(input => input.kind === 'key' && input.type === 'keyDown')
    expect(keys).toEqual([expect.objectContaining({ url: 'hetu://editor/', key: 's', meta: process.platform === 'darwin', control: process.platform !== 'darwin' })])
    await until(async () => (await title(editor)) === 'a.md', 'the unsaved mark cleared')
    const record = await instance.quit()
    expect(record.input).toEqual([ROUTES.keys, ROUTES.mouse, 'playwright'].sort())
  })

  it('opens the next row\'s note to the front on ArrowDown and Enter through main\'s hook into the Files frame', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    await instance.click(await filesRow(editor, 'a'))
    await until(async () => (await title(editor)) === 'a.md', 'a.md in the note bar')
    expect(await instance.frameKeys(['ArrowDown', 'Enter'], 150)).toEqual([])
    await until(async () => (await title(editor)) === 'b.md', 'b.md in the note bar')
    const record = await instance.quit()
    expect(record.input).toEqual([ROUTES.frameKeys, ROUTES.mouse].sort())
  })
})
