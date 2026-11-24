import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, type Plugin, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, exists, launch, logged, pageAt, records, temp, tick, until, visibleWindows, workersPage, openByHand, writeOpener } from './helpers.ts'

// Plugins drawing to mislead or to take what the human types, as the review of the views tried them, and writing notes
// before the human's Confirm or past the folder the human narrowed them to, each held

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    const topics = ['view.opened', 'view.event', 'view.message', 'layout.state', 'layout.event', 'layout.drop', 'layout.open'] as const
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

// entry is what the human's approval left beside the grant, such as the class and the items asking at their first use
type Fixture = { granted: Capability[], manifest?: object, files?: Record<string, string>, entry?: Partial<Plugin> }

type Setup = { notes?: Record<string, string>, plugins?: Record<string, Fixture> }

async function started(setup: Setup): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, folder: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes ?? {})) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
    await writeFile(path.join(folder, name), text)
  }
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
  await writeOpener(dataDir)
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  for (const [id, plugin] of Object.entries(setup.plugins ?? {})) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: plugin.granted, ...plugin.manifest }), { 'worker.js': built!.text, ...plugin.files }))
    await writeApproved(store, id, root, { granted: plugin.granted, ...plugin.entry })
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  for (const id of Object.keys(setup.plugins ?? {})) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor, dataDir, folder }
}

// A plugin's worker, in the host page of its own
async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0] as Worker
}

type Heard = { topic: string, instance?: string, node?: string, type?: string, value?: unknown, data?: unknown, state?: { editors: string[], views: { instance: string }[] } }
const heard = (worker: Worker) => worker.evaluate('globalThis.heard') as Promise<Heard[]>
const run = <T>(worker: Worker, code: string) => worker.evaluate(`(async () => { const ctx = globalThis.ctx; const heard = globalThis.heard; ${code} })()`) as Promise<T>

const open = openByHand

async function pickLayout(editor: Page, id: string | null): Promise<void> {
  await editor.locator('#views').click()
  await until(async () => editor.locator('#menu').isVisible())
  await editor.locator('#menu select').first().selectOption(id ?? '')
  await editor.locator('#menu-close').click()
}

const view = (name: string) => ({ [name]: { title: name[0]!.toUpperCase() + name.slice(1), kind: 'view' } })
const viewer: Capability[] = [{ type: 'ui.view' }]
const layoutGrants: Capability[] = [{ type: 'ui.layout' }]
const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')
const hitAt = (editor: Page, x: number, y: number) => editor.evaluate(([px, py]) => {
  const at = document.elementFromPoint(px as number, py as number)
  return { inEditor: at?.closest('.cm-content') !== null, inTitle: at?.closest('.hetu-title') !== null }
}, [x, y])
// The fixture's button, of the plugins a test runs
const viewButton = (editor: Page) => editor.locator('#editors .hetu-surface .hetu-button', { hasText: 'Press ' })

async function withLayout(setup: { notes?: Record<string, string>, plugins?: Record<string, Fixture> }) {
  const made = await started({ ...setup, plugins: { ...setup.plugins, tiles: { granted: layoutGrants } } })
  await pickLayout(made.editor, 'tiles')
  const layout = await pluginWorker(made.app, 'tiles')
  await until(async () => (await heard(layout)).some(event => event.topic === 'layout.state'))
  return { ...made, layout }
}

// The fixture layout drawing each open view titled in a column beside the note's editor, again at every state, since
// hetu has no layout of its own to place them
async function inColumns(setup: { notes?: Record<string, string>, plugins?: Record<string, Fixture> }) {
  const made = await withLayout(setup)
  await run(made.layout, `
    const draw = state => ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { display: 'flex', height: '100%' }, children: [
      ...state.views.map(view => ({ kind: 'box', id: 'c-' + view.instance, style: { display: 'flex', 'flex-direction': 'column', width: '300px' }, children: [
        { kind: 'title', id: 't-' + view.instance, of: view.instance },
        { kind: 'slot', id: 's-' + view.instance, instance: view.instance, style: { flex: '1' } } ] })),
      { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } } ] }).catch(() => {})
    ctx.ui.on('layout.state', event => { void draw(event.state) })
    await draw(heard.filter(e => e.topic === 'layout.state').at(-1).state)
  `)
  return made
}

