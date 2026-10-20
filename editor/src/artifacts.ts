// <Artifact src="./x.artifact.html" name="x" height="360" state='{...}' /> lines, drawn as sandboxed
// frames, plus the note-side half of the bridge: anchors, highlight, popup, state and the bus

import { EditorState, Facet, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, showTooltip, type DecorationSet, type Tooltip } from '@codemirror/view'
import { parseTag } from './html'
import { grantsFor, type Capability } from './policy'
import { Sandbox } from './sandbox'

const ARTIFACT_LINE = /^\s*<Artifact\b[^<>]*\/>\s*$/

// The vault path of the open note, so an artifact's src resolves against the note's own folder
export const notePath = Facet.define<string, string>({ combine: (values) => values[0] ?? '' })

// Read through the daemon as inert text. The sandbox puts it into a srcdoc frame, so it never gets a URL of its own
async function loadArtifact(src: string, from: string): Promise<string> {
  const resolved = new URL(src, `file:///${from}`).pathname.slice(1)
  const res = await fetch(`/api/files/${resolved.split('/').map(encodeURIComponent).join('/')}`)
  if (!res.ok) throw new Error(`can't load ${src}`)
  return res.text()
}

// --- Anchors: a heading's slug ("## Execute" is "execute") or an explicit {#id} at its end ---

const slug = (s: string) => s.toLowerCase().replace(/\{#[\w-]+\}/, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// The section an anchor names: from its heading line to the line before the next heading of the same or higher level
function findSection(state: EditorState, anchor: string): { from: number; to: number } | null {
  const doc = state.doc
  for (let i = 1; i <= doc.lines; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(doc.line(i).text)
    if (!m) continue
    const id = /\{#([\w-]+)\}\s*$/.exec(m[2])?.[1]
    if (anchor !== id && anchor !== slug(m[2])) continue
    const level = m[1].length
    let end = i
    for (let j = i + 1; j <= doc.lines; j++) {
      const h = /^(#{1,6})\s/.exec(doc.line(j).text)
      if (h && h[1].length <= level) break
      end = j
    }
    return { from: doc.line(i).from, to: doc.line(end).to }
  }
  return null
}

// --- Highlight and popup, set by artifacts through the bridge ---

const setHighlight = StateEffect.define<{ from: number; to: number } | null>()
const setPopup = StateEffect.define<{ pos: number; text: string } | null>()

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setHighlight)) continue
      if (!e.value) return Decoration.none
      const out: Range<Decoration>[] = []
      for (let pos = e.value.from; pos <= e.value.to; ) {
        const line = tr.state.doc.lineAt(pos)
        out.push(Decoration.line({ class: 'cm-anchor-hl' }).range(line.from))
        pos = line.to + 1
      }
      value = Decoration.set(out)
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f),
})

const popupField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setPopup)) continue
      if (!e.value) return null
      const { pos, text } = e.value
      return {
        pos,
        above: true,
        create: () => {
          const dom = document.createElement('div')
          dom.className = 'cm-artifact-popup'
          // Text only, never HTML: artifacts can't inject markup into the app
          dom.textContent = text
          return { dom }
        },
      }
    }
    return value && tr.docChanged ? { ...value, pos: tr.changes.mapPos(value.pos) } : value
  },
  provide: (f) => showTooltip.from(f),
})

// --- Finding and editing an artifact's own tag line ---

function findTag(state: EditorState, name: string) {
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (!ARTIFACT_LINE.test(line.text)) continue
    const tag = parseTag(line.text)
    if (tag && tag.name === 'Artifact' && (tag.attrs.name ?? tag.attrs.src) === name) return { line, tag }
  }
  return null
}

