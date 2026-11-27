import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, type Plugin, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { typeThroughMain } from '../tier0/input.ts'
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
    const topics = ['view.opened', 'view.event', 'view.message'] as const
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

const view = (name: string) => ({ [name]: { title: name[0]!.toUpperCase() + name.slice(1), kind: 'view' } })
const viewer: Capability[] = [{ type: 'ui.view' }]
const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')
const hitAt = (editor: Page, x: number, y: number) => editor.evaluate(([px, py]) => {
  const at = document.elementFromPoint(px as number, py as number)
  return { inEditor: at?.closest('.cm-content') !== null, inTitle: at?.closest('.hetu-title') !== null }
}, [x, y])
// The fixture's button, of the plugins a test runs
const viewButton = (editor: Page) => editor.locator('#editors .hetu-surface .hetu-button', { hasText: 'Press ' })

// hetu with these plugins, once the drawer's layout drew its skeleton with each view in it
async function inColumns(setup: { notes?: Record<string, string>, plugins?: Record<string, Fixture> }) {
  const made = await started(setup)
  await until(async () => (await made.editor.locator('#base .hetu-slot').count()) > 0)
  return made
}

// A view's title dragged onto the band along the bottom of the note, where the layout puts it under the note
async function toBottom(editor: Page, title: string): Promise<void> {
  const from = (await editor.locator('#editors .hetu-title', { hasText: title }).first().boundingBox())!
  const stage = (await editor.locator('#stage').boundingBox())!
  await editor.mouse.move(from.x + 10, from.y + from.height / 2)
  await editor.mouse.down()
  await editor.mouse.move(stage.x + stage.width / 2, stage.y + stage.height - 20, { steps: 10 })
  await until(async () => editor.locator('#drop-mark').isVisible())
  await editor.mouse.up()
}

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

describe('input in a view', () => {
  // The window's own storage files, by name, which the arrangement is kept among
  async function windowStorage(dataDir: string): Promise<Record<string, string>> {
    const kept: Record<string, string> = {}
    const root = path.join(dataDir, 'storage')
    for (const space of (await exists(root)) ? await readdir(root) : []) {
      if (!space.startsWith('window.')) continue
      for (const name of await readdir(path.join(root, space))) kept[`${space}/${name}`] = await readFile(path.join(root, space, name), 'utf8')
    }
    return kept
  }

  // Each view sits beside a control of the layout's: a side view under its tab strip, the panel under the note below its
  // tabs and its fold button, a status row item beside +n. Clicks and typing in each, at the edge nearest the control
  // too, reach the view's owner and leave the arrangement as it was, drawn and kept
  it('stays with the view beside a tab, the panel\'s fold button and +n, the arrangement left as it was', async () => {
    const items = Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [name, { title: name, kind: 'item', size: { min: 900 } }]))
    const { app, editor, dataDir } = await inColumns({
      plugins: {
        board: { granted: viewer, manifest: { views: view('cards') } },
        links: { granted: viewer, manifest: { views: view('links') } },
        meter: { granted: viewer, manifest: { views: items } },
      },
    })
    const toggle = editor.locator('#base .hetu-button', { hasText: /^[▾▴]$/ })
    const more = editor.locator('#base .hetu-button', { hasText: /^\+[0-9]+$/ })
    await until(async () => (await toggle.count()) === 1 && (await more.count()) === 1)
    // A fold and an unfold, so an arrangement is kept to compare with
    await toggle.click()
    await until(async () => (await toggle.innerText()) === '▴')
    await toggle.click()
    await until(async () => (await toggle.innerText()) === '▾')
    await tick(1500)
    const kept = await windowStorage(dataDir)
    expect(Object.keys(kept).length).toBeGreaterThan(0)
    const drawn = await editor.locator('#base').innerHTML()

    const surface = (name: string) => editor.locator('#editors .hetu-surface:not([hidden])', { hasText: `Fixture view ${name}` })
    const edges = [
      // Just under the side's tab strip
      { owner: 'board', name: 'cards', typed: true, at: (box: { x: number, y: number, width: number, height: number }) => ({ x: box.x + box.width / 2, y: box.y + 1 }) },
      // Just under the panel's fold button, at its right
      { owner: 'links', name: 'links', typed: true, at: (box: { x: number, y: number, width: number, height: number }) => ({ x: box.x + box.width - 2, y: box.y + 1 }) },
      // At the edge nearest +n of the one item shown, the first by name. An item's row is too low to show its button and input
      { owner: 'meter', name: 'alpha', typed: false, at: (box: { x: number, y: number, width: number, height: number }) => ({ x: box.x + box.width - 1, y: box.y + box.height / 2 }) },
    ]
    for (const edge of edges) {
      const worker = await pluginWorker(app, edge.owner)
      const view = surface(edge.name)
      await until(async () => (await view.count()) === 1)
      const box = (await view.boundingBox())!
      const at = edge.at(box)
      await editor.mouse.click(at.x, at.y)
      if (!edge.typed) continue
      await view.locator('.hetu-button', { hasText: `Press ${edge.name}` }).click()
      await view.locator('.hetu-input').click()
      await editor.keyboard.type('pin 4242')
      await until(async () => (await heard(worker)).some(event => event.topic === 'view.event' && event.value === 'pin 4242'))
      expect((await heard(worker)).some(event => event.topic === 'view.event' && event.type === 'click')).toBe(true)
    }
    await tick(1500)
    expect(await editor.locator('#overlay .hetu-popover').count()).toBe(0)
    expect(await toggle.innerText()).toBe('▾')
    expect(await editor.locator('#base').innerHTML()).toBe(drawn)
    expect(await windowStorage(dataDir)).toEqual(kept)
  })
})

