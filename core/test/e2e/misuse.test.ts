import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

// Plugins drawing to mislead or to take what the human types, as the review of the views tried them, each held

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

type Fixture = { granted: Capability[], manifest?: object, files?: Record<string, string> }

async function started(setup: { notes?: Record<string, string>, plugins?: Record<string, Fixture> }): Promise<{ app: ElectronApplication, editor: Page, dataDir: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes ?? {})) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  for (const [id, plugin] of Object.entries(setup.plugins ?? {})) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: plugin.granted, ...plugin.manifest }), { 'worker.js': built!.text, ...plugin.files }))
    await store.writePlugin(id, await entryFor(root, { granted: plugin.granted }))
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
  for (const id of Object.keys(setup.plugins ?? {})) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor, dataDir }
}

async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0] as Worker
}

type Heard = { topic: string, instance?: string, node?: string, type?: string, value?: unknown, data?: unknown, state?: { editors: string[], views: { instance: string }[] } }
const heard = (worker: Worker) => worker.evaluate('globalThis.heard') as Promise<Heard[]>
const run = <T>(worker: Worker, code: string) => worker.evaluate(`(async () => { const ctx = globalThis.ctx; const heard = globalThis.heard; ${code} })()`) as Promise<T>

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

const view = (name: string) => ({ [name]: { title: name[0]!.toUpperCase() + name.slice(1), kind: 'view' } })
const viewer: Capability[] = [{ type: 'ui.view' }]
const layoutGrants: Capability[] = [{ type: 'ui.layout' }]
const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')
const hitAt = (editor: Page, x: number, y: number) => editor.evaluate(([px, py]) => {
  const at = document.elementFromPoint(px as number, py as number)
  return { inEditor: at?.closest('.cm-content') !== null, inTitle: at?.closest('.hetu-title') !== null }
}, [x, y])
const viewButton = (editor: Page) => editor.locator('#editors .hetu-surface .hetu-button')

async function withLayout(setup: { notes?: Record<string, string>, plugins?: Record<string, Fixture> }) {
  const made = await started({ ...setup, plugins: { ...setup.plugins, tiles: { granted: layoutGrants } } })
  await pickLayout(made.editor, 'tiles')
  const layout = await pluginWorker(made.app, 'tiles')
  await until(async () => (await heard(layout)).some(event => event.topic === 'layout.state'))
  return { ...made, layout }
}

