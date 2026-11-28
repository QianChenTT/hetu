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
// A tab's text and its title attribute, which the page sets from one value, so only the text is compared
export type Tab = { instance: string, text: string, title: string }
export type Row = { path: string, folder: boolean, expanded: boolean, selected: boolean }
// The Files view: whether its frame is on screen and its rows, null with a problem when they can't be read
export type Files = { shown: boolean, rows: Row[] | null, problem: string | null }
// A view the drawer draws: whether it is on screen, its lines of text, each field's value or placeholder after them,
// and the notes its rows carry
export type Drawn = { owner: string, instance: string, shown: boolean, lines: string[], notes: string[] }

export type State = {
  title: string
  // What the note bar says about the current note, null while it is hidden
  noteBar: string | null
  editors: Editor[]
  tabs: Tab[]
  // The Views menu's stars by view key while it is open, null while it is closed, a star null when no one button in
  // the row is named ★ or ☆
  menu: Record<string, boolean | null> | null
  // The favorites as settings hold them on disk, null before any were written
  favorites: string[] | null
  // null with no Files frame in the page
  files: Files | null
  drawer: Drawn[]
  // Every file the luoshu lists, so past dot names and links, with the text of each open note's file
  disk: { files: string[], texts: Record<string, string | null> }
  focus: Focus
}

export type Disagreement = { places: [string, string], values: [unknown, unknown] }

// The editor window's own places in one read of its page, so they are read at one moment. On screen means the browser
// would draw it, by checkVisibility, whatever hides it
const readPage = (editor: Page) => editor.evaluate(() => {
  const all = (selector: string, under: ParentNode = document) => [...under.querySelectorAll<HTMLElement>(selector)]
  const seen = (element: HTMLElement | null) => element !== null && element.checkVisibility()
  // CodeMirror's view from its content element, as its own findFromDOM finds it, in this version and the one before
  const textOf = (element: HTMLElement) => {
    const content = element.querySelector('.cm-content') as unknown as { cmTile?: { root?: { view?: unknown } }, cmView?: { rootView?: { view?: unknown } } } | null
    const view = (content?.cmTile?.root?.view ?? content?.cmView?.rootView?.view) as { state: { sliceDoc(): string } } | undefined
    return view === undefined ? null : view.state.sliceDoc()
  }
  // A row's star: the one button in it named ★ or ☆, by its label or else its text
  const starOf = (row: HTMLElement) => {
    const named = all('button, [role=button]', row).map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()).filter(name => name === '★' || name === '☆')
    return named.length === 1 ? named[0] === '★' : null
  }
  const menu = document.querySelector<HTMLElement>('[data-hetu="views-menu"]')
  const bar = document.querySelector<HTMLElement>('[data-hetu="note-bar"]')
  return {
    title: document.querySelector('[data-hetu="note-title"]')?.textContent ?? '(no note title)',
    noteBar: seen(bar) ? bar!.innerText.trim() : null,
    editors: all('[data-hetu-editor]').map(element => ({
      instance: element.dataset.hetuEditor!, current: element.hasAttribute('data-hetu-current'), shown: seen(element),
      focused: element.contains(document.activeElement), text: textOf(element),
    })),
    tabs: all('[data-hetu-tab]').map(element => ({ instance: element.dataset.hetuTab!, text: element.textContent ?? '', title: element.title })),
    menu: seen(menu) ? Object.fromEntries(all('[data-hetu-view-key]').map(row => [row.dataset.hetuViewKey!, starOf(row)])) : null,
    drawer: all('div[data-hetu-view]').map(root => ({
      owner: root.dataset.hetuOwner!, instance: root.dataset.hetuView!, shown: seen(root),
      // A field draws its value, else its placeholder, which innerText leaves out, so a view of a field alone, as
      // Search before a word is typed, draws something
      lines: [...root.innerText.split('\n'), ...all('input, textarea', root).map(field => (field as HTMLInputElement).value || (field as HTMLInputElement).placeholder)]
        .map(line => line.trim()).filter(line => line !== ''),
      notes: all('[data-hetu-note]', root).map(row => row.dataset.hetuNote!),
    })),
    filesShown: seen(document.querySelector<HTMLElement>('iframe[data-hetu-owner="file-explorer"]')),
  }
})

