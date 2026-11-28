// A note's life on the driven build with the shipped plugins and the seed's notes: every click and key through main's
// input route and agree after every step. A pin holds a known defect as it behaves today, named by its row, so the pin
// goes red once the defect is fixed and is then turned into the check the fix makes true
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { start, until, type Instance } from '../instance.ts'
import { disagreements, readState, type State } from '../state.ts'
import { current, currentTab, drafts, explorer, noteTabs, openFromFiles, renameInFiles, shownNote, step, typeInNote } from './steps.ts'

const WELCOME = 'Welcome.md'
const CAFE = 'Inbox/Café notes — résumé.md'
const LAUNCH = 'Inbox/🚀 Launch ideas.md'
const note = (n: number) => `Inbox/Inbox note ${String(n).padStart(2, '0')}.md`
const GONE = 'moved or deleted'

// Focus after a note opens from Files stays in the Files frame the press was in, the note in front without it
async function focusStaysInFiles(editor: Page, state: State) {
  const files = (await explorer(editor)).url()
  expect(state.focus.main.find(window => window.url === 'hetu://editor/')?.focusedFrame).toBe(files)
  expect(state.editors.filter(each => each.focused)).toEqual([])
}

describe('a note\'s life on the driven build', () => {
  it('opens three notes, reopens one in its own tab and leaves focus in Files after each open', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await step(instance, state => (state.files?.rows?.length ?? 0) > 0)
    for (const [at, path] of [WELCOME, CAFE, LAUNCH].entries()) {
      const opened = await openFromFiles(instance, editor, path)
      expect(noteTabs(opened).map(tab => tab.text)).toEqual([WELCOME, CAFE, LAUNCH].slice(0, at + 1))
      await focusStaysInFiles(editor, opened)
    }
    const again = await openFromFiles(instance, editor, WELCOME)
    expect(noteTabs(again).map(tab => tab.text)).toEqual([WELCOME, CAFE, LAUNCH])
    expect(again.title).toBe(WELCOME)
    await focusStaysInFiles(editor, again)
    await instance.quit()
  })

  it('types into a note and saves it with ⌘S through main', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    const before = (await openFromFiles(instance, editor, note(2))).disk.texts[note(2)]
    const typed = await typeInNote(instance, editor, 'SAVED1 ')
    expect(typed.title).toBe(`${note(2)} (unsaved)`)
    expect(typed.disk.texts[note(2)]).toBe(before)
    await instance.press(editor, 'Mod+S')
    const saved = await step(instance, state => state.disk.texts[note(2)]?.includes('SAVED1 ') === true)
    expect(saved.title).toBe(note(2))
    expect(saved.disk.texts[note(2)]).toBe(current(saved)?.text)
    await instance.quit()
  })

  // Today the tab stays on the path the note left with the note bar saying so (AI1). With #294 the tab follows the note
  // and its draft goes with it (T-2). agree and the draft hold for both, the tab's path is pinned to today's
  it('renames an open note with unsaved text and a saved one, keeping the text and never writing the old paths', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(5))
    await typeInNote(instance, editor, 'DRAFT2 ')
    const moved = 'Inbox/Inbox note 05 moved'
    const renamed = await renameInFiles(instance, editor, moved)
    expect(renamed.files?.rows?.map(row => row.path)).toContain(`${moved}.md`)
    expect(renamed.disk.files).not.toContain(note(5))
    expect(current(renamed)?.text).toContain('DRAFT2 ')
    await until(async () => (await drafts(instance)).some(kept => kept.text.includes('DRAFT2 ')), 'a draft holding the unsaved text')
    // A save on the renamed tab never brings the old path back
    await instance.click(shownNote(editor))
    await instance.press(editor, 'Mod+S')
    expect((await step(instance, () => true)).disk.files).not.toContain(note(5))

    // A saved note renamed: a tab left saying saved on a path with no file and nothing said is what agree catches
    await openFromFiles(instance, editor, note(6))
    const second = await renameInFiles(instance, editor, 'Inbox/Inbox note 06 moved')
    expect(second.disk.files).not.toContain(note(6))
    expect(noteTabs(second)).toHaveLength(2)

    // PINNED (#294): the tab stays on the path the note left, the note bar says so and the draft names the old path
    expect(currentTab(second)).toBe(note(6))
    expect(second.noteBar).toContain(GONE)
    expect(noteTabs(second).map(tab => tab.text)).toContain(`${note(5)} (unsaved)`)
    expect((await drafts(instance)).filter(kept => kept.text.includes('DRAFT2 ')).map(kept => kept.path)).toEqual([note(5), note(5)])
    await instance.quit()
  })

  it('deletes an open note from Files', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(7))
    const files = await explorer(editor)
    await instance.click(files.getByRole('button', { name: 'Delete', exact: true }))
    await instance.click(files.getByRole('alertdialog', { name: 'Delete' }).getByRole('button', { name: 'Move to recycle bin' }))
    const deleted = await step(instance, state => !state.disk.files.includes(note(7)))
    expect(deleted.files?.rows?.map(row => row.path)).not.toContain(note(7))
    // PINNED (T-7): the tab stays open on the deleted path, the note bar saying so
    expect(currentTab(deleted)).toBe(note(7))
    expect(deleted.noteBar).toContain(GONE)
    await instance.quit()
  })

  // T-3 as it behaves today: the new note is written empty and not opened, and the keys typed next go to Files, where
  // focus stayed, never into a note
  it('creates a new note from Files and types next', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(1))
    const files = await explorer(editor)
    await instance.click(files.getByRole('button', { name: 'New note', exact: true }))
    await until(() => files.getByRole('textbox', { name: 'Note path' }).isVisible(), 'the new note box')
    expect(await files.getByRole('textbox', { name: 'Note path' }).inputValue()).toBe('Inbox/')
    expect(await instance.frameKeys([...'T3 note', 'Enter'])).toEqual([])
    const made = await step(instance, state => state.disk.files.includes('Inbox/T3 note.md'))
    expect(await instance.frameKeys('XYZ')).toEqual([])
    const after = await step(instance, () => true)
    // PINNED (T-3): the new note isn't opened
    expect(noteTabs(after).map(tab => tab.text)).toEqual(noteTabs(made).map(tab => tab.text))
    expect(currentTab(after)).toBe(note(1))
    await focusStaysInFiles(editor, after)
    expect(after.editors.filter(each => each.text?.includes('XYZ'))).toEqual([])
    expect(Object.values(after.disk.texts).filter(text => text?.includes('XYZ'))).toEqual([])
    await instance.quit()
  })

  it('closes the Views menu with Escape and gives focus back to the note', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(3))
    await typeInNote(instance, editor, 'A')
    await instance.click(editor.getByRole('button', { name: 'Views', exact: true }))
    await step(instance, state => state.menu !== null)
    await instance.press(editor, 'Escape')
    const closed = await step(instance, state => state.menu === null)
    expect(current(closed)?.focused).toBe(true)
    await instance.keys(editor, 'B')
    await step(instance, state => current(state)?.text?.includes('AB') === true)
    await instance.quit()
  })

  it('opens and closes Real text and the Marks popover', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    const raw = editor.getByRole('combobox', { name: 'Written last' })
    await openFromFiles(instance, editor, LAUNCH)
    await typeInNote(instance, editor, 'R')
    await instance.press(editor, 'Mod+/')
    await until(() => raw.isVisible(), 'Real text')
    await step(instance, () => true)
    // Escape closes it and focus goes back to the note, where the next key lands
    await instance.press(editor, 'Escape')
    const closed = await step(instance, state => current(state)?.focused === true)
    expect(await raw.isVisible()).toBe(false)
    expect(closed.editors.filter(each => each.focused).map(each => each.instance)).toEqual([current(closed)?.instance])
    await instance.keys(editor, 'S')
    await step(instance, state => current(state)?.text?.includes('RS') === true)

    // PINNED (T-52): Real text opens over the open Views menu, both shown. Escape closes Real text first, then the menu.
    // The menu covers the bar's Real text button, so its key opens it
    await instance.click(editor.getByRole('button', { name: 'Views', exact: true }))
    await step(instance, state => state.menu !== null)
    await instance.press(editor, 'Mod+/')
    await until(() => raw.isVisible(), 'Real text')
    expect((await step(instance, () => true)).menu).not.toBeNull()
    await instance.press(editor, 'Escape')
    await until(async () => !(await raw.isVisible()), 'Real text closed')
    await instance.press(editor, 'Escape')
    await step(instance, state => state.menu === null)

    const marks = editor.getByRole('button', { name: 'Marks', exact: true })
    const choice = editor.getByRole('checkbox', { name: 'Code fences' })
    await instance.click(marks)
    await until(() => choice.isVisible(), 'the Marks popover')
    await step(instance, () => true)
    // PINNED (T-53): neither Escape nor a click outside closes the popover, only Marks again does
    await instance.press(editor, 'Escape')
    await step(instance, () => true)
    expect(await choice.isVisible()).toBe(true)
    await instance.click(shownNote(editor))
    await step(instance, () => true)
    expect(await choice.isVisible()).toBe(true)
    await instance.click(marks)
    await until(async () => !(await choice.isVisible()), 'the Marks popover closed')
    await step(instance, () => true)
    await instance.quit()
  })

  // T-11 is the title and current note left on the note before a tab click, which the state tests pin. Every other
  // place agrees
  it('leaves focus on the page\'s body after a click on another note\'s tab (T-16)', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(8))
    await typeInNote(instance, editor, 'K')
    const both = await openFromFiles(instance, editor, note(9))
    const first = noteTabs(both).find(tab => tab.text.startsWith(note(8)))!.instance
    await instance.click(editor.locator(`[data-hetu-tab="${first}"]`))
    await until(async () => (await readState(instance)).editors.find(each => each.shown)?.instance === first, `${note(8)} shown`)
    const clicked = await readState(instance)
    const t11 = (places: readonly string[]) => places[0] === 'note title' || places[0] === 'current note'
    expect(disagreements(clicked).filter(found => !t11(found.places))).toEqual([])
    // PINNED (T-16): focus is on the page's body, in no note, and the key typed next lands in no note
    expect(clicked.editors.filter(each => each.focused)).toEqual([])
    expect(clicked.focus.pages.find(page => page.url === 'hetu://editor/')?.frames[0]?.active).toBe('body')
    await instance.keys(editor, 'Q')
    const typed = await readState(instance)
    expect(typed.editors.filter(each => each.text?.includes('Q'))).toEqual([])
    await instance.quit()
  })

  it('offers the unsaved text of a note as a draft after ⌘Q and restores it', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(4))
    const typed = await typeInNote(instance, editor, 'KEPT1 ')
    const text = current(typed)!.text!
    const child = instance.app.process()
    await instance.press(editor, 'Mod+Q').catch(() => {
      // Main may go down before the call's answer comes
    })
    await until(() => child.exitCode !== null || child.signalCode !== null, 'hetu to quit')
    await instance.quit()
    expect((await drafts(instance)).map(kept => kept.path)).toContain(note(4))

    const again = await start(context, { after: instance })
    const reopened = await again.editor()
    const offered = await openFromFiles(again, reopened, note(4))
    expect(offered.noteBar).toContain('A draft of this note')
    expect(offered.title).toBe(note(4))
    await again.click(reopened.getByRole('button', { name: 'Restore', exact: true }))
    const restored = await step(again, state => current(state)?.text?.includes('KEPT1 ') === true)
    expect(current(restored)?.text).toBe(text)
    expect(restored.title).toBe(`${note(4)} (unsaved)`)
    await again.quit()
  })
})