// The page picks the first layout plugin that comes while none is picked, so a first layout installed draws with no
// pick of the human's
describe('the first layout', () => {
  it('draws once it starts with no layout picked', async () => {
    const { app, editor } = await started({ notes: { 'a.md': 'alpha' }, plugins: { tiles: { granted: layoutGrants } } })
    const layout = await pluginWorker(app, 'tiles')
    await until(async () => (await heard(layout)).some(event => event.topic === 'layout.state'))
    await editor.locator('#views').click()
    await until(async () => editor.locator('#menu').isVisible())
    expect(await editor.locator('#menu select').first().inputValue()).toBe('tiles')
  })
})

describe('a popover', () => {
  it('keeps its owner strip on top of it and its size within the drawer\'s cap, whatever style the plugin gives it', async () => {
    const { app, editor } = await inColumns({ notes: { 'a.md': 'the real words' }, plugins: { board: { granted: viewer, manifest: { name: 'Boards', views: view('cards') } } } })
    await until(async () => (await viewButton(editor).count()) === 1)
    const board = await pluginWorker(app, 'board')
    const answer = await run<string>(board, `
      const instance = heard.find(e => e.topic === 'view.opened').instance
      return ctx.ui.views.draw(instance, { kind: 'box', id: 'root', children: [
        { kind: 'button', id: 'anchor', text: 'A' },
        { kind: 'popover', id: 'pop', anchor: 'anchor', side: 'below',
          style: { position: 'relative', top: '-40px', width: '100%', height: '200%', 'max-width': 'none', 'max-height': 'none', order: '-1', 'z-index': '9', 'background-color': '#ffffff' },
          children: [{ kind: 'input', id: 'fake', value: 'the real words', style: { width: '3000px', height: '2000px' } }] },
      ] }).then(() => 'ok', err => err.code)
    `)
    expect(answer).toBe('ok')
    await until(async () => (await editor.locator('#overlay .hetu-popover').count()) === 1)
    const measured = await editor.evaluate(() => {
      const stage = document.querySelector('#stage')!.getBoundingClientRect()
      const popover = document.querySelector('#overlay .hetu-popover')!.getBoundingClientRect()
      const strip = document.querySelector('#overlay .hetu-strip') as HTMLElement
      const at = strip.getBoundingClientRect()
      const top = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)
      return {
        strip: strip.textContent, stripOnTop: top === strip, stripAtTop: Math.abs(at.top - popover.top) < 3,
        width: popover.width / innerWidth, height: popover.height / innerHeight, inStage: at.top >= stage.top && at.bottom <= stage.bottom,
      }
    })
    expect(measured).toMatchObject({ strip: 'board', stripOnTop: true, stripAtTop: true, inStage: true })
    expect(measured.width).toBeLessThanOrEqual(0.61)
    expect(measured.height).toBeLessThanOrEqual(0.61)
  })
})

describe('a plugin named hetu', () => {
  it('shows under its id in titles and strips, never the name it picked', async () => {
    const { app, editor } = await inColumns({ plugins: { board: { granted: viewer, manifest: { name: 'hetu', views: { checks: { title: 'Security check', kind: 'view' } } } } } })
    await until(async () => (await viewButton(editor).count()) === 1)
    const board = await pluginWorker(app, 'board')
    await run(board, `
      const instance = heard.find(e => e.topic === 'view.opened').instance
      await ctx.ui.views.draw(instance, { kind: 'box', id: 'root', children: [
        { kind: 'button', id: 'anchor', text: 'A' },
        { kind: 'popover', id: 'pop', anchor: 'anchor', side: 'below', children: [{ kind: 'text', id: 't', text: 'Confirm to keep your notes safe' }] },
      ] })
    `)
    await until(async () => (await editor.locator('#overlay .hetu-strip').count()) === 1)
    // The note list the tests open notes through is a view of its own, titled under its id
    expect((await editor.locator('#editors .hetu-title').allInnerTexts()).filter(text => !text.startsWith('note-list ·'))).toEqual(['board · Security check'])
    expect(await editor.locator('#overlay .hetu-strip').allInnerTexts()).toEqual(['board'])
  })
})

