// A note's life on the driven build with the shipped plugins and the seed's notes: every click and key through main's
// input route and agree after every step. A pin holds a known defect as it behaves today, one row to an it, named in
// its message, so it goes red once that defect is fixed and is then turned into the check the fix makes true
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { start, until, type Instance } from '../instance.ts'
import { disagreements, readState, type State } from '../state.ts'
import { current, explorer, heardKey, markInput, note, noteTabs, openFromFiles, shownNote, step, typeInNote } from './steps.ts'

const WELCOME = 'Welcome.md'
const CAFE = 'Inbox/Café notes — résumé.md'
const LAUNCH = 'Inbox/🚀 Launch ideas.md'

// D-746 (AJ20 parked): after an open licensed by a press in a frame, focus stays in that frame, the note in front
// without it, so typing never follows into the note
async function focusStaysInFiles(editor: Page, state: State) {
  const files = (await explorer(editor)).url()
  expect(state.focus.main.find(window => window.url === 'hetu://editor/')?.focusedFrame, 'D-746').toBe(files)
  expect(state.editors.filter(each => each.focused), 'D-746').toEqual([])
}

// Keys through main into the page with focus, landed once the current note grew by them
async function keysLand(instance: Instance, editor: Page, text: string): Promise<State> {
  const before = current(await readState(instance))!.text!
  await instance.keys(editor, text)
  return step(instance, state => current(state)?.text === undefined ? false : current(state)!.text!.length === before.length + text.length)
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

  it('creates a new note from Files and types next', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(1))
    const first = await readFile(path.join(instance.notes, note(1)), 'utf8')
    const files = await explorer(editor)
    const box = files.getByRole('textbox', { name: 'Note path' })
    await instance.click(files.getByRole('button', { name: 'New note', exact: true }))
    await until(() => box.isVisible(), 'the new note box')
    expect(await box.inputValue()).toBe('Inbox/')
    expect(await instance.frameKeys([...'T3 note', 'Enter'])).toEqual([])
    const made = await step(instance, state => state.disk.files.includes('Inbox/T3 note.md'))
    // Main let every key go to the frame with focus, which is where they end
    expect(await instance.frameKeys('XYZ')).toEqual([])
    const after = await step(instance, () => true)
    expect(await readFile(path.join(instance.notes, 'Inbox/T3 note.md'), 'utf8')).toBe('')
    expect(await readFile(path.join(instance.notes, note(1)), 'utf8')).toBe(first)
    expect(after.editors.filter(each => each.text?.includes('XYZ'))).toEqual([])
    // PINNED (T-3): the new note is written but not opened, the note before it staying current and focus in Files
    expect(noteTabs(after).map(tab => tab.text), 'T-3').toEqual(noteTabs(made).map(tab => tab.text))
    await focusStaysInFiles(editor, after)
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
    await keysLand(instance, editor, 'B')
    await instance.quit()
  })

  it('closes Real text with Escape and gives focus back to the note', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    const raw = editor.getByRole('combobox', { name: 'Written last' })
    await openFromFiles(instance, editor, LAUNCH)
    await typeInNote(instance, editor, 'R')
    await instance.press(editor, 'Mod+/')
    await until(() => raw.isVisible(), 'Real text')
    await step(instance, () => true)
    await instance.press(editor, 'Escape')
    const closed = await step(instance, state => current(state)?.focused === true)
    expect(await raw.isVisible()).toBe(false)
    expect(closed.editors.filter(each => each.focused).map(each => each.instance)).toEqual([current(closed)?.instance])
    await keysLand(instance, editor, 'S')
    await instance.quit()
  })

  // The menu covers the bar's Real text button, so its key opens it
  it('opens Real text over the open Views menu (T-52)', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    const raw = editor.getByRole('combobox', { name: 'Written last' })
    await openFromFiles(instance, editor, LAUNCH)
    await instance.click(editor.getByRole('button', { name: 'Views', exact: true }))
    await step(instance, state => state.menu !== null)
    await instance.press(editor, 'Mod+/')
    await until(() => raw.isVisible(), 'Real text')
    // PINNED (T-52): both stay open, Escape closing Real text first, then the menu
    expect((await step(instance, () => true)).menu, 'T-52').not.toBeNull()
    await instance.press(editor, 'Escape')
    await until(async () => !(await raw.isVisible()), 'Real text closed')
    await instance.press(editor, 'Escape')
    await step(instance, state => state.menu === null)
    await instance.quit()
  })

  it('keeps the Marks popover open after Escape and a click outside (T-53)', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, LAUNCH)
    const marks = editor.getByRole('button', { name: 'Marks', exact: true })
    const choice = editor.getByRole('checkbox', { name: 'Code fences' })
    await instance.click(marks)
    await until(() => choice.isVisible(), 'the Marks popover')
    await step(instance, () => true)
    const since = await markInput(instance)
    await instance.press(editor, 'Escape')
    await heardKey(instance, since, 'Escape')
    await step(instance, () => true)
    // PINNED (T-53): neither Escape nor a click outside closes the popover, only Marks again does
    expect(await choice.isVisible(), 'T-53 after Escape').toBe(true)
    // The click checks main heard its press and release and the note got both
    await instance.click(shownNote(editor))
    await step(instance, () => true)
    expect(await choice.isVisible(), 'T-53 after a click outside').toBe(true)
    await instance.click(marks)
    await until(async () => !(await choice.isVisible()), 'the Marks popover closed')
    await step(instance, () => true)
    await instance.quit()
  })

  it('leaves focus in no note after a click on another note\'s tab (T-16)', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(8))
    await typeInNote(instance, editor, 'K')
    const both = await openFromFiles(instance, editor, note(9))
    const [first, second] = [note(8), note(9)].map(path => noteTabs(both).find(tab => tab.text.startsWith(path))!.instance)
    await instance.click(editor.locator(`[data-hetu-tab="${first}"]`))
    await until(async () => (await readState(instance)).editors.find(each => each.shown)?.instance === first, `${note(8)} shown`)
    // T-11's two pairs exactly, which the state tests pin. This journey can't tell T-11 fixed from broken, it only keeps
    // them from hiding any other disagreement
    const t11 = [
      { places: ['note title', `shown note ${first}'s tab`], values: [note(9), `${note(8)} (unsaved)`] },
      { places: ['current note', 'shown note'], values: [second, first] },
    ]
    const others = (state: State) => disagreements(state).filter(found => !t11.some(pair => JSON.stringify(pair) === JSON.stringify(found)))
    const texts = (state: State) => state.editors.map(each => each.text)
    const clicked = await readState(instance)
    const since = await markInput(instance)
    await instance.keys(editor, 'Q')
    await heardKey(instance, since, 'Q')
    // Held for a second, every read agreeing past T-11
    for (const ends = Date.now() + 1000; Date.now() < ends;) {
      const state = await readState(instance)
      expect(others(state)).toEqual([])
      // PINNED (T-16): focus is in no note and the key typed next lands nowhere
      expect(state.editors.filter(each => each.focused), 'T-16').toEqual([])
      expect(texts(state), 'T-16').toEqual(texts(clicked))
      expect(state.disk.texts, 'T-16').toEqual(clicked.disk.texts)
    }
    await instance.quit()
  })
})
