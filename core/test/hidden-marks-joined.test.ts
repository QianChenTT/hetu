import path from 'node:path'
import { ChangeSet, EditorState, type TransactionSpec } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import type { Mark } from '../api/editor.ts'
import { pluginMarks, revealClick, setMarks } from '../frontend/editor/editor.ts'
import { hiddenRules, move, placeCaret, remove, settle, typedAt } from '../frontend/editor/hidden-rules.ts'
import type { Editor } from '../sdk/editor.ts'
import { type FakeCore, fakeCore, FakeDrawer } from '../sdk/testing/index.ts'
import hiddenMarks from '../../core-plugins/hidden-marks/src/worker.ts'

// The ten answers of 2026-11-09 against the real hidden-marks plugin: its worker runs on the fake core, its marks go
// into the drawer's editor state as the bridge puts them there and the drawer's own rules act on them. The DOM's part
// (a real Alt+mouse click, where Chromium puts typed text, the clipboard, the popover) is the Electron case in
// e2e/drawer.test.ts

const manifest = path.join(import.meta.dirname, '..', '..', 'core-plugins', 'hidden-marks', 'hetu-plugin.json')
const OWNER = 'hidden-marks'
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

type Told = { version: number, changes: unknown }
type Asked = { version: number, changes: unknown, selection?: { anchor: number, head: number } }

// The fake drawer, also keeping each change it told the plugin and each edit the plugin asked for, so the test's editor
// state takes the plugin's edits as hetu's drawer applies them
class Watched extends FakeDrawer {
  readonly told: Told[] = []
  readonly requested: Asked[] = []

  override fresh(): Editor {
    const editor = super.fresh()
    const connect = editor.connect.bind(editor)
    editor.connect = transport => connect({
      post: message => {
        const call = message as { verb?: string, args?: Asked }
        if (call.verb === 'editor.edit' && call.args !== undefined) this.requested.push(call.args)
        transport.post(message)
      },
      listen: next => transport.listen(message => {
        const event = message as { topic?: string } & Told
        if (event.topic === 'editor.changed') this.told.push({ version: event.version, changes: event.changes })
        next(message)
      }),
    })
    return editor
  }
}

const sets = (state: EditorState): DecorationSet[] => [state.field(pluginMarks).drawn.hidden]

// The state once the drawer's settling ran, as it does after every update
function settled(state: EditorState): EditorState {
  const selection = settle(state, sets(state))
  return selection === null ? state : state.update({ selection }).state
}

// One open note: the drawer's editor state for it beside the fake drawer's copy the plugin reads
class Note {
  state: EditorState
  version = 0
  readonly drawer: Watched
  readonly instance: string

  constructor(drawer: Watched, instance: string, text: string) {
    this.drawer = drawer
    this.instance = instance
    this.state = EditorState.create({ doc: text, extensions: [pluginMarks, hiddenRules] })
  }

  get head(): number {
    return this.state.selection.main.head
  }

  get marks(): Mark[] {
    return this.drawer.marks.get(`${this.instance} marks`) ?? []
  }

  // The plugin's edits applied as the drawer applies them, a cursor it placed kept, until the plugin's marks are for the
  // note as it is and nothing more comes
  async answered(): Promise<void> {
    const key = `${this.instance} marks`
    for (let quiet = 0; quiet < 3;) {
      await until(() => {
        this.edits()
        return this.drawer.versions.get(key) === this.version
      })
      await tick(10)
      quiet = this.edits() || this.drawer.versions.get(key) !== this.version ? 0 : quiet + 1
    }
    this.state = settled(this.state.update({ effects: setMarks.of({ owner: OWNER, set: 'marks', marks: this.marks }) }).state)
  }

  // A change the drawer told past this state's version is the plugin's edit
  private edits(): boolean {
    let any = false
    for (const told of this.drawer.told.filter(one => one.version > this.version).sort((a, b) => a.version - b.version)) {
      if (told.version !== this.version + 1) break
      const asked = this.drawer.requested.find(one => one.version === this.version && JSON.stringify(one.changes) === JSON.stringify(told.changes))
      const selection = asked?.selection
      const spec: TransactionSpec = { changes: ChangeSet.fromJSON(told.changes), ...selection === undefined ? {} : { selection, effects: placeCaret.of(selection.head) } }
      this.state = settled(this.state.update(spec).state)
      this.version++
      any = true
    }
    return any
  }

