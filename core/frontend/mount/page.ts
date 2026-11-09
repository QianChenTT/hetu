import { CORE_KEYS, Drawer, type PortLike } from './bridge.ts'
import { EditorViews } from './editor.ts'
import { keyName } from './keys.ts'
import { type Bridge, CoreLink } from './link.ts'
import { type NoteNotice, Notes } from './notes.ts'
import { filterNames, listNames } from './palette.ts'
import { RawSource } from './raw.ts'
import { type Notice, Shell } from './shell.ts'

// The editor window's page, the drawer: the banner, the notes in CodeMirror, the quick-open palette, the raw view and
// each plugin's port to the bridge. Everything here is drawn as text, never markup a plugin or a note wrote

// The preload's bridge, there only in the window's top frame
const bridge = (window as unknown as { hetu?: Bridge }).hetu
const mac = /Mac/.test(navigator.userAgent)

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`the page has no #${id}`)
  return found as T
}

function button(text: string, act: () => void): HTMLButtonElement {
  const made = document.createElement('button')
  made.type = 'button'
  made.textContent = text
  made.addEventListener('click', act)
  return made
}

// Each line and notice as text. A notice is a button that opens the trusted window at its request
function drawBanner(shell: Shell, lines: string[], notices: Notice[]): void {
  const banner = element('banner')
  banner.replaceChildren(...lines.map(line => {
    const item = document.createElement('li')
    item.textContent = line
    return item
  }))
  banner.hidden = lines.length === 0
  const shown = element('notices')
  shown.replaceChildren(...notices.map(notice => button(notice.text, () => shell.open(notice.id))))
  shown.hidden = notices.length === 0
}

// What a refusal means to the human
function refusalText(code: string, reason?: string): string {
  if (reason === 'too-large') return 'This note is past the size hetu takes, so it can\'t be saved or kept as a draft'
  if (code === 'unavailable') return 'No notes folder is picked, so nothing can be saved'
  return `hetu refused: ${code}${reason === undefined ? '' : ` (${reason})`}`
}

