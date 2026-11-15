import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { entryFor, filesFor, workerManifest, writeFolder } from '../loader-fakes.ts'
import { cleanup, editorPage, exited, launch, logged, records, temp, tick, until, workersPage } from './helpers.ts'

afterEach(cleanup)

const sdk = path.join(import.meta.dirname, '..', '..', 'sdk', 'index.ts').split(path.sep).join('/')

// A plugin whose worker hands its ctx.editor to the test, which drives it from inside the worker. follow marks each
// stretch of text typed with info, made for the version the change came with, for the bridge's measurement (#73)
const fixture = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.editor = ctx.editor
    const heard: unknown[] = []
    scope.heard = heard
    scope.follow = false
    for (const topic of ['opened', 'changed', 'command'] as const) ctx.editor.on(topic, event => heard.push(event))
    ctx.editor.on('changed', event => {
      if (scope.follow !== true || event.topic !== 'editor.changed') return
      const marks = []
      let at = 0
      for (const part of event.changes) {
        if (typeof part === 'number') {
          at += part
          continue
        }
        const length = part.slice(1).join('\\n').length
        if (length > 0) marks.push({ kind: 'mark', from: at, to: at + length, style: 'info' })
        at += length
      }
      if (marks.length > 0) void ctx.editor.decorate(event.instance, event.version, 'follow', marks).catch(() => {})
    })
  },
})
`

type Setup = { notes: Record<string, string>, plugins?: Record<string, Capability[]>, off?: string[] }

async function prepared(setup: Setup): Promise<{ dataDir: string, folder: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches({ ...defaultSwitches(), off: setup.off ?? [] })
  await store.writeLuoshu({ folder })
  if (setup.plugins !== undefined) {
    const source = await temp()
    await writeFolder(source, { 'src/worker.ts': fixture })
    const [built] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
    for (const [id, granted] of Object.entries(setup.plugins)) {
      const root = path.join(dataDir, 'plugins', id)
      await writeFolder(root, filesFor(workerManifest(id, { capabilities: granted }), { 'worker.js': built.text }))
      await store.writePlugin(id, await entryFor(root, { granted }))
    }
  }
  return { dataDir, folder }
}

async function started(setup: Setup): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, folder: string }> {
  const { dataDir, folder } = await prepared(setup)
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
  for (const id of Object.keys(setup.plugins ?? {})) await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  return { app, editor, dataDir, folder }
}

const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')

async function open(editor: Page, name: string): Promise<void> {
  await editor.keyboard.press('ControlOrMeta+p')
  await until(async () => editor.locator('#palette').isVisible())
  await editor.keyboard.type(name)
  await until(async () => (await editor.locator('#palette-list li').first().innerText()) === name)
  await editor.keyboard.press('Enter')
  await until(async () => (await editor.locator('#title').innerText()).startsWith(name))
}

// A plugin's worker, once its ctx.editor has a port to this editor page
async function pluginWorker(app: ElectronApplication, id: string): Promise<Worker> {
  const page = await workersPage(app, id)
  await until(() => page.workers().length === 1)
  return page.workers()[0]
}

type Driven = { editor: Record<string, (...args: unknown[]) => Promise<unknown>>, follow: boolean, heard: unknown[], after?: string }

// Runs work inside the worker with its global, where the fixture left its ctx.editor
const drive = <T>(worker: Worker, work: (scope: Driven) => Promise<T>) =>
  worker.evaluate(`(${work.toString()})(globalThis)`) as Promise<T>

describe('the drawer', () => {
  it('opens a note through quick open, edits it and saves it to disk', async () => {
    const { editor, folder } = await started({ notes: { 'a.md': 'first line', 'b.md': 'b' } })
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    await editor.keyboard.type(', typed')
    await until(async () => (await editor.locator('#title').innerText()) === 'a.md (unsaved)')
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await readFile(path.join(folder, 'a.md'), 'utf8')) === 'first line, typed')
    await until(async () => (await editor.locator('#title').innerText()) === 'a.md')
  })

  it('keeps the text as a draft when the note changed outside, and offers it back after Reload', async () => {
    const { editor, folder } = await started({ notes: { 'a.md': 'original' } })
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    await editor.keyboard.type(' mine')
    await writeFile(path.join(folder, 'a.md'), 'changed outside')
    await until(async () => (await editor.locator('#note-text').innerText()).includes('changed outside hetu while it has unsaved text'))
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await editor.locator('#note-text').innerText()).includes('so it wasn\'t saved'))
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe('changed outside')
    await editor.getByRole('button', { name: 'Reload' }).click()
    await until(async () => (await shown(editor).innerText()) === 'changed outside')
    await until(async () => (await editor.locator('#note-text').innerText()).includes('A draft of this note'))
    await editor.getByRole('button', { name: 'Restore' }).click()
    await until(async () => (await shown(editor).innerText()) === 'original mine')
  })

  it('hides markers with hidden marks and shows the real text in the raw view over the whole window', async () => {
    const { editor } = await started({ notes: { 'a.md': '# Title\n\n**bold** text' } })
    await open(editor, 'a.md')
    await until(async () => (await shown(editor).innerText()).includes('bold text'))
    expect(await shown(editor).innerText()).not.toContain('**')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+/')
    await until(async () => editor.locator('#raw').isVisible())
    expect(await editor.locator('#raw-title').innerText()).toBe('a.md')
    expect(await editor.locator('#raw-text').innerText()).toBe('# Title\n\n**bold** text')
    // Over the whole window, whatever is under it
    const box = await editor.locator('#raw').boundingBox()
    const size = editor.viewportSize() ?? await editor.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(box).toMatchObject({ x: 0, y: 0, width: size.width, height: size.height })
    await editor.keyboard.press('Escape')
    await until(async () => !(await editor.locator('#raw').isVisible()))
  })

  it('shows the markers with hidden-marks switched off', async () => {
    const { editor } = await started({ notes: { 'a.md': '**bold** text' }, off: ['hidden-marks'] })
    await open(editor, 'a.md')
    await tick(500)
    expect(await shown(editor).innerText()).toBe('**bold** text')
  })

  it('lets a plugin read, decorate and edit an open note, and names it on the save that carries its edit', async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.edit', paths: ['**'] }, { type: 'ui.decoration' }]
    const { app, editor, dataDir, folder } = await started({ notes: { 'a.md': 'mark this word' }, plugins: { marker: granted } })
    await open(editor, 'a.md')
    const worker = await pluginWorker(app, 'marker')
    await until(async () => (await drive(worker, async scope => (await scope.editor.instances() as unknown[]).length)) === 1)
    const read = await drive(worker, async scope => {
      const [open] = await scope.editor.instances() as { instance: string }[]
      return { instance: open.instance, ...await scope.editor.read(open.instance) as { text: string, version: number } }
    })
    expect(read.text).toBe('mark this word')
    await drive(worker, async scope => {
      const [open] = await scope.editor.instances() as { instance: string, version: number }[]
      await scope.editor.decorate(open.instance, open.version, 'words', [{ kind: 'mark', from: 5, to: 9, style: 'error' }])
    })
    await until(async () => (await editor.locator('.cm-hetu-error').count()) === 1)
    expect(await editor.locator('.cm-hetu-error').innerText()).toBe('this')
    const edited = await drive(worker, async scope => {
      const [open] = await scope.editor.instances() as { instance: string, version: number }[]
      return scope.editor.edit(open.instance, open.version, [[0, 'Please '], 14])
    })
    expect(edited).toEqual({ version: 1 })
    await until(async () => (await shown(editor).innerText()) === 'Please mark this word')
    expect(await editor.locator('.cm-hetu-error').innerText()).toBe('this')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await readFile(path.join(folder, 'a.md'), 'utf8')) === 'Please mark this word')
    await until(async () => (await records(dataDir)).some(record => record.event === 'audit.call' && record.action === 'luoshu.write' && record.onBehalf === 'marker'))
  })

  it('refuses a verb a plugin lacks and lists no note outside its read scope', async () => {
    const plugins: Record<string, Capability[]> = { plain: [{ type: 'luoshu.read', paths: ['other/**'] }, { type: 'ui.command' }] }
    const { app, editor } = await started({ notes: { 'a.md': 'secret' }, plugins })
    await open(editor, 'a.md')
    const worker = await pluginWorker(app, 'plain')
    await until(async () => {
      const answer = await drive(worker, async scope => scope.editor.instances().then(() => 'ok', (err: { code: string }) => err.code))
      return answer === 'ok'
    })
    expect(await drive(worker, async scope => scope.editor.instances())).toEqual([])
    const codes = await drive(worker, async scope => Promise.all([
      scope.editor.read('n1').then(() => 'ok', (err: { code: string }) => err.code),
      scope.editor.decorate('n1', 0, 's', []).then(() => 'ok', (err: { code: string }) => err.code),
    ]))
    expect(codes).toEqual(['not-granted', 'not-granted'])
    expect(await drive(worker, async scope => scope.heard)).toEqual([])
  })

  it('takes outside text into a clean buffer without moving the cursor, adding to undo or marking it unsaved', async () => {
    const { editor, folder } = await started({ notes: { 'a.md': 'line one\nline two\nline three' }, off: ['hidden-marks'] })
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+Home')
    await editor.keyboard.press('ArrowDown')
    await editor.keyboard.press('ArrowRight')
    await editor.keyboard.press('ArrowRight')
    await writeFile(path.join(folder, 'a.md'), 'line one\nline two\nline three changed')
    await until(async () => (await shown(editor).innerText()) === 'line one\nline two\nline three changed')
    expect(await editor.locator('#title').innerText()).toBe('a.md')
    await editor.keyboard.type('X')
    await until(async () => (await shown(editor).innerText()) === 'line one\nliXne two\nline three changed')
    await editor.keyboard.press('ControlOrMeta+z')
    await until(async () => (await shown(editor).innerText()) === 'line one\nline two\nline three changed')
    await editor.keyboard.press('ControlOrMeta+z')
    await tick(300)
    expect(await shown(editor).innerText()).toBe('line one\nline two\nline three changed')
  })

  it('keeps CRLF through a save', async () => {
    const { editor, folder } = await started({ notes: { 'c.md': 'a\r\nb\r\nc' } })
    await open(editor, 'c.md')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    await editor.keyboard.type('!')
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await readFile(path.join(folder, 'c.md'), 'utf8')) === 'a\r\nb\r\nc!')
  })

  it("shows a note's notice on that note only", async () => {
    const { editor, folder } = await started({ notes: { 'a.md': 'a', 'b.md': 'b' } })
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.type(' typed')
    await writeFile(path.join(folder, 'a.md'), 'changed outside')
    await until(async () => editor.locator('#note-bar').isVisible())
    await open(editor, 'b.md')
    await until(async () => !(await editor.locator('#note-bar').isVisible()))
    await open(editor, 'a.md')
    await until(async () => editor.locator('#note-bar').isVisible())
  })

  it.each([
    ['Ctrl+Q', (editor: Page) => editor.keyboard.press('ControlOrMeta+q')],
    ['a quit from main', (_editor: Page, app: ElectronApplication) => app.evaluate(({ app }) => app.quit())],
  ] as const)('keeps what was typed just before %s as a draft', async (_name, quit) => {
    const { app, editor, dataDir } = await started({ notes: { 'a.md': 'base' } })
    await open(editor, 'a.md')
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    await editor.keyboard.type(' typed last')
    const done = exited(app)
    await quit(editor, app)
    expect(await done).toBe(0)
    const again = await launch(dataDir)
    const next = await editorPage(again)
    await until(() => logged(dataDir, 'plugin.started', { plugin: 'luoshu' }))
    await open(next, 'a.md')
    await until(async () => (await next.locator('#note-text').innerText()).includes('A draft of this note'))
    await next.getByRole('button', { name: 'Restore' }).click()
    await until(async () => (await shown(next).innerText()) === 'base typed last')
  })

  it("lets a Backspace beside a plugin's hidden text take one character, and names the plugin on the save", async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const text = 'Keep: do NOT pay Bob until the audit ends. Then sign.'
    const { app, editor, dataDir, folder } = await started({ notes: { 'a.md': text }, plugins: { painter: granted }, off: ['hidden-marks'] })
    await open(editor, 'a.md')
    const worker = await pluginWorker(app, 'painter')
    await until(async () => (await drive(worker, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    await drive(worker, async scope => {
      const [open] = await scope.editor.instances() as { instance: string, version: number }[]
      await scope.editor.decorate(open.instance, open.version, 'hide', [{ kind: 'hide', from: 6, to: 43 }])
    })
    await until(async () => (await shown(editor).innerText()) === 'Keep: Then sign.')
    await shown(editor).click()
    await editor.keyboard.press('End')
    for (let i = 0; i < 'Then sign.'.length; i++) await editor.keyboard.press('ArrowLeft')
    await editor.keyboard.press('Backspace')
    await editor.keyboard.press('ControlOrMeta+s')
    await until(async () => (await readFile(path.join(folder, 'a.md'), 'utf8')) !== text)
    expect((await readFile(path.join(folder, 'a.md'), 'utf8')).length).toBe(text.length - 1)
    await until(async () => (await records(dataDir)).some(record => record.event === 'audit.call' && record.action === 'luoshu.write' && record.onBehalf === 'painter'))
  })

  it('gives a plugin a new port after the editor renderer crashed and the page loaded again', async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const { app, editor } = await started({ notes: { 'a.md': 'a' }, plugins: { marker: granted } })
    await open(editor, 'a.md')
    const worker = await pluginWorker(app, 'marker')
    await until(async () => (await drive(worker, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL() === 'hetu://editor/')!.forcefullyCrashRenderer())
    await tick(1000)
    // A call made while the page is gone waits, and fails unavailable once a new page load's port comes
    await drive(worker, async scope => {
      scope.after = 'waiting'
      void scope.editor.instances().then(() => {
        scope.after = 'answered'
      }, (err: { code: string }) => {
        scope.after = `refused ${err.code}`
      })
    })
    await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(contents => contents.getURL() === 'hetu://editor/')!.reload())
    await until(async () => (await drive(worker, async scope => scope.after)) === 'refused unavailable')
    // The new load has no note open, and the plugin's new port answers
    expect(await drive(worker, async scope => scope.editor.instances().then(list => (list as unknown[]).length))).toBe(0)
  })

  it('gives a plugin a new port when the editor page loads again', async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const { app, editor } = await started({ notes: { 'a.md': 'mark this word' }, plugins: { marker: granted } })
    const worker = await pluginWorker(app, 'marker')
    await editor.reload()
    await until(async () => (await editor.locator('#title').innerText()) === 'No note open')
    await open(editor, 'a.md')
    await until(async () => (await drive(worker, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    await drive(worker, async scope => {
      const [open] = await scope.editor.instances() as { instance: string, version: number }[]
      await scope.editor.decorate(open.instance, open.version, 'words', [{ kind: 'mark', from: 0, to: 4, style: 'error' }])
    })
    await until(async () => (await editor.locator('.cm-hetu-error').count()) === 1)
  })

  // #73: how long a keystroke takes to come back from a worker as a decoration, on a large note
  it('measures the bridge from a key to a decoration from a worker', async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    // The last line is plain, so its text on screen is the text typed
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} with **some** text and a [link](https://example.com/${i})`)
    const big = [...lines, 'plain'].join('\n')
    const { app, editor } = await started({ notes: { 'big.md': big }, plugins: { marker: granted } })
    await open(editor, 'big.md')
    const worker = await pluginWorker(app, 'marker')
    await until(async () => (await drive(worker, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    await drive(worker, async scope => {
      scope.follow = true
    })
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    // For each key: when the character itself is on screen, then when the worker's mark on it is
    await editor.evaluate(() => {
      const scope = window as unknown as { timings: { typed: number, marked: number }[], expect: string, length: number }
      scope.timings = []
      let started = 0
      let typed = 0
      window.addEventListener('keydown', () => {
        started = performance.now()
        typed = 0
      }, true)
      new MutationObserver(() => {
        if (started === 0) return
        const now = performance.now()
        const line = document.querySelector('.editor:not([hidden]) .cm-content .cm-line:last-child')
        if (typed === 0 && line?.textContent?.length === scope.length) typed = now
        const marks = document.querySelectorAll('.editor:not([hidden]) .cm-hetu-info')
        if (typed > 0 && marks[marks.length - 1]?.textContent === scope.expect) {
          scope.timings.push({ typed: typed - started, marked: now - started })
          started = 0
        }
      }).observe(document.getElementById('editors')!, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    const letters = 'abcdefghij'
    for (let i = 0; i < 100; i++) {
      const letter = letters[i % letters.length]
      await editor.evaluate(([next, length]) => {
        Object.assign(window, { expect: next, length })
      }, [letter, 'plain'.length + i + 1] as const)
      await editor.keyboard.press(letter)
      await until(async () => (await editor.evaluate(() => (window as unknown as { timings: unknown[] }).timings.length)) === i + 1, 5000)
    }
    const timings = await editor.evaluate(() => (window as unknown as { timings: { typed: number, marked: number }[] }).timings)
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
    const marked = sorted(timings.map(each => each.marked))
    const typed = sorted(timings.map(each => each.typed))
    const bridge = sorted(timings.map(each => each.marked - each.typed))
    const summary = (values: number[]) => ({ median: values[49], p95: values[94], max: values[99] })
    // HETU_MEASURE names a file for the numbers, for the record
    const measured = process.env.HETU_MEASURE
    if (measured !== undefined) {
      await writeFile(measured, JSON.stringify({ marked: summary(marked), typed: summary(typed), bridge: summary(bridge), timings }))
    }
    expect(timings).toHaveLength(100)
  })
})
