import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type FakeCore, fakeCore, FakeDrawer } from '@hetu/sdk/testing'
import { MAX_MARKS as BRIDGE_MAX_MARKS } from 'hetu-core/api/editor.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { elementKinds, type Mark } from '../src/marks.ts'
import hiddenMarks, { heldNotes, MARGIN, MAX_HEARD, MAX_MARKS } from '../src/worker.ts'

const manifest = path.join(import.meta.dirname, '..', 'hetu-plugin.json')
const cores: FakeCore[] = []

afterEach(async () => {
  for (const core of cores.splice(0)) await core.close()
})

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (const end = Date.now() + ms; !check();) {
    if (Date.now() > end) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

async function started() {
  const drawer = new FakeDrawer()
  const core = fakeCore({ manifest, drawer })
  cores.push(core)
  expect(await core.start(hiddenMarks)).toEqual({ state: 'ready' })
  return drawer
}

const marksOn = (drawer: FakeDrawer, instance: string): Mark[] => drawer.marks.get(`${instance} marks`) ?? []
const has = (drawer: FakeDrawer, instance: string, mark: Mark) => marksOn(drawer, instance).some(one => JSON.stringify(one) === JSON.stringify(mark))
const strong = (from: number, to: number): Mark => ({ kind: 'mark', from, to, style: 'strong' })
const groupAt = (drawer: FakeDrawer, instance: string, from: number) =>
  marksOn(drawer, instance).flatMap(mark => (mark.kind === 'hide' && mark.from === from ? [mark.group] : []))[0] ?? null

describe('hidden marks behind the bridge', () => {
  it("holds the bridge's cap on marks", () => {
    expect(MAX_MARKS).toBe(BRIDGE_MAX_MARKS)
  })

  it('marks a note the human opened, through ui.read and its decoration grant alone', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => has(drawer, instance, strong(0, 5)))
    expect(marksOn(drawer, instance)).toContainEqual(expect.objectContaining({ kind: 'hide', from: 0, to: 2, edge: 'open' }))
  })

  it('marks the range the editor draws and a margin around it, then the range it moves to', async () => {
    const drawer = await started()
    const lines = Array.from({ length: 2000 }, () => '**b**')
    const text = lines.join('\n')
    const at = (line: number) => (line - 1) * 6
    const instance = drawer.openNote('notes/a.md', text, { from: at(1000), to: at(1010) })
    await until(() => has(drawer, instance, strong(at(1000), at(1000) + 5)))
    const froms = () => marksOn(drawer, instance).map(mark => mark.from)
    expect(Math.min(...froms())).toBeGreaterThanOrEqual(at(1000) - MARGIN - 6)
    expect(Math.max(...froms())).toBeLessThanOrEqual(at(1010) + MARGIN)
    expect(has(drawer, instance, strong(0, 5))).toBe(false)
    drawer.viewport(instance, 0, 30)
    await until(() => has(drawer, instance, strong(0, 5)))
    expect(has(drawer, instance, strong(at(1000), at(1000) + 5))).toBe(false)
  })

  it("keeps its copy in step with each change the human makes and marks what's typed", async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => has(drawer, instance, strong(0, 5)))
    drawer.type(instance, { from: 5, insert: '\n\n**b**' })
    await until(() => has(drawer, instance, strong(7, 12)))
    drawer.type(instance, { from: 0, insert: '# ' })
    await until(() => has(drawer, instance, strong(9, 14)))
    expect(marksOn(drawer, instance)).toContainEqual(expect.objectContaining({ kind: 'line', from: 0, style: 'h1' }))
  })

  it('reads the note again when a change never reached it, where applying the next would leave its copy wrong', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', 'xxaxx')
    await until(() => drawer.marks.has(`${instance} marks`))
    // The same length, so the next change fits the old copy
    drawer.type(instance, [{ from: 0, to: 2, insert: '**' }, { from: 3, to: 5, insert: '**' }], false)
    drawer.type(instance, { from: 5, insert: ' ' })
    await until(() => has(drawer, instance, strong(0, 5)))
  })

  it('keeps the name of an element\'s group while the human types inside it and adds an element above it', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**a**\n\n**b**')
    await until(() => has(drawer, instance, strong(7, 12)))
    const named = groupAt(drawer, instance, 7)
    expect(named).not.toBeNull()
    drawer.type(instance, { from: 10, insert: 'c' })
    await until(() => has(drawer, instance, strong(7, 13)))
    expect(groupAt(drawer, instance, 7)).toBe(named)
    drawer.type(instance, { from: 0, insert: '*new*\n\n' })
    await until(() => has(drawer, instance, strong(14, 20)))
    expect(groupAt(drawer, instance, 14)).toBe(named)
    const groups = marksOn(drawer, instance).flatMap(mark => (mark.kind === 'hide' ? [mark.group] : []))
    expect(new Set(groups).size).toBe(3)
    expect(groupAt(drawer, instance, 0)).not.toBe(named)
  })

  it('sends no more marks than the cap for a note drawn whole, each element whole', async () => {
    const drawer = await started()
    const text = Array.from({ length: 3000 }, () => '**b**').join('\n')
    const instance = drawer.openNote('notes/a.md', text)
    // A pass may come before the parse reaches the end, the next with the rest
    await until(() => marksOn(drawer, instance).length > MAX_MARKS - 3, 5000)
    await tick(20)
    const marks = marksOn(drawer, instance)
    expect(marks.length).toBeLessThanOrEqual(MAX_MARKS)
    expect(marks.filter(mark => mark.kind === 'hide').length).toBe(2 * marks.filter(mark => mark.kind === 'mark').length)
  })
})

