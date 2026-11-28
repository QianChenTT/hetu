// Open notes that leave their path, renamed or deleted from Files, and a draft across a quit, on the driven build with
// the shipped plugins and the seed's notes. Every click and key through main's input route, agree after every step and
// one pinned row to an it, named in its message
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { start, until } from '../instance.ts'
import { binned, current, currentTab, drafts, explorer, note, noteTabs, openFromFiles, quitWithKeys, renameInFiles, shownNote, step, typeInNote } from './steps.ts'

// What the note bar says on a tab whose note left its path, one per row that pins it
const BAR_294 = 'This note was moved or deleted, so this tab can\'t save it'
const BAR_T7 = 'This note was moved or deleted, so this tab can\'t save it'
const MOVED_5 = 'Inbox/Inbox note 05 moved'

describe('an open note leaving its path on the driven build', () => {
  // Today the tab stays on the path the note left (AI1). With #294 the tab follows the note and its draft goes with it.
  // agree, the text and the old path never written again hold for both
  it('renames an open note with unsaved text, keeps the text and never writes the old path again', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(5))
    await typeInNote(instance, editor, 'DRAFT2 ')
    const renamed = await renameInFiles(instance, editor, MOVED_5)
    expect(renamed.files?.rows?.map(row => row.path)).toContain(`${MOVED_5}.md`)
    expect(renamed.disk.files).not.toContain(note(5))
    expect(current(renamed)?.text).toContain('DRAFT2 ')
    await until(async () => (await drafts(instance)).some(kept => kept.text.includes('DRAFT2 ')), 'a draft holding the unsaved text')

    // The save lands as a write to the new path or the draft kept again, and never brings the old path back
    const keptAt = Math.max(...(await drafts(instance)).map(kept => kept.at))
    await instance.click(shownNote(editor))
    await instance.press(editor, 'Mod+S')
    const moved = path.join(instance.notes, `${MOVED_5}.md`)
    await until(async () => (await drafts(instance)).some(kept => kept.at > keptAt)
      || (await readFile(moved, 'utf8')).includes('DRAFT2 '), 'the save to land')
    const saved = await step(instance, () => true)
    expect(saved.disk.files).not.toContain(note(5))

    // PINNED (#294): the tab stays on the old path, every draft of the text naming it
    expect(noteTabs(saved).map(tab => tab.text), '#294').toEqual([`${note(5)} (unsaved)`])
    const holding = (await drafts(instance)).filter(kept => kept.text.includes('DRAFT2 '))
    expect(holding.length, '#294').toBeGreaterThan(0)
    expect(holding.filter(kept => kept.path !== note(5)), '#294').toEqual([])
    await instance.quit()
  })

  // A tab left saying saved on a path with no file and nothing said is what agree catches (X13)
  it('renames a saved open note', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(6))
    const renamed = await renameInFiles(instance, editor, 'Inbox/Inbox note 06 moved')
    expect(renamed.disk.files).not.toContain(note(6))
    expect(noteTabs(renamed)).toHaveLength(1)
    // PINNED (#294): the tab stays on the path the note left and the note bar says so
    expect(currentTab(renamed), '#294').toBe(note(6))
    expect(renamed.noteBar, '#294').toContain(BAR_294)
    await instance.quit()
  })

  it('offers no draft at a renamed note\'s new path after a quit (T-2)', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(5))
    await typeInNote(instance, editor, 'LOST2 ')
    await renameInFiles(instance, editor, MOVED_5)
    expect((await quitWithKeys(instance, editor)).exitCode).toBe(0)

    const again = await start(context, { after: instance })
    const reopened = await again.editor()
    const opened = await openFromFiles(again, reopened, `${MOVED_5}.md`)
    // PINNED (T-2, #294): nothing is offered at the new path and the text is kept only under the old one
    expect(opened.noteBar, 'T-2 and #294: no draft offered at the new path').toBeNull()
    expect(current(opened)?.text, 'T-2 and #294: the text is not in the note').not.toContain('LOST2 ')
    const holding = (await drafts(again)).filter(kept => kept.text.includes('LOST2 '))
    expect(holding.length, 'T-2 and #294: a draft holds the text').toBeGreaterThan(0)
    expect(holding.filter(kept => kept.path !== note(5)), 'T-2 and #294: every draft names the old path').toEqual([])
    await again.quit()
  })

  it('deletes an open note from Files into the bin', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    const bin = await binned(instance)
    await openFromFiles(instance, editor, note(7))
    const files = await explorer(editor)
    await instance.click(files.getByRole('button', { name: 'Delete', exact: true }))
    await instance.click(files.getByRole('alertdialog', { name: 'Delete' }).getByRole('button', { name: 'Move to recycle bin' }))
    const deleted = await step(instance, state => !state.disk.files.includes(note(7)))
    expect(deleted.files?.rows?.map(row => row.path)).not.toContain(note(7))
    expect(await readdir(bin)).toEqual(['Inbox note 07.md'])
    // PINNED (T-7): the tab stays open on the deleted path, the note bar saying so
    expect(currentTab(deleted), 'T-7').toBe(note(7))
    expect(deleted.noteBar, 'T-7').toContain(BAR_T7)
    await instance.quit()
  })

  it('offers the unsaved text of a note as a draft after ⌘Q and restores it', async context => {
    const instance = await start(context, { seeded: true })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, note(4))
    const typed = await typeInNote(instance, editor, 'KEPT1 ')
    const text = current(typed)!.text!
    await until(async () => (await drafts(instance)).some(kept => kept.path === note(4) && kept.text === text), 'the draft to hold the text')
    expect((await quitWithKeys(instance, editor)).exitCode).toBe(0)

    const again = await start(context, { after: instance })
    const reopened = await again.editor()
    await openFromFiles(again, reopened, note(4))
    const offered = await step(again, state => state.noteBar !== null)
    expect(offered.noteBar).toContain('A draft of this note')
    expect(offered.title).toBe(note(4))
    await again.click(reopened.getByRole('button', { name: 'Restore', exact: true }))
    const restored = await step(again, state => current(state)?.text === text)
    expect(restored.title).toBe(`${note(4)} (unsaved)`)
    await again.quit()
  })
})
