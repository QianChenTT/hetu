import { ChangeSet, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { CORE_KEYS, Drawer, type Instance, type PortLike } from '../frontend/mount/bridge.ts'
import { CoreLink } from '../frontend/mount/link.ts'
import { Versions } from '../frontend/mount/versions.ts'
import { fakeCore, settle } from './mount-fakes.ts'

type Reach = { read?: string[], write?: string[], verbs?: string[] }

// An open note as the drawer sees it, on a real text and real versions
function note(id: string, path: string, text: string) {
  let doc = Text.of(text.split('\n'))
  const versions = new Versions(doc.length)
  const marks = new Map<string, Map<string, Mark[]>>()
  const applied: { changes: ChangeSet, plugin: string }[] = []
  const instance: Instance = {
    id,
    path,
    versions,
    text: () => doc.toString(),
    selection: () => [{ anchor: 1, head: 2 }],
    apply(changes, plugin) {
      doc = changes.apply(doc)
      versions.push(changes)
      applied.push({ changes, plugin })
    },
    setMarks(owner, set, given) {
      const sets = marks.get(owner) ?? new Map<string, Mark[]>()
      sets.set(set, given)
      marks.set(owner, sets)
    },
    clearMarks(owner) {
      marks.delete(owner)
    },
  }
  // The human types: a change the editor applies and the drawer hears
  const type = (from: number, insert: string) => {
    const changes = ChangeSet.of({ from, insert }, doc.length)
    doc = changes.apply(doc)
    versions.push(changes)
    return changes
  }
  return { instance, marks, applied, type, text: () => doc.toString() }
}

function port() {
  const sent: Record<string, unknown>[] = []
  const made: PortLike & { closed: boolean } = {
    closed: false,
    onmessage: null,
    postMessage(message: unknown) {
      sent.push(JSON.parse(message as string) as Record<string, unknown>)
    },
    close() {
      made.closed = true
    },
  }
  let id = 0
  const call = async (verb: string, args?: unknown) => {
    const n = ++id
    made.onmessage?.({ data: JSON.stringify({ v: 1, kind: 'call', id: n, verb, args }) })
    await settle()
    await settle()
    return sent.find(message => message.kind === 'reply' && message.id === n)
  }
  return { port: made, sent, call, events: () => sent.filter(message => message.kind === 'event') }
}

// The gate's answers for each plugin, which editor.reach gives back
function started(reach: Record<string, Reach>, notes = [note('n1', 'a.md', 'hello world')]) {
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'editor.reach': args => {
      const { plugin, path } = args as { plugin: string, path?: string }
      const held = reach[plugin]
      if (held === undefined) return { ok: false, refusal: { code: 'policy-down' } }
      return {
        ok: true,
        result: {
          read: path !== undefined && (held.read ?? []).includes(path),
          write: path !== undefined && (held.write ?? []).includes(path),
          verbs: held.verbs ?? [],
        },
      }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  const edited: { instance: string, plugin: string }[] = []
  const drawer = new Drawer(link, () => notes.map(made => made.instance), (instance, plugin) => edited.push({ instance, plugin }))
  drawer.start()
  return { core, drawer, notes, edited }
}

const reader: Reach = { read: ['a.md'], verbs: ['ui.decoration'] }

describe("the bridge's drawer end", () => {
  it('answers a call on the plugin\'s own port only', async () => {
    const { drawer } = started({ alpha: reader, beta: reader })
    const alpha = port()
    const beta = port()
    drawer.connect('alpha', 1, alpha.port)
    drawer.connect('beta', 1, beta.port)
    const answered = await alpha.call('editor.read', { instance: 'n1' })
    expect(answered).toEqual({ v: 1, kind: 'reply', id: 1, ok: true, result: { text: 'hello world', version: 0, selection: [{ anchor: 1, head: 2 }] } })
    expect(beta.sent.filter(message => message.kind === 'reply')).toEqual([])
  })

  it('drops a port from an older incarnation and replaces one from a newer', async () => {
    const { drawer } = started({ alpha: reader })
    const newer = port()
    const older = port()
    drawer.connect('alpha', 2, newer.port)
    drawer.connect('alpha', 1, older.port)
    expect(older.port.closed).toBe(true)
    expect(await newer.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
    const next = port()
    drawer.connect('alpha', 3, next.port)
    expect(newer.port.closed).toBe(true)
  })

  it.each([
    ['editor.read', { instance: 'n1' }, { verbs: ['ui.decoration'] }],
    ['editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [] }, { read: ['a.md'] }],
    ['editor.edit', { instance: 'n1', version: 0, changes: [11] }, { read: ['a.md'] }],
    ['editor.edit', { instance: 'n1', version: 0, changes: [11] }, { write: ['a.md'] }],
    ['editor.bind', { bindings: [] }, { read: ['a.md'], verbs: ['ui.decoration'] }],
    ['editor.keys', { on: true }, { read: ['a.md'], verbs: ['ui.command'] }],
  ])('refuses %s %j without what it needs', async (verb, args, held) => {
    const { drawer } = started({ alpha: held })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call(verb, args)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it.each([
    ['editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [] }, { read: ['a.md'], verbs: ['ui.decoration'] }],
    ['editor.edit', { instance: 'n1', version: 0, changes: [11] }, { read: ['a.md'], write: ['a.md'] }],
    ['editor.bind', { bindings: [] }, { verbs: ['ui.command'] }],
    ['editor.keys', { on: true }, { verbs: ['ui.keys'] }],
  ])('answers %s with what it needs', async (verb, args, held) => {
    const { drawer } = started({ alpha: held })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call(verb, args)).toMatchObject({ ok: true })
  })

  it('reads policy-down as no reach', async () => {
    const { drawer } = started({})
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('answers not-found for an instance that is not open', async () => {
    const { drawer } = started({ alpha: reader })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.read', { instance: 'n9' })).toMatchObject({ ok: false, refusal: { code: 'not-found' } })
  })

  it('lists only the instances whose notes the plugin reads', async () => {
    const notes = [note('n1', 'a.md', 'a'), note('n2', 'secret.md', 's')]
    const { drawer } = started({ alpha: reader }, notes)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.instances')).toMatchObject({ ok: true, result: { instances: [{ instance: 'n1', path: 'a.md', version: 0 }] } })
  })

  it('tells only readers that a note opened and changed, with the change set and the version', async () => {
    const notes = [note('n1', 'a.md', 'abc'), note('n2', 'secret.md', 's')]
    const { drawer } = started({ alpha: reader }, notes)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await settle()
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }])
    const changes = notes[0].type(3, '!')
    drawer.changed(notes[0].instance, changes)
    drawer.changed(notes[1].instance, notes[1].type(0, 'x'))
    await settle()
    expect(alpha.events().slice(1)).toEqual([{ v: 1, kind: 'event', topic: 'editor.changed', instance: 'n1', version: 1, changes: [3, [0, '!']] }])
  })

  it('maps a decoration made for an old version and refuses one too old with stale', async () => {
    const made = note('n1', 'a.md', 'hello world')
    const { drawer } = started({ alpha: reader }, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    made.type(0, '>> ')
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'words', marks: [{ kind: 'mark', from: 6, to: 11, style: 'strong' }] }))
      .toMatchObject({ ok: true, result: { version: 1 } })
    expect(made.marks.get('alpha')?.get('words')).toEqual([{ kind: 'mark', from: 9, to: 14, style: 'strong' }])
    for (let i = 0; i < 501; i++) made.type(0, 'x')
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'words', marks: [] }))
      .toMatchObject({ ok: false, refusal: { code: 'stale' } })
  })

  it('rebases an edit, refuses one touching changed text as stale and names the plugin as its author', async () => {
    const made = note('n1', 'a.md', 'first line')
    const { drawer, edited } = started({ alpha: { read: ['a.md'], write: ['a.md'] } }, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    made.type(10, '!')
    // Made against version 0: "first" to "First"
    expect(await alpha.call('editor.edit', { instance: 'n1', version: 0, changes: [[5, 'First'], 5] }))
      .toMatchObject({ ok: true, result: { version: 2 } })
    expect(made.text()).toBe('First line!')
    expect(made.applied.map(each => each.plugin)).toEqual(['alpha'])
    expect(edited).toEqual([{ instance: 'n1', plugin: 'alpha' }])
    // The human types inside "First", then the plugin's edit made for version 2 replaces it
    made.type(2, 'x')
    expect(await alpha.call('editor.edit', { instance: 'n1', version: 2, changes: [[5, 'FIRST'], 6] }))
      .toMatchObject({ ok: false, refusal: { code: 'stale' } })
  })

  it('refuses an edit made against another length as stale', async () => {
    const { drawer } = started({ alpha: { read: ['a.md'], write: ['a.md'] } })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.edit', { instance: 'n1', version: 0, changes: [[0, 'a', 'b'], 999] }))
      .toMatchObject({ ok: false, refusal: { code: 'stale' } })
  })

  it('answers failed when the editor throws applying an edit, and goes on serving', async () => {
    const made = note('n1', 'a.md', 'abc')
    made.instance.apply = () => {
      throw new Error('broken')
    }
    const { drawer } = started({ alpha: { read: ['a.md'], write: ['a.md'] } }, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.edit', { instance: 'n1', version: 0, changes: [3, [0, '!']] }))
      .toMatchObject({ ok: false, refusal: { code: 'failed' } })
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
  })

  it('answers invalid for a call it can read the id of and nothing for text that is no JSON, never throwing', async () => {
    const { drawer } = started({ alpha: reader })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    const marks = Array.from({ length: 5001 }, () => ({ kind: 'hide', from: 0, to: 1 }))
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    alpha.port.onmessage?.({ data: '{' })
    alpha.port.onmessage?.({ data: { not: 'text' } })
    alpha.port.onmessage?.({ data: JSON.stringify({ v: 1, kind: 'call', id: 'x', verb: 'editor.read' }) })
    await settle()
    expect(alpha.sent.filter(message => message.kind === 'reply')).toHaveLength(1)
  })

  it('calls the owner of a binding with its command, never on a core key', async () => {
    const { drawer } = started({ alpha: { verbs: ['ui.command'] }, beta: { verbs: ['ui.command'] } })
    const alpha = port()
    const beta = port()
    drawer.connect('alpha', 1, alpha.port)
    drawer.connect('beta', 1, beta.port)
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }, { key: 'Mod-/', command: 'hide' }] })
    expect(drawer.key('n1', 'Mod-k')).toBe(true)
    expect(drawer.key('n1', 'Mod-/')).toBe(false)
    expect(drawer.key('n1', 'Mod-j')).toBe(false)
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: 'n1' }])
    expect(beta.events()).toEqual([])
    expect(CORE_KEYS).toEqual(['Mod-/', 'Mod-p', 'Mod-s', 'Mod-q'])
  })

  it('streams keys only for instances whose notes the plugin reads', async () => {
    const notes = [note('n1', 'a.md', 'a'), note('n2', 'secret.md', 's')]
    const { drawer } = started({ alpha: { read: ['a.md'], verbs: ['ui.keys'] } }, notes)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.keys', { on: true })
    drawer.key('n1', 'a')
    drawer.key('n2', 'b')
    drawer.key(null, 'c')
    await settle()
    expect(alpha.events().filter(event => event.topic === 'editor.key')).toEqual([{ v: 1, kind: 'event', topic: 'editor.key', instance: 'n1', key: 'a' }])
  })

  it('asks the core again after core.security and drops what a narrowed plugin no longer reaches', async () => {
    const made = note('n1', 'a.md', 'hello')
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'], verbs: ['ui.decoration', 'ui.command'] } }
    const { drawer, core } = started(reach, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [{ kind: 'hide', from: 0, to: 1 }] })
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })
    const asked = core.calls('editor.reach').length
    reach.alpha = { read: [], verbs: [] }
    core.event('core.security')
    await settle()
    await settle()
    expect(core.calls('editor.reach').length).toBeGreaterThan(asked)
    expect(made.marks.has('alpha')).toBe(false)
    expect(drawer.key('n1', 'Mod-k')).toBe(false)
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it("drops a plugin's marks, bindings and port when it ends", async () => {
    const made = note('n1', 'a.md', 'hello')
    const { drawer } = started({ alpha: { read: ['a.md'], verbs: ['ui.decoration', 'ui.command'] } }, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [{ kind: 'hide', from: 0, to: 1 }] })
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })
    drawer.end('alpha', 1)
    expect(made.marks.has('alpha')).toBe(false)
    expect(drawer.key('n1', 'Mod-k')).toBe(false)
    expect(alpha.port.closed).toBe(true)
  })

  it('ignores an end for an incarnation it no longer holds', async () => {
    const { drawer } = started({ alpha: reader })
    const alpha = port()
    drawer.connect('alpha', 2, alpha.port)
    drawer.end('alpha', 1)
    expect(alpha.port.closed).toBe(false)
  })
})
