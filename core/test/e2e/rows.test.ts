import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

const ROWS = 300
const ROW_HEIGHT = 24
const HOVER = 'rgb(200, 0, 0)'

// A view of one list of 300 rows, each a button with a hover color. A clicked row becomes the selected one: its button
// is drawn again under the same id inside a box with Rename beside it, the box taking the row's place in the list, as
// a file tree draws its selected note. lift, called from the test, draws one row first in the list
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    let instance: string | null = null
    let selected = -1
    let lifted = -1
    const row = (i: number) => ({ kind: 'button', id: 'r' + i, text: 'Row ' + i, style: { width: '100%' }, hover: { 'background-color': '${HOVER}' } })
    const draw = () => {
      if (instance === null) return
      const rows = Array.from({ length: ${ROWS} }, (_, i) => i !== selected ? row(i) : {
        kind: 'box', id: 'chosen', style: { display: 'flex' },
        children: [{ ...row(i), style: { flex: '1 1 auto' } }, { kind: 'button', id: 'rename', text: 'Rename' }],
      })
      if (lifted !== -1) rows.unshift(...rows.splice(lifted, 1))
      void ctx.ui.views.draw(instance, { kind: 'list', id: 'list', rowHeight: ${ROW_HEIGHT}, rows, style: { height: '100%' } } as never).catch(() => {})
    }
    ;(globalThis as Record<string, unknown>).lift = (at: number) => {
      lifted = at
      draw()
    }
    ctx.ui.on('view.opened', event => {
      instance = event.instance
      draw()
    })
    ctx.ui.on('view.event', event => {
      if (event.type !== 'click' || !/^r[0-9]+$/.test(event.node)) return
      selected = Number(event.node.slice(1))
      draw()
    })
  },
})
`

async function started(): Promise<{ app: ElectronApplication, editor: Page }> {
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder: await temp() })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const granted = [{ type: 'ui.view' as const }]
  const root = path.join(dataDir, 'plugins', 'rows')
  await writeFolder(root, filesFor(workerManifest('rows', { capabilities: granted, views: { tree: { title: 'Tree', kind: 'view' } } }), { 'worker.js': built.text }))
  await writeApproved(store, 'rows', root, { granted })
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  await until(async () => (await row(editor, 0).count()) === 1)
  return { app, editor }
}

// Draws one row first in the list, from inside the plugin
async function lift(app: ElectronApplication, at: number): Promise<void> {
  const page = await workersPage(app, 'rows')
  await until(() => page.workers().length === 1)
  await page.workers()[0]!.evaluate(`globalThis.lift(${at})`)
}

const row = (editor: Page, at: number) => editor.locator('#editors .hetu-button', { hasText: new RegExp(`^Row ${at}$`) })
const list = (editor: Page) => editor.locator('#editors .hetu-list')
const rename = (editor: Page) => editor.locator('#editors .hetu-button', { hasText: 'Rename' })
const focused = (editor: Page) => editor.evaluate(() => document.activeElement?.textContent ?? null)

// The rows drawn as the list's own children, by where each starts and ends from the list's top
const drawn = (editor: Page) => list(editor).evaluate(element => [...(element.firstElementChild as HTMLElement).children]
  .map(child => ({ top: (child as HTMLElement).offsetTop, bottom: (child as HTMLElement).offsetTop + (child as HTMLElement).offsetHeight })))

async function scrollTo(editor: Page, top: number): Promise<void> {
  // A list scrolls no further than its last row, so the rows waited for are the ones at where it landed
  const landed = await list(editor).evaluate((element, to) => {
    element.scrollTop = to
    return element.scrollTop
  }, top)
  await until(async () => (await drawn(editor)).some(at => at.top <= landed && at.bottom > landed))
}

async function sizeTo(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'hetu://editor/')?.setSize(size.width, size.height)
  }, { width, height })
}

describe('the rows of a list', () => {
  it('keeps the name of a row drawn again inside the box that took its place, beside Rename', async () => {
    const { editor } = await started()
    await row(editor, 5).click()
    await until(async () => (await rename(editor).count()) === 1)
    const name = (await row(editor, 5).boundingBox())!
    const beside = (await rename(editor).boundingBox())!
    expect(Math.abs(name.y - beside.y)).toBeLessThan(ROW_HEIGHT)
    expect(await row(editor, 5).evaluate(element => element.classList.contains('hetu-row') || element.style.top !== '' || element.style.height !== '')).toBe(false)
    // A row near the end, drawn again in its box, adds nothing past the list's last row to scroll into
    const height = await list(editor).evaluate(element => element.scrollHeight)
    expect(height).toBe(ROWS * ROW_HEIGHT)
    await scrollTo(editor, height)
    await row(editor, ROWS - 3).click()
    await until(async () => (await row(editor, ROWS - 3).evaluate(element => element.parentElement?.classList.contains('hetu-row') === true)))
    expect(await list(editor).evaluate(element => element.scrollHeight)).toBe(ROWS * ROW_HEIGHT)
  })

  it('keeps focus on a row the draw moved into another box, after Enter or a click', async () => {
    const { editor } = await started()
    await row(editor, 7).focus()
    await editor.keyboard.press('Enter')
    await until(async () => (await rename(editor).count()) === 1)
    await until(async () => (await row(editor, 7).evaluate(element => element.parentElement?.classList.contains('hetu-row') === true)))
    expect(await focused(editor)).toBe('Row 7')
    await row(editor, 9).click()
    await until(async () => (await row(editor, 9).evaluate(element => element.parentElement?.classList.contains('hetu-row') === true)))
    expect(await focused(editor)).toBe('Row 9')
    // Row 7 went back to the list's own rows, and focus stayed where it was
    await until(async () => (await row(editor, 7).evaluate(element => element.classList.contains('hetu-row'))))
    expect(await focused(editor)).toBe('Row 9')
  })

  it('draws no row as hovered once the pointer left it, after the draw moved it', async () => {
    const { editor } = await started()
    for (const at of [3, 4, 5]) {
      await row(editor, at).click()
      await until(async () => (await row(editor, at).evaluate(element => element.parentElement?.classList.contains('hetu-row') === true)))
    }
    // The pointer is over row 5 only
    await tick(300)
    const colors = await Promise.all([3, 4].map(at => row(editor, at).evaluate(element => element.style.backgroundColor)))
    expect(colors).toEqual(['', ''])
  })

  it('draws no row as hovered once a draw moved it away from under the pointer', async () => {
    const { app, editor } = await started()
    const box = (await row(editor, 10).boundingBox())!
    await editor.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await until(async () => (await row(editor, 10).evaluate(element => element.style.backgroundColor)) === HOVER)
    await lift(app, 10)
    await until(async () => (await row(editor, 10).evaluate(element => (element as HTMLElement).offsetTop)) === 0)
    await tick(300)
    expect(await row(editor, 10).evaluate(element => element.style.backgroundColor)).toBe('')
  })

  // The window grows to more than three times the list's small height, past the rows drawn a screen beyond each edge,
  // and no taller than the display allows, which on a CI runner's display is under 1000
  it('fills a list whose box grew with the window', async () => {
    const { app, editor } = await started()
    await sizeTo(app, 900, 220)
    await until(async () => (await list(editor).evaluate(element => element.clientHeight)) < 220)
    const small = await list(editor).evaluate(element => element.clientHeight)
    // Drawn again at the small size
    await scrollTo(editor, ROW_HEIGHT)
    await scrollTo(editor, 0)
    const tall = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize.height)
    await sizeTo(app, 900, Math.min(1000, tall))
    await until(async () => (await list(editor).evaluate(element => element.clientHeight)) > small * 3)
    const height = await list(editor).evaluate(element => element.clientHeight)
    await until(async () => Math.max(...(await drawn(editor)).map(at => at.bottom)) >= height, 5_000)
  })

  it('draws rows a screen past each edge of the list, so a fast scroll lands on rows already drawn', async () => {
    const { editor } = await started()
    const height = await list(editor).evaluate(element => element.clientHeight)
    const top = 100 * ROW_HEIGHT
    await scrollTo(editor, top)
    await until(async () => {
      const at = await drawn(editor)
      return Math.min(...at.map(each => each.top)) <= top - height && Math.max(...at.map(each => each.bottom)) >= top + 2 * height
    }, 5_000)
  })

  it('takes away and puts back only the rows that left or came on a scroll, never one still drawn', async () => {
    const { editor } = await started()
    await scrollTo(editor, 50 * ROW_HEIGHT)
    await list(editor).evaluate(element => {
      const scope = globalThis as unknown as { removed: string[] }
      scope.removed = []
      new MutationObserver(changes => {
        for (const change of changes) for (const node of change.removedNodes) scope.removed.push(node.textContent ?? '')
      }).observe(element.firstElementChild as HTMLElement, { childList: true })
    })
    const before = new Set(await list(editor).evaluate(element => [...(element.firstElementChild as HTMLElement).children].map(child => child.textContent)))
    await scrollTo(editor, 53 * ROW_HEIGHT)
    await tick(200)
    const after = new Set(await list(editor).evaluate(element => [...(element.firstElementChild as HTMLElement).children].map(child => child.textContent)))
    const removed = await editor.evaluate(() => (globalThis as unknown as { removed: string[] }).removed)
    expect(removed.length).toBeGreaterThan(0)
    expect(removed.filter(text => before.has(text) && after.has(text))).toEqual([])
  })
})