describe('a layout that never draws', () => {
  it('leaves the plain layout with the note on screen, and Plain picks the drawer\'s own', async () => {
    const { editor } = await withLayout({ notes: { 'a.md': 'alpha' }, plugins: { board: { granted: viewer, manifest: { views: view('cards') } } } })
    await open(editor, 'a.md')
    await until(async () => (await shown(editor).innerText()) === 'alpha')
    expect(await editor.locator('#base .hetu-plain').count()).toBe(1)
    await pickLayout(editor, null)
    await tick(800)
    expect(await editor.locator('#base .hetu-plain').count()).toBe(1)
    // No layout draws, so the drawer's own plain column holds the view under its title
    expect((await editor.locator('#editors .hetu-title').allInnerTexts()).filter(text => !text.startsWith('note-list ·'))).toEqual(['board · Cards'])
    await editor.locator('#views').click()
    expect(await editor.locator('#menu select').first().evaluate(select => (select as HTMLSelectElement).selectedOptions[0]?.textContent)).toBe('Plain')
  })
})

describe('input in a view', () => {
  it('stays with the view: a click and a press reach no layout node around its slot', async () => {
    const { app, editor, layout } = await withLayout({
      notes: { 'a.md': 'alpha', 'b.md': 'bravo' },
      plugins: { board: { granted: viewer, manifest: { views: view('cards') } } },
    })
    await open(editor, 'a.md')
    await run(layout, `
      const state = heard.filter(e => e.topic === 'layout.state').at(-1).state
      await ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { display: 'flex', height: '100%' }, children: [
        { kind: 'box', id: 'wrap', click: true, drag: { type: 'note', value: 'b.md' }, style: { width: '300px' }, children: [
          { kind: 'slot', id: 's', instance: state.views.find(v => v.owner === 'board').instance, style: { height: '100%' } } ] },
        { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } } ] })
    `)
    await until(async () => (await viewButton(editor).count()) === 1)
    const board = await pluginWorker(app, 'board')
    await viewButton(editor).click()
    await editor.locator('#editors .hetu-surface .hetu-text', { hasText: 'Fixture view' }).click()
    await until(async () => (await heard(board)).some(event => event.topic === 'view.event' && event.type === 'click'))
    await tick(500)
    expect(await editor.locator('#title').innerText()).toBe('a.md')
    expect((await heard(layout)).filter(event => event.topic === 'layout.event')).toEqual([])
  })

  it('reaches the view even under a clear input the layout lays over its slot', async () => {
    const { app, editor, layout } = await withLayout({ plugins: { board: { granted: viewer, manifest: { views: view('cards') } } } })
    await run(layout, `
      const state = heard.filter(e => e.topic === 'layout.state').at(-1).state
      await ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { position: 'relative', display: 'flex', height: '100%' }, children: [
        { kind: 'slot', id: 's', instance: state.views.find(v => v.owner === 'board').instance, style: { width: '300px' } },
        { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } },
        { kind: 'input', id: 'trap', value: '', style: { position: 'absolute', left: '0', top: '0', width: '300px', height: '100%', opacity: '0', 'z-index': '9' } } ] })
    `)
    await until(async () => (await editor.locator('#base .hetu-input').count()) === 1 && (await viewButton(editor).count()) === 1)
    const board = await pluginWorker(app, 'board')
    const field = (await editor.locator('#editors .hetu-surface .hetu-input[placeholder="Type in cards"]').boundingBox())!
    await editor.mouse.click(field.x + field.width / 2, field.y + field.height / 2)
    await editor.keyboard.type('pin 4242')
    await until(async () => (await heard(board)).some(event => event.topic === 'view.event' && event.value === 'pin 4242'))
    expect(JSON.stringify(await heard(layout))).not.toContain('4242')
  })
})

