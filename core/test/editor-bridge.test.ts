import { ChangeSet, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { CORE_KEYS, Drawer, type Instance, type PortLike, RESERVED_KEYS } from '../frontend/editor/bridge.ts'
import { MARKS_PER_SECOND, MAX_MARK_SETS, MAX_MARKS, READ_CHARS_PER_SECOND } from '../api/editor.ts'
import { CoreLink } from '../frontend/editor/link.ts'
import { Versions } from '../frontend/editor/versions.ts'
import { fakeCore, settle } from './editor-fakes.ts'

// write is what the core no longer answers, kept so a test shows the drawer never edits on it
type Reach = { read?: string[], write?: string[], edit?: string[], uiRead?: string[], list?: string[], verbs?: string[] }

// An open note as the drawer sees it, on a real text and real versions
function note(id: string, path: string, text: string, selection = [{ anchor: 1, head: 2 }]) {
  let doc = Text.of(text.split('\n'))
  const versions = new Versions(doc.length)
  const marks = new Map<string, Map<string, Mark[]>>()
  const applied: { changes: ChangeSet, plugin: string }[] = []
  const instance: Instance = {
    id,
    path,
    versions,
    text: () => doc.toString(),
    selection: () => selection.map(range => ({ ...range })),
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

// The gate's answers for each plugin, which gate.reach gives back
function started(reach: Record<string, Reach>, notes = [note('n1', 'a.md', 'hello world')], clock?: () => number) {
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'gate.reach': args => {
      const { plugin, path } = args as { plugin: string, path?: string }
      const held = reach[plugin]
      if (held === undefined) return { ok: false, refusal: { code: 'policy-down' } }
      return {
        ok: true,
        result: {
          read: path !== undefined && (held.read ?? []).includes(path),
          write: path !== undefined && (held.write ?? []).includes(path),
          edit: path !== undefined && (held.edit ?? []).includes(path),
          uiRead: path !== undefined && (held.uiRead ?? []).includes(path),
          list: path !== undefined && (held.list ?? []).includes(path),
          verbs: held.verbs ?? [],
        },
      }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  const edited: { instance: string, plugin: string }[] = []
  const drawer = new Drawer(link, () => notes.map(made => made.instance), (instance, plugin) => edited.push({ instance, plugin }), { clock })
  drawer.start()
  return { core, drawer, notes, edited }
}

const reader: Reach = { read: ['a.md'], verbs: ['ui.decoration'] }

// The read twin of ui.edit: a note the human opened, through the bridge alone. A note a plugin opened isn't counted,
// and neither is one opened from a plugin's node naming a note that plugin can't reach itself
describe('ui.read', () => {
  const shown: Reach = { uiRead: ['a.md'], verbs: ['ui.decoration'] }

  it('reaches a note the human opened through the bridge alone, with its events', async () => {
    const { drawer, notes } = started({ alpha: shown })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await drawer.humanOpened(notes[0].instance)
    await settle()
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }])
    expect(await alpha.call('editor.instances')).toMatchObject({ ok: true, result: { instances: [{ instance: 'n1', path: 'a.md' }] } })
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true, result: { text: 'hello world' } })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [] })).toMatchObject({ ok: true })
  })

  it('reaches no note the human didn\'t open, one a plugin opened included', async () => {
    const { drawer } = started({ alpha: shown })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await settle()
    expect(alpha.events()).toEqual([])
    expect(await alpha.call('editor.instances')).toMatchObject({ ok: true, result: { instances: [] } })
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('counts a note opened from a plugin\'s node as the human\'s only when that plugin reads or lists it itself', async () => {
    const { drawer, notes } = started({ alpha: shown, lure: { uiRead: ['a.md'] }, explorer: { list: ['a.md'] } })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await drawer.humanOpened(notes[0].instance, 'lure')
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await drawer.humanOpened(notes[0].instance, 'explorer')
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
  })

  it('edits a note the human opened on ui.read and ui.edit, holding no luoshu grant', async () => {
    const { drawer, notes } = started({ alpha: { uiRead: ['a.md'], edit: ['a.md'] } })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.edit', { instance: 'n1', version: 0, changes: [11, [0, '!']] })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
    await drawer.humanOpened(notes[0].instance)
    expect(await alpha.call('editor.edit', { instance: 'n1', version: 0, changes: [11, [0, '!']] })).toMatchObject({ ok: true })
    expect(notes[0].text()).toBe('hello world!')
  })
})

