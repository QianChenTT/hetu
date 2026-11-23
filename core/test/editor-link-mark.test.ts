import { EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { type LinkHit, linkAt, type Mark, mark, MARKS_PER_SECOND, MAX_MARKS, parseBridgeCall } from '../api/editor.ts'
import { MAX_NAME_LENGTH } from '../api/ids.ts'
import { Drawer, type Instance, type PortLike } from '../frontend/editor/bridge.ts'
import { pluginMarks, setMarks } from '../frontend/editor/editor.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import { drawMarks } from '../frontend/editor/marks.ts'
import { Versions } from '../frontend/editor/versions.ts'
import { fakeCore, settle } from './editor-fakes.ts'

// The link mark: text drawn as a link and a Ctrl+click, Cmd+click on macOS, on it told only to the plugin that placed
// it, the smallest link at the place winning and a tie telling no one

const link = (from: number, to: number, id: string): Mark => ({ kind: 'link', from, to, id })
const owned = (...owners: [string, Mark[]][]) => new Map(owners.map(([owner, marks]) => [owner, new Map([['s', marks]])]))

describe("a link mark's shape", () => {
  it('takes a range over text with an id and a group', () => {
    expect(mark.safeParse({ kind: 'link', from: 2, to: 5, id: 'fn1' }).success).toBe(true)
    expect(mark.safeParse({ kind: 'link', from: 2, to: 5, id: 'noteName', group: 'wiki0' }).success).toBe(true)
    expect(mark.safeParse({ kind: 'link', from: 0, to: 1, id: 'a'.repeat(MAX_NAME_LENGTH) }).success).toBe(true)
  })

  it('refuses an id that is no name or past the cap, an empty or backward range and anything a plugin adds', () => {
    for (const id of ['', '1st', 'a b', 'a-b', 'a.b', '<b>', 'a'.repeat(MAX_NAME_LENGTH + 1), 7]) {
      expect(mark.safeParse({ kind: 'link', from: 0, to: 3, id }).success, String(id)).toBe(false)
    }
    expect(mark.safeParse({ kind: 'link', from: 3, to: 3, id: 'a' }).success).toBe(false)
    expect(mark.safeParse({ kind: 'link', from: 4, to: 3, id: 'a' }).success).toBe(false)
    expect(mark.safeParse({ kind: 'link', from: -1, to: 3, id: 'a' }).success).toBe(false)
    expect(mark.safeParse({ kind: 'link', from: 0, to: 3 }).success).toBe(false)
    expect(mark.safeParse({ kind: 'link', from: 0, to: 3, id: 'a', class: 'x' }).success).toBe(false)
    expect(mark.safeParse({ kind: 'link', from: 0, to: 3, id: 'a', href: 'https://example.com' }).success).toBe(false)
  })

  it('comes in a decorate call the drawer reads', () => {
    const text = JSON.stringify({ v: 1, kind: 'call', id: 1, verb: 'editor.decorate', args: { instance: 'n1', version: 0, set: 's', marks: [link(0, 3, 'a')] } })
    expect(parseBridgeCall(text)).toMatchObject({ args: { marks: [{ kind: 'link', id: 'a' }] } })
    expect(parseBridgeCall(text.replace('"id":"a"', '"id":"a b"'))).toBe(null)
  })
})

describe('drawing a link mark', () => {
  const doc = Text.of(['see the note'])

  it("draws it with the drawer's own link class over text left as it is", () => {
    const { marks, hidden } = drawMarks([link(4, 7, 'a')], doc)
    const drawn: unknown[] = []
    marks.between(0, doc.length, (from, to, value) => void drawn.push({ from, to, spec: value.spec }))
    expect(drawn).toEqual([{ from: 4, to: 7, spec: { class: 'cm-hetu-link' } }])
    expect(hidden.size).toBe(0)
  })

  it('leaves out a link reaching past the text, drawn and mapped', () => {
    expect(drawMarks([link(4, 99, 'a')], doc).marks.size).toBe(0)
    expect(new Versions(doc.length).mapMarks([link(4, 99, 'a'), link(0, 3, 'b')], 0)).toEqual([link(0, 3, 'b')])
  })

  it('keeps a link on its text as the human types before it', () => {
    const state = EditorState.create({ doc: 'see the note', extensions: [pluginMarks] })
    const marked = state.update({ effects: setMarks.of({ owner: 'alpha', set: 's', marks: [link(4, 7, 'a')] }) }).state
    const typed = marked.update({ changes: { from: 0, insert: 'ab ' } }).state
    expect(linkAt(typed.field(pluginMarks).owned, 7)).toEqual({ owner: 'alpha', id: 'a' })
    expect(linkAt(typed.field(pluginMarks).owned, 6)).toBe(null)
  })
})

describe('the link a click lands on', () => {
  it('is a link holding the character clicked, its first character in and the one after its end out', () => {
    const marks = owned(['alpha', [link(4, 7, 'a'), { kind: 'mark', from: 0, to: 12, style: 'link' }]])
    expect(linkAt(marks, 4)).toEqual({ owner: 'alpha', id: 'a' })
    expect(linkAt(marks, 6)).toEqual({ owner: 'alpha', id: 'a' })
    expect(linkAt(marks, 7)).toBe(null)
    expect(linkAt(marks, 3)).toBe(null)
  })

  it('is the innermost of two links, whichever plugin placed each', () => {
    expect(linkAt(owned(['alpha', [link(0, 12, 'outer')]], ['beta', [link(4, 7, 'inner')]]), 5)).toEqual({ owner: 'beta', id: 'inner' })
    expect(linkAt(owned(['alpha', [link(4, 7, 'inner')]], ['beta', [link(0, 12, 'outer')]]), 5)).toEqual({ owner: 'alpha', id: 'inner' })
    expect(linkAt(owned(['alpha', [link(0, 12, 'outer')]], ['beta', [link(4, 7, 'inner')]]), 1)).toEqual({ owner: 'alpha', id: 'outer' })
  })

  it("is none on a tie between two plugins' links or two ids of one plugin, though one link sent twice is no tie", () => {
    expect(linkAt(owned(['alpha', [link(4, 7, 'a')]], ['beta', [link(5, 8, 'a')]]), 5)).toBe('tied')
    expect(linkAt(owned(['alpha', [link(4, 7, 'a'), link(4, 7, 'b')]]), 5)).toBe('tied')
    expect(linkAt(owned(['alpha', [link(4, 7, 'a'), link(4, 7, 'a')]]), 5)).toEqual({ owner: 'alpha', id: 'a' })
    expect(linkAt(owned(['alpha', [link(4, 7, 'a')]], ['beta', [link(5, 8, 'b'), link(5, 6, 'c')]]), 5)).toEqual({ owner: 'beta', id: 'c' })
  })
})

type Reach = { read: boolean, verbs: string[] }

// A drawer whose core answers gate.reach from reach, which a test changes and then tells the window core.security
function started(reach: Record<string, Reach>) {
  const doc = Text.of(['see the note and more'])
  const sets = new Map<string, Mark[]>()
  const instance: Instance = {
    id: 'n1',
    path: 'a.md',
    versions: new Versions(doc.length),
    text: () => doc.toString(),
    selection: () => [{ anchor: 0, head: 0 }],
    apply() {},
    setMarks: (owner, set, marks) => void sets.set(`${owner} ${set}`, marks),
    clearMarks: owner => {
      for (const key of [...sets.keys()]) if (key.startsWith(`${owner} `)) sets.delete(key)
    },
  }
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'gate.reach': args => {
      const held = reach[(args as { plugin: string }).plugin]
      return { ok: true, result: { read: held?.read ?? false, edit: false, uiRead: false, list: false, verbs: held?.verbs ?? [] } }
    },
  })
  const coreLink = new CoreLink(core.bridge)
  coreLink.start()
  let now = 0
  let open = [instance]
  const drawer = new Drawer(coreLink, () => open, () => {}, { clock: () => now })
  drawer.start()
  const plugin = (name: string) => {
    const sent: Record<string, unknown>[] = []
    const port: PortLike = { onmessage: null, postMessage: message => void sent.push(JSON.parse(message as string)), close() {} }
    drawer.connect(name, 1, port)
    let id = 0
    const call = async (verb: string, args: unknown) => {
      const n = ++id
      port.onmessage?.({ data: JSON.stringify({ v: 1, kind: 'call', id: n, verb, args }) })
      for (let i = 0; i < 3; i++) await settle()
      return sent.find(message => message.kind === 'reply' && message.id === n)
    }
    return { call, links: () => sent.filter(message => message.topic === 'editor.link') }
  }
  const click = async (hit: LinkHit | 'tied') => {
    drawer.linkClicked('n1', hit)
    for (let i = 0; i < 3; i++) await settle()
  }
  const narrowed = async () => {
    core.event('core.security')
    for (let i = 0; i < 6; i++) await settle()
  }
  // The note closes in the editor, as the page tells the drawer
  const close = () => {
    open = []
    drawer.closed('n1')
  }
  return { drawer, sets, plugin, click, close, narrowed, wait: (ms: number) => void (now += ms) }
}