describe('the editor\'s text', () => {
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
// worker each key it hears, each row opened and anything composed or put in its text field. Told to, it takes focus on
// its own, once after a while to a row or its text field, each time it loses it, at set times or by a route named
const frameScript = `
var rows = [].slice.call(document.querySelectorAll('button'))
var current = 0
var field = document.getElementById('field')
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
;['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'].forEach(function (type) {
  document.addEventListener(type, function (event) { say({ composed: type, text: event.data || null }) }, true)
})
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  port = event.ports[0]
  port.onmessage = function (message) {
    var data = JSON.parse(message.data)
    if (data && typeof data.steal === 'number') setTimeout(function () { rows[0].focus(); say({ tried: true }) }, data.steal)
    if (data && typeof data.field === 'number') setTimeout(function () { field.focus(); say({ tried: true }) }, data.field)
    if (data && data.sticky === true) window.addEventListener('blur', function () { setTimeout(function () { rows[0].focus(); say({ tried: true }) }, 0) })
    if (data && data.turns) for (var turn = 0; turn < data.turns.times; turn++) {
      setTimeout(function () { rows[0].focus(); say({ tried: true, at: Date.now() }) }, data.turns.start + data.turns.offset + turn * data.turns.every - Date.now())
    }
    if (data && typeof data.route === 'string') {
      if (data.route === 'focus') rows[0].focus()
      if (data.route === 'windowFocus') window.focus()
      if (data.route === 'select') field.select()
      if (data.route === 'hash') location.hash = '#field'
      if (data.route === 'tabindex') document.getElementById('tab').focus()
      if (data.route === 'showModal') document.getElementById('modal').showModal()
      say({ tried: data.route })
    }
    if (data && typeof data.hash === 'string') { location.hash = data.hash; say({ moved: location.href }) }
    if (data && typeof data.push === 'string') {
      try { history.pushState(null, '', data.push); say({ moved: location.href }) } catch (err) { say({ refused: String(err && err.name) }) }
    }
  }
  say({ hello: true })
})
`
const row = (name: string) => `<button style="display:block;width:200px;height:30px;margin:0">${name}</button>`
const framePage = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">${['row-1', 'row-2', 'row-3'].map(row).join('')}<input id="field" style="display:block;width:200px;height:30px;margin:0"><div id="tab" tabindex="0">Tab</div><dialog id="modal">Modal</dialog><script src="board.js"></script></body></html>`

type Said = { hello?: true, opened?: string, key?: string, at?: number, focused?: true, moved?: string, refused?: string, composed?: string, text?: string | null, tried?: true | string }
type Press = { down: boolean, x: number, y: number }

describe('a view frame', () => {
  // Each plugin of ids with a frame view, its frame loaded and laid out. With two frames and the note list one more
  // view than the sides show, the one the sides left out goes under the note
  async function framed(ids = ['kanban'], list = false) {
    const views = { board: { title: 'Board', kind: 'view', frame: 'board' }, ...list ? { list: { title: 'List', kind: 'view', frame: 'board' } } : {} }
    const plugin: Fixture = {
      granted: viewer,
      manifest: { entries: { worker: 'worker.js', frames: { board: 'board.html' } }, views },
      files: { 'board.html': framePage, 'board.js': frameScript },
    }
    const made = await inColumns({ notes: { 'a.md': '' }, plugins: Object.fromEntries(ids.map(id => [id, plugin])) })
    await tick(1000)
    const hidden = []
    for (const id of ids) if ((await frameOf(made.editor, id).count()) === 0) hidden.push(`${id} · Board`)
    if (!(await made.editor.locator('#editors').getByRole('button', { name: 'a.md', exact: true }).isVisible())) hidden.push('note-list ·')
    for (const title of hidden) await toBottom(made.editor, title)
    const workers = await Promise.all(ids.map(id => pluginWorker(made.app, id)))
    const said = async (at = 0) => (await heard(workers[at]!)).filter(event => event.topic === 'view.message').map(event => event.data as Said)
    for (let at = 0; at < ids.length; at++) {
      await until(async () => (await said(at)).length >= 1)
      await until(async () => ((await frameOf(made.editor, ids[at]!).first().boundingBox())?.width ?? 0) > 0)
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

  it('takes focus on a press in it, then works its own rows with arrow keys and Enter, its own focus without activation denied', async () => {
    const { app, editor, said } = await framed()
    // Denied by the frame element and by the policy its files are served with
    expect(await frameOf(editor, 'kanban').getAttribute('allow')).toBe("focus-without-user-activation 'none'")
    const script = (await frameOf(editor, 'kanban').getAttribute('src'))!.replace(/[^/]*$/, 'board.js')
    const policy = await app.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
      return (await contents.session.fetch(url)).headers.get('permissions-policy')
    }, script)
    expect(policy).toBe('focus-without-user-activation=()')
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

  // Tells the plugin's frame what to do, as data, the frame of the view it opened at that place in turn
  const tell = (worker: Worker, data: object, at = 0) => worker.evaluate(async ([told, which]) => {
    const scope = globalThis as unknown as { ctx: { ui: { views: { post(instance: string, data: unknown): Promise<void> } } }, heard: Heard[] }
    const instance = scope.heard.filter(event => event.topic === 'view.opened')[which]!.instance!
    await scope.ctx.ui.views.post(instance, told)
  }, [data, at] as const)

  // Holds the page's thread for ms from after ms on, so the page sees a frame take focus only once it is free and only
  // main stands between the frame and the keys typed meanwhile
  const holdPage = (editor: Page, after: number, ms: number) => editor.evaluate(([wait, hold]) => {
    setTimeout(() => {
      const end = Date.now() + hold
      while (Date.now() < end) { /* the page's thread held */ }
    }, wait)
  }, [after, ms] as const)
  // A key each 150 ms, or a burst long enough to run past a frame taking focus and the page pulling it back
  const typingPaces = [{ gap: 150, text: 'abcdefghijkl', steal: 300, from: 150 }, { gap: 0, text: 'abcdefghijklmnopqrstuvwxyz'.repeat(10), steal: 50, from: 0 }]
  // The text with the keys at the places main dropped them taken out
  const minusDropped = (text: string, dropped: number[]) => [...text].filter((_key, at) => !dropped.includes(at)).join('')
  const focusIsInNote = (editor: Page) => editor.evaluate(() => document.activeElement?.closest('.cm-content') !== null)
  // A press in the first row of the nth frame of plugin id, the at-th of the test's plugins, waited for until the frame
  // heard it. Chromium then lets that frame take focus on its own for the 5 s the press's activation lasts, wherever the
  // human pressed next, which only the guard stands against
  const pressInFrame = async (editor: Page, said: (at?: number) => Promise<Said[]>, id = 'kanban', at = 0, nth = 0) => {
    const box = (await frameOf(editor, id).nth(nth).boundingBox())!
    const before = (await said(at)).filter(data => data.opened !== undefined).length
    await editor.mouse.click(box.x + 20, box.y + 12)
    await until(async () => (await said(at)).filter(data => data.opened !== undefined).length > before)
  }

  // With no press in it the frame's own focus does nothing, so there is nothing to pull back or record
  it('leaves focus in the note when it calls focus(), window.focus(), select(), showModal(), jumps to a hash or focuses an element by tabindex on its own with no press', async () => {
    const { editor, workers, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.evaluate(() => {
      const scope = window as unknown as { left: number }
      scope.left = 0
      document.addEventListener('focusout', event => {
        if (event.target instanceof Element && event.target.closest('.cm-content') !== null) scope.left++
      })
    })
    // A modal dialog makes the rest of the frame's page inert, so it goes last
    for (const route of ['focus', 'windowFocus', 'select', 'hash', 'tabindex', 'showModal']) {
      await tell(workers[0]!, { route })
      await until(async () => (await said()).some(data => data.tried === route))
      await tick(200)
      expect(await focusIsInNote(editor), route).toBe(true)
    }
    expect(await editor.evaluate('window.left')).toBe(0)
    expect((await said()).filter(data => data.focused === true)).toEqual([])
    expect(await logged(dataDir, 'frame.focus-taken')).toBe(false)
  })

  it.each(typingPaces)('gets all of the typing at a key each $gap ms when it tries to take focus with no press, which nothing records', async ({ gap, text, steal, from }) => {
    const { app, editor, workers, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    await tell(workers[0]!, { steal })
    // The page held, so the guard couldn't pull focus back in time had the frame taken it
    await holdPage(editor, from, 600)
    const dropped = await typeThroughMain(app, text, gap)
    await tick(300)
    expect((await said()).some(data => data.tried === true)).toBe(true)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
    expect(dropped).toEqual([])
    await until(async () => (await shown(editor).innerText()) === text)
    expect(await focusIsInNote(editor)).toBe(true)
    expect(await logged(dataDir, 'frame.focus-taken')).toBe(false)
  })

  it.each(typingPaces)('gets none of the typing at a key each $gap ms when it focuses itself after the human pressed in it and then back in the note, which the core records', async ({ gap, text, steal, from }) => {
    const { app, editor, workers, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await pressInFrame(editor, said)
    await shown(editor).click()
    await tell(workers[0]!, { steal })
    await holdPage(editor, from, 600)
    const dropped = await typeThroughMain(app, text, gap)
    await tick(300)
    expect((await said()).some(data => data.tried === true)).toBe(true)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
    expect(dropped.length).toBeGreaterThan(0)
    await until(async () => (await shown(editor).innerText()) === minusDropped(text, dropped))
    expect(await frameOf(editor, 'kanban').count()).toBe(1)
    await until(() => focusIsInNote(editor))
    await until(() => logged(dataDir, 'frame.focus-taken', { plugin: 'kanban' }))
  })

  // Pulled back each time it takes focus again, so the two run in a loop and the note may get none of the typing either
  it.each(typingPaces)('gets none of the typing at a key each $gap ms when it takes focus back each time it loses it', async ({ gap, text }) => {
    const { app, editor, workers, said } = await framed()
    await open(editor, 'a.md')
    await tell(workers[0]!, { sticky: true })
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await shown(editor).click()
    await until(async () => (await said()).some(data => data.tried === true))
    await tick(300)
    await holdPage(editor, 0, 600)
    const dropped = await typeThroughMain(app, text, gap)
    await tick(300)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
    expect(dropped.length).toBeGreaterThan(0)
  })

  it.each(typingPaces)('gets none of the typing at a key each $gap ms when it takes focus from another frame the human pressed in later, which the core records for its plugin', async ({ gap, text, steal, from }) => {
    const { app, editor, workers, said, dataDir } = await framed(['kanban', 'board'])
    await open(editor, 'a.md')
    await pressInFrame(editor, said, 'board', 1)
    await pressInFrame(editor, said, 'kanban', 0)
    await tick(300)
    await tell(workers[1]!, { steal })
    await holdPage(editor, from, 600)
    const dropped = await typeThroughMain(app, text, gap)
    await tick(300)
    expect((await said(1)).some(data => data.tried === true)).toBe(true)
    expect((await said(1)).filter(data => data.key !== undefined)).toEqual([])
    expect(dropped.length).toBeGreaterThan(0)
    await until(() => focusIsInNote(editor))
    await until(() => logged(dataDir, 'frame.focus-taken', { plugin: 'board' }))
    expect(await logged(dataDir, 'frame.focus-taken', { plugin: 'kanban' })).toBe(false)
  })

  // An IME composing passes main's before-input-event only with the key it composes with, Process on Windows, never
  // with the composition or its commit. Once focus is in the frame of host, main's own handler is handed that key and
  // the debugger sends the composition and its commit to the frame holding focus once focus left the frame, or after
  // 40 ms, before the page's own pull back could end its 50 ms hold. Answers whether main dropped the key and whether
  // focus left the frame in time
  const composeThroughMain = (app: ElectronApplication, host: string) => app.evaluate(async ({ webContents }, frameHost) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    const inFrame = () => {
      let frame = contents.focusedFrame
      while (frame?.parent?.parent) frame = frame.parent
      return frame?.parent !== null && frame?.parent !== undefined && new URL(frame.url).host === frameHost
    }
    const waited = async (done: () => boolean, ms: number) => {
      const end = Date.now() + ms
      while (!done() && Date.now() < end) await new Promise(resolve => setImmediate(resolve))
      return done()
    }
    if (!await waited(inFrame, 5000)) return { dropped: false, left: false }
    let dropped = false
    for (const type of ['keyDown', 'keyUp'] as const) {
      let prevented = false
      const input = { type, key: 'Process', code: '', control: false, meta: false, alt: false, shift: false, isAutoRepeat: false }
      contents.emit('before-input-event', { preventDefault: () => { prevented = true } }, input)
      if (type === 'keyDown') dropped = prevented
      if (!prevented) void contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: type === 'keyDown' ? 'rawKeyDown' : 'keyUp', key: 'Process', code: '', windowsVirtualKeyCode: 229 })
    }
    const left = await waited(() => !inFrame(), 40)
    await contents.debugger.sendCommand('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    await contents.debugger.sendCommand('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
    await contents.debugger.sendCommand('Input.insertText', { text: '你好' })
    return { dropped, left }
  }, host)
  // Counts main's each word to the page to take focus back from a frame
  const countPullBacks = (editor: Page) => editor.evaluate(() => {
    const scope = window as unknown as { pulled: number }
    scope.pulled = 0
    window.addEventListener('message', event => {
      if (event.source === window && (event.data as { hetu?: unknown } | null)?.hetu === 'key-dropped') scope.pulled++
    })
  })

  // The page hears nothing when focus moves from one frame to another, so only main stands between the frame and an
  // IME's text until the page looks again
  it('gets none of an IME composition started by a key main drops when it takes focus from another frame the human pressed in later, which commits in the note', async () => {
    const { app, editor, workers, said } = await framed(['kanban', 'board'])
    await open(editor, 'a.md')
    await pressInFrame(editor, said, 'board', 1)
    await pressInFrame(editor, said, 'kanban', 0)
    await tick(300)
    await countPullBacks(editor)
    await tell(workers[1]!, { field: 0 })
    expect(await composeThroughMain(app, 'board.views')).toEqual({ dropped: true, left: true })
    await until(async () => (await shown(editor).innerText()) === '你好')
    await tick(300)
    expect((await said(1)).some(data => data.tried === true)).toBe(true)
    expect((await said(1)).filter(data => data.composed !== undefined || data.key !== undefined)).toEqual([])
    expect(await editor.evaluate('window.pulled')).toBeGreaterThan(0)
    expect(await focusIsInNote(editor)).toBe(true)
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

  it('keeps getting the typing after the human pressed in it and it moved within its own page by hash', async () => {
    const { app, editor, workers, said } = await framed()
    await open(editor, 'a.md')
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(300)
    await tell(workers[0]!, { hash: 'route-2' })
    await until(async () => (await said()).some(data => data.moved?.endsWith('#route-2') === true))
    expect(await typeThroughMain(app, 'abc', 150)).toEqual([])
    await until(async () => (await said()).filter(data => data.key !== undefined).length === 3)
    expect((await said()).filter(data => data.key !== undefined).map(data => data.key)).toEqual(['a', 'b', 'c'])
  })

  it('cannot move itself under another ticket of its host by history', async () => {
    const { editor, workers, said } = await framed()
    const src = (await frameOf(editor, 'kanban').getAttribute('src'))!
    const other = src.replace(/\/[0-9a-f]{32}\//,'/ffffffffffffffffffffffffffffffff/')
    await tell(workers[0]!, { push: other })
    await until(async () => (await said()).some(data => data.moved !== undefined || data.refused !== undefined))
    expect((await said()).filter(data => data.moved !== undefined)).toEqual([])
  })

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

  it('hands its plugin a key the plugin bound for its views after it moved within its own page by hash', async () => {
    const { app, editor, workers, said } = await framed()
    await run(workers[0]!, `
      ctx.ui.on('view.command', event => heard.push(event))
      await ctx.ui.views.bind([{ key: 'Mod-k', command: 'down' }])
    `)
    await open(editor, 'a.md')
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(300)
    await tell(workers[0]!, { hash: 'route-2' })
    await until(async () => (await said()).some(data => data.moved?.endsWith('#route-2') === true))
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

  it.each(typingPaces)('gets none of the typing at a key each $gap ms when it takes focus back after a second press in it and a core key out of it', async ({ gap, text }) => {
    const { app, editor, workers, said } = await framed()
    await open(editor, 'a.md')
    await tell(workers[0]!, { sticky: true })
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(300)
    await editor.mouse.click(at.x, at.y)
    expect(await keyInMain(app, '/')).toBe(true)
    await tick(300)
    await holdPage(editor, 0, 600)
    const dropped = await typeThroughMain(app, text, gap)
    await tick(300)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
    expect(dropped.length).toBeGreaterThan(0)
  })

  it('is pulled back with no key typed once the hold for a late press ends after the human pressed in it and then in the note, which the core records', async () => {
    const { editor, workers, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await pressInFrame(editor, said)
    await shown(editor).click()
    await tell(workers[0]!, { field: 0 })
    await until(async () => (await said()).some(data => data.tried === true))
    await until(() => focusIsInNote(editor), 2000)
    await until(() => logged(dataDir, 'frame.focus-taken', { plugin: 'kanban' }))
  })

  // The page hears nothing when focus moves from one frame to another, so a hold started afresh on each move would
  // see the other frame each time it ends and never end
  it('is pulled back once the hold ends when two frames of its plugin the human pressed in take focus from each other in turns, which the core records', async () => {
    const { editor, workers, said, dataDir } = await framed(['kanban'], true)
    // A second view on the same frame page, since the layout moves the instances of one view together as tabs, one
    // shown at a time. Put under the note when the sides show it as a tab beside the first
    const listTitle = editor.locator('#editors .hetu-title', { hasText: 'kanban · List' })
    if (await listTitle.count() === 0) await workers[0]!.evaluate(() => (globalThis as unknown as { ctx: { ui: { views: { open(view: string): Promise<string> } } } }).ctx.ui.views.open('list'))
    await until(async () => (await listTitle.count()) === 1)
    await tick(500)
    if ((await frameOf(editor, 'kanban').count()) < 2) await toBottom(editor, 'kanban · List')
    await until(async () => (await said()).filter(data => data.hello === true).length === 2)
    await until(async () => ((await frameOf(editor, 'kanban').nth(1).boundingBox())?.width ?? 0) > 0)
    await open(editor, 'a.md')
    await pressInFrame(editor, said, 'kanban', 0, 0)
    await pressInFrame(editor, said, 'kanban', 0, 1)
    await shown(editor).click()
    await tick(300)
    await editor.evaluate(() => {
      const scope = window as unknown as { backAt: number | null }
      scope.backAt = null
      document.addEventListener('focusin', event => {
        if (scope.backAt === null && event.target instanceof Element && event.target.closest('.cm-content') !== null) scope.backAt = Date.now()
      })
    })
    // The first takes focus from the note, then each takes it from the other every 50 ms, half way between the page's
    // looks at the end of each 50 ms hold started afresh, so each look would find the other one
    const start = Date.now() + 300
    await tell(workers[0]!, { turns: { start, offset: 0, every: 100, times: 1 } }, 0)
    await tell(workers[0]!, { turns: { start, offset: 25, every: 100, times: 5 } }, 1)
    await tell(workers[0]!, { turns: { start, offset: 75, every: 100, times: 5 } }, 0)
    await until(async () => (await said()).filter(data => data.at !== undefined).length === 11)
    const steals = (await said()).flatMap(data => data.at === undefined ? [] : [data.at]).sort((a, b) => a - b)
    const backAt = await editor.evaluate('window.backAt') as number | null
    expect(backAt).not.toBe(null)
    // Pulled back at the end of the first hold, before the second frame took focus a second time
    expect(backAt!).toBeLessThan(steals[3]!)
    await until(() => logged(dataDir, 'frame.focus-taken', { plugin: 'kanban' }))
  })

  it('takes focus the core moves into it as no theft, then works its own rows', async () => {
    const { app, editor, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    const url = await frameOf(editor, 'kanban').getAttribute('src')
    await app.evaluate(({ webContents }, src) => {
      webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!.send('hetu:focus-frame', { url: src })
    }, url)
    await until(async () => (await said()).some(data => data.focused === true))
    await tick(300)
    await editor.keyboard.press('ArrowDown')
    await editor.keyboard.press('Enter')
    await until(async () => (await said()).some(data => data.opened === 'row-2'))
    expect(await logged(dataDir, 'frame.focus-taken')).toBe(false)
  })

  it.each(typingPaces)('gets none of the typing at a key each $gap ms when it takes focus with no note shown after the human pressed in it and then on the empty stage, recorded once', async ({ gap, text, steal, from }) => {
    const { app, editor, workers, said, dataDir } = await framed()
    await pressInFrame(editor, said)
    await editor.locator('#empty').click()
    await tell(workers[0]!, { steal })
    await holdPage(editor, from, 600)
    const dropped = await typeThroughMain(app, text, gap)
    await tick(1500)
    expect((await said()).some(data => data.tried === true)).toBe(true)
    expect((await said()).filter(data => data.key !== undefined)).toEqual([])
    expect(dropped.length).toBeGreaterThan(0)
    expect((await records(dataDir)).filter(record => record.event === 'frame.focus-taken').map(record => record.count)).toEqual([1])
  })

  it('keeps focus on a press in it while the page is busy as the press comes', async () => {
    const { editor, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    const at = await inRow(editor, 'kanban')
    await editor.evaluate(() => {
      setTimeout(() => {
        const until = Date.now() + 300
        while (Date.now() < until) { /* the page's thread held */ }
      }, 0)
    })
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(500)
    expect(await editor.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    expect(await logged(dataDir, 'frame.focus-taken')).toBe(false)
  })

  it('takes focus on a press in it whose push reaches the page after the move it caused, which the core records as no theft', async () => {
    const { app, editor, said, dataDir } = await framed()
    await open(editor, 'a.md')
    await shown(editor).click()
    // Main's push of each press reaches the page 25 ms late, after the frame took focus from it
    await app.evaluate(({ webContents }) => {
      const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
      const send = contents.send.bind(contents)
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === 'hetu:press') setTimeout(() => send(channel, ...args), 25)
        else send(channel, ...args)
      }
    })
    const at = await inRow(editor, 'kanban')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).some(data => data.opened === 'row-1'))
    await tick(500)
    expect(await editor.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    expect(await logged(dataDir, 'frame.focus-taken')).toBe(false)
  })

  it('is found under a press at its point on the page with the page zoomed to 150%', async () => {
    const { app, editor, said } = await framed(['kanban', 'board'])
    await app.evaluate(({ webContents }) => {
      webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!.setZoomFactor(1.5)
    })
    await tick(500)
    await editor.evaluate(() => {
      const scope = window as unknown as { pushed: unknown[] }
      scope.pushed = []
      window.addEventListener('message', event => {
        const data = event.data as { hetu?: unknown, press?: unknown } | null
        if (event.source === window && data?.hetu === 'press') scope.pushed.push(data.press)
      })
    })
    const at = await inRow(editor, 'board')
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said(1)).some(data => data.opened === 'row-1'))
    await until(async () => (await editor.evaluate('window.pushed.length')) === 2)
    const hosts = await editor.evaluate(() => (window as unknown as { pushed: Press[] }).pushed.map(press =>
      new URL(document.elementFromPoint(press.x, press.y)?.getAttribute('src') ?? 'hetu://page/').host))
    expect(hosts).toEqual(['board.views', 'board.views'])
    expect((await said(0)).some(data => data.opened !== undefined)).toBe(false)
  })
})

// The input delay and a little more, so a click after it lands
const PAST_DELAY = 1300
const listAll: Capability = { type: 'luoshu.list', paths: ['**'] }
const readAll: Capability = { type: 'luoshu.read', paths: ['**'] }
const writeAll: Capability = { type: 'luoshu.write', paths: ['**'] }

const files = async (folder: string) => (await readdir(folder, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile()).map(entry => path.relative(folder, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

// The writer's worker's notes calls, as the worker holds them
type Writer = { ctx: { luoshu: {
  write(args: { path: string, text: string }): Promise<unknown>
  move(args: { from: string, to: string }): Promise<unknown>
  read(args: { path: string }): Promise<{ version: string }>
  remove(args: { path: string, baseVersion: string }): Promise<unknown>
} } }
// What the writer's worker gets back for each call, the error's code for a refused one
const write = (worker: Worker, note: string) => worker.evaluate(at => (globalThis as unknown as Writer).ctx.luoshu.write({ path: at, text: '' })
  .then(() => 'ok', (err: { code: string }) => err.code), note)
const move = (worker: Worker, from: string, to: string) => worker.evaluate(([source, target]) => (globalThis as unknown as Writer).ctx.luoshu.move({ from: source, to: target })
  .then(() => 'ok', (err: { code: string }) => err.code), [from, to] as const)
// A remove names the version it read, as a plugin binning a note it can see does
const remove = (worker: Worker, note: string) => worker.evaluate(at => {
  const { luoshu } = (globalThis as unknown as Writer).ctx
  return luoshu.read({ path: at }).then(read => luoshu.remove({ path: at, baseVersion: read.version })).then(() => 'ok', (err: { code: string }) => err.code)
}, note)

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
