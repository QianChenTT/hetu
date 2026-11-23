import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication, Page, Worker } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { held, type Run, type Sitting, summary } from '../../../scripts/measure-bridge.ts'
import type { Capability } from '../../api/capabilities.ts'
import { defaultSwitches, StateStore } from '../../backend/boot/state.ts'
import { buildPlugin } from '../../sdk/build/esbuild.ts'
import { filesFor, workerManifest, writeFolder, writeApproved } from '../plugins-manager-fakes.ts'
import { cleanup, editorPage, exited, launch, logged, records, temp, tick, until, workersPage, openByHand, writeOpener } from './helpers.ts'

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
    for (const topic of ['opened', 'changed', 'command', 'viewport'] as const) ctx.editor.on(topic, event => heard.push(event))
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

// Loads for the bridge's measurement, each started and stopped from the test and counting what it did. redraw draws a
// view of 100 rows ten times a second, each row's text new each time. flood sends decorations of 2,500 marks over the
// note's lines of more than 20 characters, which leaves out the plain last one, eight at a time and again as each
// answers, which passes the marks a second the drawer takes. index reads each note a change names again, as search
// does to index it
const loads = `
import { definePlugin } from '${sdk}'
export default definePlugin({
  start(ctx) {
    const scope = globalThis as Record<string, unknown>
    scope.editor = ctx.editor
    const counts = { draws: 0, refusedDraws: 0, drawn: 0, throttled: 0, refused: 0 }
    scope.counts = counts
    let view: string | null = null
    ctx.ui.on('view.opened', event => {
      view = event.instance
    })
    const rows = (tick: number) => ({
      kind: 'box', id: 'root',
      children: Array.from({ length: 100 }, (_, i) => ({ kind: 'text', id: 'row' + i, text: 'row ' + i + ' at ' + tick })),
    })
    let redrawing: ReturnType<typeof setInterval> | null = null
    scope.redraw = (on: boolean) => {
      if (redrawing !== null) clearInterval(redrawing)
      redrawing = null
      if (!on) return
      let tick = 0
      redrawing = setInterval(() => {
        if (view === null) return
        tick++
        ctx.ui.views.draw(view, rows(tick) as never).then(() => {
          counts.draws++
        }, () => {
          counts.refusedDraws++
        })
      }, 100)
    }
    let version = 0
    ctx.editor.on('changed', event => {
      if (event.topic === 'editor.changed') version = event.version
    })
    let flooding = false
    let inFlight = 0
    let idle: (() => void) | null = null
    scope.flood = async (on: boolean) => {
      flooding = on
      const [open] = await ctx.editor.instances()
      if (!on) {
        if (inFlight > 0) await new Promise<void>(resolve => {
          idle = resolve
        })
        for (;;) {
          const cleared = await ctx.editor.decorate(open.instance, version, 'flood', []).then(() => true, () => false)
          if (cleared) return
          await new Promise(resolve => setTimeout(resolve, 200))
        }
      }
      const read = await ctx.editor.read(open.instance)
      version = read.version
      const starts: number[] = []
      let at = 0
      for (const line of read.text.split('\\n').slice(0, -1)) {
        if (line.length > 20) starts.push(at)
        at += line.length + 1
      }
      let tick = 0
      const marks = () => {
        tick++
        const out = []
        for (let k = 0; k < 2500; k++) {
          const from = starts[k % starts.length] + Math.floor(k / starts.length) * 5 + (tick % 2)
          out.push({ kind: 'mark' as const, from, to: from + 4, style: tick % 2 === 0 ? 'muted' as const : 'em' as const })
        }
        return out
      }
      const pump = () => {
        while (flooding && inFlight < 8) {
          inFlight++
          ctx.editor.decorate(open.instance, version, 'flood', marks()).then(() => {
            counts.drawn += 2500
          }, (err: { code?: string }) => {
            if (err.code === 'throttled') counts.throttled++
            else counts.refused++
          }).finally(() => {
            inFlight--
            if (inFlight === 0 && idle !== null) {
              idle()
              idle = null
            }
            pump()
          })
        }
      }
      pump()
    }
    scope.index = async () => {
      await ctx.events.on(['luoshu.changed', 'luoshu.outside'], event => {
        if (event.path !== undefined) void ctx.luoshu.read({ path: event.path }).catch(() => {})
      })
    }
  },
})
`