// The Files tree's rows by role, each named as a reader hears it, past what is hidden from it, and its path from its
// level and the folders above it. The explorer lists .md files only, a note's row naming it without .md, and the
// folders above them
async function readFiles(editor: Page, shown: boolean): Promise<Files | null> {
  const element = await editor.$('iframe[data-hetu-owner="file-explorer"]')
  if (element === null) return null
  const frame: Frame | null = await element.contentFrame()
  const items = frame === null ? null : await frame.getByRole('treeitem').evaluateAll(rows => rows.map(row => ({
    name: row.getAttribute('aria-label') ?? [...row.childNodes].filter(node => !(node instanceof Element && node.getAttribute('aria-hidden') === 'true')).map(node => node.textContent).join(''),
    level: Number(row.getAttribute('aria-level')), expanded: row.getAttribute('aria-expanded'), selected: row.getAttribute('aria-selected') === 'true',
  }))).catch((err: unknown) => String(err))
  if (items === null || typeof items === 'string') return { shown, rows: null, problem: items ?? 'the frame has no document' }
  const above: string[] = []
  const rows: Row[] = []
  for (const item of items) {
    if (!Number.isInteger(item.level) || item.level < 1 || item.level > above.length + 1) return { shown, rows: null, problem: `row ${item.name} at level ${item.level} under ${above.length} folders` }
    above.length = item.level - 1
    const folder = item.expanded !== null
    const at = [...above, item.name].join('/')
    if (folder) above.push(item.name)
    rows.push({ path: folder ? at : `${at}.md`, folder, expanded: item.expanded === 'true', selected: item.selected })
  }
  return { shown, rows, problem: null }
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
  const { filesShown, ...shown } = page
  return { ...shown, favorites: await readFavorites(instance.data), files: await readFiles(editor, filesShown), disk: { files, texts }, focus: await readFocus(instance.app) }
}

const UNSAVED = ' (unsaved)'
const pathOf = (shown: string) => (shown.endsWith(UNSAVED) ? shown.slice(0, -UNSAVED.length) : shown)
const NO_NOTE = 'No note open'
const FAILED = / could not be opened: [^ ]+$/
// Each folder above a path, outermost first
const foldersOf = (file: string) => file.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/'))

