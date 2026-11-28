import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { diskFiles, disagreements, said, settle, type State } from './state.ts'

// One note open, saved and current, shown in main, the Files tree, the drawer and the disk agreeing
const agreeing = (): State => ({
  title: 'a.md',
  noteBar: null,
  editors: [{ instance: 'n1', current: true, shown: true, focused: true, text: 'alpha' }],
  tabs: [{ instance: 'n1', text: 'a.md', title: 'a.md' }, { instance: 'v2', text: 'links · Links', title: 'links · Links' }],
  menu: null,
  favorites: null,
  files: { shown: true, problem: null, rows: [{ path: 'f', folder: true, expanded: false, selected: false }, { path: 'a.md', folder: false, expanded: false, selected: true }] },
  drawer: [{ owner: 'links', instance: 'v2', shown: true, lines: ['Linked from (0)'], notes: [] }],
  disk: { files: ['a.md', 'f/b.md', 'f/notes.txt'], texts: { 'a.md': 'alpha' } },
  focus: { main: [{ url: 'hetu://editor/', focused: false, focusedFrame: null }], pages: [] },
})
const pairs = (state: State) => disagreements(state).map(found => found.places)

describe('which places disagree', () => {
  it('finds none when every place shows the same note, text and files, and no tab\'s title attribute is compared', () => {
    const state = agreeing()
    state.tabs[0]!.title = 'one value sets both'
    expect(disagreements(state)).toEqual([])
  })

  it('names the title against the current note\'s tab when a save leaves the title unsaved', () => {
    const state = agreeing()
    state.title = 'a.md (unsaved)'
    expect(disagreements(state)).toEqual([{ places: ['note title', 'current note n1\'s tab'], values: ['a.md (unsaved)', 'a.md'] }])
  })

  it('names the title and the current note against the note the layout shows, and two notes shown at once', () => {
    const state = agreeing()
    state.editors = [{ ...state.editors[0]!, shown: false, focused: false }, { instance: 'n2', current: false, shown: true, focused: false, text: 'beta' }]
    state.tabs.push({ instance: 'n2', text: 'b.md', title: 'b.md' })
    state.disk.texts['b.md'] = 'beta'
    expect(pairs(state)).toEqual([['note title', 'shown note n2\'s tab'], ['current note', 'shown note']])
    state.editors[0]!.shown = true
    expect(pairs(state)).toEqual([['shown notes', 'the layout\'s one editor']])
  })

  it('takes a failed open in the title only over the note that failed', () => {
    const state = agreeing()
    state.title = 'a.md could not be opened: not-found'
    expect(disagreements(state)).toEqual([])
    state.title = 'gone.md could not be opened: not-found'
    expect(pairs(state)).toEqual([['note title', 'current note n1\'s tab']])
  })

  it('names a saved note\'s text against its file, current or in a background tab, and leaves an unsaved one', () => {
    const state = agreeing()
    state.editors.push({ instance: 'n3', current: false, shown: false, focused: false, text: 'gamma' })
    state.tabs.push({ instance: 'n3', text: 'c.md', title: 'c.md' })
    state.disk.texts['c.md'] = 'gamma from outside'
    expect(pairs(state)).toEqual([['note n3\'s text, its tab saying saved', 'disk c.md']])
    state.tabs[2]!.text = 'c.md (unsaved)'
    expect(disagreements(state)).toEqual([])
  })

  it('takes a current note whose file left only with the note bar saying so', () => {
    const state = agreeing()
    state.disk = { files: ['moved.md'], texts: { 'a.md': null } }
    state.files!.rows = [{ path: 'moved.md', folder: false, expanded: false, selected: true }]
    expect(pairs(state)).toEqual([['note n1\'s tab', 'disk and the note bar']])
    state.noteBar = 'This note was moved or deleted, so this tab can\'t save it'
    expect(disagreements(state)).toEqual([])
  })

  it('names Files rows against the files both ways, notes and folders, as a stale rename leaves them', () => {
    const state = agreeing()
    state.disk.files = ['renamed.md', 'g/b.md']
    state.disk.texts = {}
    state.files!.rows![1]!.path = 'a.md'
    state.editors = []
    state.title = 'No note open'
    expect(said(disagreements(state))).toBe([
      'Files row f shows "shown" but disk f shows "(no folder with a note in it)"',
      'Files row a.md shows "shown" but disk a.md shows "(no file)"',
      'disk g shows "a folder" but Files tree shows "(no row)"',
      'disk renamed.md shows "a note" but Files tree shows "(no row)"',
    ].join('\n'))
  })

  it('shows a note in a folder only once the folder is open, and fails a shown Files view it can\'t read', () => {
    const state = agreeing()
    state.files!.rows![0]!.expanded = true
    expect(pairs(state)).toEqual([['disk f/b.md', 'Files tree']])
    state.files = { shown: false, rows: null, problem: 'the frame has no document' }
    expect(disagreements(state)).toEqual([])
    state.files.shown = true
    expect(disagreements(state)).toEqual([{ places: ['Files view', 'its rows'], values: ['shown', 'the frame has no document'] }])
  })

  // Search shares the Files column, so Files behind it is hidden and its tree reads no rows by role
  it('compares no Files rows while another view hides Files, then compares them again once it is shown', () => {
    const state = agreeing()
    state.files = { shown: false, rows: [], problem: null }
    expect(disagreements(state)).toEqual([])
    state.files.shown = true
    expect(pairs(state)).toEqual([['disk f', 'Files tree'], ['disk a.md', 'Files tree']])
  })

  it('names a menu star against the settings, a row with no one star, and focus against the current note and main', () => {
    const state = agreeing()
    state.menu = { 'links/links': true, 'search/search': null }
    state.favorites = []
    state.editors.push({ instance: 'n2', current: false, shown: false, focused: true, text: null })
    state.focus = {
      main: [{ url: 'hetu://editor/', focused: false, focusedFrame: 'hetu://x.views/a' }],
      pages: [{ url: 'hetu://editor/', frames: [{ url: 'hetu://x.views/a', hasFocus: false, active: null }] }],
    }
    expect(pairs(state)).toEqual([
      ['focus', 'current note'],
      ['main\'s focused frame in hetu://editor/', 'that frame\'s document'],
      ['Views menu star of links/links', 'settings favorites'],
      ['Views menu star of search/search', 'settings favorites'],
    ])
  })

  it('names a drawn view\'s note rows against the files, its owner against its tab and a shown view drawing nothing', () => {
    const state = agreeing()
    state.drawer = [{ owner: 'links', instance: 'v2', shown: true, lines: [], notes: ['gone.md'] }, { owner: 'search', instance: 'v3', shown: false, lines: [], notes: [] }]
    state.tabs[1]!.text = 'search · Search'
    expect(pairs(state)).toEqual([['links row for gone.md', 'disk gone.md'], ['links\'s view v2', 'tab v2'], ['links\'s view v2', 'its text']])
  })
})

