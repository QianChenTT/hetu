import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, it } from 'vitest'
import { start, until, type Instance } from './instance.ts'
import { agree, disagreements, diskFiles, readState } from './state.ts'

const notes = { 'a.md': '# a\n\nbody a\n', 'b.md': '# b\n\nbody b\n', 'c.md': '# c\n\nbody c\n' }
const explorer = async (editor: Page) => {
  const element = await editor.waitForSelector('iframe[data-hetu-owner="file-explorer"]', { state: 'attached' })
  return (await element.contentFrame())!
}
async function filesRow(editor: Page, name: string) {
  const row = (await explorer(editor)).getByRole('treeitem', { name, exact: true })
  await until(async () => await row.count() === 1, `the ${name} row`)
  return row
}
const title = (editor: Page) => editor.locator('[data-hetu="note-title"]')
const shownNote = (editor: Page) => editor.locator('[data-hetu-editor]:not([hidden]) [role=textbox]')

async function openFromFiles(instance: Instance, editor: Page, name: string) {
  await instance.click(await filesRow(editor, name))
  await until(async () => (await title(editor).innerText()) === `${name}.md`, `${name}.md in the note title`)
}

describe('the places showing hetu\'s state on the driven build', () => {
  it('agree through opening, typing, saving and renaming a note and starring a view', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const first = await agree(instance)
    expect(first.title).toBe('No note open')
    expect(first.files?.map(row => row.path)).toEqual(['a.md', 'b.md', 'c.md'])

    await openFromFiles(instance, editor, 'a')
    await agree(instance)
    await instance.click(shownNote(editor))
    await instance.keys(editor, 'XY')
    const typed = await agree(instance)
    expect(typed.title).toBe('a.md (unsaved)')
    await instance.press(editor, 'Mod+S')
    await until(async () => (await readFile(path.join(instance.notes, 'a.md'), 'utf8')).includes('XY'), 'the save on disk')
    const saved = await agree(instance)
    expect(saved.title).toBe('a.md')
    expect(saved.editors.find(each => each.current)?.text).toContain('XY')

    // Rename through the Files frame: the box opens holding the name, which the keys replace
    await openFromFiles(instance, editor, 'b')
    const files = await explorer(editor)
    await instance.click(files.getByRole('button', { name: 'Rename' }))
    await until(async () => await files.getByRole('textbox').isVisible(), 'the rename box')
    expect(await instance.frameKeys(['Backspace', ...'renamed', 'Enter'], 30)).toEqual([])
    // The tab stays on the path the note left and the note bar says so (AI1)
    await until(async () => (await diskFiles(instance.notes)).includes('renamed.md'), 'the rename on disk')
    const renamed = await agree(instance)
    expect(renamed.disk.files).toEqual(['a.md', 'c.md', 'renamed.md'])
    expect(renamed.files?.map(row => row.path)).toEqual(['a.md', 'c.md', 'renamed.md'])
    expect(renamed.noteBar).not.toBeNull()

    await instance.click(editor.getByRole('button', { name: 'Views', exact: true }))
    const star = editor.locator('[data-hetu-view-key="file-explorer/files"]').getByRole('button', { name: '☆' })
    await instance.click(star)
    const starred = await agree(instance)
    expect(starred.menu?.['file-explorer/files']).toBe(true)
    expect(starred.favorites).toEqual(['file-explorer/files'])
    await instance.quit()
  })

  // T-11: a click on a note's tab has the layout show that note while the editors keep the other current, so the title
  // names the note no longer shown. A known red, pinned to the two pairs it breaks, until one owner holds the current
  // note and this becomes agree
  it('disagree on the title and the current note after a click on another open note\'s tab (T-11)', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, 'a')
    await openFromFiles(instance, editor, 'b')
    const before = await agree(instance)
    const [a, b] = ['a.md', 'b.md'].map(name => before.tabs.find(tab => tab.text === name)!.instance)
    await instance.click(editor.locator(`[data-hetu-tab="${a}"]`))
    await until(async () => (await readState(instance)).editors.find(each => each.shown)?.instance === a, 'a.md shown')
    expect(disagreements(await readState(instance))).toEqual([
      { places: ['note title', `shown note ${a}'s tab`], values: ['b.md', 'a.md'] },
      { places: ['current note', 'shown note'], values: [b, a] },
    ])
    await instance.quit()
  })
})
