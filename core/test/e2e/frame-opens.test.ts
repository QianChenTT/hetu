import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CDPSession, ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, launch, logged, temp, tick, until, workersPage } from './helpers.ts'

// A note opened from a plugin's frame: the human's only right after a press or Enter in that plugin's frames, and a
// note dragged out of a frame by the token main minted for it

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// Keeps each ui event and each note the editor tells it opened, and hands its ctx to the test
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    const opened: string[] = []
    scope.opened = opened
    for (const topic of ['view.opened', 'view.message', 'layout.state'] as const) ctx.ui.on(topic, event => heard.push(event))
    ctx.editor.on('opened', event => opened.push((event as { instance: string }).instance))
  },
})
`

// A frame of note rows, as a file list draws them, and a pad that opens nothing. A click on a row or Enter on it asks
// hetu to open its note, as @hetu/sdk/frame's open does. Each row asks for a drag token at the start and carries it in
// a drag. It tells its worker each open it asked and each token answered. Told to, it asks opens on its own
const frameScript = `
var rows = [].slice.call(document.querySelectorAll('button'))
var pad = document.getElementById('pad')
var port = null
var tokens = {}
var minted = rows.map(function (row) { return row.textContent })
var many = false
document.addEventListener('keydown', function (event) { say({ key: event.key }) })
function say(data) { if (port) port.postMessage(JSON.stringify(data)) }
function open(path) { port.postMessage({ v: 1, kind: 'open', path: path }); say({ asked: path }) }
rows.forEach(function (row, at) {
  row.addEventListener('click', function () {
    open(row.textContent)
    if (many) { open('c.md'); open('d.md') }
  })
  row.addEventListener('dragstart', function (event) { event.dataTransfer.setData('text/plain', 'hetu-drag:' + tokens[row.textContent]) })
})
pad.addEventListener('click', function () { rows[1].focus() })
window.addEventListener('message', function (event) {
  if (event.source !== parent || !event.ports[0]) return
  port = event.ports[0]
  port.onmessage = function (message) {
    if (typeof message.data !== 'string') {
      if (message.data.kind !== 'drag-token') return
      tokens[minted[message.data.ask]] = message.data.token
      say({ token: minted[message.data.ask], is: message.data.token })
      return
    }
    var data = JSON.parse(message.data)
    if (data.timer) setTimeout(function () { open(data.timer) }, data.after)
    if (data.onMove) document.addEventListener('pointermove', function moved() { document.removeEventListener('pointermove', moved); open(data.onMove) })
    if (data.onWheel) document.addEventListener('wheel', function wheeled() { document.removeEventListener('wheel', wheeled); open(data.onWheel) })
    if (data.many) many = true
    if (data.mint) port.postMessage({ v: 1, kind: 'drag-token', ask: minted.push(data.mint) - 1, path: data.mint })
  }
  rows.forEach(function (row, at) { port.postMessage({ v: 1, kind: 'drag-token', ask: at, path: row.textContent }) })
  say({ hello: true })
})
`
// The frame's policy takes styles only from its own files, so the rows' places come from board.css
const row = (name: string) => `<button draggable="true">${name}</button>`
const framePage = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="board.css"></head><body>${['a.md', 'b.md', 'c.md', 'secret.md'].map(row).join('')}<div id="pad"></div><script src="board.js"></script></body></html>`
const frameStyle = 'body { margin: 0 } button { display: block; box-sizing: border-box; width: 200px; height: 30px; margin: 0 } #pad { height: 60px }'

type Said = { hello?: true, asked?: string, token?: string, is?: string | null, key?: string }
type Heard = { topic: string, instance?: string, data?: unknown, state?: unknown }
const heard = (worker: Worker) => worker.evaluate('globalThis.heard') as Promise<Heard[]>
const opened = (worker: Worker) => worker.evaluate('globalThis.opened') as Promise<string[]>
const run = <T>(worker: Worker, code: string) => worker.evaluate(`(async () => { const ctx = globalThis.ctx; const heard = globalThis.heard; ${code} })()`) as Promise<T>

async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0] as Worker
}