  // A human change: the state updated and settled, the fake drawer told
  private human(spec: TransactionSpec): void {
    const tr = this.state.update(spec)
    this.state = settled(tr.state)
    if (!tr.docChanged) return
    this.drawer.type(this.instance, tr.changes)
    this.version++
  }

  async press(rule: (state: EditorState, given: DecorationSet[]) => TransactionSpec | null): Promise<void> {
    const spec = rule(this.state, sets(this.state))
    if (spec !== null) this.human(spec)
    await this.answered()
  }

  // A click at pos, plain
  click(pos: number): void {
    this.human({ selection: { anchor: pos } })
  }

  select(anchor: number, head: number): void {
    this.human({ selection: { anchor, head } })
  }

  // An Alt+click at pos as the drawer's mousedown handler applies it, or a plain click when it reveals nothing
  altClick(pos: number): void {
    const spec = revealClick(this.state, pos)
    this.human(spec ?? { selection: { anchor: pos } })
  }

  // Text typed one key at a time at the caret, the first at chromium when given, where Chromium puts it, each moved
  // where the drawer moves it. The plugin answers each key
  async type(text: string, chromium?: number): Promise<void> {
    let at = chromium
    for (const char of text) {
      const lands = at ?? this.head
      const pos = typedAt(this.state, sets(this.state), lands, lands) ?? lands
      this.human({ changes: { from: pos, insert: char }, selection: { anchor: pos + 1 }, userEvent: 'input.type' })
      at = undefined
      await this.answered()
    }
  }

  // A format key: the human's press sent with the selection, then the plugin's edit back
  async format(command: string): Promise<void> {
    const { anchor, head } = this.state.selection.main
    expect(this.drawer.command(command, this.instance, [{ anchor, head }])).toBe(true)
    await tick(20)
    await this.answered()
  }

  get text(): string {
    return this.state.doc.toString()
  }

  // The text as the human sees it: hidden ranges left out, a widget as its text
  get visible(): string {
    let out = ''
    let at = 0
    this.state.field(pluginMarks).drawn.hidden.between(0, this.state.doc.length, (from, to, value) => {
      if (from < at) return
      out += this.state.sliceDoc(at, from) + ((value.spec.widget as { text?: string } | undefined)?.text ?? '')
      at = to
    })
    return out + this.state.sliceDoc(at)
  }

  // What a copy takes: the selection as the drawer settled it
  get copied(): string {
    const { from, to } = this.state.selection.main
    return this.state.sliceDoc(from, to)
  }

  styled(style: string): string[] {
    return this.marks.flatMap(mark => (mark.kind === 'mark' && mark.style === style ? [this.state.sliceDoc(mark.from, mark.to)] : []))
  }
}

async function opened(text: string): Promise<Note> {
  const drawer = new Watched()
  const core = fakeCore({ manifest, drawer })
  cores.push(core)
  expect(await core.start(hiddenMarks)).toEqual({ state: 'ready' })
  const note = new Note(drawer, drawer.openNote('notes/a.md', text), text)
  await until(() => drawer.marks.has(`${note.instance} marks`))
  await note.answered()
  return note
}

const right = (state: EditorState, given: DecorationSet[]) => move(state, given, true, false)
const shiftRight = (state: EditorState, given: DecorationSet[]) => move(state, given, true, true)
const backspace = (state: EditorState, given: DecorationSet[]) => remove(state, given, false)

// x **bold** y: the markers at 2-4 and 8-10, the word at 4-8
const BOLD = 'x **bold** y'

describe('answer 1: syntax stays hidden with the cursor inside an element', () => {
  it('keeps the markers hidden at every place the cursor can be put in the element and at its edges', async () => {
    const note = await opened(BOLD)
    expect(note.visible).toBe('x bold y')
    for (let pos = 2; pos <= 10; pos++) {
      note.click(pos)
      expect(note.visible).toBe('x bold y')
    }
    note.click(6)
    await note.type('e')
    expect(note.text).toBe('x **boeld** y')
    expect(note.visible).toBe('x boeld y')
  })
})

