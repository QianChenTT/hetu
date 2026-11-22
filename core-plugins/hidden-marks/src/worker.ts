import { syntaxTreeAvailable } from '@codemirror/language'
import { ChangeSet, EditorState } from '@codemirror/state'
import { definePlugin, type PluginContext } from '@hetu/sdk'
import { hiddenMarks, keepNearest, markdownSupport, type Named } from './marks.ts'

// Hidden marks as a worker behind the editor bridge. It keeps a copy of each open note's text from editor.read, in
// step with each change list editor.changed brings and read again when a version is missed. It marks the range the
// editor draws and a margin around it, so the bridge's cap on marks holds for a note of any length

// The bridge's cap on one plugin's marks on one note
export const MAX_MARKS = 5000
// Characters marked past each end of the range the editor draws, so a short scroll shows marked text at once
export const MARGIN = 2000
const SET = 'marks'
// Changes held while a read is out. Past it they are dropped and the note is read again
export const MAX_HEARD = 1000
// The characters of an element's start that tell it from others with its node and length, after a read again
const SIGNED = 32

// The notes the latest run holds, which its tests count
let held: ReadonlyMap<string, unknown> = new Map()
export const heldNotes = (): number => held.size

type Range = { from: number, to: number }
// An element's group, kept by the node and where it starts and mapped through each change, so the name holds while
// the human types inside the element or above it. After a read again the starts may be off, so the name goes to the
// element that reads the same: its node, its length and its start's characters
type Kept = { name: string, from: number, sign: string, group: string }
type Note = {
  // Null until a read lands. A read out holds the changes heard meanwhile up to MAX_HEARD and lost says some were
  // dropped
  state: EditorState | null
  version: number
  reading: boolean
  heard: { version: number, changes: unknown }[]
  lost: boolean
  viewport: Range
  groups: Kept[]
  reread: boolean
  named: number
  drawing: boolean
  again: boolean
}

export default definePlugin({
  async start(ctx: PluginContext) {
    const notes = new Map<string, Note>()
    held = notes

    const fresh = (instance: string, viewport: Range = { from: 0, to: 0 }): Note => {
      const note: Note = {
        state: null, version: 0, reading: false, heard: [], lost: false, viewport, groups: [], reread: false, named: 0, drawing: false, again: false,
      }
      notes.set(instance, note)
      void read(instance, note)
      return note
    }

    // A change list onto the copy, false when it doesn't fit the text
    const apply = (note: Note, changes: unknown): boolean => {
      if (note.state === null) return false
      let set: ChangeSet
      try {
        set = ChangeSet.fromJSON(changes)
        note.state = note.state.update({ changes: set }).state
      } catch {
        return false
      }
      note.groups = note.groups.map(kept => ({ ...kept, from: set.mapPos(kept.from, 1) }))
      return true
    }

    // A note closed meanwhile is forgotten. After any other refusal the range and the names stay and the next event
    // reads again
    const read = async (instance: string, note: Note) => {
      note.reread ||= note.state !== null
      Object.assign(note, { state: null, reading: true, heard: [], lost: false })
      const got = await ctx.try(ctx.editor.read(instance))
      if (notes.get(instance) !== note) return
      note.reading = false
      if (!got.ok) return void (got.refused.code === 'not-found' && notes.delete(instance))
      if (note.lost) return void read(instance, note)
      note.state = EditorState.create({ doc: got.value.text, extensions: [markdownSupport()] })
      note.version = got.value.version
      const heard = note.heard
      note.heard = []
      for (const { version, changes } of heard) if (!step(instance, note, version, changes)) return
      draw(instance, note)
    }

    // A change at version onto the copy. A version missed reads the text again. False when it did
    const step = (instance: string, note: Note, version: number, changes: unknown): boolean => {
      if (version <= note.version) return true
      if (version !== note.version + 1 || !apply(note, changes)) {
        void read(instance, note)
        return false
      }
      note.version = version
      return true
    }

    const draw = (instance: string, note: Note) => {
      if (note.drawing) return void (note.again = true)
      if (note.state === null) return
      note.drawing = true
      const state = note.state
      const length = state.doc.length
      const viewport = { from: Math.min(note.viewport.from, length), to: Math.min(note.viewport.to, length) }
      const range = { from: Math.max(0, viewport.from - MARGIN), to: Math.min(length, viewport.to + MARGIN) }
      const signOf = (named: Named) => `${named.to - named.from} ${state.sliceDoc(named.from, Math.min(named.to, named.from + SIGNED))}`
      const reread = note.reread
      const keyOf = (name: string, from: number, sign: string) => (reread ? `${name} ${sign}` : `${name} ${from}`)
      const known = new Map<string, string[]>()
      for (const kept of note.groups) {
        const key = keyOf(kept.name, kept.from, kept.sign)
        known.set(key, [...known.get(key) ?? [], kept.group])
      }
      note.reread = false
      const groups: Kept[] = []
      const elements = hiddenMarks(state, [range], named => {
        const sign = signOf(named)
        const group = known.get(keyOf(named.name, named.from, sign))?.shift() ?? `g${++note.named}`
        groups.push({ name: named.name, from: named.from, sign, group })
        return group
      })
      note.groups = groups
      // Text not parsed yet is marked on a later pass
      note.again ||= !syntaxTreeAvailable(state, range.to)
      void ctx.try(ctx.editor.decorate(instance, note.version, SET, keepNearest(elements, viewport, MAX_MARKS))).then(sent => {
        note.drawing = false
        if (notes.get(instance) !== note) return
        if (!sent.ok && sent.refused.code === 'not-found') return void notes.delete(instance)
        if (!sent.ok && sent.refused.code === 'stale') return void read(instance, note)
        if (note.again) {
          note.again = false
          setTimeout(() => draw(instance, note), 0)
        }
      })
    }

    ctx.editor.on('opened', event => {
      if (event.topic === 'editor.opened') fresh(event.instance, notes.get(event.instance)?.viewport)
    })
    ctx.editor.on('closed', event => {
      if (event.topic === 'editor.closed') notes.delete(event.instance)
    })
    ctx.editor.on('viewport', event => {
      if (event.topic !== 'editor.viewport') return
      const note = notes.get(event.instance)
      if (note === undefined) return void fresh(event.instance, { from: event.from, to: event.to })
      note.viewport = { from: event.from, to: event.to }
      if (note.state === null && !note.reading) void read(event.instance, note)
      else draw(event.instance, note)
    })
    ctx.editor.on('changed', event => {
      if (event.topic !== 'editor.changed') return
      const note = notes.get(event.instance) ?? fresh(event.instance)
      if (note.state !== null) {
        if (step(event.instance, note, event.version, event.changes)) draw(event.instance, note)
      } else if (!note.reading) void read(event.instance, note)
      else if (note.heard.length < MAX_HEARD) note.heard.push({ version: event.version, changes: event.changes })
      else note.lost = true
    })
    await ctx.try(ctx.editor.viewports(true))
  },
})