type Load = { granted: Capability[], manifest?: object }
type Setup = { notes: Record<string, string>, plugins?: Record<string, Capability[]>, loads?: Record<string, Load> }

async function built(code: string): Promise<string> {
  const source = await temp()
  await writeFolder(source, { 'src/worker.ts': code })
  const [one] = await buildPlugin(source, { entries: { 'worker.js': 'src/worker.ts' }, workers: ['worker.js'], write: false })
  return one.text
}

async function prepared(setup: Setup): Promise<{ dataDir: string, folder: string }> {
  const folder = await temp()
  for (const [name, text] of Object.entries(setup.notes)) await writeFile(path.join(folder, name), text)
  const dataDir = await temp()
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  await writeOpener(dataDir)
  const plugins: [string, Load, string][] = []
  if (setup.plugins !== undefined) {
    const code = await built(fixture)
    for (const [id, granted] of Object.entries(setup.plugins)) plugins.push([id, { granted }, code])
  }
  if (setup.loads !== undefined) {
    const code = await built(loads)
    for (const [id, load] of Object.entries(setup.loads)) plugins.push([id, load, code])
  }
  for (const [id, { granted, manifest }, code] of plugins) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: granted, ...manifest }), { 'worker.js': code }))
    await writeApproved(store, id, root, { granted })
  }
  return { dataDir, folder }
}

async function started(setup: Setup): Promise<{ app: ElectronApplication, editor: Page, dataDir: string, folder: string }> {
  const { dataDir, folder } = await prepared(setup)
  const app = await launch(dataDir)
  const editor = await editorPage(app)
  await until(() => logged(dataDir, 'core.ready'))
  for (const id of [...Object.keys(setup.plugins ?? {}), ...Object.keys(setup.loads ?? {})]) {
    await until(() => logged(dataDir, 'plugin.started', { plugin: id }))
  }
  return { app, editor, dataDir, folder }
}

const shown = (editor: Page) => editor.locator('.editor:not([hidden]) .cm-content')

