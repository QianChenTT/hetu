import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, hashOf, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, launch, logged, pageAt, records, temp, tick, until, visibleWindows, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A plugin whose worker hands its whole ctx to the test, which drives it from inside the worker
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.ctx = ctx
    const heard: unknown[] = []
    scope.heard = heard
    ctx.editor.on('opened', event => heard.push(event))
  },
})
`

type Setup = { notes: Record<string, string>, plugins?: Record<string, Capability[]> }

async function started(setup: Setup): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, folder: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
    await writeFile(path.join(folder, name), text)
  }
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  if (setup.plugins !== undefined) {
    const source = await temp()
    await writeFolder(source, { 'src/worker.ts': fixture })
    const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
    for (const [id, granted] of Object.entries(setup.plugins)) {
      const root = path.join(dataDir, 'plugins', id)
      await writeFolder(root, filesFor(workerManifest(id, { capabilities: granted }), { 'worker.js': built.text }))
      // Approved with each item's first use confirmed, which the entry records. The start classes it again
      await store.writePlugin(id, await entryFor(root, { granted, class: 4, confirmed: granted }))
    }
  }
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
  for (const id of Object.keys(setup.plugins ?? {})) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor, dataDir, folder }
}

const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')

// The human opens a note through quick open
async function open(editor: Page, name: string): Promise<void> {
  await editor.keyboard.press('ControlOrMeta+p')
  await until(async () => editor.locator('#palette').isVisible())
  await editor.keyboard.type(name)
  await until(async () => (await editor.locator('#palette-list li').first().innerText()) === name)
  await editor.keyboard.press('Enter')
  await until(async () => (await editor.locator('#title').innerText()).startsWith(name))
}

async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0]
}

type Ctx = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>
type Driven = { ctx: Ctx, heard: unknown[] }

// Runs work inside the worker with its global, where the fixture left its ctx
const drive = <T>(worker: Worker, work: (scope: Driven) => Promise<T>) =>
  worker.evaluate(`(${work.toString()})(globalThis)`) as Promise<T>

type Reply = { ok: boolean, result?: unknown, refusal?: { code: string } }
let next = 9000

// A call through the editor window's bridge, as its own code makes one: the editor holds write and read on **
const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
  const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
  bridge.listen(message => {
    const reply = message as { kind?: string, id?: number }
    if (reply.kind === 'reply' && reply.id === id) resolve(reply)
  })
  bridge.send({ v: 1, kind: 'call', id, action, args })
}), [next++, action, args] as const) as Promise<Reply>

const codeOf = (reply: Reply) => (reply.ok ? 'ok' : reply.refusal?.code)

// Runs a script over each item of the Windows recycle bin deleted from folder and gives back its lines. Read through
// the shell's own view of the bin, which names each item's original folder
function inBin(folder: string, each: string): string[] {
  const script = [
    '$bin = (New-Object -ComObject Shell.Application).NameSpace(10)',
    `$from = '${folder.replace(/'/g, "''")}'`,
    `$bin.Items() | Where-Object { $bin.GetDetailsOf($_, 1) -eq $from } | ForEach-Object { ${each} }`,
  ].join('; ')
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
}

// The names of what the bin holds from folder. An item's Name is the one Explorer shows, which drops a known extension
// while Explorer hides them, so the name the file had is read
const binned = (folder: string) => inBin(folder, "$_.ExtendedProperty('System.FileName')")

// Puts all the bin holds from folder back into it, through the bin's own Restore
const putBack = (folder: string) => inBin(folder, "$_.InvokeVerb('undelete')")

