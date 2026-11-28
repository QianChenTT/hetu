import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Frame, Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { click, heard, mark, ROUTES } from './input.ts'
import { start, until, type Instance } from './instance.ts'

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
const focusedFrame = async (instance: Instance) => (await instance.focus()).main.find(window => window.url === 'hetu://editor/')!.focusedFrame ?? ''
// Counts what a frame's window gets from now on, of one event type
const count = (frame: Frame, type: string) => frame.evaluate(type => {
  const scope = window as unknown as Record<string, string[]>
  scope[`tier0-${type}`] = []
  window.addEventListener(type, event => scope[`tier0-${type}`]!.push((event as KeyboardEvent).key ?? type), true)
}, type)
const counted = (frame: Frame, type: string) => frame.evaluate(type => (window as unknown as Record<string, string[]>)[`tier0-${type}`]!, type)
const sendInputMouse = (instance: Instance, at: { x: number, y: number }) => instance.app.evaluate(({ webContents }, [x, y]) => {
  const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
  for (const type of ['mouseDown', 'mouseUp'] as const) contents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
}, [at.x, at.y] as const)

describe('main\'s input route on the driven build', () => {
  it('opens a note to the front from a click on its Files row, main hearing the press, where Playwright\'s trial click presses for real', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    // The alternative: Playwright's trial click, meant to only check, and main hears a press and a release
    let since = await mark(instance.app)
    await (await filesRow(editor, 'c')).click({ trial: true })
    instance.usedInput('playwright')
    await until(async () => (await heard(instance.app, since, { kind: 'mouse' })).length === 2, 'main to hear the trial click')

    since = await mark(instance.app)
    const clicked = await instance.click(await filesRow(editor, 'b'))
    await until(async () => (await title(editor)) === 'b.md', 'b.md in the note bar')
    expect(await shown(editor).innerText()).toContain('body b')
    const presses = await heard(instance.app, since, { kind: 'mouse' })
    expect(presses.map(input => [input.url, input.type, input.prevented])).toEqual([['hetu://editor/', 'mouseDown', false], ['hetu://editor/', 'mouseUp', false]])
    expect(Math.abs(clicked.page.x - clicked.intended.x)).toBeLessThanOrEqual(1)
    expect(await focusedFrame(instance)).toContain('file-explorer.views')
    const focus = await instance.focus()
    expect(focus.pages.find(page => page.url === 'hetu://editor/')!.frames.find(frame => frame.url.includes('file-explorer.views'))!.active).toMatch(/treeitem/)
    const record = await instance.quit()
    expect(record.input).toEqual([ROUTES.mouse, 'playwright'].sort())
    expect(record.presses).toEqual([{ url: 'hetu://editor/', intended: clicked.intended, heard: clicked.page }])
  })

  it('holds a press before its release, a held press on a Files row opening its note to the front from the release', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const row = await filesRow(editor, 'c')
    const since = await mark(instance.app)
    const begun = Date.now()
    await instance.click(row, { holdMs: 800 })
    expect(Date.now() - begun).toBeGreaterThanOrEqual(800)
    expect((await heard(instance.app, since, { kind: 'mouse' })).map(input => input.type)).toEqual(['mouseDown', 'mouseUp'])
    await until(async () => (await title(editor)) === 'c.md', 'c.md in the note bar')
  })

  it('never reaches a plugin frame with sendInputEvent\'s mouse, which main hears, where the route\'s click on the same row opens it', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const row = await filesRow(editor, 'c')
    await count(explorerOf(editor)!, 'pointerdown')
    const box = (await row.boundingBox())!
    const since = await mark(instance.app)
    await sendInputMouse(instance, { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) })
    await until(async () => (await heard(instance.app, since, { kind: 'mouse' })).length === 2, 'main to hear the press')
    // Sent after it to the same point: had sendInputEvent's press reached the frame, the frame got it first
    await instance.click(row)
    await until(async () => (await title(editor)) === 'c.md', 'c.md in the note bar')
    expect(await counted(explorerOf(editor)!, 'pointerdown')).toEqual(['pointerdown'])
  })

  it('saves on ⌘S through main\'s route with focus in a plugin frame, and not on Playwright\'s press, which goes to the frame', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const row = await filesRow(editor, 'a')
    await instance.click(row)
    await until(async () => (await title(editor)) === 'a.md', 'a.md in the note bar')
    await instance.click(shown(editor))
    await instance.keys(editor, 'XY')
    await until(async () => (await title(editor)) === 'a.md (unsaved)', 'the note marked unsaved')
    await instance.click(row)
    await until(async () => (await focusedFrame(instance)).includes('file-explorer.views'), 'focus in the Files frame')
    const disk = () => readFile(path.join(instance.notes, 'a.md'), 'utf8')

    // Playwright's press lands in the frame. Main hears a key before any frame does, so once the frame has it main
    // hearing nothing is final, and the page, which saves on its own keydown, never got it
    await count(explorerOf(editor)!, 'keydown')
    let since = await mark(instance.app)
    await editor.keyboard.press('ControlOrMeta+s')
    instance.usedInput('playwright')
    await until(async () => (await counted(explorerOf(editor)!, 'keydown')).includes('s'), 'the frame to get Playwright\'s s')
    expect(await heard(instance.app, since, { kind: 'key' })).toEqual([])
    expect(await disk()).toBe(notes['a.md'])
    expect(await title(editor)).toBe('a.md (unsaved)')

    since = await mark(instance.app)
    await instance.press(editor, 'Mod+S')
    await until(async () => (await disk()).includes('XY'), 'the save on disk')
    const down = (await heard(instance.app, since, { kind: 'key' })).filter(input => input.type === 'keyDown')
    // Main took the core key for the page, so no frame heard it
    expect(down).toEqual([expect.objectContaining({ url: 'hetu://editor/', key: 's', meta: process.platform === 'darwin', control: process.platform !== 'darwin', prevented: true })])
    await until(async () => (await title(editor)) === 'a.md', 'the unsaved mark cleared')
    const record = await instance.quit()
    expect(record.input).toEqual([ROUTES.keys, ROUTES.mouse, 'playwright'].sort())
  })

  it('opens the next row\'s note on ArrowDown and Enter through main\'s hook into the Files frame, where sendInputEvent\'s keys never reach it', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    await instance.click(await filesRow(editor, 'a'))
    await until(async () => (await title(editor)) === 'a.md', 'a.md in the note bar')
    await until(async () => (await focusedFrame(instance)).includes('file-explorer.views'), 'focus in the Files frame')
    await expect(instance.keys(editor, 'j')).rejects.toThrow(/frameKeys/)

    // The alternative: the same keys through sendInputEvent, which main lets through to the page
    await count(explorerOf(editor)!, 'keydown')
    let since = await mark(instance.app)
    await instance.app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
      for (const keyCode of ['Down', 'Enter']) for (const type of ['keyDown', 'keyUp'] as const) contents.sendInputEvent({ type, keyCode })
    })
    instance.usedInput('sendInputEvent keys with focus in a frame')
    await until(async () => (await heard(instance.app, since, { kind: 'key' })).length === 4, 'main to hear sendInputEvent\'s keys')
    expect((await heard(instance.app, since, { kind: 'key' })).map(input => input.prevented)).toEqual([false, false, false, false])

    since = await mark(instance.app)
    expect(await instance.frameKeys(['ArrowDown', 'Enter'], 150)).toEqual([])
    await until(async () => (await title(editor)) === 'b.md', 'b.md in the note bar')
    // Only the route's two keys reached the frame. Had sendInputEvent's moved the selection, Enter would open c
    expect(await counted(explorerOf(editor)!, 'keydown')).toEqual(['ArrowDown', 'Enter'])
    expect((await heard(instance.app, since, { kind: 'key' })).filter(input => input.type === 'keyDown').map(input => [input.key, input.prevented])).toEqual([['ArrowDown', false], ['Enter', false]])
    const record = await instance.quit()
    expect(record.input).toEqual([ROUTES.frameKeys, ROUTES.mouse, 'sendInputEvent keys with focus in a frame'].sort())
  })

  it('clicks into a shadow root and at zoom 1.5, and refuses a disabled target, one clipped by its frame\'s box and one a redraw replaced under the press', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    await editor.evaluate(() => {
      const host = Object.assign(document.createElement('div'), { id: 'tier0-host' })
      host.style.cssText = 'position: fixed; left: 400px; top: 300px; z-index: 99999'
      const button = document.createElement('button')
      button.textContent = 'shadowed'
      button.addEventListener('click', () => { (window as unknown as { shadowClicks: number }).shadowClicks++ })
      Object.assign(window, { shadowClicks: 0 })
      host.attachShadow({ mode: 'open' }).append(button)
      document.body.append(host)
    })
    const shadowed = editor.locator('#tier0-host button')
    await instance.click(shadowed)
    expect(await editor.evaluate(() => (window as unknown as { shadowClicks: number }).shadowClicks)).toBe(1)
    await shadowed.evaluate(button => { (button as HTMLButtonElement).disabled = true })
    await expect(click(instance.app, shadowed, 500)).rejects.toThrow('the target stayed disabled')
    // Replaced by a copy on the move the click sends just before its press, as a page that draws itself whole does
    await shadowed.evaluate(button => {
      (button as HTMLButtonElement).disabled = false
      window.addEventListener('mousemove', () => button.replaceWith(button.cloneNode(true)), { capture: true, once: true })
    })
    await expect(click(instance.app, shadowed)).rejects.toThrow(/the target left the page under the press, as a redraw replaces it: the press went to what took its place/)

    const frameElement = await explorerOf(editor)!.frameElement()
    await frameElement.evaluate(frame => { (frame as HTMLElement).style.clipPath = 'inset(0 0 calc(100% - 4px) 0)' })
    await expect(click(instance.app, await filesRow(editor, 'c'))).rejects.toThrow(/outside the box of the frame/)
    await frameElement.evaluate(frame => { (frame as HTMLElement).style.clipPath = '' })

    await instance.app.evaluate(({ webContents }) => webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!.setZoomFactor(1.5))
    const clicked = await instance.click(await filesRow(editor, 'b'))
    await until(async () => (await title(editor)) === 'b.md', 'b.md in the note bar at zoom 1.5')
    expect(Math.abs(clicked.page.y - clicked.intended.y)).toBeLessThanOrEqual(1)
    await instance.quit()
  })
})
