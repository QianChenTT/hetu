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

type Range = { from: number, to: number }
// An element's group, kept by the node and where it starts and mapped through each change, so the name holds while
// the human types inside the element or above it
type Kept = Named & { group: string }
type Note = {
  // Null while a read is out, with the changes heard meanwhile
  state: EditorState | null
  version: number
  heard: { version: number, changes: unknown }[]
  viewport: Range
  groups: Kept[]
  named: number
  drawing: boolean
  again: boolean
}

export default definePlugin({
  async start(ctx: PluginContext) {
    const notes = new Map<string, Note>()

    const fresh = (instance: string, viewport: Range = { from: 0, to: 0 }): Note => {
      const note: Note = { state: null, version: 0, heard: [], viewport, groups: [], named: 0, drawing: false, again: false }
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

    const read = async (instance: string, note: Note) => {
      note.state = null
      note.heard = []
      const got = await ctx.try(ctx.editor.read(instance))
      if (notes.get(instance) !== note) return
      if (!got.ok) return void notes.delete(instance)
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
      const known = new Map(note.groups.map(kept => [`${kept.name} ${kept.from}`, kept.group]))
      const groups: Kept[] = []
      const elements = hiddenMarks(state, [range], named => {
        const group = known.get(`${named.name} ${named.from}`) ?? `g${++note.named}`
        groups.push({ ...named, group })
        return group
      })
      note.groups = groups
      // Text not parsed yet is marked on a later pass
      note.again ||= !syntaxTreeAvailable(state, range.to)
      void ctx.try(ctx.editor.decorate(instance, note.version, SET, keepNearest(elements, viewport, MAX_MARKS))).then(sent => {
        note.drawing = false
        if (notes.get(instance) !== note) return
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
      draw(event.instance, note)
    })
    ctx.editor.on('changed', event => {
      if (event.topic !== 'editor.changed') return
      const note = notes.get(event.instance) ?? fresh(event.instance)
      if (note.state === null) return void note.heard.push({ version: event.version, changes: event.changes })
      if (step(event.instance, note, event.version, event.changes)) draw(event.instance, note)
    })
    await ctx.try(ctx.editor.viewports(true))
  },
})