describe('luoshu.move and luoshu.remove in the app', () => {
  // With write alone, a plugin that writes everywhere and reads public/** could carry a private note into public/
  it('refuses a plugin with write on ** and read on public/** moving private/x.md anywhere', async () => {
    const granted: Capability[] = [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['public/**'] }]
    const { app, folder } = await started({ notes: { 'private/x.md': 'secret', 'public/p.md': 'p' }, plugins: { sorter: granted } })
    const worker = await pluginWorker(app, 'sorter')
    const codes = await drive(worker, async scope => {
      const tried: string[] = []
      for (const to of ['public/x.md', 'private/y.md', 'x.md']) {
        tried.push(await scope.ctx.luoshu.move({ from: 'private/x.md', to }).then(() => 'ok', (err: { code: string }) => err.code))
      }
      return tried
    })
    expect(codes).toEqual(['not-granted', 'not-granted', 'not-granted'])
    expect(await readFile(path.join(folder, 'private', 'x.md'), 'utf8')).toBe('secret')
    expect((await readdir(path.join(folder, 'public'))).sort()).toEqual(['p.md'])
    // Inside both grants the move lands
    expect(await drive(worker, async scope => scope.ctx.luoshu.move({ from: 'public/p.md', to: 'public/q.md' }))).toBe(null)
    expect(await readFile(path.join(folder, 'public', 'q.md'), 'utf8')).toBe('p')
  })

  it('renames a.md to A.md in place and never moves onto a note that exists', async () => {
    const { editor, folder } = await started({ notes: { 'a.md': 'note a', 'b.md': 'note b' } })
    expect(codeOf(await ask(editor, 'luoshu.move', { from: 'a.md', to: 'b.md' }))).toBe('stale')
    expect(codeOf(await ask(editor, 'luoshu.move', { from: 'a.md', to: 'A.md' }))).toBe('ok')
    expect((await readdir(folder)).sort()).toEqual(['A.md', 'b.md'])
    expect(await readFile(path.join(folder, 'A.md'), 'utf8')).toBe('note a')
    expect(await readFile(path.join(folder, 'b.md'), 'utf8')).toBe('note b')
  })

  it('hands a removed note to the OS bin, so it is gone from the folder and can be put back', async () => {
    const name = `removed-${Date.now()}.md`
    const { editor, folder } = await started({ notes: { [name]: 'to the bin' } })
    expect(codeOf(await ask(editor, 'luoshu.remove', { path: name }))).toBe('invalid')
    const { version } = (await ask(editor, 'luoshu.read', { path: name })).result as { version: string }
    expect(codeOf(await ask(editor, 'luoshu.remove', { path: name, baseVersion: version }))).toBe('ok')
    expect(await readdir(folder)).toEqual([])
    if (process.platform !== 'win32') return
    // Put back whatever the check finds, so no run leaves the note in the bin
    const from = await realpath(folder)
    try {
      expect(binned(from)).toEqual([name])
    } finally {
      putBack(from)
    }
    await until(async () => (await readdir(folder)).includes(name))
    expect(await readFile(path.join(folder, name), 'utf8')).toBe('to the bin')
    expect(binned(from)).toEqual([])
  })
})