// Every two places that disagree in one read:
// - the title against the note the editors hold current and the note the layout shows, two owners of one fact
// - the note the editors hold current against the one the layout shows. Every layout draws one editor, the core's
//   skeleton and the plain one alike, so two shown is a disagreement too
// - each note whose tab says saved against its file, a note whose file left only with the note bar saying so
// - focus in an editor against the current note, and the frame main says has focus against that frame's own word
// - the menu's stars against the settings
// - the Files rows of a shown Files view, notes and folders, against the files both ways, and a shown Files view whose
//   rows can't be read
// - each row of a drawn view carrying a note against the files, each drawn view against its tab and a shown one
//   drawing nothing
// Not compared: the Files selection, which follows the explorer's own clicks and answers and never the current note,
// as hetu tells no plugin which note is current
export function disagreements(state: State): Disagreement[] {
  const found: Disagreement[] = []
  const differ = (a: string, va: unknown, b: string, vb: unknown) => found.push({ places: [a, b], values: [va, vb] })
  const tabOf = (instance: string) => state.tabs.find(tab => tab.instance === instance)
  const shownText = (instance: string | undefined) => (instance === undefined ? NO_NOTE : tabOf(instance)?.text ?? null)

  const current = state.editors.find(editor => editor.current)
  const shown = state.editors.filter(editor => editor.shown)
  // An open that failed is named in the title over the note it left current, the current one when it was that note
  const failed = FAILED.test(state.title) ? state.title.replace(FAILED, '') : null
  const failedOnCurrent = failed !== null && current !== undefined && pathOf(tabOf(current.instance)?.text ?? '') === failed
  if (!failedOnCurrent) {
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
  for (const window of state.focus.main) {
    if (window.focusedFrame === null || window.focusedFrame === window.url) continue
    const frame = state.focus.pages.find(page => page.url === window.url)?.frames.find(each => each.url === window.focusedFrame)
    if (frame !== undefined && !frame.hasFocus) differ(`main's focused frame in ${window.url}`, window.focusedFrame, 'that frame\'s document', 'no focus')
  }

  if (state.menu !== null) {
    const favorites = new Set(state.favorites ?? [])
    for (const [key, star] of Object.entries(state.menu)) {
      if (star !== favorites.has(key)) differ(`Views menu star of ${key}`, star === null ? '(no one star)' : star ? '★' : '☆', 'settings favorites', [...favorites])
    }
  }

  const onDisk = new Set(state.disk.files)
  if (state.files !== null && state.files.rows === null && state.files.shown) differ('Files view', 'shown', 'its rows', state.files.problem)
  // Rows of a Files view another view hides aren't read by role, so they are compared only while it is shown
  if (state.files?.rows != null && state.files.shown) {
    const rows = state.files.rows
    const notes = state.disk.files.filter(file => file.endsWith('.md'))
    const folders = new Set(notes.flatMap(foldersOf))
    for (const row of rows) {
      if (!(row.folder ? folders.has(row.path) : onDisk.has(row.path))) differ(`Files row ${row.path}`, 'shown', `disk ${row.path}`, row.folder ? '(no folder with a note in it)' : '(no file)')
    }
    // A note or folder on disk shows when every folder above it is open
    const open = new Set(['', ...rows.filter(row => row.folder && row.expanded).map(row => row.path)])
    const listed = new Set(rows.map(row => row.path))
    for (const entry of [...folders, ...notes]) {
      if (foldersOf(entry).every(folder => open.has(folder)) && !listed.has(entry)) differ(`disk ${entry}`, folders.has(entry) ? 'a folder' : 'a note', 'Files tree', '(no row)')
    }
    const selected = rows.filter(row => row.selected)
    if (selected.length > 1) differ('Files selection', selected.map(row => row.path), 'one selected row', 1)
  }

  for (const view of state.drawer) {
    for (const note of view.notes) if (!onDisk.has(note)) differ(`${view.owner} row for ${note}`, 'shown', `disk ${note}`, '(no file)')
    const tab = tabOf(view.instance)
    if (tab !== undefined && !tab.text.startsWith(`${view.owner} · `)) differ(`${view.owner}'s view ${view.instance}`, view.owner, `tab ${view.instance}`, tab.text)
    if (view.shown && view.lines.length === 0) differ(`${view.owner}'s view ${view.instance}`, 'shown', 'its text', '(nothing drawn)')
  }
  return found
}

export const said = (found: readonly Disagreement[]) => found.map(({ places, values }) =>
  `${places[0]} shows ${JSON.stringify(values[0])} but ${places[1]} shows ${JSON.stringify(values[1])}`).join('\n')

export type Agreed = State & { agreedMs: number }
export type AgreeOptions = {
  // What must be true of a read before its agreement counts, so a read from before the action landed never passes
  landed?: (state: State) => boolean
  within?: number
  // How long agreement must hold, read again and again, before it counts
  hold?: number
}

// Reads every place until they all agree and keep agreeing for hold ms, at least 3 reads, as a change reaches each
// place in its own time, else fails naming each two that disagree in the last read, or why the reads didn't count. A
// read that throws mid change, a settings file half written or a frame loading, is read again. Answers the last read
// with how long after the call the agreement it held began
export const agree = (instance: Instance, options: AgreeOptions = {}) => settle(() => readState(instance), options)

export async function settle(read: () => Promise<State>, options: AgreeOptions = {}): Promise<Agreed> {
  const { landed = () => true, within = 3000, hold = 300 } = options
  const began = Date.now()
  let since: number | null = null
  let reads = 0
  let last = 'no read finished'
  for (;;) {
    const at = Date.now()
    try {
      const state = await read()
      const found = disagreements(state)
      if (!landed(state)) last = 'the action never landed'
      else if (found.length > 0) last = `the places showing hetu's state disagree:\n${said(found)}`
      if (landed(state) && found.length === 0) {
        since ??= at
        reads++
        if (reads >= 3 && Date.now() - since >= hold) return { ...state, agreedMs: since - began }
      } else [since, reads] = [null, 0]
    } catch (err) {
      [since, reads] = [null, 0]
      last = `a read failed: ${String(err)}`
    }
    if (Date.now() - began > within + hold) throw new Error(last)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
