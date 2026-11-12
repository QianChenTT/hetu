import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A plugin that hands its ctx to the test, records every ui event and draws each view it opens: a label, a button and
// an input
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    const topics = ['view.opened', 'view.shown', 'view.hidden', 'view.event', 'view.message', 'view.command', 'layout.state', 'layout.event', 'layout.drop', 'layout.resized', 'layout.open', 'layout.close'] as const
    for (const topic of topics) ctx.ui.on(topic, event => heard.push(event))
    ctx.ui.on('view.opened', event => {
      void ctx.ui.views.draw(event.instance, {
        kind: 'box', id: 'root', style: { padding: '8px', display: 'flex', 'flex-direction': 'column', gap: '6px' },
        children: [
          { kind: 'text', id: 'label', text: 'Fixture view ' + event.view },
          { kind: 'button', id: 'press', text: 'Press ' + event.view },
          { kind: 'input', id: 'field', value: '', placeholder: 'Type in ' + event.view },
        ],
      }).catch(() => {})
    })
  },
})
`

type Fixture = { granted: Capability[], manifest?: object, files?: Record<string, string> }
type Setup = { notes?: Record<string, string>, plugins?: Record<string, Fixture>, off?: string[] }

async function prepared(setup: Setup): Promise<{ dataDir: string, folder: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes ?? {})) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: setup.off ?? [] })
  await store.writeLuoshu({ folder })
  if (setup.plugins !== undefined) {
    const source = await temp()
    await writeFolder(source, { 'src/worker.ts': fixture })
    const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
    for (const [id, plugin] of Object.entries(setup.plugins)) {
      const root = path.join(dataDir, 'plugins', id)
      await writeFolder(root, filesFor(workerManifest(id, { capabilities: plugin.granted, ...plugin.manifest }), { 'worker.js': built.text, ...plugin.files }))
      await store.writePlugin(id, await entryFor(root, { granted: plugin.granted }))
    }
  }
  return { dataDir, folder }
}

async function running(dataDir: string, plugins: string[]): Promise<{ app: ElectronApplication, editor: Page }> {
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
  for (const id of plugins) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor }
}

// The column widths the layout plugin last stored, from its key's first line as the storage plugin writes it, or null
// before it stores any
async function started(setup: Setup) {
  const { dataDir, folder } = await prepared(setup)
  return { ...await running(dataDir, Object.keys(setup.plugins ?? {})), dataDir, folder }
}

async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0] as Worker
}

type Scope = { ctx: { ui: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>, editor: Record<string, (...args: unknown[]) => Promise<unknown>> }, heard: { topic: string }[] }
const drive = <T>(worker: Worker, work: (scope: Scope) => Promise<T> | T) => worker.evaluate(`(${work.toString()})(globalThis)`) as Promise<T>
const heard = (worker: Worker) => drive(worker, scope => scope.heard)

async function open(editor: Page, name: string): Promise<void> {
  await editor.keyboard.press('ControlOrMeta+p')
  await until(async () => editor.locator('#palette').isVisible())
  await editor.keyboard.type(name)
  await until(async () => (await editor.locator('#palette-list li').first().innerText()) === name)
  await editor.keyboard.press('Enter')
  await until(async () => (await editor.locator('#title').innerText()).startsWith(name))
}

async function pickLayout(editor: Page, id: string | null): Promise<void> {
  await editor.locator('#views').click()
  await until(async () => editor.locator('#menu').isVisible())
  await editor.locator('#menu select').first().selectOption(id ?? '')
  await editor.locator('#menu-close').click()
}

const view = (name: string, extra: object = {}) => ({ [name]: { title: name[0]!.toUpperCase() + name.slice(1), kind: 'view', ...extra } })
const viewer: Capability[] = [{ type: 'ui.view' }]
const layoutGrants: Capability[] = [{ type: 'ui.layout' }]
const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')

describe("hetu's layout", () => {
  it("draws the editor and a plugin's view, titled under the plugin's name", async () => {
    const { editor } = await started({ notes: { 'a.md': 'alpha' }, plugins: { board: { granted: viewer, manifest: { name: 'Boards', views: view('hetu') } } } })
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').count()) === 1)
    expect(await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').innerText()).toBe('Press hetu')
    // A view titled hetu shows under its plugin's name, in the drawer's own element above the layout
    await until(async () => (await editor.locator('#editors .hetu-title', { hasText: 'board · Hetu' }).count()) === 1)
    await open(editor, 'a.md')
    await until(async () => (await shown(editor).innerText()) === 'alpha')
    await until(async () => (await editor.locator('#editors .hetu-title', { hasText: 'a.md' }).count()) === 1)
  })

  it('moves a view dragged onto another column and keeps it there after a restart', async () => {
    const { app, editor, dataDir } = await started({ notes: { 'a.md': 'alpha' }, plugins: { board: { granted: viewer, manifest: { views: view('cards') } } } })
    await open(editor, 'a.md')
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').count()) === 1)
    const title = editor.locator('#editors .hetu-title', { hasText: 'board · Cards' })
    const from = (await title.boundingBox())!
    const button = (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').boundingBox())!
    const editorBox = (await shown(editor).boundingBox())!
    // The view starts in a side column, left of the editor
    expect(button.x).toBeLessThan(editorBox.x)
    await editor.mouse.move(from.x + 10, from.y + from.height / 2)
    await editor.mouse.down()
    await editor.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + 40, { steps: 8 })
    await until(async () => editor.locator('#drop-mark').isVisible())
    await editor.mouse.move(editorBox.x + editorBox.width / 2, editorBox.y + 60, { steps: 2 })
    await editor.mouse.up()
    // Dropped on main, the view shows there in place of the note, and the side it left is gone
    await until(async () => (await editor.locator('.editor:not([hidden])').count()) === 0)
    expect(await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').isVisible()).toBe(true)
    expect(await editor.locator('#base .hetu-divider').count()).toBe(0)
    await app.close()
    // Started again with no note open, main still shows the view rather than the empty editor
    const again = await running(dataDir, ['board'])
    await until(async () => (await again.editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').count()) === 1)
    expect(await again.editor.locator('#empty').isVisible()).toBe(false)
    expect(await again.editor.locator('#base .hetu-divider').count()).toBe(0)
  })

  it('keeps the width the human dragged a column to', async () => {
    const { app, editor, dataDir } = await started({ plugins: { board: { granted: viewer, manifest: { views: view('cards') } } } })
    await until(async () => (await editor.locator('#base .hetu-divider').count()) >= 1)
    const divider = (await editor.locator('#base .hetu-divider').first().boundingBox())!
    await editor.mouse.move(divider.x + 2, divider.y + 100)
    await editor.mouse.down()
    await editor.mouse.move(divider.x + 102, divider.y + 100, { steps: 6 })
    await editor.mouse.up()
    await until(async () => Math.abs((await editor.locator('#base .hetu-divider').first().boundingBox())!.x - (divider.x + 100)) < 4)
    // Closed as soon as the divider settles: the layout's stop waits for its write
    await app.close()
    const again = await running(dataDir, ['board'])
    await until(async () => (await again.editor.locator('#base .hetu-divider').count()) >= 1)
    await until(async () => Math.abs((await again.editor.locator('#base .hetu-divider').first().boundingBox())!.x - (divider.x + 100)) < 4)
  })

  it('folds the side whose views rank lowest in a narrow window, and a favorite keeps its side open', async () => {
    const { app, editor } = await started({ plugins: { board: { granted: viewer, manifest: { views: { ...view('alpha'), ...view('beta') } } } } })
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').count()) === 2)
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(each => each.webContents.getURL() === 'hetu://editor/')
      window?.setContentSize(600, 700)
    })
    // alpha ranks above beta by name, so beta's side folds to a rail and its view goes
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').allInnerTexts()).join() === 'Press alpha')
    await editor.locator('#views').click()
    await editor.locator('#menu li[data-view="board/beta"] .menu-star').click()
    await editor.locator('#menu-close').click()
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').allInnerTexts()).join() === 'Press beta')
  })
})

describe('input by owner', () => {
  it('sends a click and typing in a view to its owner only, never to the layout', async () => {
    const { app, editor } = await started({
      plugins: { board: { granted: viewer, manifest: { views: view('cards') } }, tiles: { granted: layoutGrants } },
    })
    await pickLayout(editor, 'tiles')
    const layout = await pluginWorker(app, 'tiles')
    await until(async () => (await heard(layout)).some(event => event.topic === 'layout.state'))
    await drive(layout, async scope => {
      const state = (scope.heard.filter(event => event.topic === 'layout.state').at(-1) as unknown as { state: { views: { instance: string }[] } }).state
      await scope.ctx.ui.layout.draw({
        kind: 'box', id: 'root', style: { display: 'flex', height: '100%' },
        children: [
          { kind: 'slot', id: 's', instance: state.views[0]!.instance, style: { width: '300px' } },
          { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } },
        ],
      })
    })
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-input').count()) === 1)
    await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-button').click()
    await editor.locator('#editors .hetu-surface:not([hidden]) .hetu-input').click()
    await editor.keyboard.type('pin 4242')
    const board = await pluginWorker(app, 'board')
    await until(async () => (await heard(board)).some(event => event.topic === 'view.event' && (event as { value?: string }).value === 'pin 4242'))
    expect((await heard(board)).some(event => event.topic === 'view.event' && (event as { type?: string }).type === 'click')).toBe(true)
    const layoutHeard = await heard(layout)
    expect(layoutHeard.filter(event => event.topic === 'view.event' || event.topic === 'layout.event')).toEqual([])
    expect(JSON.stringify(layoutHeard)).not.toContain('4242')
  })
})

describe('a layout redrawing to mislead (A-30)', () => {
  async function withLayout(setup: Setup) {
    const made = await started({ ...setup, plugins: { ...setup.plugins, cover: { granted: layoutGrants, ...setup.plugins?.cover } } })
    await pickLayout(made.editor, 'cover')
    const layout = await pluginWorker(made.app, 'cover')
    await until(async () => (await heard(layout)).some(event => event.topic === 'layout.state'))
    return { ...made, layout }
  }

  it('keeps the editor above a box the layout lays over it, and refuses position fixed', async () => {
    const { editor, layout } = await withLayout({ notes: { 'a.md': 'the real words' } })
    await open(editor, 'a.md')
    const refused = await drive(layout, async scope => {
      await scope.ctx.ui.layout.draw({
        kind: 'box', id: 'root', style: { position: 'relative', height: '100%' },
        children: [
          { kind: 'editor', id: 'e', instance: 'current', style: { position: 'absolute', inset: '0' } },
          { kind: 'box', id: 'cover', style: { position: 'absolute', inset: '0', 'z-index': '9', 'background-color': '#ff0000' }, children: [{ kind: 'text', id: 'fake', text: 'nothing to see' }] },
        ],
      })
      return scope.ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { position: 'fixed', inset: '0' } }).then(() => 'ok', (err: { code: string }) => err.code)
    })
    expect(refused).toBe('invalid')
    await until(async () => (await editor.locator('#base .hetu-text', { hasText: 'nothing to see' }).count()) === 1)
    const box = (await shown(editor).boundingBox())!
    const hit = await editor.evaluate(([x, y]) => document.elementFromPoint(x as number, y as number)?.closest('.cm-content') !== null, [box.x + box.width / 2, box.y + 10])
    expect(hit).toBe(true)
    expect(await shown(editor).innerText()).toBe('the real words')
  })

  it('draws the editor in hetu\'s colors under a theme whose text matches its background, and says so', async () => {
    const theme = { tokens: { 'color-editor-fg': '#fefefe', 'color-editor-bg': '#ffffff', 'color-bg': '#202020' } }
    const { editor } = await started({ notes: { 'a.md': 'readable' }, plugins: { dusk: { granted: [], manifest: { theme } } } })
    await open(editor, 'a.md')
    await editor.locator('#views').click()
    await editor.locator('#menu select').nth(1).selectOption('dusk')
    await until(async () => (await editor.locator('#menu .menu-note').allInnerTexts()).some(text => text.includes('too close to read')))
    const colors = await shown(editor).evaluate(element => {
      const style = getComputedStyle(element.closest('.cm-editor') as Element)
      return { fg: style.color, bg: style.backgroundColor }
    })
    expect(colors).toEqual({ fg: 'rgb(31, 31, 31)', bg: 'rgb(255, 255, 255)' })
    // The rest of the theme applies to the base layer
    expect(await editor.locator('#base').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(32, 32, 32)')
  })

  it('shows the real text with Ctrl+/ under a layout that places no editor', async () => {
    const { editor, layout } = await withLayout({ notes: { 'a.md': '**hidden** markers' } })
    await drive(layout, scope => scope.ctx.ui.layout.draw({ kind: 'box', id: 'root', children: [{ kind: 'text', id: 't', text: 'No editor here' }] }))
    await until(async () => (await editor.locator('#base .hetu-text', { hasText: 'No editor here' }).count()) === 1)
    await open(editor, 'a.md')
    expect(await editor.locator('.editor:not([hidden])').count()).toBe(0)
    await editor.keyboard.press('ControlOrMeta+/')
    await until(async () => editor.locator('#raw').isVisible())
    expect(await editor.locator('#raw-text').innerText()).toBe('**hidden** markers')
  })
})

describe('notes opened by plugins', () => {
  it('opens a note inside the plugin\'s read scope and refuses one outside', async () => {
    const { app, editor } = await started({
      notes: { 'a.md': 'open me', 'secret.md': 'not you' },
      plugins: { opener: { granted: [{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['a.md'] }] } },
    })
    const worker = await pluginWorker(app, 'opener')
    const codes = await drive(worker, async scope => Promise.all([
      scope.ctx.editor.open('a.md').then(() => 'ok', (err: { code: string }) => err.code),
      scope.ctx.editor.open('secret.md').then(() => 'ok', (err: { code: string }) => err.code),
    ]))
    expect(codes).toEqual(['ok', 'not-granted'])
    await until(async () => (await editor.locator('#title').innerText()) === 'a.md')
    expect(await shown(editor).innerText()).toBe('open me')
  })
})

describe('a layout that fails', () => {
  it('leaves the drawer\'s plain layout with the notes still open', async () => {
    const { editor, layout, dataDir } = await (async () => {
      const made = await started({ notes: { 'a.md': 'still here' }, plugins: { cover: { granted: layoutGrants } } })
      await pickLayout(made.editor, 'cover')
      const worker = await pluginWorker(made.app, 'cover')
      return { ...made, layout: worker }
    })()
    await drive(layout, scope => scope.ctx.ui.layout.draw({ kind: 'box', id: 'root', children: [{ kind: 'text', id: 't', text: 'Cover layout' }] }))
    await until(async () => (await editor.locator('#base .hetu-text', { hasText: 'Cover layout' }).count()) === 1)
    await open(editor, 'a.md')
    await layout.evaluate('globalThis.close()').catch(() => {})
    await until(() => logged(dataDir, 'plugin.crashed', { plugin: 'cover' }))
    await until(async () => (await editor.locator('#base .hetu-text', { hasText: 'Cover layout' }).count()) === 0)
    await until(async () => (await shown(editor).innerText()) === 'still here')
  })
})