const open = openByHand

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

  // Hiding the markers is the hidden-marks plugin's, proved with it in hetu-plugins
  it('shows the real text in the raw view over the whole window', async () => {
    const { editor } = await started({ notes: { 'a.md': '# Title\n\n**bold** text' } })
    await open(editor, 'a.md')
    await until(async () => (await shown(editor).innerText()).includes('**bold** text'))
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

  it('shows the markers with no hidden marks installed', async () => {
    const { editor } = await started({ notes: { 'a.md': '**bold** text' } })
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
    const { editor, folder } = await started({ notes: { 'a.md': 'line one\nline two\nline three' } })
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
    await until(() => logged(dataDir, 'core.ready'))
    await open(next, 'a.md')
    await until(async () => (await next.locator('#note-text').innerText()).includes('A draft of this note'))
    await next.getByRole('button', { name: 'Restore' }).click()
    await until(async () => (await shown(next).innerText()) === 'base typed last')
  })

  it("lets a Backspace beside a plugin's hidden text take only the visible character before it, naming no plugin on the save", async () => {
    const granted: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    const text = 'Keep: do NOT pay Bob until the audit ends. Then sign.'
    const { app, editor, dataDir, folder } = await started({ notes: { 'a.md': text }, plugins: { painter: granted } })
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
    // The arrows rest the caret before the hidden text, so Backspace takes the space after "Keep:"
    expect(await readFile(path.join(folder, 'a.md'), 'utf8')).toBe(`Keep:${text.slice(6)}`)
    const writes = async () => (await records(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'luoshu.write')
    await until(async () => (await writes()).length > 0)
    expect((await writes()).some(record => record.onBehalf === 'painter')).toBe(false)
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

  it('sends a command the selection at the key only when its plugin reads the note', async () => {
    const plugins: Record<string, Capability[]> = {
      reader: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.command' }],
      outsider: [{ type: 'luoshu.read', paths: ['other/**'] }, { type: 'ui.command' }],
    }
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const { app, editor } = await started({ notes: { 'a.md': text }, plugins })
    await open(editor, 'a.md')
    const reader = await pluginWorker(app, 'reader')
    const outsider = await pluginWorker(app, 'outsider')
    await drive(reader, async scope => scope.editor.bind([{ key: 'Mod-k', command: 'here' }]))
    await drive(outsider, async scope => scope.editor.bind([{ key: 'Mod-j', command: 'there' }]))
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    await editor.keyboard.press('ControlOrMeta+k')
    await editor.keyboard.press('ControlOrMeta+j')
    const commands = async (worker: Worker) => (await drive(worker, async scope => scope.heard) as { topic: string }[]).filter(event => event.topic === 'editor.command')
    await until(async () => (await commands(reader)).length === 1 && (await commands(outsider)).length === 1)
    expect(await commands(reader)).toEqual([
      { v: 1, kind: 'event', topic: 'editor.command', command: 'here', instance: 'n1', version: 0, selection: [{ anchor: text.length, head: text.length }] },
    ])
    expect(await commands(outsider)).toEqual([{ v: 1, kind: 'event', topic: 'editor.command', command: 'there', instance: null }])
  })

  it('sends the range the editor draws to a plugin that asked for it and reads the note and to no other, again as it moves', async () => {
    const plugins: Record<string, Capability[]> = {
      reader: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.command' }],
      outsider: [{ type: 'luoshu.read', paths: ['other/**'] }, { type: 'ui.command' }],
      unasked: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.command' }],
    }
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const text = lines.join('\n')
    const short = 'short note'
    const { app, editor } = await started({ notes: { 'a.md': text, 'b.md': short }, plugins })
    const reader = await pluginWorker(app, 'reader')
    const outsider = await pluginWorker(app, 'outsider')
    const unasked = await pluginWorker(app, 'unasked')
    for (const worker of [reader, outsider]) await drive(worker, async scope => scope.editor.viewports(true))
    await open(editor, 'a.md')
    type Range = { topic: string, instance: string, version: number, from: number, to: number }
    const ranges = async (worker: Worker) => (await drive(worker, async scope => scope.heard) as Range[]).filter(event => event.topic === 'editor.viewport')
    const last = async () => (await ranges(reader)).filter(range => range.instance === 'n1').at(-1)
    // Where line i of the note starts and ends
    const start = (i: number) => lines.slice(0, i).reduce((at, line) => at + line.length + 1, 0)
    const end = (i: number) => start(i) + lines[i].length
    // The first and last line the editor holds in the page, the lines of its viewport
    const drawn = async () => {
      const held = await editor.locator('.editor:not([hidden]) .cm-line').allInnerTexts()
      return [Number(held[0].slice(5)), Number(held.at(-1)!.slice(5))]
    }
    await until(async () => (await last())?.from === 0)
    await tick(500)
    const [top, bottom] = await drawn()
    expect(top).toBe(0)
    expect(await last()).toEqual({ v: 1, kind: 'event', topic: 'editor.viewport', instance: 'n1', version: 0, from: 0, to: end(bottom) })
    expect(bottom).toBeLessThan(lines.length - 1)
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    await until(async () => (await ranges(reader)).some(range => range.instance === 'n1' && range.from > 0 && range.to === text.length))
    // A change moves the range, which comes with the version it counts in
    await editor.keyboard.type('!')
    const typed = async () => (await ranges(reader)).find(range => range.instance === 'n1' && range.to === text.length + 1)
    await until(async () => (await typed()) !== undefined)
    expect((await typed())!.version).toBe(1)
    // Another note's range names that note
    await open(editor, 'b.md')
    await until(async () => (await ranges(reader)).some(range => range.instance === 'n2' && range.to === short.length))
    expect((await ranges(reader)).filter(range => range.instance === 'n2')).toContainEqual(expect.objectContaining({ from: 0, to: short.length }))
    expect((await ranges(reader)).filter(range => range.instance === 'n1' && range.to === short.length)).toEqual([])
    expect(await ranges(outsider)).toEqual([])
    expect(await ranges(unasked)).toEqual([])
    expect((await drive(unasked, async scope => scope.heard) as { topic: string }[]).filter(event => event.topic === 'editor.opened')).toHaveLength(2)
  })

  // CodeMirror's viewport is what it draws: the lines on screen with a margin past them and a stretch hidden in it
  // whole. Its visibleRanges leaves out each hidden stretch of 20 characters or more, the margin kept
  it('sends the range the editor draws, past the lines on screen and over a stretch another plugin hid', async () => {
    const plugins: Record<string, Capability[]> = {
      reader: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.command' }],
      hider: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }],
    }
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
    const start = (i: number) => lines.slice(0, i).reduce((at, line) => at + line.length + 1, 0)
    const end = (i: number) => start(i) + lines[i].length
    const { app, editor } = await started({ notes: { 'a.md': lines.join('\n') }, plugins })
    const reader = await pluginWorker(app, 'reader')
    const hider = await pluginWorker(app, 'hider')
    await drive(reader, async scope => scope.editor.viewports(true))
    await open(editor, 'a.md')
    type Range = { topic: string, from: number, to: number }
    const last = async () => (await drive(reader, async scope => scope.heard) as Range[]).filter(event => event.topic === 'editor.viewport').at(-1)
    // The last line inside the editor's scroll box
    const screen = () => editor.evaluate(() => {
      const box = document.querySelector('.editor:not([hidden]) .cm-scroller')!.getBoundingClientRect()
      const shown = [...document.querySelectorAll('.editor:not([hidden]) .cm-line')].filter(line => {
        const at = line.getBoundingClientRect()
        return at.bottom > box.top && at.top < box.bottom && /^line \d+$/.test(line.textContent ?? '')
      })
      return Number(shown.at(-1)!.textContent!.slice(5))
    })
    await until(async () => (await last())?.from === 0)
    await tick(500)
    const bottom = await screen()
    expect(bottom).toBeGreaterThan(10)
    // A margin of lines past the screen
    expect((await last())!.to).toBeGreaterThan(end(bottom + 5))
    await until(async () => (await drive(hider, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    await drive(hider, async scope => {
      const [open] = await scope.editor.instances() as { instance: string, version: number }[]
      // Lines 10 to 1999
      await scope.editor.decorate(open.instance, open.version, 'fold', [{ kind: 'hide', from: 70, to: 18_889 }])
    })
    expect([start(10), end(1999)]).toEqual([70, 18_889])
    // The editor now draws lines 0 to 9 and lines past 1999, one range over the hidden stretch
    await until(async () => ((await last())?.to ?? 0) > start(2000))
    expect(await last()).toMatchObject({ from: 0 })
  })

  // #73, #154: how long a keystroke takes to reach the screen and to come back from a worker as a decoration, on a large
  // note, with nothing else running and under three loads in turn, in one app. HETU_MEASURE names a file for the numbers,
  // which npm run measure:bridge takes three times and writes under docs/measurements
  // Skipped: the big note is marked by the real hidden-marks plugin, which no longer ships with hetu. The measure moves to
  // hetu-plugins with the plugin
  it.skip('measures the bridge from a key to the text and to a decoration, quiet and under three loads', async () => {
    const reader: Capability[] = [{ type: 'luoshu.read', paths: ['**'] }, { type: 'ui.decoration' }]
    // The last line is plain, so its text on screen is the text typed. Each line above it is an item of a list, as a long
    // note's lines sit in blocks of their own: one paragraph of 2,000 lines would have every key parse all its links again
    const lines = Array.from({ length: 2000 }, (_, i) => `- line ${i} with **some** text and a [link](https://example.com/${i})`)
    const big = [...lines, '', 'plain'].join('\n')
    // A folder of a real one's size for the indexing load to read
    const note = (i: number, sweep: number) => `# Note ${i}\n\n${Array.from({ length: 40 }, (_, j) => `word${(i * 7 + j) % 997} sweep ${sweep} line ${j}`).join('\n')}\n`
    const notes: Record<string, string> = { 'big.md': big }
    for (let i = 0; i < 469; i++) notes[`note-${String(i).padStart(3, '0')}.md`] = note(i, 0)
    const { app, editor, dataDir, folder } = await started({
      notes,
      plugins: { marker: reader },
      loads: {
        painter: { granted: [{ type: 'ui.view' }], manifest: { views: { rows: { title: 'Rows', kind: 'view' } } } },
        flooder: { granted: reader },
        indexer: { granted: [{ type: 'luoshu.read', paths: ['**'] }, { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] }] },
      },
    })
    await open(editor, 'big.md')
    const marker = await pluginWorker(app, 'marker')
    const painter = await pluginWorker(app, 'painter')
    const flooder = await pluginWorker(app, 'flooder')
    const indexer = await pluginWorker(app, 'indexer')
    await until(async () => (await drive(marker, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    await until(async () => (await drive(flooder, async scope => scope.editor.instances().then(list => (list as unknown[]).length, () => -1))) === 1)
    // The marking plugin also hears the range the editor draws, as a plugin marking only what is drawn would
    await drive(marker, async scope => {
      scope.follow = true
      await scope.editor.viewports(true)
    })
    const ranges = async () => (await drive(marker, async scope => scope.heard) as { topic: string }[]).filter(event => event.topic === 'editor.viewport').length
    await until(async () => (await ranges()) > 0)
    await shown(editor).click()
    await editor.keyboard.press('ControlOrMeta+End')
    // The real hidden-marks plugin marked the big note: each list line drawn shows a dot, its bold text and its link's
    // text, none of their markers or the link's target
    const marked = async () => {
      const drawn = (await editor.locator('.editor:not([hidden]) .cm-line').allInnerTexts()).filter(line => line.includes('line '))
      return drawn.length > 0 && drawn.every(line => /^• line \d+ with some text and a link$/.test(line))
    }
    await until(marked)
    // For each key: when its event was made, when the character itself is on screen, then when the worker's mark on it is.
    // The event's own time counts what the key waited behind other work on the page
    await editor.evaluate(() => {
      const scope = window as unknown as { timings: { typed: number, marked: number }[], expect: string, length: number }
      scope.timings = []
      let started = 0
      let typed = 0
      window.addEventListener('keydown', event => {
        started = event.timeStamp
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
    let count = 0
    const letters = 'abcdefghij'
    // Ten keys a second, a fast typist's pace, so each run lasts ten seconds of its load
    const PACE_MS = 100
    const keys = async (): Promise<Run> => {
      await editor.evaluate(() => {
        (window as unknown as { timings: unknown[] }).timings = []
      })
      const rangesBefore = await ranges()
      for (let i = 0; i < 100; i++) {
        const letter = letters[i % letters.length]
        const next = Date.now() + PACE_MS
        count++
        await editor.evaluate(([next, length]) => {
          Object.assign(window, { expect: next, length })
        }, [letter, 'plain'.length + count] as const)
        await editor.keyboard.press(letter)
        await until(async () => (await editor.evaluate(() => (window as unknown as { timings: unknown[] }).timings.length)) === i + 1, 15_000)
        await tick(next - Date.now())
      }
      const timings = await editor.evaluate(() => (window as unknown as { timings: { typed: number, marked: number }[] }).timings)
      expect(timings).toHaveLength(100)
      // Each key typed on the drawn last line moves the end of the range
      const heard = await ranges() - rangesBefore
      expect(heard).toBeGreaterThan(0)
      return { typed: summary(timings.map(each => each.typed)), marked: summary(timings.map(each => each.marked)), ranges: heard }
    }
    const counts = (worker: Worker) => drive(worker, async scope => ({ ...(scope as unknown as { counts: Record<string, number> }).counts }))
    const reads = async () => (await records(dataDir)).filter(record => record.event === 'audit.call' && record.action === 'luoshu.read'
      && String(record.caller).includes('indexer')).length
    const sitting: Partial<Sitting> = {}

    sitting.quiet = await keys()

    await drive(painter, async scope => (scope as unknown as { redraw: (on: boolean) => void }).redraw(true))
    // The painter's view is on screen beside the note
    await until(async () => (await editor.locator('#editors .hetu-surface:not([hidden])', { hasText: 'row 0 at' }).count()) === 1)
    const drawsBefore = await counts(painter)
    sitting.view = await keys()
    const drawsAfter = await counts(painter)
    await drive(painter, async scope => (scope as unknown as { redraw: (on: boolean) => void }).redraw(false))
    sitting.view.load = { draws: drawsAfter.draws - drawsBefore.draws, refused: drawsAfter.refusedDraws - drawsBefore.refusedDraws }
    expect(sitting.view.load.draws).toBeGreaterThan(0)
    await tick(500)

    await drive(flooder, async scope => (scope as unknown as { flood: (on: boolean) => Promise<void> }).flood(true))
    await tick(500)
    const floodBefore = await counts(flooder)
    sitting.flood = await keys()
    const floodAfter = await counts(flooder)
    await drive(flooder, async scope => (scope as unknown as { flood: (on: boolean) => Promise<void> }).flood(false))
    sitting.flood.load = { drawn: floodAfter.drawn - floodBefore.drawn, throttled: floodAfter.throttled - floodBefore.throttled }
    expect(sitting.flood.load.throttled).toBeGreaterThan(0)
    await tick(500)

    // Each note rewritten in turn, about 470 a second, each read again by the indexing load
    await drive(indexer, async scope => (scope as unknown as { index: () => Promise<void> }).index())
    let rewriting = true
    const readsBefore = await reads()
    const rewrites = (async () => {
      for (let sweep = 1; rewriting; sweep++) {
        for (let i = 0; i < 469 && rewriting; i++) {
          await writeFile(path.join(folder, `note-${String(i).padStart(3, '0')}.md`), note(i, sweep))
          if (i % 47 === 46) await tick(100)
        }
      }
    })()
    await tick(1000)
    sitting.search = await keys()
    const readsTyped = await reads()
    rewriting = false
    await rewrites
    await tick(2000)
    sitting.search.load = { reads: readsTyped - readsBefore }
    expect(sitting.search.load.reads).toBeGreaterThan(0)
    expect(await marked()).toBe(true)

    const measured = process.env.HETU_MEASURE
    if (measured !== undefined) await writeFile(measured, JSON.stringify(sitting))
    // Each load within twice the quiet run of this app by the 95th percentile from a key to its text
    expect(held(sitting as Sitting)).toMatchObject({ view: { within: true }, flood: { within: true }, search: { within: true } })
  }, 300_000)
})

// The answers of 2026-11-09 that only the window shows, against the real hidden-marks plugin: the mouse with Alt and
// without it, where Chromium puts typed text at a run's end, the system clipboard and the plugin's settings popover.
// The rest were proved against the real plugin in a joined test. Skipped: hidden marks no longer ships with hetu, these
// run with the plugin in hetu-plugins
describe.skip('hidden marks in the window', () => {
  it('reveals on Alt+click only, keeps typing in a run until its key, copies the markdown and hides by its settings', async () => {
    const text = 'x **bold** y\nx **bold text** y\nx [link](https://e.com) y'
    const { app, editor, folder } = await started({ notes: { 'a.md': text } })
    await open(editor, 'a.md')
    const lines = () => editor.locator('.editor:not([hidden]) .cm-line').allInnerTexts()
    await until(async () => (await lines()).join('\n') === 'x bold y\nx bold text y\nx link y')
    const saved = async () => {
      await editor.keyboard.press('ControlOrMeta+s')
      await until(async () => (await editor.locator('#title').innerText()) === 'a.md')
      return readFile(path.join(folder, 'a.md'), 'utf8')
    }
    // Where a word the human sees is drawn on a line, outside any hidden text
    type Box = { x: number, y: number, width: number, height: number }
    const boxOf = async (line: number, word: string): Promise<Box> => (await editor.evaluate(([line, word]) => {
      const walker = document.createTreeWalker(document.querySelectorAll('.editor:not([hidden]) .cm-line')[line], NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(word)
        if (at < 0 || node.parentElement!.closest('.cm-hetu-hidden') !== null) continue
        const range = document.createRange()
        range.setStart(node, at)
        range.setEnd(node, at + word.length)
        const { x, y, width, height } = range.getBoundingClientRect()
        return { x, y, width, height }
      }
      return null
    }, [line, word] as const))!
    const bold = () => boxOf(0, 'bold')
    const click = async (x: number, y: number, modifier?: 'Alt' | 'Control' | 'Meta' | 'Shift') => {
      if (modifier !== undefined) await editor.keyboard.down(modifier)
      await editor.mouse.click(x, y)
      if (modifier !== undefined) await editor.keyboard.up(modifier)
    }
    // The cursor in the shown note's editor, read from its view as CodeMirror's EditorView.findFromDOM reaches it
    const head = () => editor.evaluate(() => {
      type Found = { cmTile: { root: { view: { state: { selection: { main: { head: number } } } } } } }
      const content = document.querySelector('.editor:not([hidden]) .cm-content') as unknown as Found
      return content.cmTile.root.view.state.selection.main.head
    })
    // A frame drawn, by which the editor's settle has run too, as it runs in a microtask after each update
    const frame = () => editor.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const third = (await editor.locator('.editor:not([hidden]) .cm-line').nth(2).boundingBox())!
    const away = async () => {
      await click(third.x + third.width - 2, third.y + third.height / 2)
      await until(async () => (await head()) === text.length)
    }

    // Answer 10: a plain, Ctrl or Shift click on the bold word shows nothing, an Alt+click shows its markers. Each
    // click starts away from the word, so the cursor in the word says the editor took the click before "nothing shown"
    // is checked
    const word = await bold()
    // On macOS a Control+click is a right-click that moves no cursor, the Ctrl click of Windows is a Cmd click there
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    for (const modifier of [undefined, mod, 'Shift'] as const) {
      await away()
      await click(word.x + word.width / 2, word.y + word.height / 2, modifier)
      await until(async () => (await head()) > 4 && (await head()) < 8)
      await frame()
      expect((await lines())[0], modifier ?? 'plain').toBe('x bold y')
    }
    await click(word.x + word.width / 2, word.y + word.height / 2, 'Alt')
    await until(async () => (await lines())[0] === 'x **bold** y')
    // Hidden again once the cursor leaves it
    await away()
    await until(async () => (await lines())[0] === 'x bold y')

    // Answer 4: a click at the end of the word and the bold key, then the text after it is plain, where Chromium alone
    // would put it before the hidden closer. The "er" typed first proves nothing, as plain Chromium also puts it inside
    // the run. The " next" after the key is the proof
    const end = await bold()
    await click(end.x + end.width - 1, end.y + end.height / 2)
    await editor.keyboard.type('er')
    expect((await saved()).split('\n')[0]).toBe('x **bolder** y')
    await editor.keyboard.press('ControlOrMeta+b')
    // The plugin's answer puts the cursor past the closer at 12
    await until(async () => (await head()) === 12)
    await frame()
    await editor.keyboard.type(' next')
    expect((await saved()).split('\n')[0]).toBe('x **bolder** next y')
    expect((await lines())[0]).toBe('x bolder next y')

    // Answer 8 on the system clipboard: the element whole copies its markdown, a part of one what was selected (Y16).
    // Only the clipboard's text is put back after, an image or any other format on it is lost
    const before = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      const copied = async (box: Box) => {
        await app.evaluate(({ clipboard }) => clipboard.writeText(''))
        await editor.mouse.dblclick(box.x + box.width / 4, box.y + box.height / 2)
        await editor.keyboard.press('ControlOrMeta+c')
        let got = ''
        await until(async () => (got = await app.evaluate(({ clipboard }) => clipboard.readText())) !== '')
        return got
      }
      expect(await copied(await boxOf(0, 'bolder'))).toBe('**bolder**')
      expect(await copied(await boxOf(1, 'bold'))).toBe('bold')
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
    }

    // Answer 9: the plugin's settings, an item whose popover holds a box for each element. Bold unticked shows bold's
    // markers and no other element's, ticked again hides them
    await editor.getByRole('button', { name: 'Marks' }).click()
    const box = editor.locator('#overlay .hetu-popover label', { hasText: 'Bold' })
    await until(async () => (await box.count()) === 1)
    expect(await box.locator('input').isChecked()).toBe(true)
    await box.click()
    await until(async () => (await lines())[0] === 'x **bolder** next y')
    expect((await lines())[1]).toBe('x **bold text** y')
    expect((await lines())[2]).toBe('x link y')
    await box.click()
    await until(async () => (await lines())[0] === 'x bolder next y')
  })
})