describe('hidden marks as notes open, close and the drawer refuses or lags', () => {
  const reads = (drawer: FakeDrawer) => drawer.calls.filter(verb => verb === 'editor.read').length

  it('sends its marks for the version of its copy', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => has(drawer, instance, strong(0, 5)))
    drawer.type(instance, { from: 0, insert: 'x ' })
    drawer.type(instance, { from: 0, insert: 'y ' })
    await until(() => has(drawer, instance, strong(4, 9)))
    expect(drawer.versions.get(`${instance} marks`)).toBe(2)
  })

  it('reads the note again when the drawer refuses its marks as stale', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => has(drawer, instance, strong(0, 5)))
    drawer.refuseNext('editor.decorate', 'stale')
    drawer.type(instance, { from: 0, insert: 'x ' })
    await until(() => reads(drawer) === 2 && has(drawer, instance, strong(2, 7)))
  })

  it('forgets a note once closed and marks the note opened after it', async () => {
    const drawer = await started()
    const first = drawer.openNote('notes/a.md', '**a**')
    await until(() => has(drawer, first, strong(0, 5)))
    drawer.closeNote(first)
    await until(() => heldNotes() === 0)
    const second = drawer.openNote('notes/a.md', '**b**')
    await until(() => has(drawer, second, strong(0, 5)))
    expect(heldNotes()).toBe(1)
  })

  it('forgets a note closed before its first marks landed, which the drawer never tells closed', async () => {
    const drawer = await started()
    const release = drawer.delay('editor.read')
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => reads(drawer) === 1)
    drawer.closeNote(instance)
    release()
    await until(() => drawer.calls.includes('editor.decorate'))
    await until(() => heldNotes() === 0)
  })

  it('keeps marks apart on two notes open, a change in one leaving the other', async () => {
    const drawer = await started()
    const a = drawer.openNote('notes/a.md', '**a**')
    const b = drawer.openNote('notes/b.md', '*b*')
    await until(() => has(drawer, a, strong(0, 5)) && has(drawer, b, { kind: 'mark', from: 0, to: 3, style: 'em' }))
    drawer.type(a, { from: 0, insert: 'x ' })
    await until(() => has(drawer, a, strong(2, 7)))
    expect(drawer.versions.get(`${b} marks`)).toBe(0)
    expect(marksOn(drawer, b)).toContainEqual({ kind: 'mark', from: 0, to: 3, style: 'em' })
  })

  it('reads again for a change missed while its read was out and marks the text as it is', async () => {
    const drawer = await started()
    const release = drawer.delay('editor.read')
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => reads(drawer) === 1)
    drawer.type(instance, { from: 5, insert: ' **b**' })
    drawer.type(instance, { from: 0, insert: '# ' }, false)
    drawer.type(instance, { from: 13, insert: '!' })
    release()
    await until(() => has(drawer, instance, strong(8, 13)))
    expect(marksOn(drawer, instance)).toContainEqual(expect.objectContaining({ kind: 'line', from: 0, style: 'h1' }))
  })

  it('holds no more changes than its bound while a read is out and reads again for those past it', async () => {
    const drawer = await started()
    const release = drawer.delay('editor.read')
    const instance = drawer.openNote('notes/a.md', '**a**')
    await until(() => reads(drawer) === 1)
    for (let n = 0; n <= MAX_HEARD; n++) drawer.type(instance, { from: 0, insert: 'x' })
    await tick(20)
    release()
    await until(() => reads(drawer) === 2 && has(drawer, instance, strong(MAX_HEARD + 1, MAX_HEARD + 6)))
  })

  it("keeps the range the editor draws through a failed read, so the next change marks there and not the note's start", async () => {
    const drawer = await started()
    const text = Array.from({ length: 2000 }, () => '**b**').join('\n')
    const middle = 1000 * 6
    drawer.refuseNext('editor.read', 'unavailable')
    const instance = drawer.openNote('notes/a.md', text, { from: middle, to: middle + 30 })
    await until(() => reads(drawer) === 1)
    await tick(20)
    drawer.type(instance, { from: text.length, insert: '!' })
    await until(() => has(drawer, instance, strong(middle, middle + 5)))
    expect(has(drawer, instance, strong(0, 5))).toBe(false)
  })

  it("names an element's group as before once the note is read again after a missed change", async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**a**\n\n**b**')
    await until(() => has(drawer, instance, strong(7, 12)))
    const named = { a: groupAt(drawer, instance, 0), b: groupAt(drawer, instance, 7) }
    drawer.type(instance, { from: 0, insert: '123' }, false)
    drawer.type(instance, { from: 15, insert: '!' })
    await until(() => has(drawer, instance, strong(10, 15)))
    expect({ a: groupAt(drawer, instance, 3), b: groupAt(drawer, instance, 10) }).toEqual(named)
  })
})

