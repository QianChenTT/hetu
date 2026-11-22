import { ChangeSet, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { ANSWER_MS, Drawer, type Instance, type PortLike } from '../frontend/editor/bridge.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import { Versions } from '../frontend/editor/versions.ts'
import { fakeCore, settle } from './editor-fakes.ts'

// editor.select moves the cursor and changes no text. The drawer takes it in two windows only: once as a note opens,
// before the human's first key or click in it, and in answer to a command the human just invoked through the plugin's
// binding, on that note at the version the command named, with the human's selection where it was at the key

type Caret = { anchor: number, head: number }

function opened(id: string, text: string) {
  let doc = Text.of([text])
  const versions = new Versions(doc.length)
  const selected: Caret[] = []
  let caret: Caret = { anchor: 0, head: 0 }
  const instance: Instance = {
    id,
    path: 'a.md',
    versions,
    text: () => doc.toString(),
    selection: () => [caret],
    apply(changes) {
      doc = changes.apply(doc)
      versions.push(changes)
    },
    select(selection) {
      caret = selection
      selected.push(selection)
    },
    setMarks() {},
    clearMarks() {},
  }
  const typed = (from: number, insert: string) => {
    const changes = ChangeSet.of({ from, insert }, doc.length)
    doc = changes.apply(doc)
    versions.push(changes)
  }
  const moveTo = (pos: number) => {
    caret = { anchor: pos, head: pos }
  }
  return { instance, selected, typed, moveTo, text: () => doc.toString() }
}

type Reach = { read: boolean, edit: boolean, verbs: string[] }

// A drawer whose core gives each plugin the reach named, read, edit and ui.command by default, on a.md
async function drawerWith(reaches: Record<string, Reach> = {}) {
  const open = new Map<string, ReturnType<typeof opened>>()
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'gate.reach': args => {
      const { read, edit, verbs } = reaches[(args as { plugin: string }).plugin] ?? { read: true, edit: true, verbs: ['ui.command'] }
      return { ok: true, result: { read, write: false, edit, uiRead: false, list: false, verbs } }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  let now = 0
  const drawer = new Drawer(link, () => [...open.values()].map(note => note.instance), () => {}, { clock: () => now })
  drawer.start()
  const plugin = (name: string) => {
    const sent: Record<string, unknown>[] = []
    const port: PortLike = { onmessage: null, postMessage: message => void sent.push(JSON.parse(message as string)), close() {} }
    drawer.connect(name, 1, port)
    let id = 0
    return async (verb: string, args: unknown) => {
      const n = ++id
      port.onmessage?.({ data: JSON.stringify({ v: 1, kind: 'call', id: n, verb, args }) })
      for (let i = 0; i < 3; i++) await settle()
      return sent.find(message => message.kind === 'reply' && message.id === n)
    }
  }
  const openNote = (id: string, text = 'hello world') => {
    const note = opened(id, text)
    open.set(id, note)
    drawer.opened(note.instance)
    return note
  }
  const closeNote = (id: string) => {
    open.delete(id)
    drawer.closed(id)
  }
  const press = async (id: string, key = 'Mod-b') => {
    drawer.touched(id)
    drawer.key(id, key)
    for (let i = 0; i < 3; i++) await settle()
  }
  const wait = (ms: number) => {
    now += ms
  }
  return { drawer, plugin, openNote, closeNote, press, wait }
}

const select = (instance: string, version: number, anchor: number, head = anchor) => ['editor.select', { instance, version, selection: { anchor, head } }] as const

describe('a select as the note opens', () => {
  it('moves the cursor before the human touched the note, changing no text', async () => {
    const { plugin, openNote } = await drawerWith()
    const note = openNote('n1')
    const call = plugin('alpha')
    expect(await call(...select('n1', 0, 6, 11))).toMatchObject({ ok: true, result: { version: 0 } })
    expect(note.selected).toEqual([{ anchor: 6, head: 11 }])
    expect(note.text()).toBe('hello world')
  })

  it('is taken once per opening, across plugins', async () => {
    const { plugin, openNote } = await drawerWith()
    const note = openNote('n1')
    expect(await plugin('alpha')(...select('n1', 0, 3))).toMatchObject({ ok: true })
    expect(await plugin('beta')(...select('n1', 0, 4))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.selected).toEqual([{ anchor: 3, head: 3 }])
  })

  it("is refused after the human's first key in the note", async () => {
    const { drawer, plugin, openNote } = await drawerWith()
    const note = openNote('n1')
    drawer.touched('n1')
    expect(await plugin('alpha')(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.selected).toEqual([])
  })

  it("is refused after the human's first click in the note, and a click in another note leaves it", async () => {
    const { drawer, plugin, openNote } = await drawerWith()
    openNote('n1')
    const other = openNote('n2')
    drawer.touched('n1')
    const call = plugin('alpha')
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await call(...select('n2', 0, 3))).toMatchObject({ ok: true })
    expect(other.selected).toEqual([{ anchor: 3, head: 3 }])
  })

  it('is refused after a key the drawer hears in the note, a bound one included', async () => {
    const { drawer, plugin, openNote } = await drawerWith()
    openNote('n1')
    drawer.key('n1', 'Mod-k')
    expect(await plugin('alpha')(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('opens again when the note closes and opens again', async () => {
    const { drawer, plugin, openNote, closeNote } = await drawerWith()
    openNote('n1')
    drawer.touched('n1')
    closeNote('n1')
    const again = openNote('n1')
    expect(await plugin('alpha')(...select('n1', 0, 2))).toMatchObject({ ok: true })
    expect(again.selected).toEqual([{ anchor: 2, head: 2 }])
  })

  it('is refused stale at another version and invalid past the end, either leaving the window open', async () => {
    const { plugin, openNote } = await drawerWith()
    const note = openNote('n1')
    const call = plugin('alpha')
    expect(await call(...select('n1', 1, 3))).toMatchObject({ ok: false, refusal: { code: 'stale' } })
    expect(await call(...select('n1', 0, 12))).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(await call(...select('n1', 0, 0, 12))).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(await call(...select('n1', 0, 11))).toMatchObject({ ok: true })
    expect(note.selected).toEqual([{ anchor: 11, head: 11 }])
  })

  it('is refused to a plugin without ui.edit on the note and to one that does not read it', async () => {
    const { plugin, openNote } = await drawerWith({
      reader: { read: true, edit: false, verbs: [] },
      outsider: { read: false, edit: true, verbs: [] },
    })
    const note = openNote('n1')
    expect(await plugin('reader')(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await plugin('outsider')(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await plugin('alpha')(...select('n1', 0, 3))).toMatchObject({ ok: true })
    expect(note.selected).toEqual([{ anchor: 3, head: 3 }])
  })

  it('is refused not-found for a note that is not open', async () => {
    const { plugin } = await drawerWith()
    expect(await plugin('alpha')(...select('n9', 0, 0))).toMatchObject({ ok: false, refusal: { code: 'not-found' } })
  })
})

describe("a select in answer to the human's key", () => {
  // The note touched first, so only the window after the key is open
  async function keyed() {
    const made = await drawerWith()
    const note = made.openNote('n1')
    made.drawer.touched('n1')
    const call = made.plugin('alpha')
    await call('editor.bind', { bindings: [{ key: 'Mod-b', command: 'jump' }] })
    return { ...made, note, call }
  }

  it('moves the cursor anywhere in the note at the version the command named', async () => {
    const { note, call, press } = await keyed()
    await press('n1')
    expect(await call(...select('n1', 0, 9, 2))).toMatchObject({ ok: true, result: { version: 0 } })
    expect(note.selected).toEqual([{ anchor: 9, head: 2 }])
  })

  it('is refused with no key of the human, past the time and after another key', async () => {
    const { note, call, press, wait } = await keyed()
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press('n1')
    wait(ANSWER_MS + 1)
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press('n1')
    await press('n1', 'Mod-k')
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.selected).toEqual([])
  })

  it('is taken once per key, a select or an edit with a cursor spending it', async () => {
    const { note, call, press } = await keyed()
    await press('n1')
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: true })
    expect(await call(...select('n1', 0, 4))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press('n1')
    await call('editor.edit', { instance: 'n1', version: 0, changes: [11, [0, '!']], selection: { anchor: 12, head: 12 } })
    expect(await call(...select('n1', 1, 4))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.selected).toEqual([{ anchor: 3, head: 3 }])
  })

  it('spends the key on a refused select, so an edit with a cursor after it is refused', async () => {
    const { call, press } = await keyed()
    await press('n1')
    expect(await call(...select('n1', 0, 99))).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(await call('editor.edit', { instance: 'n1', version: 0, changes: [11, [0, '!']], selection: { anchor: 12, head: 12 } }))
      .toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('is refused on another note and at another version', async () => {
    const { openNote, drawer, call, press } = await keyed()
    openNote('n2')
    drawer.touched('n2')
    await press('n1')
    expect(await call(...select('n2', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press('n1')
    expect(await call(...select('n1', 1, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('is refused stale once the human typed after the key and refused once the human moved the cursor', async () => {
    const { note, call, press } = await keyed()
    await press('n1')
    note.typed(0, 'x')
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'stale' } })
    await press('n1')
    note.moveTo(5)
    expect(await call(...select('n1', 1, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.selected).toEqual([])
  })

  it('is refused after a click in the note, even one that leaves the cursor where it was', async () => {
    const { drawer, call, press } = await keyed()
    await press('n1')
    drawer.touched('n1')
    expect(await call(...select('n1', 0, 3))).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })
})
