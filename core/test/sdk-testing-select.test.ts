import { ChangeSet } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin, type PluginContext } from '../sdk/plugin.ts'
import { type FakeCore, fakeCore, FakeDrawer } from '../sdk/testing/index.ts'
import { Drawer, type Instance, type PortLike } from '../frontend/editor/bridge.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import { Versions } from '../frontend/editor/versions.ts'
import { Editor, type EditorClient } from '../sdk/editor.ts'
import { fakeCore as editorCore } from './editor-fakes.ts'
import { tick } from './router-fakes.ts'

// The fake drawer takes editor.select in the windows hetu's drawer takes it in: once as a note opens, before the human's
// first key or click in it, and in answer to the human's command on that note at its version

const cores: FakeCore[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
})

const manifest = (capabilities: object[]) => ({
  id: 'jumper', name: 'Jumper', version: '1.0.0', api: '^3', entries: { worker: 'dist/worker.js' }, capabilities,
})
const full = [{ type: 'luoshu.read', paths: ['notes/**'] }, { type: 'ui.edit', paths: ['notes/**'] }, { type: 'ui.command' }]

async function started(drawer: FakeDrawer, capabilities: object[] = full): Promise<PluginContext> {
  const made = fakeCore({ manifest: manifest(capabilities), drawer })
  cores.push(made)
  let given: PluginContext | null = null
  await made.start(definePlugin({ start(ctx) { given = ctx } }))
  return given as unknown as PluginContext
}

const code = (done: Promise<unknown>) => done.then(() => 'ok', (err: { code?: string }) => err.code)

describe("the fake drawer's select", () => {
  it('moves the cursor once as the note opens, read with selection, and refuses a second select', async () => {
    const drawer = new FakeDrawer()
    const ctx = await started(drawer)
    const note = drawer.openNote('notes/a.md', 'hello world')
    expect(await ctx.editor.select(note, 0, { anchor: 6, head: 11 })).toEqual({ version: 0 })
    expect(drawer.selection(note)).toEqual({ anchor: 6, head: 11 })
    expect(drawer.text(note)).toBe('hello world')
    expect(await code(ctx.editor.select(note, 0, { anchor: 1, head: 1 }))).toBe('not-granted')
  })

  it("refuses a select at open after the human's first key, click or command in the note", async () => {
    const drawer = new FakeDrawer()
    const ctx = await started(drawer)
    await ctx.editor.bind([{ key: 'Mod-k', command: 'jump' }])
    const typed = drawer.openNote('notes/a.md', 'one')
    const clicked = drawer.openNote('notes/b.md', 'two')
    const keyed = drawer.openNote('notes/c.md', 'three')
    drawer.type(typed, { from: 0, insert: 'x' })
    drawer.click(clicked)
    drawer.command('jump', keyed)
    expect(await code(ctx.editor.select(typed, 1, { anchor: 0, head: 0 }))).toBe('not-granted')
    expect(await code(ctx.editor.select(clicked, 0, { anchor: 0, head: 0 }))).toBe('not-granted')
    drawer.type(keyed, { from: 0, insert: 'x' })
    expect(await code(ctx.editor.select(keyed, 1, { anchor: 0, head: 0 }))).toBe('not-granted')
  })

  it("takes a select once in answer to the human's command on that note at its version, anywhere in the note", async () => {
    const drawer = new FakeDrawer()
    const ctx = await started(drawer)
    await ctx.editor.bind([{ key: 'Mod-k', command: 'jump' }])
    const note = drawer.openNote('notes/a.md', 'hello world')
    const other = drawer.openNote('notes/b.md', 'two')
    drawer.click(note)
    drawer.click(other)
    drawer.command('jump', note)
    expect(await ctx.editor.select(note, 0, { anchor: 9, head: 2 })).toEqual({ version: 0 })
    expect(await code(ctx.editor.select(note, 0, { anchor: 1, head: 1 }))).toBe('not-granted')
    drawer.command('jump', note)
    expect(await code(ctx.editor.select(other, 0, { anchor: 1, head: 1 }))).toBe('not-granted')
    drawer.command('jump', note)
    expect(await code(ctx.editor.select(note, 1, { anchor: 1, head: 1 }))).toBe('not-granted')
    drawer.command('jump', note)
    drawer.click(note)
    expect(await code(ctx.editor.select(note, 0, { anchor: 1, head: 1 }))).toBe('not-granted')
    expect(drawer.selection(note)).toEqual({ anchor: 9, head: 2 })
  })

  it('refuses stale and past the end, leaving the window at open, and opens a new window for a note opened again', async () => {
    const drawer = new FakeDrawer()
    const ctx = await started(drawer)
    const note = drawer.openNote('notes/a.md', 'hello')
    expect(await code(ctx.editor.select(note, 1, { anchor: 0, head: 0 }))).toBe('stale')
    expect(await code(ctx.editor.select(note, 0, { anchor: 6, head: 6 }))).toBe('invalid')
    expect(await code(ctx.editor.select(note, 0, { anchor: 5, head: 5 }))).toBe('ok')
    drawer.closeNote(note)
    const again = drawer.openNote('notes/a.md', 'hello')
    expect(await code(ctx.editor.select(again, 0, { anchor: 2, head: 2 }))).toBe('ok')
  })

  it('refuses a select at open after a key in the note the plugin did not bind, as hetu does', async () => {
    const drawer = new FakeDrawer()
    const ctx = await started(drawer)
    const note = drawer.openNote('notes/a.md', 'hello')
    expect(drawer.command('unbound', note)).toBe(false)
    expect(await code(ctx.editor.select(note, 0, { anchor: 1, head: 1 }))).toBe('not-granted')
  })

  it('refuses a plugin without ui.edit on the note', async () => {
    const drawer = new FakeDrawer()
    const ctx = await started(drawer, [{ type: 'luoshu.read', paths: ['notes/**'] }])
    const note = drawer.openNote('notes/a.md', 'hello')
    expect(await code(ctx.editor.select(note, 0, { anchor: 1, head: 1 }))).toBe('not-granted')
  })
})

