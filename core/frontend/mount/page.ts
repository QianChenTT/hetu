import type { CoreViewsPlugin } from '../../api/actions.ts'
import type { Payload } from '../../api/ui.ts'
import { Drawer, type PortLike } from './bridge.ts'
import { accepts, DragGesture, fraction, splitSizes, zoneAt } from './drag.ts'
import { type DrawHooks, fillerOf, taggedOf } from './draw.ts'
import { EditorViews } from './editor.ts'
import { CORE_KEY_NAMES, type CoreKey, coreKeyOf, keyName } from './keys.ts'
import { Layers } from './layers.ts'
import { type Bridge, CoreLink } from './link.ts'
import { drawMenu, type MenuData } from './menu.ts'
import { type NoteNotice, Notes } from './notes.ts'
import { Frames } from './frames.ts'
import { filterNames, listNames } from './palette.ts'
import { RawSource } from './raw.ts'
import { Settings } from './settings.ts'
import { type Notice, Shell } from './shell.ts'
import { themeStyle } from './theme.ts'
import { OWN_LAYOUT, SKELETON } from './ui-port.ts'

// The editor window's page, the drawer: the banner, the notes in CodeMirror, the quick-open palette, the raw view, the
// views menu, the layout's skeleton with the views in it and each plugin's port. Everything here is drawn as text,
// never markup a plugin or a note wrote, and what plugins draw stays below the core layer

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
  if (code === 'throttled') return 'hetu is busy, so not every note is listed yet. Open this again in a moment'
  return `hetu refused: ${code}${reason === undefined ? '' : ` (${reason})`}`
}

// A press followed on the window until it is released, as a click or a drag
function track(start: PointerEvent, moved: (event: PointerEvent, dragging: boolean) => void, ended: (event: PointerEvent, how: 'drop' | 'click' | 'cancel') => void): void {
  const gesture = new DragGesture(start.clientX, start.clientY)
  const move = (event: PointerEvent) => {
    if (event.isTrusted) moved(event, gesture.move(event.clientX, event.clientY) === 'dragging')
  }
  const up = (event: PointerEvent) => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
    ended(event, event.type === 'pointercancel' || !event.isTrusted ? 'cancel' : gesture.end())
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
}

