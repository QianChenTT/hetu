import { ChangeSet, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { ANSWER_MS, Drawer, type Instance, type PortLike } from '../frontend/editor/bridge.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import { Versions } from '../frontend/editor/versions.ts'
import { fakeCore, settle } from './editor-fakes.ts'

// An edit that places the cursor, which the drawer takes only in answer to the human's own key: on the note the key came
// in, at the version it named, inside the range the edit changed or at its edges and once per key. The window closes on
// the first of a move of the caret, any other key, a binding changed, ANSWER_MS gone and an edit with a cursor refused

type Placed = { anchor: number, head: number } | undefined

function opened(text: string) {
  let doc = Text.of([text])
  const versions = new Versions(doc.length)
  const applied: Placed[] = []
  let caret = 11
  const instance: Instance = {
    id: 'n1',
    path: 'a.md',
    versions,
    text: () => doc.toString(),
    selection: () => [{ anchor: caret, head: caret }],
    apply(changes, _plugin, selection) {
      doc = changes.apply(doc)
      versions.push(changes)
      applied.push(selection)
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
    caret = pos
  }
  return { instance, applied, typed, moveTo, text: () => doc.toString() }
}

// A drawer whose core gives the plugin read, edit and its bindings on a.md with the plugin's port bound to Mod-b
async function bound(text = '**important**') {
  const note = opened(text)
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'gate.reach': () => ({ ok: true, result: { read: true, write: false, edit: true, uiRead: false, list: false, verbs: ['ui.command'] } }),
  })
  const link = new CoreLink(core.bridge)
  link.start()
  let now = 0
  const drawer = new Drawer(link, () => [note.instance], () => {}, { clock: () => now })
  drawer.start()
  const plugin = (name: string) => {
    const sent: Record<string, unknown>[] = []
    const port: PortLike = { onmessage: null, postMessage: message => void sent.push(JSON.parse(message as string)), close() {} }
    drawer.connect(name, 1, port)
    let id = 0
    return async (verb: string, args: unknown, raw?: string) => {
      const n = ++id
      port.onmessage?.({ data: raw ?? JSON.stringify({ v: 1, kind: 'call', id: n, verb, args }) })
      for (let i = 0; i < 3; i++) await settle()
      return sent.find(message => message.kind === 'reply' && message.id === n)
    }
  }
  const call = plugin('alpha')
  await call('editor.bind', { bindings: [{ key: 'Mod-b', command: 'bold' }] })
  const press = async (key = 'Mod-b') => {
    drawer.key('n1', key)
    for (let i = 0; i < 3; i++) await settle()
  }
  const wait = (ms: number) => {
    now += ms
  }
  // Mod-b at the end of the run: the closing marker put back with the cursor after it
  const rest = text.length - 13
  const changes = rest === 0 ? [11, [2, '**']] : [11, [2, '**'], rest]
  const stepOut = (version: number, selection = { anchor: 13, head: 13 }) => call('editor.edit', { instance: 'n1', version, changes, selection })
  return { note, call, press, stepOut, plugin, wait, drawer }
}

describe("an edit's cursor", () => {
  it("is placed for an edit answering the human's key, inside or at the edges of the range it changed", async () => {
    const { note, press, stepOut } = await bound()
    await press()
    expect(await stepOut(0)).toMatchObject({ ok: true, result: { version: 1 } })
    expect(note.applied).toEqual([{ anchor: 13, head: 13 }])
  })

  it('is refused for an edit no key of the human asked for, the edit with it', async () => {
    const { note, stepOut } = await bound()
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.applied).toEqual([])
  })

  it('is refused outside the range the edit changed', async () => {
    const { note, press, stepOut } = await bound('**important** next')
    await press()
    expect(await stepOut(0, { anchor: 13, head: 18 })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    await press()
    expect(await stepOut(0, { anchor: 10, head: 10 })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(note.applied).toEqual([])
  })

  it('is taken once per key and refused stale once the human typed after the key', async () => {
    const { note, press, stepOut } = await bound()
    await press()
    expect(await stepOut(0)).toMatchObject({ ok: true })
    expect(await stepOut(1)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press()
    note.typed(0, 'x')
    expect(await stepOut(1)).toMatchObject({ ok: false, refusal: { code: 'stale' } })
    expect(note.text()).toBe('x**important**')
  })

  it('leaves an edit with no cursor as it was, with no key asked for', async () => {
    const { note, call } = await bound()
    expect(await call('editor.edit', { instance: 'n1', version: 0, changes: [13, [0, '!']] })).toMatchObject({ ok: true })
    expect(note.applied).toEqual([undefined])
  })

  it('is refused once the human moved the caret after the key', async () => {
    const { note, press, stepOut } = await bound()
    await press()
    note.moveTo(4)
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.applied).toEqual([])
  })

  it('is refused after another key, bound or not', async () => {
    const { note, press, stepOut } = await bound()
    await press()
    await press('Mod-k')
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.applied).toEqual([])
  })

  it('is refused after a Ctrl or Cmd click on a link, a tie that tells no one included', async () => {
    const { note, press, stepOut, drawer } = await bound()
    await press()
    drawer.linkClicked('n1', { owner: 'alpha', id: 'a' })
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press()
    drawer.linkClicked('n1', 'tied')
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(note.applied).toEqual([])
  })

  it('is refused once the plugin binds again or another plugin binds the key', async () => {
    const { call, press, stepOut, plugin } = await bound()
    await press()
    await call('editor.bind', { bindings: [{ key: 'Mod-b', command: 'bold' }] })
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press()
    await plugin('beta')('editor.bind', { bindings: [{ key: 'Mod-b', command: 'thick' }] })
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it(`is refused past ${ANSWER_MS} ms after the key`, async () => {
    const { press, stepOut, wait } = await bound()
    await press()
    wait(ANSWER_MS + 1)
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(ANSWER_MS).toBe(1000)
  })

  it('is taken by an edit with a cursor refused for any reason, one that is no call at all included', async () => {
    const { call, press, stepOut } = await bound()
    await press()
    expect(await call('editor.edit', { instance: 'n1', version: 0, changes: [5, [2, '**']], selection: { anchor: 5, head: 5 } }))
      .toMatchObject({ ok: false, refusal: { code: 'stale' } })
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await press()
    await call('editor.edit', null, '{"v":1,"kind":"call","id":3,"verb":"editor.edit","args":{"selection":{"anchor":-1}}}')
    expect(await stepOut(0)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })
})