describe('answer 2: Alt+click shows the element under the pointer', () => {
  it.each([
    ['bold', BOLD, 6, 'x **bold** y'],
    ['italic', 'x *it* y', 4, 'x *it* y'],
    ['strikethrough', 'x ~~st~~ y', 5, 'x ~~st~~ y'],
    ['inline code', 'x `co` y', 4, 'x `co` y'],
    ['highlight', 'x ==hi== y', 5, 'x ==hi== y'],
    ['a heading, from its text', '## Title', 5, '## Title'],
    ['a quote, from its text', '> said', 4, '> said'],
    ['a link, its target too', 'x [text](https://e.com) y', 5, 'x [text](https://e.com) y'],
  ])('shows %s whole and leaves the cursor where it was clicked', async (_kind, text, pos, shown) => {
    const note = await opened(text)
    expect(note.visible).not.toBe(text)
    note.altClick(pos)
    expect(note.visible).toBe(shown)
    expect(note.head).toBe(pos)
  })

  it('shows only the element clicked, never another beside it', async () => {
    const note = await opened('**a** and **b**')
    note.altClick(3)
    expect(note.visible).toBe('**a** and b')
  })

  it('shows the innermost element when one holds another', async () => {
    const note = await opened('**bold *it* end**')
    note.altClick(9)
    expect(note.visible).toBe('bold *it* end')
  })
})

describe('answer 3: hidden again when the cursor leaves the element', () => {
  it('stays shown while the cursor moves and types inside it, hides once it leaves and stays hidden when it comes back', async () => {
    const note = await opened(BOLD)
    note.altClick(6)
    await note.type('X')
    expect(note.text).toBe('x **boXld** y')
    await note.press(right)
    expect(note.visible).toBe('x **boXld** y')
    note.click(12)
    expect(note.visible).toBe('x boXld y')
    note.click(6)
    expect(note.visible).toBe('x boXld y')
  })

  it('hides it again when an arrow takes the cursor out', async () => {
    const note = await opened(BOLD)
    note.altClick(9)
    for (let i = 0; i < 3; i++) await note.press(right)
    expect(note.head).toBe(12)
    expect(note.visible).toBe('x bold y')
  })
})

describe("answer 4: typing at a run's end continues it, the format key gets out, the arrows only move", () => {
  it('keeps text typed at the end of a run in the run', async () => {
    const note = await opened(BOLD)
    note.click(10)
    expect(note.head).toBe(8)
    await note.type('er')
    expect(note.text).toBe('x **bolder** y')
    expect(note.styled('strong')).toEqual(['**bolder**'])
  })

  it("steps out with the run's own key, so text typed next is plain even where Chromium puts it before the closer", async () => {
    const note = await opened(BOLD)
    note.click(10)
    await note.format('bold')
    expect(note.text).toBe(BOLD)
    expect(note.head).toBe(10)
    expect(note.visible).toBe('x bold y')
    // Chromium puts the first key before the hidden closer at 8 and the drawer moves it to the placed caret
    await note.type(' next', 8)
    expect(note.text).toBe('x **bold** next y')
    expect(note.styled('strong')).toEqual(['**bold**'])
  })

  it('steps back in with the same key', async () => {
    const note = await opened(BOLD)
    note.click(10)
    await note.format('bold')
    await note.format('bold')
    expect(note.head).toBe(8)
    await note.type('X')
    expect(note.text).toBe('x **boldX** y')
  })

  it("moves the cursor with the right arrow at a run's end and changes nothing", async () => {
    const note = await opened(BOLD)
    note.click(8)
    await note.press(right)
    expect(note.head).toBe(11)
    expect(note.text).toBe(BOLD)
    expect(note.drawer.requested).toEqual([])
  })
})

describe('answer 5: markers hide once the closing marker is typed', () => {
  it('shows an unclosed **word as typed and hides both markers once ** closes it', async () => {
    const note = await opened('x ')
    note.click(2)
    await note.type('**word')
    expect(note.visible).toBe('x **word')
    expect(note.marks.filter(mark => mark.kind === 'hide')).toEqual([])
    await note.type(' more')
    expect(note.visible).toBe('x **word more')
    note.click(note.text.length)
    await note.type('**')
    expect(note.text).toBe('x **word more**')
    expect(note.visible).toBe('x word more')
    expect(note.styled('strong')).toEqual(['**word more**'])
  })

  // D-648: one key short of the bold closer CommonMark reads *word* as italic, kept as built
  it('shows x *word in italics one key short of the closer and bold with every marker hidden after it', async () => {
    const note = await opened('x ')
    note.click(2)
    await note.type('**word*')
    expect(note.text).toBe('x **word*')
    expect(note.visible).toBe('x *word')
    expect(note.styled('em')).toEqual(['*word*'])
    expect(note.styled('strong')).toEqual([])
    expect(note.marks.flatMap(mark => (mark.kind === 'hide' ? [[mark.from, mark.to]] : []))).toEqual([[3, 4], [8, 9]])
    await note.type('*')
    expect(note.text).toBe('x **word**')
    expect(note.visible).toBe('x word')
    expect(note.styled('strong')).toEqual(['**word**'])
    expect(note.styled('em')).toEqual([])
    expect(note.marks.flatMap(mark => (mark.kind === 'hide' ? [[mark.from, mark.to]] : []))).toEqual([[2, 4], [8, 10]])
  })
})