describe('the format keys behind the bridge', () => {
  it('binds each format key and toggles its format at the selection the key came with', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', 'a word')
    await until(() => drawer.versions.has(`${instance} marks`))
    expect(['bold', 'italic', 'strike', 'code', 'highlight'].every(format => drawer.command(format, 'n0'))).toBe(true)
    drawer.command('bold', instance, [{ anchor: 2, head: 6 }])
    await until(() => drawer.text(instance) === 'a **word**')
  })

  it('turns a run off with the cursor inside it, once its own edit came back as a change', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', 'a word')
    await until(() => drawer.versions.has(`${instance} marks`))
    drawer.command('bold', instance, [{ anchor: 2, head: 6 }])
    await until(() => has(drawer, instance, strong(2, 10)))
    drawer.command('bold', instance, [{ anchor: 6, head: 6 }])
    await until(() => drawer.text(instance) === 'a word')
  })
})

describe('a run the human empties', () => {
  const settled = (drawer: FakeDrawer, instance: string, version: number) => drawer.versions.get(`${instance} marks`) === version

  it('loses its markers once the last character between them goes, a run inside another with it', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', 'a **b** c ***d*** e')
    await until(() => has(drawer, instance, strong(2, 7)))
    drawer.type(instance, { from: 4, to: 5 })
    await until(() => drawer.text(instance) === 'a  c ***d*** e')
    drawer.type(instance, { from: 8, to: 9 })
    await until(() => drawer.text(instance) === 'a  c  e')
  })

  it('keeps its markers when the human typed between them before the edit came, the edit refused stale', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', 'a **b** c')
    await until(() => has(drawer, instance, strong(2, 7)))
    drawer.type(instance, { from: 4, to: 5 })
    drawer.type(instance, { from: 4, insert: 'x' })
    await until(() => drawer.calls.includes('editor.edit') && settled(drawer, instance, 2))
    await tick(20)
    expect(drawer.text(instance)).toBe('a **x** c')
  })

  it('keeps markers the human typed with nothing between them', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', 'a ')
    await until(() => drawer.versions.has(`${instance} marks`))
    drawer.type(instance, { from: 2, insert: '****' })
    await until(() => settled(drawer, instance, 1))
    await tick(20)
    expect(drawer.calls).not.toContain('editor.edit')
  })
})