// Where the human is in a note: the selection on a command and the range the editor draws, each only to a plugin that
// reads the note, as every other event about it. The range goes only to a plugin that asked for it
describe('the selection and the viewport', () => {
  const twoNotes = () => [note('n1', 'a.md', 'one two three', [{ anchor: 3, head: 7 }]), note('n2', 'b.md', 'secret text', [{ anchor: 0, head: 6 }])]
  const viewports = (made: ReturnType<typeof port>) => made.events().filter(event => event.topic === 'editor.viewport')
  const range = (instance: string, version: number, from: number, to: number) => ({ v: 1, kind: 'event', topic: 'editor.viewport', instance, version, from, to })
  // Connected plugins, each asking for the range when asks says so
  const connected = async (drawer: Drawer, ids: string[], asks: string[] = ids) => {
    const made = Object.fromEntries(ids.map(id => [id, port()]))
    for (const id of ids) drawer.connect(id, 1, made[id].port)
    for (const id of asks) expect(await made[id].call('editor.viewports', { on: true })).toMatchObject({ ok: true, result: null })
    await settle()
    return made
  }

  it('sends no range to a plugin that reads the note and never asked, as the editor opens, moves and changes', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md', 'b.md'], verbs: ['ui.decoration'] } }, notes)
    const { alpha } = await connected(drawer, ['alpha'], [])
    drawer.viewport(notes[0].instance, 0, 9)
    notes[0].type(0, 'x')
    drawer.viewport(notes[0].instance, 1, 12)
    drawer.viewport(notes[1].instance, 0, 11)
    await settle()
    expect(viewports(alpha)).toEqual([])
    expect(alpha.events().map(event => event.topic)).toEqual(['editor.opened', 'editor.opened'])
  })

  it('sends a plugin that asked the range drawn at its ask, then each one after with its version', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha } = await connected(drawer, ['alpha'])
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9)])
    notes[0].type(0, 'x')
    drawer.viewport(notes[0].instance, 1, 12)
    drawer.viewport(notes[0].instance, 4, 14)
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 1, 1, 12), range('n1', 1, 4, 14)])
  })

  it('sends a plugin that asked no range of a note it can\'t read, on ui.read none until the human opened it', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['b.md'] }, shown: { uiRead: ['a.md'] }, other: { verbs: ['ui.decoration'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const plugins = await connected(drawer, ['alpha', 'shown', 'other'])
    drawer.viewport(notes[0].instance, 2, 9)
    await settle()
    expect(viewports(plugins.alpha)).toEqual([])
    expect(viewports(plugins.shown)).toEqual([])
    expect(plugins.other.events()).toEqual([])
    await drawer.humanOpened(notes[0].instance)
    drawer.viewport(notes[0].instance, 3, 9)
    await settle()
    expect(viewports(plugins.shown)).toEqual([range('n1', 0, 2, 9), range('n1', 0, 3, 9)])
    expect(viewports(plugins.alpha)).toEqual([])
  })

  it('sends each range once to a plugin that asked twice', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha } = await connected(drawer, ['alpha'])
    expect(await alpha.call('editor.viewports', { on: true })).toMatchObject({ ok: true })
    drawer.viewport(notes[0].instance, 2, 9)
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 0, 2, 9)])
  })

  it('sends no range after the plugin stopped them and the range drawn then once it asks again', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha } = await connected(drawer, ['alpha'])
    expect(await alpha.call('editor.viewports', { on: false })).toMatchObject({ ok: true, result: null })
    // Asked again with nothing moved, it hears where the editor is again
    await alpha.call('editor.viewports', { on: true })
    await alpha.call('editor.viewports', { on: false })
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 0, 0, 9)])
    drawer.viewport(notes[0].instance, 2, 9)
    drawer.viewport(notes[0].instance, 3, 9)
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 0, 0, 9)])
    await alpha.call('editor.viewports', { on: true })
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 0, 0, 9), range('n1', 0, 3, 9)])
  })

  it('sends no range of a note that closed while its read was being checked', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    const { alpha } = await connected(drawer, ['alpha'])
    drawer.viewport(notes[0].instance, 0, 9)
    drawer.closed('n1')
    await settle()
    expect(viewports(alpha)).toEqual([])
  })

  it('tells a plugin that asked before the note opened that it opened, then its range once', async () => {
    const notes: ReturnType<typeof note>[] = []
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    const { alpha } = await connected(drawer, ['alpha'])
    expect(alpha.events()).toEqual([])
    // As the page tells it: the note opened, then the range its editor drew
    notes.push(note('n1', 'a.md', 'one two three'))
    drawer.opened(notes[0].instance)
    drawer.viewport(notes[0].instance, 0, 13)
    await settle()
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }, range('n1', 0, 0, 13)])
  })

  it('sends no range while a plugin has lost its read of the note, then tells it the note opened with the range drawn then once it reads again', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] }, beta: { read: ['a.md'] } }
    const { drawer, core } = started(reach, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha, beta } = await connected(drawer, ['alpha', 'beta'], ['alpha'])
    reach.alpha = { read: [] }
    reach.beta = { read: [] }
    core.event('core.security')
    await settle()
    drawer.viewport(notes[0].instance, 2, 9)
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9)])
    // Back with no move of the view: the note opened again, so the plugin reads it afresh and hears where the editor is now
    reach.alpha = { read: ['a.md'] }
    reach.beta = { read: ['a.md'] }
    core.event('core.security')
    await settle()
    await settle()
    const opened = { v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }
    expect(alpha.events()).toEqual([opened, range('n1', 0, 0, 9), opened, range('n1', 0, 2, 9)])
    expect(beta.events()).toEqual([opened, opened])
    drawer.viewport(notes[0].instance, 3, 9)
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 0, 2, 9), range('n1', 0, 3, 9)])
  })

  it('tells a plugin that lost its read and got it back before the drawer checked again that the note opened, a change missed between', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] } }
    const { drawer, core } = started(reach, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha } = await connected(drawer, ['alpha'])
    reach.alpha = { read: [] }
    core.event('core.security')
    drawer.changed(notes[0].instance, notes[0].type(12, 'x'))
    reach.alpha = { read: ['a.md'] }
    core.event('core.security')
    await settle()
    await settle()
    const opened = { v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }
    expect(alpha.events()).toEqual([opened, range('n1', 0, 0, 9), opened, range('n1', 1, 0, 9)])
  })

  // The core's answers to gate.reach held while hold says so, each given as the gate stood when asked
  const holding = (core: ReturnType<typeof started>['core'], hold: (args: { path?: string }) => boolean) => {
    const answer = core.answers['gate.reach']
    const held: (() => void)[] = []
    let on = true
    core.answers['gate.reach'] = (args, sent) => {
      const got = answer(args, sent)
      if (!on || !hold(args as { path?: string })) return got
      return new Promise(resolve => held.push(() => resolve(got)))
    }
    return { stop: () => { on = false }, release: () => { for (const each of held.splice(0)) each() } }
  }

  it('tells a plugin the note opened again when a change held back from it was checked against a read given back since', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] } }
    const { drawer, core } = started(reach, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha } = await connected(drawer, ['alpha'])
    const gate = holding(core, () => true)
    reach.alpha = { read: [] }
    core.event('core.security')
    drawer.changed(notes[0].instance, notes[0].type(12, 'x'))
    gate.stop()
    reach.alpha = { read: ['a.md'] }
    core.event('core.security')
    await settle()
    await settle()
    gate.release()
    await settle()
    await settle()
    const opened = { v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }
    expect(alpha.events()).toEqual([opened, range('n1', 0, 0, 9), opened, range('n1', 1, 0, 9)])
  })

  it('keeps sending ranges to a plugin whose read went and came back while the drawer still checked the note against the first', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] } }
    const { drawer, core } = started(reach, notes)
    const { alpha } = await connected(drawer, ['alpha'])
    const gate = holding(core, args => args.path !== undefined)
    reach.alpha = { read: [] }
    core.event('core.security')
    await settle()
    gate.stop()
    reach.alpha = { read: ['a.md'] }
    core.event('core.security')
    await settle()
    await settle()
    gate.release()
    await settle()
    drawer.viewport(notes[0].instance, 0, 9)
    await settle()
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }, range('n1', 0, 0, 9)])
  })

  it('tells a plugin given a read after the note opened that it opened, with the range drawn then', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: [] } }
    const { drawer, core } = started(reach, notes)
    const { alpha } = await connected(drawer, ['alpha'])
    drawer.viewport(notes[1].instance, 0, 11)
    await settle()
    expect(alpha.events()).toEqual([])
    reach.alpha = { read: ['b.md'] }
    core.event('core.security')
    await settle()
    await settle()
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.opened', instance: 'n2' }, range('n2', 0, 0, 11)])
  })

  it('sends a range the editor still draws with the version of the note then, at a late ask, at an open on ui.read and when a read comes back', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] }, shown: { uiRead: ['a.md'] } }
    const { drawer, core } = started(reach, notes)
    drawer.viewport(notes[0].instance, 0, 5)
    // Changes past the drawn range leave it where it is, so the editor tells no new one
    for (const at of [9, 10, 11]) drawer.changed(notes[0].instance, notes[0].type(at, 'x'))
    const { alpha, shown } = await connected(drawer, ['alpha', 'shown'])
    expect(viewports(alpha)).toEqual([range('n1', 3, 0, 5)])
    drawer.changed(notes[0].instance, notes[0].type(12, 'x'))
    await drawer.humanOpened(notes[0].instance)
    await settle()
    expect(viewports(shown)).toEqual([range('n1', 4, 0, 5)])
    reach.alpha = { read: [] }
    core.event('core.security')
    await settle()
    drawer.changed(notes[0].instance, notes[0].type(13, 'x'))
    reach.alpha = { read: ['a.md'] }
    core.event('core.security')
    await settle()
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 3, 0, 5), range('n1', 5, 0, 5)])
  })

  it('sends a range the editor drew before a newer one with the version it was drawn at', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    const { alpha } = await connected(drawer, ['alpha'])
    drawer.viewport(notes[0].instance, 0, 9)
    notes[0].type(0, 'x')
    drawer.viewport(notes[0].instance, 1, 10)
    notes[0].type(12, 'x')
    await settle()
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9), range('n1', 2, 1, 10)])
  })

  it('sends a restarted plugin no range until its new run asks and its stopped run none', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha } = await connected(drawer, ['alpha'])
    drawer.end('alpha', 1)
    const again = port()
    drawer.connect('alpha', 2, again.port)
    drawer.viewport(notes[0].instance, 2, 9)
    await settle()
    expect(viewports(again)).toEqual([])
    expect(viewports(alpha)).toEqual([range('n1', 0, 0, 9)])
    // A newer run that replaces a live one starts with no ask either
    await again.call('editor.viewports', { on: true })
    const third = port()
    drawer.connect('alpha', 3, third.port)
    drawer.viewport(notes[0].instance, 3, 9)
    await settle()
    expect(viewports(third)).toEqual([])
    expect(viewports(again)).toEqual([range('n1', 0, 2, 9)])
  })

  it("sends a command the selection and the version at the key, of that key's note and only to a plugin that reads it", async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'], verbs: ['ui.command'] } }, notes)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })
    notes[0].type(0, '> ')
    drawer.key('n1', 'Mod-k')
    drawer.key('n2', 'Mod-k')
    drawer.key(null, 'Mod-k')
    await settle()
    expect(alpha.events().filter(event => event.topic === 'editor.command')).toEqual([
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: 'n1', version: 1, selection: [{ anchor: 3, head: 7 }] },
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
    ])
  })

  it('sends a command no selection on ui.read until the human opened the note', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { uiRead: ['a.md'], verbs: ['ui.command'] } }, notes)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })
    drawer.key('n1', 'Mod-k')
    await settle()
    await drawer.humanOpened(notes[0].instance)
    drawer.key('n1', 'Mod-k')
    await settle()
    expect(alpha.events().filter(event => event.topic === 'editor.command')).toEqual([
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: 'n1', version: 0, selection: [{ anchor: 3, head: 7 }] },
    ])
  })

  it("sends each note's viewport with its own instance and version to its readers and to no other plugin", async () => {
    const notes = twoNotes()
    const { drawer } = started({
      alpha: { read: ['a.md'] }, beta: { read: ['b.md'], verbs: ['ui.decoration'] }, shown: { uiRead: ['a.md'] }, other: { verbs: ['ui.decoration'] },
    }, notes)
    const plugins = await connected(drawer, ['alpha', 'beta', 'shown', 'other'])
    drawer.viewport(notes[0].instance, 0, 9)
    drawer.viewport(notes[1].instance, 2, 11)
    notes[0].type(0, 'x')
    drawer.viewport(notes[0].instance, 1, 12)
    await settle()
    expect(viewports(plugins.alpha)).toEqual([
      { v: 1, kind: 'event', topic: 'editor.viewport', instance: 'n1', version: 0, from: 0, to: 9 },
      { v: 1, kind: 'event', topic: 'editor.viewport', instance: 'n1', version: 1, from: 1, to: 12 },
    ])
    expect(viewports(plugins.beta)).toEqual([{ v: 1, kind: 'event', topic: 'editor.viewport', instance: 'n2', version: 0, from: 2, to: 11 }])
    expect(plugins.shown.events()).toEqual([])
    expect(plugins.other.events()).toEqual([])
  })

  it('tells a plugin the last viewport with editor.opened, on ui.read once the human opened the note', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] }, shown: { uiRead: ['a.md'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    const { alpha, shown } = await connected(drawer, ['alpha', 'shown'])
    expect(alpha.events()).toEqual([
      { v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' },
      { v: 1, kind: 'event', topic: 'editor.viewport', instance: 'n1', version: 0, from: 0, to: 9 },
    ])
    expect(shown.events()).toEqual([])
    await drawer.humanOpened(notes[0].instance)
    await settle()
    expect(shown.events()).toEqual([
      { v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' },
      { v: 1, kind: 'event', topic: 'editor.viewport', instance: 'n1', version: 0, from: 0, to: 9 },
    ])
  })

  it('stops sending the viewport and the selection once core.security narrowed the grant', async () => {
    const notes = twoNotes()
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'], verbs: ['ui.command'] } }
    const { drawer, core } = started(reach, notes)
    const { alpha } = await connected(drawer, ['alpha'])
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })
    drawer.viewport(notes[0].instance, 0, 9)
    await settle()
    expect(viewports(alpha)).toHaveLength(1)
    reach.alpha = { read: [], verbs: ['ui.command'] }
    core.event('core.security')
    await settle()
    drawer.viewport(notes[0].instance, 3, 9)
    drawer.key('n1', 'Mod-k')
    await settle()
    expect(viewports(alpha)).toHaveLength(1)
    expect(alpha.events().filter(event => event.topic === 'editor.command')).toEqual([
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
    ])
  })

  it('forgets the viewport of a closed note, so an instance opened under its id starts with none', async () => {
    const notes = twoNotes()
    const { drawer } = started({ alpha: { read: ['a.md'] } }, notes)
    drawer.viewport(notes[0].instance, 0, 9)
    drawer.closed('n1')
    notes[0] = note('n1', 'a.md', 'again')
    const { alpha } = await connected(drawer, ['alpha'])
    expect(alpha.events()).toEqual([{ v: 1, kind: 'event', topic: 'editor.opened', instance: 'n1' }])
  })
})

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
    ['editor.edit', { instance: 'n1', version: 0, changes: [11] }, { edit: ['a.md'] }],
    // A plugin that writes the note on disk still edits it in the editor only with ui.edit
    ['editor.edit', { instance: 'n1', version: 0, changes: [11] }, { read: ['a.md'], write: ['a.md'] }],
    ['editor.bind', { bindings: [] }, { read: ['a.md'], verbs: ['ui.decoration'] }],
    ['editor.keystream', { on: true }, { read: ['a.md'], verbs: ['ui.command'] }],
  ])('refuses %s %j without what it needs', async (verb, args, held) => {
    const { drawer } = started({ alpha: held })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call(verb, args)).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it.each([
    ['editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [] }, { read: ['a.md'], verbs: ['ui.decoration'] }],
    ['editor.edit', { instance: 'n1', version: 0, changes: [11] }, { read: ['a.md'], edit: ['a.md'] }],
    ['editor.bind', { bindings: [] }, { verbs: ['ui.command'] }],
    ['editor.keystream', { on: true }, { verbs: ['ui.keystream'] }],
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
    const { drawer, edited } = started({ alpha: { read: ['a.md'], edit: ['a.md'] } }, [made])
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
    const { drawer } = started({ alpha: { read: ['a.md'], edit: ['a.md'] } })
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
    const { drawer } = started({ alpha: { read: ['a.md'], edit: ['a.md'] } }, [made])
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

  it('calls the owner of a binding with its command, naming the note only when the plugin reads it', async () => {
    const notes = [note('n1', 'a.md', 'a'), note('n2', 'secret.md', 's')]
    const { drawer } = started({ alpha: { read: ['a.md'], verbs: ['ui.command'] }, beta: { verbs: ['ui.command'] } }, notes)
    const alpha = port()
    const beta = port()
    drawer.connect('alpha', 1, alpha.port)
    drawer.connect('beta', 1, beta.port)
    expect(await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })).toMatchObject({ ok: true })
    expect(drawer.key('n1', 'Mod-k')).toBe(true)
    expect(drawer.key('n2', 'Mod-k')).toBe(true)
    expect(drawer.key('n1', 'Mod-j')).toBe(false)
    await settle()
    const commands = alpha.events().filter(event => event.topic === 'editor.command')
    expect(commands).toEqual([
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: 'n1', version: 0, selection: [{ anchor: 1, head: 2 }] },
      { v: 1, kind: 'event', topic: 'editor.command', command: 'kill', instance: null },
    ])
    expect(beta.events()).toEqual([])
    expect(CORE_KEYS).toEqual(['Mod-/', 'Mod-p', 'Mod-s', 'Mod-q'])
  })

  it.each(['k', '4', 'Shift-k', 'Enter'])('refuses a binding on %s, a key with no modifier, so typing in a note never reaches one', async key => {
    const { drawer } = started({ alpha: { verbs: ['ui.command'] } })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.bind', { bindings: [{ key, command: 'grab' }] })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
  })

  it.each(['Mod-/', 'Mod-Shift-/', 'Ctrl-/', 'Mod-p', 'Mod-s', 'Mod-q', 'Mod-c', 'Mod-x', 'Mod-v', 'Mod-z', 'Mod-y', 'Mod-Shift-z', 'Mod-a'])(
    'refuses a binding on %s, a core key or one the editor keeps for itself, and never fires one',
    async key => {
      const { drawer } = started({ alpha: { verbs: ['ui.command'] } })
      const alpha = port()
      drawer.connect('alpha', 1, alpha.port)
      expect(await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'ok' }, { key, command: 'grab' }] }))
        .toMatchObject({ ok: false, refusal: { code: 'invalid' } })
      expect(drawer.key('n1', key)).toBe(false)
      expect(RESERVED_KEYS).toContain(key === 'Ctrl-/' ? 'Mod-/' : key)
    },
  )

  it('takes back marks from a plugin that keeps ui.decoration but loses read of the note', async () => {
    const made = note('n1', 'a.md', 'hello')
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'], verbs: ['ui.decoration'] } }
    const { drawer, core } = started(reach, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [{ kind: 'hide', from: 0, to: 1 }] })
    reach.alpha = { read: [], verbs: ['ui.decoration'] }
    core.event('core.security')
    await settle()
    await settle()
    expect(made.marks.has('alpha')).toBe(false)
  })

  it('asks the core again after core.status as after core.security', async () => {
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] } }
    const { drawer, core } = started(reach)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
    reach.alpha = { read: [] }
    core.event('core.status')
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('sends keys only to a plugin that turned its key stream on', async () => {
    const { drawer } = started({ alpha: { read: ['a.md'], verbs: ['ui.keystream'] } })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    drawer.key('n1', 'a')
    await settle()
    expect(alpha.events().filter(event => event.topic === 'editor.key')).toEqual([])
  })

  it('sends nothing to a plugin once it ended', async () => {
    const made = note('n1', 'a.md', 'abc')
    const { drawer } = started({ alpha: reader }, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await settle()
    const before = alpha.sent.length
    drawer.end('alpha', 1)
    drawer.changed(made.instance, made.type(0, 'x'))
    drawer.opened(made.instance)
    await settle()
    expect(alpha.sent.length).toBe(before)
  })

  it(`holds a plugin to ${MAX_MARK_SETS} sets and ${MAX_MARKS} marks on one note, across its sets, and counts each plugin apart`, async () => {
    const { drawer } = started({ alpha: reader, beta: reader })
    const alpha = port()
    const beta = port()
    drawer.connect('alpha', 1, alpha.port)
    drawer.connect('beta', 1, beta.port)
    const one = [{ kind: 'hide', from: 0, to: 1 }]
    for (let i = 0; i < MAX_MARK_SETS; i++) {
      expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: `s${i}`, marks: one })).toMatchObject({ ok: true })
    }
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'more', marks: one })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    const many = Array.from({ length: MAX_MARKS - MAX_MARK_SETS + 2 }, () => ({ kind: 'hide', from: 0, to: 1 }))
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's0', marks: many })).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's0', marks: many.slice(2) })).toMatchObject({ ok: true })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's1', marks: [] })).toMatchObject({ ok: true })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 'more', marks: one })).toMatchObject({ ok: true })
    expect(await beta.call('editor.decorate', { instance: 'n1', version: 0, set: 'b', marks: one })).toMatchObject({ ok: true })
  })

  it(`throttles a plugin past ${MARKS_PER_SECOND} marks a second and lets it on in the next second`, async () => {
    const time = { now: 0 }
    const { drawer } = started({ alpha: reader }, undefined, () => time.now)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    const full = Array.from({ length: MAX_MARKS }, () => ({ kind: 'hide', from: 0, to: 1 }))
    for (let i = 0; i < MARKS_PER_SECOND / MAX_MARKS; i++) {
      expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: full })).toMatchObject({ ok: true })
    }
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [] })).toMatchObject({ ok: true })
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: full })).toMatchObject({ ok: false, refusal: { code: 'throttled' } })
    time.now = 1000
    expect(await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: full })).toMatchObject({ ok: true })
  })

  it('throttles reads past their budget of text a second', async () => {
    const time = { now: 0 }
    const big = note('n1', 'a.md', 'x'.repeat(READ_CHARS_PER_SECOND / 4))
    const { drawer } = started({ alpha: reader }, [big], () => time.now)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    for (let i = 0; i < 4; i++) expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'throttled' } })
    time.now = 1000
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
  })

  it("matches a binding however the plugin spelled the key, as the page names keys", async () => {
    const { drawer } = started({ alpha: { verbs: ['ui.command'] } })
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.bind', { bindings: [{ key: 'Shift-Ctrl-K', command: 'kill' }] })).toMatchObject({ ok: true })
    expect(drawer.key('n1', 'Mod-Shift-k')).toBe(true)
  })

  it('streams keys only for instances whose notes the plugin reads', async () => {
    const notes = [note('n1', 'a.md', 'a'), note('n2', 'secret.md', 's')]
    const { drawer } = started({ alpha: { read: ['a.md'], verbs: ['ui.keystream'] } }, notes)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.keystream', { on: true })
    drawer.key('n1', 'a')
    drawer.key('n2', 'b')
    drawer.key(null, 'c')
    await settle()
    expect(alpha.events().filter(event => event.topic === 'editor.key')).toEqual([{ v: 1, kind: 'event', topic: 'editor.key', instance: 'n1', key: 'a' }])
  })

  it('keeps a key stream across core.security while the plugin still holds ui.keystream and ends it once it does not', async () => {
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'], verbs: ['ui.keystream'] } }
    const { drawer, core } = started(reach)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.keystream', { on: true })
    const heard = () => alpha.events().filter(event => event.topic === 'editor.key').map(event => event.key)
    core.event('core.security')
    await settle()
    await settle()
    drawer.key('n1', 'a')
    await settle()
    expect(heard()).toEqual(['a'])
    reach.alpha = { read: ['a.md'], verbs: [] }
    core.event('core.security')
    await settle()
    await settle()
    // Given back, the grant restarts nothing: the plugin asks for the stream again
    reach.alpha = { read: ['a.md'], verbs: ['ui.keystream'] }
    core.event('core.security')
    await settle()
    await settle()
    drawer.key('n1', 'b')
    await settle()
    expect(heard()).toEqual(['a'])
  })

  it('asks the core again after core.security and drops what a narrowed plugin no longer reaches', async () => {
    const made = note('n1', 'a.md', 'hello')
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'], verbs: ['ui.decoration', 'ui.command'] } }
    const { drawer, core } = started(reach, [made])
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    await alpha.call('editor.decorate', { instance: 'n1', version: 0, set: 's', marks: [{ kind: 'hide', from: 0, to: 1 }] })
    await alpha.call('editor.bind', { bindings: [{ key: 'Mod-k', command: 'kill' }] })
    const asked = core.calls('gate.reach').length
    reach.alpha = { read: [], verbs: [] }
    core.event('core.security')
    await settle()
    await settle()
    expect(core.calls('gate.reach').length).toBeGreaterThan(asked)
    expect(made.marks.has('alpha')).toBe(false)
    expect(drawer.key('n1', 'Mod-k')).toBe(false)
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: false, refusal: { code: 'not-granted' } })
  })

  it('asks the core again when core.security reached the window only folded into events.dropped', async () => {
    const reach: Record<string, Reach> = { alpha: { read: ['a.md'] } }
    const { drawer, core } = started(reach)
    const alpha = port()
    drawer.connect('alpha', 1, alpha.port)
    expect(await alpha.call('editor.read', { instance: 'n1' })).toMatchObject({ ok: true })
    reach.alpha = { read: [] }
    core.hears({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.changed', 'core.security'] })
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