describe('the editor\'s text', () => {
  it('stays above a title the layout lays over its lines', async () => {
    const { editor, layout } = await withLayout({ notes: { 'a.md': 'first line\nsecond line\nthird line' } })
    await open(editor, 'a.md')
    await run(layout, `
      await ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { position: 'relative', height: '100%' }, children: [
        { kind: 'editor', id: 'e', instance: 'current', style: { position: 'absolute', inset: '0' } } ] })
    `)
    await until(async () => (await heard(layout)).some(event => event.topic === 'layout.state' && (event.state?.editors.length ?? 0) === 1))
    const line = (await editor.locator('.editor:not([hidden]) .cm-line', { hasText: 'second line' }).boundingBox())!
    const stage = (await editor.locator('#stage').boundingBox())!
    const top = Math.round(line.y - stage.y)
    await run(layout, `
      const state = heard.filter(e => e.topic === 'layout.state').at(-1).state
      await ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { position: 'relative', height: '100%' }, children: [
        { kind: 'editor', id: 'e', instance: 'current', style: { position: 'absolute', inset: '0' } },
        { kind: 'title', id: 't', of: state.editors[0], style: { position: 'absolute', left: '0', top: '${top}px', width: '100%', height: '20px' } } ] })
    `)
    await until(async () => (await editor.locator('#editors .hetu-title').count()) === 1)
    expect(await hitAt(editor, line.x + 20, line.y + line.height / 2)).toEqual({ inEditor: true, inTitle: false })
  })

  it('keeps the human\'s typing where it was when a plugin opens another note', async () => {
    const { app, editor } = await started({
      notes: { 'a.md': '', 'b.md': 'bravo' },
      plugins: { opener: { granted: [{ type: 'ui.view' }, { type: 'luoshu.read', paths: ['b.md'] }] } },
    })
    const worker = await pluginWorker(app, 'opener')
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.type('abc', { delay: 30 })
    expect(await run<string>(worker, `return ctx.editor.open('b.md').then(() => 'ok', err => err.code)`)).toBe('ok')
    await tick(300)
    await editor.keyboard.type('xyz', { delay: 30 })
    await until(async () => (await shown(editor).innerText()) === 'abcxyz')
    expect(await editor.locator('#title').innerText()).toBe('a.md (unsaved)')
  })
})

describe('a busy view', () => {
  it('leaves typing in the editor working while it changes one text of a large tree ten times a second', async () => {
    const { app, editor } = await inColumns({ notes: { 'a.md': '' }, plugins: { board: { granted: viewer, manifest: { views: view('cards') } } } })
    await until(async () => (await viewButton(editor).count()) === 1)
    const board = await pluginWorker(app, 'board')
    await open(editor, 'a.md')
    await shown(editor).click()
    await run(board, `
      const instance = heard.find(e => e.topic === 'view.opened').instance
      const leaves = []
      for (let i = 0; i < 9999; i++) leaves.push({ kind: 'text', id: 'l' + i, text: 'x' })
      globalThis.instance = instance
      await ctx.editor.call('view.draw', { instance, ops: [{ op: 'tree', root: { kind: 'box', id: 'root', children: leaves } }] })
    `)
    await tick(1500)
    // The loop runs on while the test types and may outlive the app at the end
    void run(board, `
      const until = Date.now() + 6000
      let round = 0
      while (Date.now() < until) {
        round++
        ctx.editor.call('view.draw', { instance: globalThis.instance, ops: [{ op: 'text', id: 'l9998', text: 'y' + round }] }).catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    `).catch(() => {})
    await tick(300)
    const before = Date.now()
    const text = ' typing while the view is busy'
    await editor.keyboard.type(text, { delay: 20 })
    // CodeMirror draws the leading space as a non-breaking one
    await until(async () => (await shown(editor).innerText()).endsWith(text.trim()), 30_000)
    // Unhindered this takes under a second. Drawing every text again on each draw took 45 s
    expect(Date.now() - before).toBeLessThan(5000)
  })
})

