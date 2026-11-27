// Tier 0's invariants: one reader for each place the editor window shows a state, and agree, which fails naming every
// two places that disagree with what each shows. Readers go by role and name or by the data-hetu attributes the page
// carries for them, never by the page's ids and classes, so a rewrite of the page that keeps the attributes keeps them.
// What no reader sees: the OS window title and macOS's edited dot, which hetu sets to nothing (the title is fixed)
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Frame, Page } from 'playwright'
import { readFocus, type Focus } from './input.ts'
import type { Instance } from './instance.ts'

// Each open note's editor: whether the editors hold it current, whether the layout laid it on screen, whether focus is
// in it and its text as CodeMirror holds it, null when CodeMirror's view couldn't be found from its element
export type Editor = { instance: string, current: boolean, shown: boolean, focused: boolean, text: string | null }
export type Tab = { instance: string, text: string, title: string }
export type Row = { path: string, folder: boolean, expanded: boolean, selected: boolean }
// A view the drawer draws: its lines of text and the notes its rows carry
export type Drawn = { owner: string, instance: string, lines: string[], notes: string[] }

export type State = {
  title: string
  // What the note bar says about the current note, null while it is hidden
  noteBar: string | null
  editors: Editor[]
  tabs: Tab[]
  // The Views menu's stars by view key while it is open, null while it is closed
  menu: Record<string, boolean> | null
  // The favorites as settings hold them on disk, null before any were written
  favorites: string[] | null
  // The Files tree's rows with each note's and folder's path, null with no explorer drawn
  files: Row[] | null
  drawer: Drawn[]
  // Every file the luoshu lists, so past dot names and links, with the text of each open note's file
  disk: { files: string[], texts: Record<string, string | null> }
  focus: Focus
}

export type Disagreement = { places: [string, string], values: [unknown, unknown] }

// The editor window's own places in one read of its page, so they are read at one moment
const readPage = (editor: Page) => editor.evaluate(() => {
  const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  // CodeMirror's view from its content element, as its own findFromDOM finds it, in this version and the one before
  const textOf = (element: HTMLElement) => {
    const content = element.querySelector('.cm-content') as unknown as { cmTile?: { root?: { view?: unknown } }, cmView?: { rootView?: { view?: unknown } } } | null
    const view = (content?.cmTile?.root?.view ?? content?.cmView?.rootView?.view) as { state: { sliceDoc(): string } } | undefined
    return view === undefined ? null : view.state.sliceDoc()
  }
  const menu = document.querySelector<HTMLElement>('[data-hetu="views-menu"]')
  const bar = document.querySelector<HTMLElement>('[data-hetu="note-bar"]')
  return {
    title: document.querySelector('[data-hetu="note-title"]')?.textContent ?? '(no note title)',
    noteBar: bar === null || bar.hidden ? null : bar.innerText.trim(),
    editors: all('[data-hetu-editor]').map(element => ({
      instance: element.dataset.hetuEditor!, current: element.hasAttribute('data-hetu-current'), shown: !element.hidden,
      focused: element.contains(document.activeElement), text: textOf(element),
    })),
    tabs: all('[data-hetu-tab]').map(element => ({ instance: element.dataset.hetuTab!, text: element.textContent ?? '', title: element.title })),
    menu: menu === null || menu.hidden ? null : Object.fromEntries(all('[data-hetu-view-key]').map(row => [row.dataset.hetuViewKey!, row.querySelector('button')?.textContent === '★'])),
    drawer: all('div[data-hetu-view]').map(root => ({
      owner: root.dataset.hetuOwner!, instance: root.dataset.hetuView!, lines: root.innerText.split('\n').map(line => line.trim()).filter(line => line !== ''),
      notes: [...root.querySelectorAll<HTMLElement>('[data-hetu-note]')].map(row => row.dataset.hetuNote!),
    })),
  }
})

// The Files tree's rows by role, each row's path from its level and the folders above it. A note's row names it
// without .md
async function readFiles(editor: Page): Promise<Row[] | null> {
  const element = await editor.$('iframe[data-hetu-owner="file-explorer"]')
  const frame: Frame | null = element === null ? null : await element.contentFrame()
  if (frame === null) return null
  const rows = await frame.getByRole('treeitem').evaluateAll(items => items.map(item => ({
    name: item.textContent?.replace(/^[▸▾]/, '') ?? '', level: Number(item.getAttribute('aria-level') ?? '1'),
    expanded: item.getAttribute('aria-expanded'), selected: item.getAttribute('aria-selected') === 'true',
  }))).catch(() => null)
  if (rows === null) return null
  const above: string[] = []
  return rows.map(row => {
    above.length = row.level - 1
    const folder = row.expanded !== null
    const at = [...above, row.name].join('/')
    if (folder) above.push(row.name)
    return { path: folder ? at : `${at}.md`, folder, expanded: row.expanded === 'true', selected: row.selected }
  })
}

// Every file the luoshu would list: past dot names and links at any depth, in its own spelling
export async function diskFiles(root: string, at = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(path.join(root, at), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
    const relative = at === '' ? entry.name : `${at}/${entry.name}`
    if (entry.isDirectory()) found.push(...await diskFiles(root, relative))
    else if (entry.isFile()) found.push(relative)
  }
  return found.sort()
}

// The editor window's favorites as storage keeps them: one JSON line naming the key and its value, then its hash
async function readFavorites(data: string): Promise<string[] | null> {
  const stored = await readFile(path.join(data, 'storage', 'window.editor', 'key-settings'), 'utf8').catch(() => null)
  if (stored === null) return null
  return (JSON.parse(stored.split('\n')[0]!) as { value: { favorites: string[] } }).value.favorites
}