describe('the settings for which elements hide', () => {
  const settingsView = (drawer: FakeDrawer) => drawer.instances().find(one => one.view === 'settings')?.instance ?? ''
  type Node = { kind: string, id: string, checked?: boolean, children?: Node[] }
  const root = (drawer: FakeDrawer) => (drawer.tree(settingsView(drawer)) as Node | null)?.children ?? []
  // The boxes in the popover the item's button opens, none while it is shut
  const boxes = (drawer: FakeDrawer) => (root(drawer).find(child => child.kind === 'popover')?.children ?? [])
    .filter(child => child.kind === 'checkbox').map(child => [child.id, child.checked])
  const press = (drawer: FakeDrawer) => drawer.emit({ topic: 'view.event', instance: settingsView(drawer), node: 'marks', type: 'click' })
  const hiddenAt = (drawer: FakeDrawer, instance: string, from: number) => marksOn(drawer, instance).some(mark => mark.kind === 'hide' && mark.from === from)

  it('is a small item with a button, so it takes no place a view would in the layout', async () => {
    expect(JSON.parse(await readFile(manifest, 'utf8')).views).toEqual({ settings: { title: 'Hidden marks', kind: 'item' } })
    const drawer = await started()
    await until(() => root(drawer).length > 0)
    expect(root(drawer).map(child => child.kind)).toEqual(['button'])
  })

  it('opens a popover from its button with a box for each element answer 7 names, each ticked as hidden at first, and shuts it again', async () => {
    const drawer = await started()
    await until(() => root(drawer).length > 0)
    press(drawer)
    await until(() => boxes(drawer).length > 0)
    expect(boxes(drawer)).toEqual(elementKinds.map(kind => [`hide-${kind}`, true]))
    press(drawer)
    await until(() => boxes(drawer).length === 0)
    expect(elementKinds).toEqual(['bold', 'italic', 'strike', 'code', 'highlight', 'heading', 'bullet', 'quote', 'rule', 'link', 'fence'])
  })

  it("shows an element's markdown once the human unticks it, keeps the choice in its storage and holds it in the next run", async () => {
    const drawer = new FakeDrawer()
    const core = fakeCore({ manifest, drawer })
    cores.push(core)
    expect(await core.start(hiddenMarks)).toEqual({ state: 'ready' })
    const instance = drawer.openNote('notes/a.md', '**a** *b*')
    await until(() => hiddenAt(drawer, instance, 0) && hiddenAt(drawer, instance, 6))
    press(drawer)
    await until(() => boxes(drawer).length > 0)
    drawer.emit({ topic: 'view.event', instance: settingsView(drawer), node: 'hide-bold', type: 'change', value: false })
    await until(() => !hiddenAt(drawer, instance, 0))
    expect(hiddenAt(drawer, instance, 6)).toBe(true)
    expect(has(drawer, instance, strong(0, 5))).toBe(true)
    expect(boxes(drawer)[0]).toEqual(['hide-bold', false])
    expect(core.stored('storage', 'shown')).toEqual(['bold'])
    await core.stop()
    expect(await core.start(hiddenMarks)).toEqual({ state: 'ready' })
    await until(() => root(drawer).length > 0)
    press(drawer)
    await until(() => boxes(drawer).length > 0)
    expect(boxes(drawer)[0]).toEqual(['hide-bold', false])
    const again = drawer.openNote('notes/b.md', '**a** *b*')
    await until(() => hiddenAt(drawer, again, 6))
    expect(hiddenAt(drawer, again, 0)).toBe(false)
  })
})

describe('the format key at the end of a run', () => {
  it('steps out of the run, so the next text typed there is plain', async () => {
    const drawer = await started()
    const instance = drawer.openNote('notes/a.md', '**important**')
    await until(() => has(drawer, instance, strong(0, 13)))
    drawer.command('bold', instance, [{ anchor: 11, head: 11 }])
    await until(() => drawer.selection(instance)?.head === 13)
    const at = drawer.selection(instance)?.head ?? 0
    drawer.type(instance, { from: at, insert: ' next' })
    expect(drawer.text(instance)).toBe('**important** next')
  })
})
