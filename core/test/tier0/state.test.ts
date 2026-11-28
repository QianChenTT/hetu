import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { diskFiles, disagreements, said, type State } from './state.ts'

// One note open, saved and current, shown in main, the Files tree and the disk agreeing
const agreeing = (): State => ({
  title: 'a.md',
  noteBar: null,
  editors: [{ instance: 'n1', current: true, shown: true, focused: true, text: 'alpha' }],
  tabs: [{ instance: 'n1', text: 'a.md', title: 'a.md' }, { instance: 'v1', text: 'file-explorer · Files', title: 'file-explorer · Files' }],
  menu: null,
  favorites: null,
  files: [{ path: 'a.md', folder: false, expanded: false, selected: true }, { path: 'f', folder: true, expanded: false, selected: false }],
  drawer: [{ owner: 'links', instance: 'v2', lines: ['Linked from (0)'], notes: [] }],
  disk: { files: ['a.md', 'f/b.md', 'f/notes.txt'], texts: { 'a.md': 'alpha' } },
  focus: { main: [], pages: [] },
})
const pairs = (state: State) => disagreements(state).map(found => found.places)

describe('which places disagree', () => {
  it('finds none when every place shows the same note, text and files', () => {
    expect(disagreements(agreeing())).toEqual([])
  })

  it('names the title against the current note\'s tab when a save leaves the title unsaved', () => {
    const state = agreeing()
    state.title = 'a.md (unsaved)'
    expect(disagreements(state)).toEqual([{ places: ['note title', 'current note n1\'s tab'], values: ['a.md (unsaved)', 'a.md'] }])
  })

  it('names the title and the current note against the note the layout shows', () => {
    const state = agreeing()
    state.editors.push({ instance: 'n2', current: false, shown: true, focused: false, text: 'beta' })
    state.editors[0]!.shown = false
    state.tabs.push({ instance: 'n2', text: 'b.md', title: 'b.md' })
    state.disk.texts['b.md'] = 'beta'
    state.editors[0]!.focused = false
    expect(pairs(state)).toEqual([['note title', 'shown note n2\'s tab'], ['current note', 'shown note']])
  })

  it('names a tab against its title attribute and a saved note\'s text against its file', () => {
    const state = agreeing()
    state.tabs[0]!.title = 'old.md'
    state.disk.texts['a.md'] = 'alpha from outside'
    expect(pairs(state)).toEqual([['tab n1', 'tab n1\'s title attribute'], ['note n1\'s text, its tab saying saved', 'disk a.md']])
  })

  it('leaves an unsaved note\'s text to differ from its file', () => {
    const state = agreeing()
    state.title = 'a.md (unsaved)'
    state.tabs[0] = { instance: 'n1', text: 'a.md (unsaved)', title: 'a.md (unsaved)' }
    state.editors[0]!.text = 'alpha typed'
    expect(disagreements(state)).toEqual([])
  })

  it('takes a current note whose file left only with the note bar saying so', () => {
    const state = agreeing()
    state.disk = { files: ['moved.md'], texts: { 'a.md': null } }
    state.files = [{ path: 'moved.md', folder: false, expanded: false, selected: true }]
    expect(pairs(state)).toEqual([['note n1\'s tab', 'disk and the note bar']])
    state.noteBar = 'a.md was moved or removed'
    expect(disagreements(state)).toEqual([])
  })

  it('names a Files row with no file and a file in an open folder with no row, as a stale rename leaves them', () => {
    const state = agreeing()
    state.disk.files = ['renamed.md', 'f/b.md']
    state.disk.texts = { 'a.md': 'alpha' }
    state.files![0]!.path = 'b.md'
    state.tabs = state.tabs.filter(tab => tab.instance !== 'n1')
    state.editors = []
    state.title = 'No note open'
    expect(said(disagreements(state))).toBe('Files row b.md shows "shown" but disk b.md shows "(no file)"\ndisk renamed.md shows "a note" but Files tree shows "(no row)"')
    // f/b.md shows once f is open
    state.files![1]!.expanded = true
    expect(pairs(state)).toContainEqual(['disk f/b.md', 'Files tree'])
  })

  it('names a menu star against the settings, focus outside the current note and a drawer row with no file', () => {
    const state = agreeing()
    state.menu = { 'file-explorer/files': true, 'links/links': false }
    state.favorites = []
    state.editors.push({ instance: 'n2', current: false, shown: false, focused: true, text: null })
    state.drawer[0]!.notes = ['gone.md']
    expect(pairs(state)).toEqual([
      ['focus', 'current note'],
      ['Views menu star of file-explorer/files', 'settings favorites'],
      ['links row for gone.md', 'disk gone.md'],
    ])
  })
})

describe('the files on disk as the luoshu lists them', () => {
  it('lists files at any depth in its own spelling, past dot names and links', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hetu-tier0-disk-'))
    try {
      await mkdir(path.join(root, 'f', '.git'), { recursive: true })
      await mkdir(path.join(root, '.obsidian'))
      for (const name of ['a.md', 'f/b.md', 'f/.hidden.md', 'f/.git/c.md', '.obsidian/d.md', 'é.md']) await writeFile(path.join(root, name), '')
      await symlink(path.join(root, 'a.md'), path.join(root, 'link.md'))
      expect(await diskFiles(root)).toEqual(['a.md', 'é.md', 'f/b.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
