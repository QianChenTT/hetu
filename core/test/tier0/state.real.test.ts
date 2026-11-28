import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { afterAll, describe, expect, it } from 'vitest'
import { start, until, type Instance } from './instance.ts'
import { agree, disagreements, diskFiles, readState, type AgreeOptions, type State } from './state.ts'

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
const shownNote = (editor: Page) => editor.locator('[data-hetu-editor]:not([hidden]) [role=textbox]')
const current = (state: State) => state.editors.find(each => each.current)
const disk = (instance: Instance, name: string) => readFile(path.join(instance.notes, name), 'utf8')

// How long after its action each agreement began and how long until it held, printed once the file is done
const took: string[] = []
afterAll(() => console.info(`agreements began/held after (ms): ${took.join(', ')}`))
async function agreeAfter(instance: Instance, what: string, landed: AgreeOptions['landed']) {
  const asked = Date.now()
  const agreed = await agree(instance, { landed })
  took.push(`${what} ${agreed.agreedMs}/${Date.now() - asked}`)
  return agreed
}

async function openFromFiles(instance: Instance, editor: Page, name: string) {
  await instance.click(await filesRow(editor, name))
  return agreeAfter(instance, `open ${name}`, state => current(state)?.text?.includes(`body ${name}`) === true)
}

// Renames a note through the Files frame: the box opens holding the name, which the keys replace
async function renameInFiles(instance: Instance, editor: Page, from: string, to: string) {
  const files = await explorer(editor)
  await instance.click(files.getByRole('button', { name: 'Rename' }))
  await until(async () => await files.getByRole('textbox').isVisible(), 'the rename box')
  expect(await instance.frameKeys([...Array<string>(from.length).fill('Backspace'), ...to, 'Enter'], 30)).toEqual([])
  return agreeAfter(instance, `rename ${from}`, state => state.disk.files.includes(`${to}.md`))
}

describe('the places showing hetu\'s state on the driven build', () => {
  it('agree through opening, typing, saving and renaming a note, a background tab and starring a view', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    const first = await agreeAfter(instance, 'start', state => state.files?.rows?.length === 3)
    expect(first.title).toBe('No note open')

    await openFromFiles(instance, editor, 'a')
    await instance.click(shownNote(editor))
    await instance.keys(editor, 'XY')
    expect((await agreeAfter(instance, 'type', state => current(state)?.text?.includes('XY') === true)).title).toBe('a.md (unsaved)')
    await instance.press(editor, 'Mod+S')
    expect((await agreeAfter(instance, 'save', state => state.disk.texts['a.md']?.includes('XY') === true)).title).toBe('a.md')

    // a.md stays open behind b.md, saved, its text read against its file
    const behind = await openFromFiles(instance, editor, 'b')
    expect(behind.editors.find(each => !each.current && !each.shown)?.text).toContain('XY')

    // The tab stays on the path the note left and the note bar says so (AI1)
    const renamed = await renameInFiles(instance, editor, 'b', 'renamed')
    expect(renamed.files?.rows?.map(row => row.path)).toEqual(['a.md', 'c.md', 'renamed.md'])
    expect(renamed.noteBar).toContain('moved or deleted')

    await instance.click(editor.getByRole('button', { name: 'Views', exact: true }))
    await instance.click(editor.locator('[data-hetu-view-key="file-explorer/files"]').getByRole('button', { name: '☆', exact: true }))
    const starred = await agreeAfter(instance, 'star', state => state.favorites?.includes('file-explorer/files') === true)
    expect(starred.menu?.['file-explorer/files']).toBe(true)
    await instance.quit()
  })

  it('agree through an outside change to an unsaved note, its Reload and the draft restored', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, 'a')
    await instance.click(shownNote(editor))
    await instance.keys(editor, 'XY')
    await agreeAfter(instance, 'type', state => current(state)?.text?.includes('XY') === true)
    await writeFile(path.join(instance.notes, 'a.md'), '# a\n\nfrom outside\n')
    await agreeAfter(instance, 'outside change', state => state.noteBar?.includes('changed outside hetu') === true)
    await instance.click(editor.getByRole('button', { name: 'Reload', exact: true }))
    const reloaded = await agreeAfter(instance, 'reload', state => state.noteBar?.includes('A draft of this note') === true)
    expect(reloaded.title).toBe('a.md')
    await instance.click(editor.getByRole('button', { name: 'Restore', exact: true }))
    const restored = await agreeAfter(instance, 'restore', state => current(state)?.text?.includes('XY') === true)
    expect(restored.title).toBe('a.md (unsaved)')
    expect(await disk(instance, 'a.md')).toBe('# a\n\nfrom outside\n')
    await instance.quit()
  })

  it('agree after a note linking another is renamed in Files and the other is worked in', async context => {
    const instance = await start(context, { notes: { 'alpha.md': 'see [[beta]]\n', 'beta.md': '# beta\n\nbody beta\n' } })
    const editor = await instance.editor()
    await instance.click(await filesRow(editor, 'alpha'))
    await agreeAfter(instance, 'open alpha', state => current(state)?.text?.includes('[[beta]]') === true)
    await renameInFiles(instance, editor, 'alpha', 'gamma')
    await openFromFiles(instance, editor, 'beta')
    await instance.click(shownNote(editor))
    await instance.keys(editor, 'Z')
    // Links shares its column with other views, so its tab brings it to the front
    const links = (await readState(instance)).tabs.find(tab => tab.text.startsWith('links · '))!
    await instance.click(editor.locator(`[data-hetu-tab="${links.instance}"]`))
    const worked = await agreeAfter(instance, 'type in beta', state => state.drawer.some(view => view.owner === 'links' && view.notes.includes('gamma.md')))
    expect(worked.drawer.find(view => view.owner === 'links')?.notes).toEqual(['gamma.md'])
    await instance.quit()
  })

  // T-11: a click on a note's tab has the layout show that note while the editors keep the other current, so the title
  // names the note no longer shown. A known red, pinned to the two pairs it breaks for the whole window agree waits,
  // until one owner holds the current note and this becomes agree
  it('disagree on the title and the current note after a click on another open note\'s tab (T-11)', async context => {
    const instance = await start(context, { notes })
    const editor = await instance.editor()
    await openFromFiles(instance, editor, 'a')
    const before = await openFromFiles(instance, editor, 'b')
    const [a, b] = ['a.md', 'b.md'].map(name => before.tabs.find(tab => tab.text === name)!.instance)
    await instance.click(editor.locator(`[data-hetu-tab="${a}"]`))
    await until(async () => (await readState(instance)).editors.find(each => each.shown)?.instance === a, 'a.md shown')
    for (const ends = Date.now() + 3300; Date.now() < ends;) {
      expect(disagreements(await readState(instance))).toEqual([
        { places: ['note title', `shown note ${a}'s tab`], values: ['b.md', 'a.md'] },
        { places: ['current note', 'shown note'], values: [b, a] },
      ])
    }
    expect(await diskFiles(instance.notes)).toEqual(['a.md', 'b.md', 'c.md'])
    await instance.quit()
  })
})