describe('ui.edit and ui.read in the app', () => {
  // The plugin reads the note on screen through ui.read and changes it only through the editor, under ui.edit
  it('lets a plugin holding ui.edit and ui.read change the open note, which the save names, and refuses it luoshu.write', async () => {
    const granted: Capability[] = [{ type: 'ui.edit', paths: ['**'] }, { type: 'ui.read', paths: ['**'] }]
    const { app, editor, dataDir, folder } = await started({ notes: { 'a.md': 'mark this word' }, plugins: { formatter: granted } })
    const worker = await pluginWorker(app, 'formatter')
    await open(editor, 'a.md')
    await until(async () => (await drive(worker, async scope => (await scope.ctx.editor.instances() as unknown[]).length)) === 1)
    const edited = await drive(worker, async scope => {
      const [opened] = await scope.ctx.editor.instances() as { instance: string, version: number }[]
      const read = await scope.ctx.editor.read(opened.instance) as { text: string }
      const after = await scope.ctx.editor.edit(opened.instance, opened.version, [[0, 'Please '], read.text.length])
      const written = await scope.ctx.luoshu.write({ path: 'a.md', text: 'straight to disk' }).then(() => 'ok', (err: { code: string }) => err.code)
      return { text: read.text, after, written }
    })
    expect(edited).toEqual({ text: 'mark this word', after: { version: 1 }, written: 'not-granted' })
    await until(async () => (await shown(editor).innerText()) === 'Please mark this word')
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('mark this word')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await readFile(path.join(folder, 'a.md'), 'utf8')) === 'Please mark this word')
    await until(async () => (await records(dataDir)).some(record => record.event === 'audit.call' && record.action === 'luoshu.write' && record.onBehalf === 'formatter'))
  })

  it('lets a plugin holding only ui.read read the note the human opened and no other', async () => {
    const plugins: Record<string, Capability[]> = {
      reader: [{ type: 'ui.read', paths: ['**'] }],
      // Opens b.md through editor.open, which needs its own read and never makes the note the human's
      opener: [{ type: 'luoshu.read', paths: ['b.md'] }, { type: 'ui.view' }],
    }
    const { app, editor } = await started({ notes: { 'a.md': 'shown', 'b.md': 'not shown' }, plugins })
    const reader = await pluginWorker(app, 'reader')
    const opener = await pluginWorker(app, 'opener')
    await open(editor, 'a.md')
    expect(await drive(opener, async scope => scope.ctx.editor.open('b.md').then(() => 'ok', (err: { code: string }) => err.code))).toBe('ok')
    await until(async () => (await drive(opener, async scope => (await scope.ctx.editor.instances() as unknown[]).length)) === 1)
    await until(async () => (await drive(reader, async scope => (await scope.ctx.editor.instances() as unknown[]).length)) === 1)
    const seen = await drive(reader, async scope => {
      const listed = await scope.ctx.editor.instances() as { instance: string, path: string }[]
      const text = (await scope.ctx.editor.read(listed[0].instance) as { text: string }).text
      const others = ['n1', 'n2', 'n3'].filter(id => id !== listed[0].instance)
      const refused = await Promise.all(others.map(id => scope.ctx.editor.read(id).then(() => 'ok', (err: { code: string }) => err.code)))
      const direct = await scope.ctx.luoshu.read({ path: 'a.md' }).then(() => 'ok', (err: { code: string }) => err.code)
      return { paths: listed.map(each => each.path), text, refused, direct }
    })
    expect(seen.paths).toEqual(['a.md'])
    expect(seen.text).toBe('shown')
    expect(seen.refused.every(code => code === 'not-granted' || code === 'not-found')).toBe(true)
    expect(seen.refused).toContain('not-granted')
    expect(seen.direct).toBe('not-granted')
    // A plugin holding ui.read alone opens nothing itself
    expect(await drive(reader, async scope => scope.ctx.editor.open('b.md').then(() => 'ok', (err: { code: string }) => err.code))).toBe('not-granted')
  })

  // public/link is a junction to private inside the notes folder. The window names a note by where the luoshu found it
  it('opens nothing for a plugin naming a note through a junction into a folder it can\'t read, and names a note by where it is', async () => {
    const plugins: Record<string, Capability[]> = {
      pub: [{ type: 'luoshu.read', paths: ['public/**'] }, { type: 'ui.view' }],
      priv: [{ type: 'luoshu.read', paths: ['private/**'] }, { type: 'ui.view' }],
    }
    const { app, folder } = await started({ notes: { 'public/a.md': 'public text', 'private/x.md': 'SECRET' }, plugins })
    await symlink(path.join(folder, 'private'), path.join(folder, 'public', 'link'), 'junction')
    const pub = await pluginWorker(app, 'pub')
    const priv = await pluginWorker(app, 'priv')
    // Each runs in the worker as its own text, so the path is written in each
    const listed = (worker: Worker) => drive(worker, async scope => (await scope.ctx.editor.instances() as { path: string }[]).map(each => each.path))
    // Answered as an open whose read failed, and nothing opens
    expect(await drive(pub, async scope => scope.ctx.editor.open('public/link/x.md').then(() => 'ok', (err: { code: string }) => err.code))).toBe('ok')
    expect(await drive(priv, async scope => scope.ctx.editor.open('public/link/x.md').then(() => 'ok', (err: { code: string }) => err.code))).toBe('not-granted')
    await tick(300)
    expect(await listed(priv)).toEqual([])
    expect(await drive(pub, async scope => scope.ctx.editor.open('public/a.md').then(() => 'ok', (err: { code: string }) => err.code))).toBe('ok')
    await until(async () => (await listed(pub)).length === 1)
    expect(await drive(priv, async scope => scope.ctx.editor.open('private/x.md').then(() => 'ok', (err: { code: string }) => err.code))).toBe('ok')
    await until(async () => (await listed(priv)).length === 1)
    await tick(200)
    expect(await listed(pub)).toEqual(['public/a.md'])
    expect(await listed(priv)).toEqual(['private/x.md'])
  })
})