// A frame's rows: arrow keys move between them and Enter or a click opens one, as a file list would. It tells its
// worker each key it hears and each row opened. Told to, it takes focus on its own, once after a while or each time it
// loses it
const frameScript = `
var rows = [].slice.call(document.querySelectorAll('button'))
var current = 0
var port = null
function say(data) { if (port) port.postMessage(JSON.stringify(data)) }
rows.forEach(function (row, at) {
  row.addEventListener('click', function () { say({ opened: row.textContent }) })
  row.addEventListener('focus', function () { current = at })
})
document.addEventListener('keydown', function (event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    rows[Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))].focus()
  }
  say({ key: event.key })
})
window.addEventListener('focus', function () { say({ focused: true }) })
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (data && typeof data.steal === 'number') setTimeout(function () { rows[0].focus(); say({ stole: true }) }, data.steal)
    if (data && data.sticky === true) window.addEventListener('blur', function () { setTimeout(function () { rows[0].focus(); say({ stole: true }) }, 0) })
  }
  say({ hello: true })
})
`
const row = (name: string) => `<button style="display:block;width:200px;height:30px;margin:0">${name}</button>`
const framePage = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${['row-1', 'row-2', 'row-3'].map(row).join('')}<script src="board.js"></script></body></html>`

type Said = { hello?: true, opened?: string, key?: string, stole?: true, focused?: true }
type Press = { down: boolean, x: number, y: number }

describe('a view frame', () => {
  // Each plugin of ids with a frame view in a column, side by side in that order, its frame loaded and laid out
  async function framed(ids = ['kanban']) {
    const plugin: Fixture = {
      granted: viewer,
      manifest: { entries: { worker: 'worker.js', frames: { board: 'board.html' } }, views: { board: { title: 'Board', kind: 'view', frame: 'board' } } },
      files: { 'board.html': framePage, 'board.js': frameScript },
    }
    const made = await inColumns({ notes: { 'a.md': '' }, plugins: Object.fromEntries(ids.map(id => [id, plugin])) })
    const workers = await Promise.all(ids.map(id => pluginWorker(made.app, id)))
    const said = async (at = 0) => (await heard(workers[at]!)).filter(event => event.topic === 'view.message').map(event => event.data as Said)
    for (let at = 0; at < ids.length; at++) {
      await until(async () => (await said(at)).length >= 1)
      await until(async () => ((await frameOf(made.editor, ids[at]!).boundingBox())?.width ?? 0) > 0)
    }
    return { ...made, workers, said }
  }
  const frameOf = (editor: Page, id: string) => editor.locator(`#editors iframe.hetu-frame[src^="hetu://${id}.views/"]`)
  // A point in a frame's first row, on the page
  const inRow = async (editor: Page, id: string) => {
    const box = (await frameOf(editor, id).boundingBox())!
    return { x: box.x + 20, y: box.y + 12 }
  }

  it('is found under each press and release main pushes at its point on the page, with two frames side by side', async () => {
    const { editor } = await framed(['kanban', 'board'])
    await editor.evaluate(() => {
      const scope = window as unknown as { pushed: unknown[] }
      scope.pushed = []
      window.addEventListener('message', event => {
        const data = event.data as { hetu?: unknown, press?: unknown } | null
        if (event.source === window && data?.hetu === 'press') scope.pushed.push(data.press)
      })
    })
    // The same point within each frame, which main gets as the frame's own x and y
    for (const id of ['kanban', 'board']) {
      const at = await inRow(editor, id)
      await editor.mouse.click(at.x, at.y)
      await until(async () => (await editor.evaluate('window.pushed.length')) === 2)
      const pushed = await editor.evaluate(() => (window as unknown as { pushed: Press[] }).pushed.splice(0).map(press => ({
        ...press, host: new URL(document.elementFromPoint(press.x, press.y)?.getAttribute('src') ?? 'hetu://page/').host,
      })))
      expect(pushed.map(press => [press.down, press.host])).toEqual([[true, `${id}.views`], [false, `${id}.views`]])
      for (const press of pushed) {
        expect(Math.abs(press.x - at.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(press.y - at.y)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('takes focus on a press in it, then works its own rows with arrow keys and Enter', async () => {
    const { editor, said } = await framed()
    await open(editor, 'a.md')
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    // Past the check that would pull focus back
    await tick(300)
    await editor.keyboard.press('ArrowDown')
    await editor.keyboard.press('Enter')
    await until(async () => (await said()).some(data => data.opened === 'row-2'))
    expect((await said()).filter(data => data.key !== undefined).map(data => data.key)).toEqual(['ArrowDown', 'Enter'])
    expect(await editor.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
  })

  // Tells the plugin's frame what to do, as data
  const tell = (worker: Worker, data: object) => run(worker, `
    const instance = heard.find(e => e.topic === 'view.opened').instance
    await ctx.ui.views.post(instance, ${JSON.stringify(data)})
  `)

  it('gets none of the typing at a key each 150 ms when it takes focus with no press, which the core records', async () => {
    const { editor, workers, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.type('abc', { delay: 150 })
    await tell(workers[0]!, { steal: 400 })
    await editor.keyboard.type('defghijkl', { delay: 150 })
    await until(async () => (await shown(editor).innerText()) === 'abcdefghijkl')
    expect((await said()).some(data => data.stole === true)).toBe(true)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
    expect(await frameOf(editor, 'kanban').count()).toBe(1)
    await until(() => logged(dataDir, 'frame.focus-taken', { plugin: 'kanban' }))
  })

  it('gets none of the typing when it focuses itself after the human pressed in it and then back in the note', async () => {
    const { editor, workers, said } = await framed()
    await open(editor, 'a.md')
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await shown(editor).click()
    await tell(workers[0]!, { steal: 400 })
    await editor.keyboard.type('abcdefgh', { delay: 150 })
    await until(async () => (await shown(editor).innerText()) === 'abcdefgh')
    expect((await said()).some(data => data.stole === true)).toBe(true)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
  })

  // Pulled back each time it takes focus again, so the two run in a loop and the note may get none of the typing either
  it('gets none of the typing when it takes focus back each time it loses it', async () => {
    const { editor, workers, said } = await framed()
    await open(editor, 'a.md')
    await tell(workers[0]!, { sticky: true })
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await shown(editor).click()
    await until(async () => (await said()).some(data => data.stole === true))
    await tick(300)
    await editor.keyboard.type('abcdefgh', { delay: 150 })
    await tick(300)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
  })

  it('gets none of the typing when it takes focus from another frame the human pressed in, which the core records for its plugin', async () => {
    const { editor, workers, said, dataDir } = await framed(['kanban', 'board'])
    await open(editor, 'a.md')
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said(0)).some(data => data.opened === 'row-1'))
    await tick(300)
    await tell(workers[1]!, { steal: 0 })
    await until(async () => (await said(1)).some(data => data.stole === true))
    await tick(300)
    await editor.keyboard.type('xyz', { delay: 150 })
    await until(async () => (await shown(editor).innerText()) === 'xyz')
    expect((await said(1)).filter(data => data.key !== undefined)).toEqual([])
    await until(() => logged(dataDir, 'frame.focus-taken', { plugin: 'board' }))
    expect(await logged(dataDir, 'frame.focus-taken', { plugin: 'kanban' })).toBe(false)
  })

  // Keys Playwright sends never pass the window's before-input-event, so main's own handler is handed the key as the
  // window's input would hand it. Answers whether main kept the key from the page and its frames
  const keyInMain = (app: ElectronApplication, key: string) => app.evaluate(({ webContents }, [pressed, mac]) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
    let prevented = false
    const input = { type: 'keyDown', key: pressed, code: '', control: !mac, meta: mac, alt: false, shift: false, isAutoRepeat: false }
    contents.emit('before-input-event', { preventDefault: () => { prevented = true } }, input)
    return prevented
  }, [key, process.platform === 'darwin'] as const)

  it('hands the core a core key pressed while focus is in it', async () => {
    const { app, editor, said } = await framed()
    await open(editor, 'a.md')
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(300)
    expect(await keyInMain(app, '/')).toBe(true)
    await until(async () => editor.locator('#raw').isVisible())
  })

  it('hands its plugin a key the plugin bound for its views, as view.command, while focus is in it', async () => {
    const { app, editor, workers, said } = await framed()
    await run(workers[0]!, `
      ctx.ui.on('view.command', event => heard.push(event))
      await ctx.ui.views.bind([{ key: 'Mod-k', command: 'down' }])
    `)
    await open(editor, 'a.md')
    // Focus in the note: the key is the note's
    await shown(editor).click()
    await tick(300)
    expect(await keyInMain(app, 'k')).toBe(false)
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(300)
    expect(await keyInMain(app, 'k')).toBe(true)
    await until(async () => (await heard(workers[0]!)).some(event => event.topic === 'view.command'))
    expect((await heard(workers[0]!)).filter(event => event.topic === 'view.command')).toEqual([expect.objectContaining({ topic: 'view.command', command: 'down' })])
  })

  it('is never reached by Tab from the note', async () => {
    const { editor, said } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    for (let i = 0; i < 8; i++) await editor.keyboard.press('Tab')
    await tick(300)
    expect((await said()).filter(data => data.focused === true || data.key !== undefined)).toEqual([])
  })
})

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300
const listAll: Capability = { type: 'luoshu.list', paths: ['**'] }
const readAll: Capability = { type: 'luoshu.read', paths: ['**'] }
const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }

const files = async (folder: string) => (await readdir(folder, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

// What the writer's worker gets back for each call, the error's code for a refused one
const write = (worker: Worker, note: string) => run<string>(worker, `return ctx.luoshu.write({ path: '${note}', text: '' }).then(() => 'ok', err => err.code)`)
const move = (worker: Worker, from: string, to: string) => run<string>(worker, `return ctx.luoshu.move({ from: '${from}', to: '${to}' }).then(() => 'ok', err => err.code)`)
// A remove names the version it read, as a plugin binning a note it can see does
const remove = (worker: Worker, note: string) => run<string>(worker, `
  return ctx.luoshu.read({ path: '${note}' }).then(read => ctx.luoshu.remove({ path: '${note}', baseVersion: read.version })).then(() => 'ok', err => err.code)
`)

// Puts back what the Windows recycle bin holds from folder, so no run leaves its notes there. Read through the shell's
// own view of the bin, which names each item's original folder
async function putBack(folder: string): Promise<void> {
  if (process.platform !== 'win32') return
  const from = await realpath(folder)
  const script = [
    '$bin = (New-Object -ComObject Shell.Application).NameSpace(10)',
    `$from = '${from.replace(/'/g, "''")}'`,
    "$bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1) -eq $from } | ForEach-Object { $_.InvokeVerb('undelete') }",
  ].join('; ')
  execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
}

const WRITER = 'writer'

describe('a plugin writing notes', () => {
  // Write on every note is class 4 and asks at its first use, as its approval classed it
  it('asks once in the trusted window before its first write, writing nothing before the Confirm, then moves and removes unasked', async () => {
    const notes = { 'a.md': 'alpha', 'inbox/b.md': 'beta' }
    const granted = [listAll, readAll, writeAll]
    const { app, editor, dataDir, folder } = await started({ notes, plugins: { [WRITER]: { granted, entry: { class: 4, firstUse: [writeAll] } } } })
    try {
      expect((await new StateStore(dataDir).load()).state.plugins[WRITER]).toMatchObject({ class: 4, granted, firstUse: [writeAll] })
      const writer = await pluginWorker(app, WRITER)

      // The first write asks, writes nothing before the Confirm and answers needs-confirm
      expect(await write(writer, 'inbox/new.md')).toBe('needs-confirm')
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)
      const notice = editor.getByRole('button', { name: `The plugin "${WRITER}" asks to use something for the first time` })
      await notice.waitFor()
      await tick(PAST_DELAY)
      await notice.click()
      const page = await pageAt(app, 'hetu://trusted/')
      await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
      await until(async () => (await page.locator('#root').innerText()).includes(`Let ${WRITER} create, change, move and delete all your notes`))
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)
      await tick(PAST_DELAY)
      await page.getByRole('button', { name: 'Confirm' }).click()
      await until(() => logged(dataDir, 'security.applied', { kind: 'item.on', target: WRITER }))
      expect((await new StateStore(dataDir).load()).state.plugins[WRITER]?.firstUse).toEqual([])
      expect(await exists(path.join(folder, 'inbox', 'new.md'))).toBe(false)

      // The same write again, now the item is on, then a move into another folder and a remove
      expect(await write(writer, 'inbox/new.md')).toBe('ok')
      expect(await readFile(path.join(folder, 'inbox', 'new.md'), 'utf8')).toBe('')
      expect(await move(writer, 'inbox/new.md', 'notes/renamed.md')).toBe('ok')
      expect(await remove(writer, 'inbox/b.md')).toBe('ok')
      expect(await files(folder)).toEqual(['a.md', 'notes/renamed.md'])
      // Asked once only
      expect((await records(dataDir)).filter(record => record.event === 'security.applied' && record.kind === 'item.on' && record.target === WRITER)).toHaveLength(1)
    } finally {
      await putBack(folder)
    }
  })

  // Its write narrowed to inbox/** by the human at approval: class 2 and nothing asks. It still lists and reads every note
  it('narrowed to write in inbox/** lists and reads every note and moves and removes only inside inbox/', async () => {
    const notes = { 'a.md': 'alpha', 'inbox/b.md': 'beta', 'inbox/c.md': 'gamma', 'notes/d.md': 'delta' }
    const narrowed: Capability = { type: 'luoshu.write', paths: ['inbox/**'] }
    const granted = [listAll, readAll, narrowed]
    const { app, dataDir, folder } = await started({ notes, plugins: { writer: { granted, entry: { class: 2 } } } })
    try {
      const entry = (await new StateStore(dataDir).load()).state.plugins.writer
      expect(entry).toMatchObject({ class: 2, granted })
      expect(entry?.firstUse ?? []).toEqual([])
      const writer = await pluginWorker(app, 'writer')
      expect(await run<string[]>(writer, 'return ctx.luoshu.list({}).then(listed => listed.paths)')).toEqual(['a.md', 'inbox/b.md', 'inbox/c.md', 'notes/d.md'])
      expect(await run<string>(writer, 'return ctx.luoshu.read({ path: "notes/d.md" }).then(read => read.text)')).toBe('delta')

      // Moves inside inbox/, not out of it and not outside it
      expect(await move(writer, 'inbox/c.md', 'inbox/c2.md')).toBe('ok')
      expect(await move(writer, 'inbox/c2.md', 'c3.md')).toBe('not-granted')
      expect(await move(writer, 'notes/d.md', 'notes/d2.md')).toBe('not-granted')

      // Removes inside inbox/ and not outside it
      expect(await remove(writer, 'inbox/b.md')).toBe('ok')
      expect(await remove(writer, 'a.md')).toBe('not-granted')
      expect(await files(folder)).toEqual(['a.md', 'inbox/c2.md', 'notes/d.md'])
      expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('alpha')

      // Nothing asked: write inside one folder is class 2
      expect(await logged(dataDir, 'security.applied', { kind: 'item.on', target: 'writer' })).toBe(false)
    } finally {
      await putBack(folder)
    }
  })
})