describe('a popover', () => {
  it('keeps its owner strip on top of it and its size within the drawer\'s cap, whatever style the plugin gives it', async () => {
    const { app, editor } = await started({ notes: { 'a.md': 'the real words' }, plugins: { board: { granted: viewer, manifest: { name: 'Boards', views: view('cards') } } } })
    await until(async () => (await viewButton(editor).count()) === 1)
    await open(editor, 'a.md')
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
    const { app, editor } = await started({ plugins: { board: { granted: viewer, manifest: { name: 'hetu', views: { checks: { title: 'Security check', kind: 'view' } } } } } })
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
    expect(await editor.locator('#editors .hetu-title').allInnerTexts()).toEqual(['board · Security check'])
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
    // No layout draws, so no view is placed and no title drawn
    expect(await editor.locator('#editors .hetu-title').count()).toBe(0)
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
    await run(layout, `
      const state = heard.filter(e => e.topic === 'layout.state').at(-1).state
      await ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { display: 'flex', height: '100%' }, children: [
        { kind: 'box', id: 'wrap', click: true, drag: { type: 'note', value: 'b.md' }, style: { width: '300px' }, children: [
          { kind: 'slot', id: 's', instance: state.views[0].instance, style: { height: '100%' } } ] },
        { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } } ] })
    `)
    await until(async () => (await viewButton(editor).count()) === 1)
    await open(editor, 'a.md')
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
        { kind: 'slot', id: 's', instance: state.views[0].instance, style: { width: '300px' } },
        { kind: 'editor', id: 'e', instance: 'current', style: { flex: '1' } },
        { kind: 'input', id: 'trap', value: '', style: { position: 'absolute', left: '0', top: '0', width: '300px', height: '100%', opacity: '0', 'z-index': '9' } } ] })
    `)
    await until(async () => (await editor.locator('#base .hetu-input').count()) === 1 && (await viewButton(editor).count()) === 1)
    const board = await pluginWorker(app, 'board')
    const field = (await editor.locator('#editors .hetu-surface .hetu-input').boundingBox())!
    await editor.mouse.click(field.x + field.width / 2, field.y + field.height / 2)
    await editor.keyboard.type('pin 4242')
    await until(async () => (await heard(board)).some(event => event.topic === 'view.event' && event.value === 'pin 4242'))
    expect(JSON.stringify(await heard(layout))).not.toContain('4242')
  })
})

describe('the editor\'s text', () => {
  it('stays above a title the layout lays over its lines', async () => {
    const { editor, layout } = await withLayout({ notes: { 'a.md': 'first line\nsecond line\nthird line' } })
    await run(layout, `
      await ctx.ui.layout.draw({ kind: 'box', id: 'root', style: { position: 'relative', height: '100%' }, children: [
        { kind: 'editor', id: 'e', instance: 'current', style: { position: 'absolute', inset: '0' } } ] })
    `)
    await open(editor, 'a.md')
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
    const { app, editor } = await started({ notes: { 'a.md': '' }, plugins: { board: { granted: viewer, manifest: { views: view('cards') } } } })
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

const frameScript = `
var input = document.getElementById('i')
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  var port = event.ports[0]
  input.addEventListener('input', function () { port.postMessage(JSON.stringify({ typed: input.value })) })
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (data === 'steal') setInterval(function () { if (document.activeElement !== input) input.focus() }, 100)
  }
  port.postMessage(JSON.stringify({ hello: true }))
})
`
const framePage = '<!doctype html><html><head><meta charset="utf-8"></head><body><input id="i"><script src="board.js"></script></body></html>'

describe('a view frame', () => {
  async function framed() {
    const made = await started({
      notes: { 'a.md': '' },
      plugins: {
        kanban: {
          granted: viewer,
          manifest: { entries: { worker: 'worker.js', frames: { board: 'board.html' } }, views: { board: { title: 'Board', kind: 'view', frame: 'board' } } },
          files: { 'board.html': framePage, 'board.js': frameScript },
        },
      },
    })
    const worker = await pluginWorker(made.app, 'kanban')
    const messages = async () => (await heard(worker)).filter(event => event.topic === 'view.message').map(event => event.data as { typed?: string })
    await until(async () => (await messages()).length >= 1)
    return { ...made, worker, messages }
  }

  it('takes none of the typing on its own: a frame that focuses itself is closed and the note keeps the typing', async () => {
    const { editor, worker, messages } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.type('abc', { delay: 50 })
    await run(worker, `
      const instance = heard.find(e => e.topic === 'view.opened').instance
      await ctx.ui.views.post(instance, 'steal')
    `)
    await until(async () => (await editor.locator('#editors .hetu-down', { hasText: 'took focus without a click' }).count()) === 1)
    expect(await editor.locator('#editors iframe.hetu-frame').count()).toBe(0)
    await editor.keyboard.type('defghij', { delay: 120 })
    await until(async () => (await shown(editor).innerText()) === 'abcdefghij')
    expect((await messages()).some(data => data.typed !== undefined)).toBe(false)
  })

  it('takes typing once the human clicks it, and goes back behind its shield on a press elsewhere', async () => {
    const { editor, messages } = await framed()
    await open(editor, 'a.md')
    const shield = editor.locator('#editors .hetu-frame-shield')
    await until(async () => shield.isVisible())
    await shield.click()
    await until(async () => !(await shield.isVisible()))
    const frame = (await editor.locator('#editors iframe.hetu-frame').boundingBox())!
    await editor.mouse.click(frame.x + 20, frame.y + 12)
    await editor.keyboard.type('mine', { delay: 30 })
    await until(async () => (await messages()).some(data => data.typed === 'mine'))
    // A press elsewhere in the page puts the frame back behind its shield
    await shown(editor).click()
    await until(async () => shield.isVisible())
  })
})