describe('answer 6: deleting the last visible character of a run removes its markers', () => {
  it("takes a run's empty markers in the plugin's edit after the human's Backspace", async () => {
    const note = await opened('x **a** y')
    note.click(5)
    expect(note.head).toBe(5)
    await note.press(backspace)
    expect(note.text).toBe('x  y')
    expect(note.drawer.text(note.instance)).toBe('x  y')
    expect(note.visible).toBe('x  y')
    expect(note.marks).toEqual([])
  })

  it('leaves a run the human typed empty, which was empty before the change', async () => {
    const note = await opened('x ')
    note.click(2)
    await note.type('****')
    expect(note.text).toBe('x ****')
  })
})

describe('answer 7: which syntax hides', () => {
  it.each([
    ['bold', 'a **b** c', 'a b c', 'strong'],
    ['italic', 'a *b* c', 'a b c', 'em'],
    ['highlight', 'a ==b== c', 'a b c', 'highlight'],
    ['a heading', '# Head', 'Head', null],
    ['a bullet, drawn as a dot', '- item', '• item', null],
    ['a quote', '> said', 'said', null],
    ['a horizontal rule', 'a\n\n---\n\nb', 'a\n\n\n\nb', null],
    ["a link's target, its text kept", 'a [text](https://e.com) b', 'a text b', 'link'],
  ])('hides %s', async (_kind, text, visible, style) => {
    const note = await opened(text)
    expect(note.visible).toBe(visible)
    if (style !== null) expect(note.styled(style)).toHaveLength(1)
  })

  it('hides strikethrough, the text struck', async () => {
    const note = await opened('a ~~gone~~ b')
    expect(note.visible).toBe('a gone b')
    expect(note.styled('strike')).toEqual(['~~gone~~'])
  })

  it('hides inline code, the code styled as code', async () => {
    const note = await opened('a `x = 1` b')
    expect(note.visible).toBe('a x = 1 b')
    expect(note.styled('code')).toEqual(['`x = 1`'])
  })

  it("hides a code fence's markers and language, its code shown", async () => {
    const note = await opened('```js\nlet a\n```')
    expect(note.visible.split('\n').filter(line => line.length > 0)).toEqual(['let a'])
  })

  it('leaves task boxes and tables as typed, as they come later', async () => {
    const note = await opened('- [ ] task\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(note.visible).toBe('• [ ] task\n\n| a | b |\n| - | - |\n| 1 | 2 |')
  })
})

describe('answer 8: copying gives the markdown', () => {
  it('copies an element held whole with its markers, however its visible text was selected', async () => {
    const note = await opened(BOLD)
    note.select(4, 8)
    expect(note.copied).toBe('**bold**')
    note.select(0, 12)
    expect(note.copied).toBe(BOLD)
    note.click(4)
    for (let i = 0; i < 4; i++) await note.press(shiftRight)
    expect(note.copied).toBe('**bold**')
  })

  // Y16, D-647
  it('copies part of an element as what was selected, the visible text without markers', async () => {
    const note = await opened('x **bold text** y')
    note.select(4, 8)
    expect(note.copied).toBe('bold')
    note.select(9, 13)
    expect(note.copied).toBe('text')
  })
})

describe('answer 9: the settings choose which elements hide', () => {
  it("shows bold's markers while Bold is unticked, every other element still hidden, and hides them once ticked", async () => {
    const note = await opened('x **bold** y\nx [link](https://e.com) y')
    const settings = note.drawer.instances().find(one => one.view === 'settings')!.instance
    // The box's change as the popover sends it, then the plugin's marks drawn again until the note looks as expected
    const choose = async (hides: boolean, looks: string) => {
      note.drawer.emit({ topic: 'view.event', instance: settings, node: 'hide-bold', type: 'change', value: hides })
      await until(() => {
        note.state = settled(note.state.update({ effects: setMarks.of({ owner: OWNER, set: 'marks', marks: note.marks }) }).state)
        return note.visible === looks
      })
    }
    await choose(false, 'x **bold** y\nx link y')
    expect(note.styled('strong')).toEqual(['**bold**'])
    await choose(true, 'x bold y\nx link y')
  })
})