// Rewrite only the state attribute, leaving the rest of the tag exactly as written
function writeState(view: EditorView, name: string, value: unknown) {
  const found = findTag(view.state, name)
  if (!found) throw new Error('artifact tag not found')
  const json = JSON.stringify(value ?? null).replace(/'/g, '\\u0027')
  const { line } = found
  const m = /\sstate\s*=\s*('[^']*'|"[^"]*")/.exec(line.text)
  const change = m
    ? { from: line.from + m.index, to: line.from + m.index + m[0].length, insert: ` state='${json}'` }
    : { from: line.from + line.text.lastIndexOf('/>'), insert: `state='${json}' ` }
  view.dispatch({ changes: change, userEvent: 'artifact.state' })
}

function readState(state: EditorState, name: string): unknown {
  const raw = findTag(state, name)?.tag.attrs.state
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// --- The live frames of each editor, for the bus ---

const frames = new WeakMap<EditorView, Map<string, Sandbox>>()
const framesOf = (view: EditorView) => frames.get(view) ?? frames.set(view, new Map()).get(view)!
const live = new WeakMap<HTMLElement, { view: EditorView; sandbox: Sandbox }>()

function handler(view: EditorView) {
  return (cap: Capability, args: unknown[], sandbox: Sandbox): unknown => {
    const str = (i: number) => (typeof args[i] === 'string' ? (args[i] as string) : '')
    switch (cap) {
      case 'note.read':
        return view.state.doc.toString()
      case 'note.highlight': {
        const section = str(0) ? findSection(view.state, str(0)) : null
        view.dispatch({ effects: setHighlight.of(section) })
        return !!section
      }
      case 'note.popup': {
        const section = str(0) ? findSection(view.state, str(0)) : null
        view.dispatch({ effects: setPopup.of(section ? { pos: section.from, text: str(1).slice(0, 500) } : null) })
        return !!section
      }
      case 'note.scrollTo': {
        const section = findSection(view.state, str(0))
        if (section) view.dispatch({ effects: EditorView.scrollIntoView(section.from, { y: 'center' }) })
        return !!section
      }
      case 'state.get':
        return readState(view.state, sandbox.name)
      case 'state.set':
        // While an agent holds the note the editor is view only, and an artifact can't write into it either
        if (view.state.readOnly) return false
        writeState(view, sandbox.name, args[0])
        return true
      case 'bus.subscribe':
        sandbox.topics.add(str(0))
        return true
      case 'bus.publish':
        for (const other of framesOf(view).values()) if (other !== sandbox) other.emit(str(0), args[1], sandbox.name)
        return true
      case 'frame.resize':
        sandbox.frame.style.height = `${Math.min(Math.max(Number(args[0]) || 0, 40), 2000)}px`
        return true
    }
  }
}

class ArtifactWidget extends WidgetType {
  constructor(readonly attrs: Record<string, string>) {
    super()
  }
  // The state attribute is left out on purpose: saving state must not reload the frame
  key() {
    const { state: _state, ...rest } = this.attrs
    return JSON.stringify(rest)
  }
  eq(other: ArtifactWidget) {
    return other.key() === this.key()
  }
  toDOM(view: EditorView) {
    const name = this.attrs.name ?? this.attrs.src
    const wrap = document.createElement('div')
    wrap.className = 'cm-artifact'
    const label = document.createElement('div')
    label.className = 'cm-artifact-label'
    const grants = grantsFor(this.attrs)
    label.textContent = `artifact · ${name}${grants.network.length ? ` · network: ${grants.network.join(', ')}` : ''}${grants.capabilities.has('note.read') ? ' · reads note' : ''}`
    wrap.appendChild(label)
    loadArtifact(this.attrs.src, view.state.facet(notePath))
      .then((html) => {
        const sandbox = new Sandbox(name, html, grants, () => ({ name, state: readState(view.state, name) }), handler(view))
        sandbox.frame.style.height = `${Number(this.attrs.height) || 360}px`
        framesOf(view).get(name)?.destroy()
        framesOf(view).set(name, sandbox)
        live.set(wrap, { view, sandbox })
        wrap.appendChild(sandbox.frame)
      })
      .catch((e) => {
        label.textContent += ` · ${e.message}`
      })
    return wrap
  }
  destroy(dom: HTMLElement) {
    const entry = live.get(dom)
    if (!entry) return
    const map = framesOf(entry.view)
    if (map.get(entry.sandbox.name) === entry.sandbox) map.delete(entry.sandbox.name)
    entry.sandbox.destroy()
    live.delete(dom)
  }
  ignoreEvent() {
    return true
  }
}

function artifactDecorations(state: EditorState): DecorationSet {
  const out: Range<Decoration>[] = []
  const sel = state.selection.main
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    if (!ARTIFACT_LINE.test(line.text)) continue
    // Cursor on the line: show the tag's source for editing
    if (sel.from <= line.to && sel.to >= line.from) continue
    const tag = parseTag(line.text)
    if (!tag || tag.name !== 'Artifact' || tag.kind !== 'self' || !tag.attrs.src) continue
    out.push(Decoration.replace({ widget: new ArtifactWidget(tag.attrs), block: true }).range(line.from, line.to))
  }
  return Decoration.set(out)
}

const artifactBlocks = StateField.define<DecorationSet>({
  create: artifactDecorations,
  update: (value, tr) => (tr.docChanged || tr.selection ? artifactDecorations(tr.state) : value),
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
})

export const artifacts = [artifactBlocks, highlightField, popupField]