describe('agreement that counts', () => {
  const reads = (...states: (State | Error)[]) => {
    let at = 0
    return async () => {
      const next = states[Math.min(at++, states.length - 1)]!
      if (next instanceof Error) throw next
      return next
    }
  }
  const torn = { ...agreeing(), title: 'a.md (unsaved)' }

  it('holds for three reads and the hold, read again past a disagreement and a read that throws', async () => {
    const agreed = await settle(reads(torn, new Error('torn settings'), agreeing()), { hold: 100 })
    expect(agreed.title).toBe('a.md')
    expect(agreed.agreedMs).toBeGreaterThanOrEqual(90)
  })

  it('fails on agreement that doesn\'t hold, naming the pair in the last read', async () => {
    let flip = false
    const flapping = async () => ((flip = !flip) ? agreeing() : torn)
    await expect(settle(flapping, { within: 300, hold: 100 })).rejects.toThrow('note title shows "a.md (unsaved)" but current note n1\'s tab shows "a.md"')
  })

  it('counts no agreement before the action landed, and fails with the last read\'s error', async () => {
    await expect(settle(reads(agreeing()), { within: 200, landed: state => state.title === 'b.md' })).rejects.toThrow('the action never landed')
    await expect(settle(reads(new Error('frame navigated')), { within: 200 })).rejects.toThrow('a read failed: Error: frame navigated')
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