export async function readState(instance: Instance): Promise<State> {
  const editor = await instance.editor()
  const page = await readPage(editor)
  const files = await diskFiles(instance.notes)
  const texts: Record<string, string | null> = {}
  for (const tab of page.tabs.filter(tab => tab.instance.startsWith('n'))) {
    const at = pathOf(tab.text)
    texts[at] = await readFile(path.join(instance.notes, at), 'utf8').catch(() => null)
  }
  return { ...page, favorites: await readFavorites(instance.data), files: await readFiles(editor), disk: { files, texts }, focus: await readFocus(instance.app) }
}

const UNSAVED = ' (unsaved)'
const pathOf = (shown: string) => (shown.endsWith(UNSAVED) ? shown.slice(0, -UNSAVED.length) : shown)
const NO_NOTE = 'No note open'

// Every two places that disagree in one read. The title against the note the editors hold current and the note the
// layout shows, which two owners hold. Each tab against its own title attribute. Each note whose tab says saved
// against its file. Focus in an editor against the current one. The menu's stars against the settings. The Files tree
// and the drawer's note rows against the files
export function disagreements(state: State): Disagreement[] {
  const found: Disagreement[] = []
  const differ = (a: string, va: unknown, b: string, vb: unknown) => found.push({ places: [a, b], values: [va, vb] })
  const tabOf = (instance: string) => state.tabs.find(tab => tab.instance === instance)
  const shownText = (instance: string | undefined) => (instance === undefined ? NO_NOTE : tabOf(instance)?.text ?? null)

  for (const tab of state.tabs) if (tab.text !== tab.title) differ(`tab ${tab.instance}`, tab.text, `tab ${tab.instance}'s title attribute`, tab.title)

  const current = state.editors.find(editor => editor.current)
  const shown = state.editors.filter(editor => editor.shown)
  // A title naming an open that failed names no note, so only the note-bar's own tests read it
  if (!state.title.includes(' could not be opened: ')) {
    const want = shownText(current?.instance)
    if (want !== null && want !== state.title) differ('note title', state.title, `current note ${current?.instance ?? '(none)'}'s tab`, want)
    // The layout's main shows a view and no note, which the title doesn't name
    if (shown.length === 1 && shown[0] !== current) differ('note title', state.title, `shown note ${shown[0]!.instance}'s tab`, shownText(shown[0]!.instance))
  }
  if (shown.length > 1) differ('shown notes', shown.map(editor => editor.instance), 'the layout\'s one editor', 1)
  if (shown.length === 1 && current !== undefined && shown[0] !== current) differ('current note', current.instance, 'shown note', shown[0]!.instance)

  for (const editor of state.editors) {
    if (editor.focused && !editor.current) differ('focus', `in note ${editor.instance}`, 'current note', current?.instance ?? '(none)')
    const tab = tabOf(editor.instance)
    if (tab === undefined || tab.text.endsWith(UNSAVED)) continue
    const disk = state.disk.texts[tab.text]
    // A note whose file left its path keeps its tab on that path, which the note bar says while it is current (AI1)
    if (disk === null || disk === undefined) {
      if (editor.current && state.noteBar === null) differ(`note ${editor.instance}'s tab`, tab.text, `disk and the note bar`, '(no file, nothing said)')
      continue
    }
    if (editor.text === null) differ(`note ${editor.instance}'s text`, 'unreadable from CodeMirror', `its tab`, tab.text)
    else if (disk !== editor.text) differ(`note ${editor.instance}'s text, its tab saying saved`, editor.text, `disk ${tab.text}`, disk)
  }

  if (state.menu !== null) {
    const favorites = new Set(state.favorites ?? [])
    for (const [key, star] of Object.entries(state.menu)) {
      if (star !== favorites.has(key)) differ(`Views menu star of ${key}`, star ? '★' : '☆', 'settings favorites', [...favorites])
    }
  }

  const onDisk = new Set(state.disk.files)
  if (state.files !== null) {
    const rows = state.files
    for (const row of rows) if (!row.folder && !onDisk.has(row.path)) differ(`Files row ${row.path}`, 'shown', `disk ${row.path}`, '(no file)')
    // A note on disk shows when every folder above it is open
    const open = new Set(['', ...rows.filter(row => row.folder && row.expanded).map(row => row.path)])
    const listed = new Set(rows.map(row => row.path))
    for (const file of onDisk) {
      const folders = file.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/'))
      if (file.endsWith('.md') && ['', ...folders].every(folder => open.has(folder)) && !listed.has(file)) differ(`disk ${file}`, 'a note', 'Files tree', '(no row)')
    }
    const selected = rows.filter(row => row.selected)
    if (selected.length > 1) differ('Files selection', selected.map(row => row.path), 'one selected row', 1)
  }

  for (const view of state.drawer) {
    for (const note of view.notes) if (!onDisk.has(note)) differ(`${view.owner} row for ${note}`, 'shown', `disk ${note}`, '(no file)')
  }
  return found
}

export const said = (found: readonly Disagreement[]) => found.map(({ places, values }) =>
  `${places[0]} shows ${JSON.stringify(values[0])} but ${places[1]} shows ${JSON.stringify(values[1])}`).join('\n')

// Reads every place until they all agree, as a change reaches each place in its own time, else fails naming each two
// that disagree in the last read. Answers the read they agreed in
export async function agree(instance: Instance, within = 3000): Promise<State> {
  const until = Date.now() + within
  for (;;) {
    const state = await readState(instance)
    const found = disagreements(state)
    if (found.length === 0) return state
    if (Date.now() > until) throw new Error(`the places showing hetu's state disagree:\n${said(found)}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}