const viewer = (reads: string[]): Capability[] => [{ type: 'ui.view' }, { type: 'luoshu.read', paths: reads }]
const notes = { 'a.md': 'alpha', 'b.md': 'beta', 'c.md': 'gamma', 'd.md': 'delta', 'e.md': 'epsilon', 'secret.md': 'hidden', 'public/p.md': 'open text', 'private/x.md': 'SECRET' }

// kanban and board each draw the rows in a frame and read every note but secret.md. marks reads notes through ui.read
// alone, so it hears only of the human's opens. The drawer's layout puts the two frames on the two sides of the note
async function started() {
  const folder = await temp()
  for (const [name, text] of Object.entries(notes)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
    await writeFile(path.join(folder, name), text)
  }
  // public/link is a junction to private, which kanban can't read, inside the notes folder
  await symlink(path.join(folder, 'private'), path.join(folder, 'public', 'link'), 'junction')
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: [] })
  await store.writeLuoshu({ folder })
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': fixture })
  const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  const framed = { entries: { worker: 'worker.js', frames: { board: 'board.html' } }, views: { board: { title: 'Board', kind: 'view', frame: 'board' } } }
  const plugins: Record<string, { granted: Capability[], manifest?: object, files?: Record<string, string> }> = {
    kanban: { granted: viewer(['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'public/**']), manifest: framed, files: { 'board.html': framePage, 'board.js': frameScript, 'board.css': frameStyle } },
    board: { granted: viewer(['a.md', 'b.md', 'c.md', 'd.md']), manifest: framed, files: { 'board.html': framePage, 'board.js': frameScript, 'board.css': frameStyle } },
    marks: { granted: [{ type: 'ui.read', paths: ['**'] }] },
  }
  for (const [id, plugin] of Object.entries(plugins)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: plugin.granted, ...plugin.manifest }), { 'worker.js': built!.text, ...plugin.files }))
    await writeApproved(store, id, root, { granted: plugin.granted })
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  for (const id of Object.keys(plugins)) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  const kanban = await pluginWorker(app, 'kanban')
  const board = await pluginWorker(app, 'board')
  const marks = await pluginWorker(app, 'marks')
  const said = async (worker: Worker = kanban) => (await heard(worker)).filter(event => event.topic === 'view.message').map(event => event.data as Said)
  for (const [id, worker] of [['kanban', kanban], ['board', board]] as const) {
    await until(async () => (await said(worker)).filter(data => data.token !== undefined).length === 4)
    await until(async () => ((await frameOf(editor, id).boundingBox())?.width ?? 0) > 0)
  }
  return { app, editor, kanban, board, marks, said }
}

const frameOf = (editor: Page, id: string) => editor.locator(`#editors iframe.hetu-frame[src^="hetu://${id}.views/"]`)
// A point on the page in a row of a plugin's frame, by its place from 0, or in its pad
async function inFrame(editor: Page, id: string, at: number | 'pad') {
  const box = (await frameOf(editor, id).boundingBox())!
  return { x: box.x + 20, y: box.y + (at === 'pad' ? 150 : 15 + 30 * at) }
}
const notesOpen = (editor: Page) => editor.locator('.editor').count()
const title = (editor: Page) => editor.locator('#title').innerText()
// Tells a plugin's frame what to do, as data
const tell = (worker: Worker, data: object) => worker.evaluate(async told => {
  const own = globalThis as unknown as { heard: Heard[], ctx: { ui: { views: { post: (instance: string, data: unknown) => Promise<unknown> } } } }
  const instance = own.heard.find(e => e.topic === 'view.opened')!.instance!
  await own.ctx.ui.views.post(instance, told)
}, data)
// The paths of the notes a ui.read plugin heard the human open
const humanOpened = async (marks: Worker) => {
  const instances = await run<{ instance: string, path: string }[]>(marks, 'return await ctx.editor.instances()')
  return instances.map(each => each.path).sort()
}

describe('a note opened from a frame', () => {
  it('opens in front as the human\'s on a click on its row, leaving the next key to the frame, and on a long press counted from its release', async () => {
    const { editor, marks, said } = await started()
    const at = await inFrame(editor, 'kanban', 1)
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await title(editor)).startsWith('b.md'))
    await until(async () => (await opened(marks)).length === 1)
    expect(await humanOpened(marks)).toEqual(['b.md'])
    // Focus stays in the frame the human clicked, so the next key is the frame's and never lands in the note
    await tick(300)
    await editor.keyboard.press('x')
    await until(async () => (await said()).some(data => data.key === 'x'))
    expect(await editor.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    expect(await editor.locator('.editor:not([hidden]) .cm-content').innerText()).toBe('beta')
    // A long press counts from its release
    const held = await inFrame(editor, 'kanban', 2)
    await editor.mouse.move(held.x, held.y)
    await editor.mouse.down()
    await tick(800)
    await editor.mouse.up()
    await until(async () => (await title(editor)).startsWith('c.md'))
    await until(async () => (await opened(marks)).length === 2)
  })

  it('opens in the background, never in front or as the human\'s, what it asks on a timer, a pointer move, the wheel or right after a click in another plugin\'s frame, and nothing outside its read', async () => {
    const { editor, kanban, marks, said } = await started()
    // The human's note in front, opened from the other plugin's frame
    const front = await inFrame(editor, 'board', 0)
    await editor.mouse.click(front.x, front.y)
    await until(async () => (await title(editor)).startsWith('a.md'))
    await until(async () => (await opened(marks)).length === 1)
    await tick(700)
    await tell(kanban, { timer: 'b.md', after: 0 })
    await tell(kanban, { onMove: 'c.md' })
    await tick(200)
    const at = await inFrame(editor, 'kanban', 'pad')
    await editor.mouse.move(at.x, at.y)
    await editor.mouse.move(at.x + 5, at.y + 5)
    await tell(kanban, { onWheel: 'd.md' })
    await tick(200)
    await editor.mouse.wheel(0, 40)
    await tell(kanban, { timer: 'secret.md', after: 0 })
    await tell(kanban, { timer: 'e.md', after: 300 })
    const other = await inFrame(editor, 'board', 'pad')
    await editor.mouse.click(other.x, other.y)
    await until(async () => (await said()).filter(data => data.asked !== undefined).length === 5)
    await until(async () => (await notesOpen(editor)) === 5)
    await tick(700)
    expect((await said()).filter(data => data.asked !== undefined).map(data => data.asked)).toEqual(['b.md', 'c.md', 'd.md', 'secret.md', 'e.md'])
    expect(await notesOpen(editor)).toBe(5)
    expect(await title(editor)).toMatch(/^a\.md/)
    expect(await humanOpened(marks)).toEqual(['a.md'])
  })

  it('opens one note in front as the human\'s and the other two in the background for three asked on one click', async () => {
    const { editor, kanban, marks, said } = await started()
    await tell(kanban, { many: true })
    await tick(200)
    const at = await inFrame(editor, 'kanban', 0)
    await editor.mouse.click(at.x, at.y)
    await until(async () => (await said()).filter(data => data.asked !== undefined).length === 3)
    await until(async () => (await title(editor)).startsWith('a.md'))
    await until(async () => (await notesOpen(editor)) === 3)
    await tick(700)
    expect(await notesOpen(editor)).toBe(3)
    expect(await title(editor)).toMatch(/^a\.md/)
    expect(await humanOpened(marks)).toEqual(['a.md'])
  })

  // Keys Playwright sends never pass the window's before-input-event, so main's own handler is handed the key as the
  // window's input would hand it, with focus where the frame really holds it
  const enterInMain = (app: ElectronApplication) => app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find(each => each.getURL() === 'hetu://editor/')!
    const input = { type: 'keyDown', key: 'Enter', code: 'Enter', control: false, meta: false, alt: false, shift: false, isAutoRepeat: false }
    contents.emit('before-input-event', { preventDefault: () => {} }, input)
  })

  it('opens as the human\'s on Enter in a frame holding focus, which main pushes, and in the background on an Enter main never saw', async () => {
    const { app, editor, marks, said } = await started()
    const pad = await inFrame(editor, 'kanban', 'pad')
    await editor.mouse.click(pad.x, pad.y)
    await tick(700)
    expect(await editor.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME')
    await editor.keyboard.press('Enter')
    await until(async () => (await said()).filter(data => data.asked !== undefined).length === 1)
    await until(async () => (await notesOpen(editor)) === 1)
    await tick(700)
    expect(await humanOpened(marks)).toEqual([])
    await enterInMain(app)
    await editor.keyboard.press('Enter')
    await until(async () => (await opened(marks)).length === 1)
    expect(await humanOpened(marks)).toEqual(['b.md'])
  })
})

// A drag out of a frame as the human's press and moves would start it: Chromium starts the drag, which CDP intercepts and
// delivers to the page along a path. A real OS drag isn't started, so the OS's own drag loop is left out
async function dragged(cdp: CDPSession, from: { x: number, y: number }, to: { x: number, y: number }): Promise<string> {
  await cdp.send('Input.setInterceptDrags', { enabled: true })
  const started = new Promise<{ data: { items: { mimeType: string, data: string }[], dragOperationsMask: number } }>((resolve, reject) => {
    cdp.once('Input.dragIntercepted', resolve)
    setTimeout(() => reject(new Error('no drag started')), 5000)
  })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let dx = 10; dx <= 60; dx += 10) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + dx, y: from.y, button: 'left', buttons: 1 })
  const { data } = await started
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.setInterceptDrags', { enabled: false })
  return data.items.find(item => item.mimeType === 'text/plain')?.data ?? ''
}

// Text dropped on the page from outside it, as from another program
async function droppedText(cdp: CDPSession, to: { x: number, y: number }, text: string): Promise<void> {
  const data = { items: [{ mimeType: 'text/plain', data: text }], dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data })
}

describe('a note dragged out of a frame', () => {
  it('opens as the human\'s once on the editor by its token, never as text, and nothing for a replay, an unknown token or a link out of the read, with no token for a note outside it', async () => {
    const { editor, kanban, marks, said } = await started()
    const tokens = Object.fromEntries((await said()).filter(data => data.token !== undefined).map(data => [data.token, data.is]))
    expect(tokens['secret.md']).toBeNull()
    expect(tokens['b.md']).toMatch(/^[0-9a-f]{32}$/)
    const first = await inFrame(editor, 'kanban', 0)
    await editor.mouse.click(first.x, first.y)
    await until(async () => (await title(editor)).startsWith('a.md'))
    const box = (await editor.locator('.editor:not([hidden]) .cm-content').boundingBox())!
    const onNote = { x: box.x + box.width / 2, y: box.y + 10 }
    const cdp = await editor.context().newCDPSession(editor)
    const text = await dragged(cdp, await inFrame(editor, 'kanban', 1), onNote)
    expect(text).toBe(`hetu-drag:${tokens['b.md']}`)
    await until(async () => (await title(editor)).startsWith('b.md'))
    // A drop is aimed at the editor, so focus goes to the note it opened
    await until(async () => editor.evaluate(() => document.activeElement?.closest('.cm-editor') !== null && document.activeElement?.closest('.cm-editor') !== undefined))
    await until(async () => (await opened(marks)).length === 2)
    expect(await humanOpened(marks)).toEqual(['a.md', 'b.md'])
    await droppedText(cdp, onNote, text)
    await droppedText(cdp, onNote, `hetu-drag:${'f'.repeat(32)}`)
    await tick(700)
    expect(await notesOpen(editor)).toBe(2)
    expect(await editor.locator('.cm-content', { hasText: 'hetu-drag' }).count()).toBe(0)
    expect(await humanOpened(marks)).toEqual(['a.md', 'b.md'])
    // A token for a note inside kanban's read opens, one for a link inside it to a note outside opens nothing
    await tell(kanban, { mint: 'public/link/x.md' })
    await tell(kanban, { mint: 'public/p.md' })
    await until(async () => (await said()).filter(data => data.token !== undefined).length === 6)
    const more = Object.fromEntries((await said()).filter(data => data.token !== undefined).map(data => [data.token, data.is]))
    expect(more['public/link/x.md']).toMatch(/^[0-9a-f]{32}$/)
    await droppedText(cdp, onNote, `hetu-drag:${more['public/link/x.md']}`)
    await droppedText(cdp, onNote, `hetu-drag:${more['public/p.md']}`)
    await until(async () => (await title(editor)).startsWith('public/p.md'))
    await tick(700)
    expect(await notesOpen(editor)).toBe(3)
    expect(await editor.locator('.cm-content', { hasText: 'SECRET' }).count()).toBe(0)
  })
})