describe('a class another plugin\'s approval moves', () => {
  // The input delay and a little more, so a click after it lands
  const PAST_DELAY = 1300
  const fetchOne: Capability = { type: 'net.fetch', hosts: ['example.com'] }
  const hears: Capability = { type: 'events.subscribe', topics: ['reader.done'] }
  // A worker speaking the lifecycle as text on the port its page hands it, doing nothing else
  const idle = `
self.onmessage = event => {
  const port = event.ports[0]
  self.onmessage = null
  const send = message => port.postMessage(JSON.stringify(message))
  port.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.kind === 'init') send({ v: 1, kind: 'ready' })
    else if (message.kind === 'ping') send({ v: 1, kind: 'pong' })
    else if (message.kind === 'stop') send({ v: 1, kind: 'stopped' })
  }
}
`

  // The listener holds network and hears the reader's topic. It was approved while the reader wasn't installed, so its
  // entry holds class 3 and nothing asking
  it('names the network listener with 3 and 4 on the reader\'s Confirm, then stores 4 with its fetch asking at first use', async () => {
    const dataDir = await temp()
    const store = new StateStore(dataDir)
    const listener = path.join(dataDir, 'plugins', 'listener')
    await writeFolder(listener, filesFor(workerManifest('listener', { capabilities: [fetchOne, hears] }), { 'worker.js': idle }))
    await store.writePlugin('listener', await entryFor(listener, { granted: [fetchOne, hears], class: 3 }))
    const reader = path.join(dataDir, 'plugins', 'reader')
    await writeFolder(reader, filesFor(workerManifest('reader', { capabilities: [{ type: 'luoshu.read', paths: ['**'] }] }), { 'worker.js': idle }))
    // An approval writes no signer until plugin provenance, so this build is trusted as the human would trust one
    await store.writeSwitches({ ...defaultSwitches(), allowUnsigned: [await hashOf(reader)] })
    await store.writeLuoshu({ folder: await temp() })
    const app = await launch(dataDir)
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'capabilities' }))
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await pageAt(app, 'hetu://trusted/')
    await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
    const row = (id: string) => page.locator('.plugin', { hasText: `${id} ·` })
    await until(async () => (await row('listener').innerText()).includes('class 3'))
    await tick(PAST_DELAY)
    await row('reader').getByRole('button', { name: 'Approve' }).click()
    await until(async () => (await page.locator('#root').innerText()).includes('Raises listener from class 3, Network to class 4, Powerful'))
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await until(async () => (await row('listener').innerText()).includes('net.fetch to "example.com" · asks at first use'))
    expect(await row('listener').innerText()).toContain('class 4')
    const entry = (await new StateStore(dataDir).load()).state.plugins.listener
    expect(entry).toMatchObject({ class: 4, firstUse: [fetchOne, hears] })
  })

  // A window's call to the core through its bridge, answered with the reply
  let next = 1
  const ask = (page: Page, action: string, args?: unknown) => page.evaluate(([id, action, args]) => new Promise<unknown>(resolve => {
    const bridge = (window as unknown as { hetu: { send(m: unknown): void, listen(f: (m: unknown) => void): void } }).hetu
    bridge.listen(message => {
      const reply = message as { kind?: string, id?: number }
      if (reply.kind === 'reply' && reply.id === id) resolve(reply)
    })
    bridge.send({ v: 1, kind: 'call', id, action, args })
  }), [next++, action, args] as const) as Promise<{ ok: boolean, result?: unknown }>

  async function trustedWindow(app: ElectronApplication, editor: Page): Promise<Page> {
    await tick(PAST_DELAY)
    await editor.getByRole('button', { name: 'Plugins and security' }).click()
    const page = await pageAt(app, 'hetu://trusted/')
    await until(async () => (await visibleWindows(app)).includes('hetu://trusted/'))
    return page
  }

  it('shows the screen and the plugin\'s own Raises line on the Confirm of a restore of a bundled plugin the human narrowed', async () => {
    const dataDir = await temp()
    const store = new StateStore(dataDir)
    await store.writeSwitches(defaultSwitches())
    await store.writeLuoshu({ folder: await temp() })
    const app = await launch(dataDir)
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'search' }))
    const readAll: Capability = { type: 'luoshu.read', paths: ['**'] }
    expect((await ask(editor, 'security.request', { change: { kind: 'grant.narrow', plugin: 'search', capability: readAll } })).ok).toBe(true)
    expect((await new StateStore(dataDir).load()).state.plugins.search).toMatchObject({ class: 0 })
    expect((await ask(editor, 'security.request', { change: { kind: 'plugin.restore', plugin: 'search' } })).ok).toBe(true)
    const page = await trustedWindow(app, editor)
    await until(async () => (await page.locator('#root').innerText()).includes('Raises search from class 0, Contained to class 1, Reader'))
    expect(await page.locator('#root').innerText()).toContain('Class 1, Reader')
  })

  it('shows a notice in the trusted window for a stale class 0 listener the start finds beside a reader, at 4 already', async () => {
    const dataDir = await temp()
    const store = new StateStore(dataDir)
    const listener = path.join(dataDir, 'plugins', 'listener')
    await writeFolder(listener, filesFor(workerManifest('listener', { capabilities: [fetchOne, hears] }), { 'worker.js': idle }))
    await store.writePlugin('listener', await entryFor(listener, { granted: [fetchOne, hears], class: 0 }))
    const reader = path.join(dataDir, 'plugins', 'reader')
    const readAll: Capability = { type: 'luoshu.read', paths: ['**'] }
    await writeFolder(reader, filesFor(workerManifest('reader', { capabilities: [readAll], provides: { topics: ['done'] } }), { 'worker.js': idle }))
    await store.writePlugin('reader', await entryFor(reader, { granted: [readAll], class: 1 }))
    await store.writeSwitches(defaultSwitches())
    await store.writeLuoshu({ folder: await temp() })
    const app = await launch(dataDir)
    const editor = await editorPage(app)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'listener' }))
    expect((await new StateStore(dataDir).load()).state.plugins.listener).toMatchObject({ class: 4, firstUse: [fetchOne, hears] })
    const page = await trustedWindow(app, editor)
    const text = '"listener" moved from class 0, Contained to class 4, Powerful with no Confirm on screen'
    await until(async () => (await page.locator('#root').innerText()).includes(text))
    await tick(PAST_DELAY)
    await page.getByRole('button', { name: 'Confirm' }).click()
    await until(async () => !(await page.locator('#root').innerText()).includes(text))
    expect((await new StateStore(dataDir).load()).state.plugins.listener).toMatchObject({ class: 4, firstUse: [fetchOne, hears] })
  })
})