describe("a select in the fake drawer and in hetu's drawer", () => {
  it('answers the same through the SDK', async () => {
    type Human = { open(path: string, text: string): string, type(instance: string): void, click(instance: string): void, key(instance: string): void, close(instance: string): void }
    const play = async (editor: EditorClient, human: Human) => {
      const answers: string[] = []
      const select = async (id: string, version: number, at: number) => void answers.push(String(await code(editor.select(id, version, { anchor: at, head: at }))))
      await editor.bind([{ key: 'Mod-k', command: 'jump' }])
      const a = human.open('notes/a.md', 'hello world')
      const b = human.open('notes/b.md', 'two')
      await select(a, 0, 3)
      await select(a, 0, 4)
      await select(b, 1, 1)
      await select(b, 0, 9)
      human.click(b)
      await select(b, 0, 1)
      human.key(b)
      await tick(5)
      await select(a, 0, 1)
      human.key(b)
      await tick(5)
      await select(b, 0, 2)
      await select(b, 0, 2)
      human.type(a)
      await select(a, 1, 0)
      human.close(a)
      const again = human.open('notes/a.md', 'hello')
      await select(again, 0, 5)
      human.open('secret/c.md', 'hidden')
      await select('n4', 0, 0)
      await select('n9', 0, 0)
      return answers
    }

    // hetu's drawer, the plugin's client on a port to it
    let notes: Instance[] = []
    const core = editorCore({
      'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
      'gate.reach': args => {
        const { path: asked } = args as { path?: string }
        const reads = asked !== undefined && asked.startsWith('notes/')
        return { ok: true, result: { read: reads, edit: reads, uiRead: false, list: false, verbs: ['ui.command'] } }
      },
    })
    const link = new CoreLink(core.bridge)
    link.start()
    const real = new Drawer(link, () => notes, () => {})
    real.start()
    let toPlugin: ((message: unknown) => void) | null = null
    const port: PortLike = { onmessage: null, close() {}, postMessage: message => toPlugin?.(JSON.parse(message as string)) }
    real.connect('jumper', 1, port)
    const client = new Editor()
    client.connect({ post: message => port.onmessage?.({ data: JSON.stringify(message) }), listen: next => { toPlugin = next } })
    let n = 0
    const fromReal = await play(client, {
      open(at, text) {
        const id = `n${++n}`
        let doc = text
        const versions = new Versions(text.length)
        const made: Instance = {
          id, path: at, versions, text: () => doc, selection: () => [{ anchor: 0, head: 0 }],
          apply() {}, select() {}, setMarks() {}, clearMarks() {},
        }
        notes.push(made)
        real.opened(made)
        return id
      },
      type(id) {
        const made = notes.find(each => each.id === id) as Instance
        real.touched(id)
        made.versions.push(ChangeSet.of({ from: 0, insert: 'x' }, made.text().length))
      },
      click: id => real.touched(id),
      key(id) {
        real.touched(id)
        real.key(id, 'Mod-k')
      },
      close(id) {
        notes = notes.filter(each => each.id !== id)
        real.closed(id)
      },
    })

    const drawer = new FakeDrawer()
    const ctx = await started(drawer)
    const fromFake = await play(ctx.editor, {
      open: (at, text) => drawer.openNote(at, text),
      type: id => drawer.type(id, { from: 0, insert: 'x' }),
      click: id => drawer.click(id),
      key: id => void drawer.command('jump', id),
      close: id => drawer.closeNote(id),
    })

    expect(fromReal).toEqual([
      'ok', 'not-granted', 'stale', 'invalid', 'not-granted', 'not-granted', 'ok', 'not-granted', 'not-granted', 'ok', 'not-granted', 'not-found',
    ])
    expect(fromFake).toEqual(fromReal)
  })
})