function start(bridge: Bridge): void {
  const link = new CoreLink(bridge)
  link.start()
  const shell: Shell = new Shell(link, (lines, notices) => drawBanner(shell, lines, notices))
  // A notice about each open note, the newest, shown for the note on screen
  const noteNotices = new Map<string, NoteNotice>()

  let notes: Notes | null = null
  let drawer: Drawer | null = null
  const views = new EditorViews(element('editors'), {
    created: instance => drawer?.opened(instance),
    changed: (instance, changes, remote) => {
      drawer?.changed(instance, changes)
      if (!remote) notes?.changed(instance.id)
      drawTitle()
      if (rawOpen) drawRawSoon()
    },
    key: (instance, event) => {
      const name = keyName(event, mac)
      return name !== null && drawer !== null && drawer.key(instance, name)
    },
  })
  const theNotes = new Notes(link, views, notice => {
    noteNotices.set(notice.instance, notice)
    drawNoteBar()
    drawTitle()
  })
  notes = theNotes
  const theDrawer = new Drawer(link, () => views.instances(), (instance, plugin) => theNotes.edited(instance, plugin), { mac })
  drawer = theDrawer
  const raw = new RawSource(link, theNotes, id => views.text(id))
  shell.onStatus = status => views.hiddenMarks(status.page.includes('hidden-marks'))

  // ---- the note on screen

  function drawTitle(): void {
    const id = views.shown()
    const note = id === null ? undefined : theNotes.opened.get(id)
    element('title').textContent = note === undefined ? 'No note open' : `${note.path}${note.dirty ? ' (unsaved)' : ''}`
  }

  function drawNoteBar(): void {
    const id = views.shown()
    const notice = id === null ? undefined : noteNotices.get(id)
    const bar = element('note-bar')
    bar.hidden = notice === undefined
    if (notice === undefined || id === null) return
    const clear = () => {
      noteNotices.delete(id)
      drawNoteBar()
    }
    const reload = button('Reload', () => {
      noteNotices.delete(id)
      void theNotes.reload(id).then(() => {
        drawNoteBar()
        drawTitle()
      })
    })
    let text: string
    let actions: HTMLButtonElement[]
    if (notice.kind === 'draft') {
      const when = new Date(notice.at).toLocaleString()
      text = `A draft of this note from ${when} is kept${notice.changedSince ? ', made before the note last changed' : ''}`
      actions = [
        button('Restore', () => {
          theNotes.restore(id)
          clear()
        }),
        button('Discard', () => void theNotes.discard(id).then(clear)),
      ]
    } else if (notice.kind === 'stale') {
      text = 'This note changed outside hetu since it was opened, so it wasn\'t saved. Your text is kept as a draft'
      actions = [reload]
    } else if (notice.kind === 'outside') {
      text = 'This note changed outside hetu while it has unsaved text. Reload keeps your text as a draft'
      actions = [reload, button('Keep mine', clear)]
    } else if (notice.kind === 'refused') {
      text = refusalText(notice.code, notice.reason)
      actions = [button('Dismiss', clear)]
    } else {
      return
    }
    element('note-text').textContent = text
    element('note-actions').replaceChildren(...actions)
  }

  async function openNote(path: string): Promise<void> {
    closePalette()
    try {
      const id = await theNotes.open(path)
      element('empty').hidden = true
      views.show(id)
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'failed'
      element('title').textContent = `${path} could not be opened: ${code}`
      return
    }
    drawTitle()
    drawNoteBar()
  }

  async function save(): Promise<void> {
    const id = views.shown()
    if (id === null) return
    if (await theNotes.save(id) === 'saved' && noteNotices.get(id)?.kind !== 'draft') noteNotices.delete(id)
    drawTitle()
    drawNoteBar()
  }

  // ---- the quick-open palette

  let names: string[] = []
  let matches: string[] = []
  let picked = 0

  function drawPalette(): void {
    matches = filterNames(names, element<HTMLInputElement>('palette-input').value)
    picked = Math.min(picked, Math.max(0, matches.length - 1))
    element('palette-list').replaceChildren(...matches.map((name, at) => {
      const item = document.createElement('li')
      item.textContent = name
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(at === picked))
      item.addEventListener('mousedown', event => {
        event.preventDefault()
        void openNote(name)
      })
      return item
    }))
  }

  async function openPalette(): Promise<void> {
    const listed = await listNames(link)
    names = listed.names
    picked = 0
    const note = element('palette-note')
    note.textContent = listed.refused !== undefined
      ? refusalText(listed.refused)
      : listed.cut ? 'Only the first 20,000 names are listed' : ''
    note.hidden = note.textContent === ''
    const input = element<HTMLInputElement>('palette-input')
    input.value = ''
    element('palette').hidden = false
    drawPalette()
    input.focus()
  }

  function closePalette(): void {
    element('palette').hidden = true
  }

  element('palette-input').addEventListener('input', () => {
    picked = 0
    drawPalette()
  })
  element('palette-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      picked = Math.max(0, Math.min(matches.length - 1, picked + (event.key === 'ArrowDown' ? 1 : -1)))
      drawPalette()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const name = matches[picked]
      if (name !== undefined) void openNote(name)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closePalette()
      views.focus()
    }
  })
  element('palette-input').addEventListener('blur', closePalette)

  // ---- the raw view

  let rawOpen = false
  let rawFocus: string | null = null
  let rawPick: string | undefined
  let rawQueued = false

  async function drawRaw(): Promise<void> {
    const shown = await raw.show(rawFocus, rawPick)
    element('raw-title').textContent = shown === null ? 'Nothing written yet' : shown.path
    element('raw-text').textContent = shown === null ? '' : shown.text
    const recent = raw.recent()
    element('raw-recent').replaceChildren(...['', ...recent].map(path => {
      const option = document.createElement('option')
      option.value = path
      option.textContent = path === '' ? '(the note in the editor)' : path
      option.selected = path === (rawPick ?? '')
      return option
    }))
  }

  // At most once a frame while the human types
  function drawRawSoon(): void {
    if (rawQueued) return
    rawQueued = true
    requestAnimationFrame(() => {
      rawQueued = false
      if (rawOpen) void drawRaw()
    })
  }

  function toggleRaw(): void {
    rawOpen = !rawOpen
    element('raw').hidden = !rawOpen
    if (rawOpen) {
      rawFocus = views.focused()
      rawPick = undefined
      element('raw').focus()
      void drawRaw()
    } else {
      views.focus()
    }
  }

  element('raw-recent').addEventListener('change', () => {
    const value = element<HTMLSelectElement>('raw-recent').value
    rawPick = value === '' ? undefined : value
    void drawRaw()
  })
  element('raw-close').addEventListener('click', toggleRaw)
  link.on('luoshu.changed', () => {
    if (rawOpen) drawRawSoon()
  })
  link.on('luoshu.outside', () => {
    if (rawOpen) drawRawSoon()
  })

  // ---- the core keys, taken before CodeMirror or any binding

  window.addEventListener('keydown', event => {
    const name = keyName(event, mac)
    if (name === 'Escape' && rawOpen) {
      event.preventDefault()
      toggleRaw()
      return
    }
    if (name === null || !CORE_KEYS.includes(name)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat) return
    if (name === 'Mod-/') toggleRaw()
    else if (name === 'Mod-p') void openPalette()
    else if (name === 'Mod-s') void save()
    else if (name === 'Mod-q') void link.call('core.quit')
  }, true)

  element('open').addEventListener('click', () => void openPalette())
  element('security').addEventListener('click', () => shell.open())

  // ---- each plugin's port to the bridge, from main through the preload

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return
    const data = event.data as { hetu?: unknown, plugin?: unknown, incarnation?: unknown } | null
    if (typeof data?.plugin !== 'string' || typeof data.incarnation !== 'number') return
    const port = event.ports[0]
    if (data.hetu === 'drawer' && port !== undefined) theDrawer.connect(data.plugin, data.incarnation, port as unknown as PortLike)
    else if (data.hetu === 'drawer-end') theDrawer.end(data.plugin, data.incarnation)
  })

  shell.start()
  theNotes.start()
  theDrawer.start()
  raw.start()
}

if (bridge !== undefined) start(bridge)