const marker: Reach = { read: true, verbs: ['ui.decoration'] }

describe('a Ctrl or Cmd click on a link mark', () => {
  it("tells the plugin that placed it the note, its version and the link's id, and no other plugin reading the note", async () => {
    const { plugin, click } = started({ alpha: marker, beta: marker })
    const [alpha, beta] = [plugin('alpha'), plugin('beta')]
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [link(4, 7, 'theNote')] })).toMatchObject({ ok: true })
    await click({ owner: 'alpha', id: 'theNote' })
    expect(alpha.links()).toEqual([{ v: 1, kind: 'event', topic: 'editor.link', instance: 'n1', version: 0, id: 'theNote' }])
    expect(beta.links()).toEqual([])
  })

  it('tells no one on a tie and no one for a note that closed', async () => {
    const { plugin, click, close } = started({ alpha: marker, beta: marker })
    const [alpha, beta] = [plugin('alpha'), plugin('beta')]
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [link(4, 7, 'a')] })).toMatchObject({ ok: true })
    expect(await beta.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [link(4, 7, 'b')] })).toMatchObject({ ok: true })
    await click('tied')
    expect([...alpha.links(), ...beta.links()]).toEqual([])
    close()
    await click({ owner: 'alpha', id: 'a' })
    expect(alpha.links()).toEqual([])
  })

  it('tells a plugin nothing once it lost read of the note or ui.decoration, checked at the send', async () => {
    const reach: Record<string, Reach> = { alpha: { ...marker }, beta: { ...marker } }
    const { plugin, click, narrowed } = started(reach)
    const [alpha, beta] = [plugin('alpha'), plugin('beta')]
    reach.alpha = { read: false, verbs: ['ui.decoration'] }
    reach.beta = { read: true, verbs: [] }
    await narrowed()
    await click({ owner: 'alpha', id: 'a' })
    await click({ owner: 'beta', id: 'b' })
    expect(alpha.links()).toEqual([])
    expect(beta.links()).toEqual([])
  })

  it('tells a plugin with no port or a port that ended nothing', async () => {
    const { plugin, click, drawer } = started({ alpha: marker })
    const alpha = plugin('alpha')
    drawer.end('alpha', 1)
    await click({ owner: 'alpha', id: 'a' })
    await click({ owner: 'ghost', id: 'a' })
    expect(alpha.links()).toEqual([])
  })

  it(`counts link marks toward the ${MAX_MARKS} marks a note holds and the ${MARKS_PER_SECOND} a second`, async () => {
    const { plugin, wait } = started({ alpha: marker })
    const alpha = plugin('alpha')
    const many = (n: number) => Array.from({ length: n }, (_, i) => link(0, 1 + (i % 20), `l${i}`))
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'a', marks: many(MAX_MARKS) })).toMatchObject({ ok: true })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'b', marks: many(1) })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    const spent = Math.floor(MARKS_PER_SECOND / MAX_MARKS) - 1
    for (let i = 0; i < spent; i++) await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'a', marks: many(MAX_MARKS) })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'a', marks: many(MAX_MARKS) })).toMatchObject({ ok: false, refusal: { code: 'throttled' } })
    wait(1000)
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'a', marks: many(MAX_MARKS) })).toMatchObject({ ok: true })
  })

  it('needs ui.decoration and a read of the note to place a link, as every mark does', async () => {
    const { plugin, sets } = started({ alpha: { read: true, verbs: [] }, beta: { read: false, verbs: ['ui.decoration'] } })
    expect(await plugin('alpha').call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [link(0, 3, 'a')] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(await plugin('beta').call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [link(0, 3, 'a')] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    expect(sets.size).toBe(0)
  })
})