function start(bridge: Bridge): void {
  const link = new CoreLink(bridge)
  link.start()
  const shell: Shell = new Shell(link, (lines, notices) => drawBanner(shell, lines, notices))
  const settings = new Settings(link)
  // A notice about each open note, the newest, shown for the note on screen
  const noteNotices = new Map<string, NoteNotice>()
  let declared: CoreViewsPlugin[] = []
  let themeFallback = false

  let notes: Notes | null = null
  let drawer: Drawer | null = null
  let layers: Layers | null = null
  let frames: Frames | null = null
  const views = new EditorViews(element('editors'), {
    created: instance => drawer?.opened(instance),
    changed: (instance, changes, remote, hid) => {
      drawer?.changed(instance, changes)
      if (!remote) notes?.changed(instance.id)
      for (const plugin of hid) notes?.edited(instance.id, plugin)
      drawTitle()
      layers?.schedule()
      if (rawOpen) drawRawSoon()
    },
    key: (instance, event) => {
      const name = keyName(event, mac)
      return name !== null && drawer !== null && drawer.key(instance, name)
    },
    focused: () => {
      drawTitle()
      drawNoteBar()
      layers?.schedule()
    },
  })
  const theNotes = new Notes(link, views, notice => {
    noteNotices.set(notice.instance, notice)
    drawNoteBar()
    drawTitle()
  })
  notes = theNotes
  const theDrawer = new Drawer(link, () => views.instances(), (instance, plugin) => theNotes.edited(instance, plugin), {
    mac,
    ui: {
      settings: () => settings.value,
      hooks: {
        drawn: (owner, surface) => layers?.drawn(owner, surface),
        changed: () => {
          layers?.changed()
          drawMenuSoon()
        },
        // A post that lands answers null, so a missing Frames has to be told apart from it
        post: (owner, instance, data) => (frames === null ? 'unavailable' : frames.post(owner, instance, data)),
        // A plugin's open adds the note without taking the human's focus or the current note from them
        open: (path, reads) => openNote(path, false, undefined, reads),
      },
    },
  })
  drawer = theDrawer
  const ui = theDrawer.ui
  const raw = new RawSource(link, theNotes, id => views.text(id))
  shell.onStatus = status => views.hiddenMarks(status.page.includes('hidden-marks'))

  // ---- the layers plugins draw in

  const stage = element('stage')
  const ghost = element('drag-ghost')
  const mark = element('drop-mark')
  const drawHooks = (owner: string, surface: string): DrawHooks => ({
    event: (node, type, value) => ui.nodeEvent(owner, surface, node, type, value),
    dragStart: (_node, payload, event) => payloadDrag(owner, payload, event),
    divider: (node, index, event, split) => dividerDrag(owner, surface, node, index, event, split),
    iconUrl: src => `hetu://views/icon/${owner}/${src}`,
    scrolled: () => listScrolled(owner, surface),
  })
  const theFrames = new Frames(link, element('editors'), (owner, instance, data) => ui.frameMessage(owner, instance, data), instance => {
    const held = ui.views.get(instance)
    return held === null || held.down
  })
  frames = theFrames
  const theLayers = new Layers(
    { stage, base: element('base'), lifted: element('editors'), overlay: element('overlay'), empty: element('empty') },
    {
      ui,
      editors: views,
      frames: theFrames,
      titles: {
        view: id => {
          const held = ui.views.get(id)
          // The plugin by its id, which the core checks and no plugin can make read as hetu
          return held === null ? null : { text: `${held.owner} · ${held.runtimeTitle ?? held.spec.title}`, down: held.down }
        },
        note: id => {
          const note = theNotes.opened.get(id)
          return note === undefined ? null : `${note.path}${note.dirty ? ' (unsaved)' : ''}`
        },
      },
      hooks: {
        drawHooks,
        titlePressed: (instance, event) => viewDrag(instance, event),
        titleClicked: (owner, node) => ui.nodeEvent(owner, SKELETON, node, 'click'),
        state: geometry => ui.state({
          ...geometry, views: ui.views.list(settings.value.favorites), editors: views.ids(), current: views.shown(),
        }),
      },
    },
  )
  layers = theLayers
  views.onCurrent = () => {
    theLayers.place()
    drawTitle()
    drawNoteBar()
  }

  // Where the pointer is on the stage
  const onStage = (event: PointerEvent) => {
    const box = stage.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  function showAt(target: HTMLElement, box: { left: number, top: number, width: number, height: number } | null): void {
    target.hidden = box === null
    if (box === null) return
    const at = stage.getBoundingClientRect()
    target.style.left = `${at.left + box.left}px`
    target.style.top = `${at.top + box.top}px`
    target.style.width = `${box.width}px`
    target.style.height = `${box.height}px`
  }

  function moveGhost(event: PointerEvent, text: string): void {
    ghost.textContent = text
    ghost.hidden = false
    ghost.style.left = `${event.clientX + 12}px`
    ghost.style.top = `${event.clientY + 12}px`
  }

  // A view's title dragged onto one of the layout's zones. The zones light up as the pointer moves with no worker asked,
  // and only the drop goes to the layout
  function viewDrag(instance: string, start: PointerEvent): void {
    const held = ui.views.get(instance)
    if (held === null || ui.layout() === null) return
    const text = `${ui.views.name(held.owner)} · ${held.spec.title}`
    let zones = theLayers.zones()
    track(start, (event, dragging) => {
      if (!dragging) return
      moveGhost(event, text)
      const at = onStage(event)
      if (zones.length === 0) zones = theLayers.zones()
      showAt(mark, zoneAt(zones, at.x, at.y)?.rect ?? null)
    }, (event, how) => {
      ghost.hidden = true
      mark.hidden = true
      if (how !== 'drop') return
      const at = onStage(event)
      const zone = zoneAt(zones, at.x, at.y)
      if (zone === null) return
      const where = fraction(zone.rect, at.x, at.y)
      ui.viewDropped(instance, zone.zone, where.x, where.y)
    })
  }

  // What a payload would land on under the pointer: an editor for a note's path, or a node that accepts it
  function dropTarget(event: PointerEvent, payload: Payload): { editor: true } | { owner: string, surface: string, node: string, element: HTMLElement } | null {
    const under = document.elementFromPoint(event.clientX, event.clientY)
    if (under === null) return null
    if (payload.type === 'note' && (under.closest('.editor') !== null || under.closest('#empty') !== null)) return { editor: true }
    const tag = taggedOf(under)
    if (tag === null || !accepts(tag.tree.accepts(tag.id), payload)) return null
    return { owner: tag.tree.owner, surface: tag.tree.surface, node: tag.id, element: tag.tree.element(tag.id) as HTMLElement }
  }

  // A node's payload dragged onto a node that accepts its type, or a note's path onto an editor, which opens it. A
  // click on a node carrying a note's path opens the note too. The gesture is the human's, so the window's own read
  // opens it and the target still needs its own grant to read the note
  function payloadDrag(owner: string, payload: Payload, start: PointerEvent): void {
    track(start, (event, dragging) => {
      if (!dragging) return
      moveGhost(event, payload.value)
      const target = dropTarget(event, payload)
      if (target === null) showAt(mark, null)
      else if ('editor' in target) showAt(mark, { left: 0, top: 0, width: stage.clientWidth, height: stage.clientHeight })
      else {
        const box = target.element.getBoundingClientRect()
        const at = stage.getBoundingClientRect()
        showAt(mark, { left: box.left - at.left, top: box.top - at.top, width: box.width, height: box.height })
      }
    }, (event, how) => {
      ghost.hidden = true
      mark.hidden = true
      if (how === 'click') {
        if (payload.type === 'note') void openNote(payload.value, true, owner)
        return
      }
      if (how !== 'drop') return
      const target = dropTarget(event, payload)
      if (target === null) return
      if ('editor' in target) void openNote(payload.value, true, owner)
      else ui.nodeEvent(target.owner, target.surface, target.node, 'drop', undefined, payload)
    })
  }

  // A split's divider moved by the drawer while the pointer moves. The owner hears the sizes once it is released
  function dividerDrag(owner: string, surface: string, node: string, index: number, start: PointerEvent, split: HTMLElement): void {
    const spec = theLayers.treeOf(owner, surface).node(node)
    if (spec?.kind !== 'split') return
    const children = [...split.children].filter(child => !(child as HTMLElement).dataset.divider) as HTMLElement[]
    const across = spec.direction === 'row'
    const from = children.map(child => (across ? child.getBoundingClientRect().width : child.getBoundingClientRect().height))
    let sizes = from.map(size => Math.round(size))
    track(start, event => {
      const delta = across ? event.clientX - start.clientX : event.clientY - start.clientY
      sizes = splitSizes(from, spec.min, index, Math.round(delta)).map(size => Math.round(size))
      const filler = fillerOf(spec.sizes, children.length)
      children.forEach((child, at) => child.style.setProperty('flex', at === filler ? '1 1 0' : `0 0 ${sizes[at]}px`))
      theLayers.schedule()
    }, (_event, how) => {
      if (how !== 'cancel') ui.resized(owner, surface, node, sizes)
    })
  }

  const listsQueued = new Set<string>()
  function listScrolled(owner: string, surface: string): void {
    const key = `${owner} ${surface}`
    if (listsQueued.has(key)) return
    listsQueued.add(key)
    requestAnimationFrame(() => {
      listsQueued.delete(key)
      theLayers.treeOf(owner, surface).refresh()
      theLayers.schedule()
    })
  }

  // ---- views, themes and settings

  async function readViews(): Promise<void> {
    const got = await link.call('core.views')
    if (!got.ok) return
    declared = (got.result as { plugins: CoreViewsPlugin[] }).plugins
    ui.views.declared(declared)
    applyTheme()
    theLayers.changed()
    drawMenuSoon()
  }

  // The picked theme's variables on the base and lifted layers only, never the core layer
  let themed: string[] = []
  function applyTheme(): void {
    const spec = declared.find(plugin => plugin.plugin === settings.value.theme)?.theme ?? null
    const { variables, editorFallback } = themeStyle(spec)
    themeFallback = editorFallback
    for (const target of [element('base'), element('editors')]) {
      for (const name of themed) target.style.removeProperty(name)
      for (const [name, value] of Object.entries(variables)) target.style.setProperty(name, value)
    }
    themed = Object.keys(variables)
  }

  settings.onChange = () => {
    ui.settingsChanged()
    applyTheme()
    theLayers.favorites = settings.value.favorites
    theLayers.changed()
    drawMenuSoon()
  }

  // ---- the views menu, in the core layer

  let menuOpen = false
  let menuQueued = false
  function menuData(): MenuData {
    const name = (id: string) => declared.find(plugin => plugin.plugin === id)?.name ?? id
    const shown = theLayers.shownViews()
    return {
      layouts: ui.layoutChoices().map(id => ({ id, name: `${name(id)} (${id})` })),
      // Plain is the empty choice. No pick at all is hetu's own
      layout: settings.value.plain ? null : settings.value.layout ?? OWN_LAYOUT,
      themes: declared.filter(plugin => plugin.theme !== null).map(plugin => ({ id: plugin.plugin, name: plugin.name })),
      theme: settings.value.theme,
      themeFallback,
      views: declared.flatMap(plugin => Object.entries(plugin.views).map(([view, spec]) => {
        const key = `${plugin.plugin}/${view}`
        const first = ui.views.all().find(held => held.owner === plugin.plugin && held.view === view && held.first) ?? null
        return {
          key, name: `${plugin.name} (${plugin.plugin})`, title: spec.title, running: first !== null && !first.down, favorite: settings.value.favorites.includes(key),
          instance: first?.instance ?? null, shown: first !== null && shown.has(first.instance),
        }
      })),
      conflicts: theDrawer.conflicts().map(conflict => ({
        key: conflict.key, plugins: conflict.plugins.map(id => ({ id, name: `${name(id)} (${id})` })), owner: settings.value.keys[conflict.key] ?? null,
      })),
    }
  }

  function drawMenuSoon(): void {
    if (!menuOpen || menuQueued) return
    menuQueued = true
    requestAnimationFrame(() => {
      menuQueued = false
      if (menuOpen) drawTheMenu()
    })
  }

  function drawTheMenu(): void {
    drawMenu(element('menu-body'), menuData(), {
      pickLayout: id => void settings.pickLayout(id),
      pickTheme: id => void settings.pickTheme(id),
      favorite: (key, on) => void settings.favorite(key, on),
      show: instance => ui.openView(instance),
      hide: instance => ui.closeView(instance),
      ownKey: (key, plugin) => void settings.ownKey(key, plugin),
    })
  }

  function toggleMenu(open = !menuOpen): void {
    menuOpen = open
    element('menu').hidden = !open
    if (open) {
      drawTheMenu()
      element('menu').focus()
    } else {
      views.focus()
    }
  }

  element('views').addEventListener('click', () => toggleMenu())
  element('menu-close').addEventListener('click', () => toggleMenu(false))

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
    if (notice === undefined || id === null) {
      element('note-text').textContent = ''
      element('note-actions').replaceChildren()
      return
    }
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

  // focus false opens the note beside the others for the layout to place, leaving the current one current: a plugin's
  // open, which isn't the human's, whose reads judges the path the luoshu resolved. via names the plugin whose node
  // named the note
  async function openNote(path: string, focus = true, via?: string, reads?: (resolved: string) => Promise<boolean>): Promise<void> {
    if (focus) closePalette()
    try {
      const id = await theNotes.open(path, reads)
      const opened = views.instance(id)
      if (focus && opened !== undefined) void drawer?.humanOpened(opened, via)
      if (!focus) {
        // With no note current nothing the human types can go astray, so it becomes current, still without focus
        if (views.shown() === null) views.show(id, false)
        else theLayers.schedule()
        return
      }
      views.show(id)
    } catch (err) {
      if (!focus) return
      const code = (err as { code?: string }).code ?? 'failed'
      element('title').textContent = `${path} could not be opened: ${code}`
      return
    }
    drawTitle()
    drawNoteBar()
  }

  // Every dirty note kept as a draft before hetu quits, so nothing typed in the last second is lost
  async function quit(): Promise<void> {
    await theNotes.keepAll()
    await link.call('core.quit')
  }

  async function save(): Promise<void> {
    const id = views.shown()
    if (id === null) return
    if (await theNotes.save(id) === 'saved' && noteNotices.get(id)?.kind !== 'draft') noteNotices.delete(id)
    drawTitle()
    drawNoteBar()
    theLayers.schedule()
  }

  // ---- the quick-open palette

  let names: string[] = []
  let matches: string[] = []
  let picked = 0
  // Each opening's listing, so pages of an older one still coming are dropped
  let listing = 0

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
    const run = ++listing
    names = []
    picked = 0
    const note = element('palette-note')
    note.textContent = 'Listing notes'
    note.hidden = false
    const input = element<HTMLInputElement>('palette-input')
    input.value = ''
    element('palette').hidden = false
    drawPalette()
    input.focus()
    // Names show as each page comes, so a large luoshu is searchable while the rest are listed
    const listed = await listNames(link, {
      onPage: page => {
        if (run !== listing) return
        names.push(...page)
        note.textContent = `Listing notes, ${names.length} so far`
        drawPalette()
      },
    })
    if (run !== listing) return
    names = listed.names
    note.textContent = listed.refused !== undefined
      ? refusalText(listed.refused)
      : listed.cut ? 'Only the first 20,000 names are listed' : ''
    note.hidden = note.textContent === ''
    drawPalette()
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
      // The note being typed in, else the one on screen, as after a click on the bar's button
      rawFocus = views.focused() ?? views.shown()
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

  // ---- the core keys, taken before CodeMirror, any view or any binding

  function coreKey(core: CoreKey): void {
    if (core === 'raw') toggleRaw()
    else if (core === 'open') void openPalette()
    else if (core === 'save') void save()
    else void quit()
  }

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && rawOpen) {
      event.preventDefault()
      toggleRaw()
      return
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault()
      toggleMenu(false)
      return
    }
    const core = coreKeyOf(event, mac)
    if (core === null) return
    event.preventDefault()
    event.stopPropagation()
    if (event.repeat) return
    coreKey(core)
  }, true)

  // A key outside the editors and the core layer: the focused view's own bindings, then the global ones. In an editor
  // CodeMirror's own keymaps come first and hand the rest to the bindings themselves
  window.addEventListener('keydown', event => {
    if (event.defaultPrevented || !event.isTrusted) return
    const active = document.activeElement
    if (active === null || active.closest('.cm-editor, #palette, #raw, #menu, #bar, #note-bar, #notices') !== null) return
    const name = keyName(event, mac)
    if (name === null) return
    const tag = taggedOf(active)
    const took = tag !== null && tag.tree.surface !== SKELETON ? theDrawer.viewKey(tag.tree.surface, name) : theDrawer.key(null, name)
    if (took) event.preventDefault()
  })

  element('open').addEventListener('click', () => void openPalette())
  element('raw-open').addEventListener('click', toggleRaw)
  element('security').addEventListener('click', () => shell.open())

  // ---- each plugin's port to the bridge, from main through the preload

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return
    const data = event.data as { hetu?: unknown, plugin?: unknown, incarnation?: unknown, key?: unknown } | null
    // A core key main took before any frame could, since a frame with focus would hear it first
    if (data?.hetu === 'key' && typeof data.key === 'string' && (CORE_KEY_NAMES as readonly string[]).includes(data.key)) {
      if (data.key === 'raw' && rawOpen) toggleRaw()
      else coreKey(data.key as CoreKey)
      return
    }
    if (typeof data?.plugin !== 'string' || typeof data.incarnation !== 'number') return
    const port = event.ports[0]
    if (data.hetu === 'drawer' && port !== undefined) theDrawer.connect(data.plugin, data.incarnation, port as unknown as PortLike)
    else if (data.hetu === 'drawer-end') theDrawer.end(data.plugin, data.incarnation)
  })

  link.on('core.status', () => void readViews())
  link.on('core.security', () => void readViews())

  // A frame that took focus on its own is closed and the note gets it back
  theFrames.onTheft = () => views.focus()
  window.addEventListener('blur', () => theFrames.checkFocus())

  // A press anywhere but on a frame's shield puts every frame back behind its shield
  window.addEventListener('pointerdown', event => {
    if (!(event.target instanceof Element) || event.target.closest('.hetu-frame-shield') === null) theFrames.deactivate()
  }, true)

  shell.start()
  theNotes.start()
  theDrawer.start()
  raw.start()
  void settings.load().then(readViews)
  theLayers.place()
}

if (bridge !== undefined) start(bridge)
