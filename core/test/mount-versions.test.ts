import { ChangeSet, EditorState, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { MAX_KEPT_VERSIONS, type Mark } from '../api/editor.ts'
import { Versions } from '../frontend/mount/versions.ts'

// A note typed into: each change made against the text as it is, kept in versions as the editor keeps them
function typing(text: string) {
  let doc = Text.of(text.split('\n'))
  const versions = new Versions(doc.length)
  return {
    versions,
    // Inserts at a place in the text as it is now
    insert(from: number, insert: string) {
      const changes = ChangeSet.of({ from, insert }, doc.length)
      doc = changes.apply(doc)
      versions.push(changes)
    },
    remove(from: number, to: number) {
      const changes = ChangeSet.of({ from, to }, doc.length)
      doc = changes.apply(doc)
      versions.push(changes)
    },
    apply(changes: ChangeSet) {
      doc = changes.apply(doc)
      versions.push(changes)
    },
    text: () => doc.toString(),
    slice: (from: number, to: number) => doc.sliceString(from, to),
  }
}

const strong = (from: number, to: number): Mark => ({ kind: 'mark', from, to, style: 'strong' })

describe('versions', () => {
  it('counts each change from 0', () => {
    const note = typing('hello')
    expect(note.versions.version).toBe(0)
    note.insert(5, '!')
    note.insert(0, '>')
    expect(note.versions.version).toBe(2)
  })

  it('refuses a change made against another length, which would map nothing right', () => {
    const versions = new Versions(5)
    expect(() => versions.push(ChangeSet.of({ from: 0, insert: 'x' }, 6))).toThrow()
  })

  it('gives the changes since a version, nothing for one newer than now and none past what it keeps', () => {
    const note = typing('hello')
    note.insert(5, ' world')
    expect(note.versions.since(1)?.empty).toBe(true)
    expect(note.versions.since(0)?.length).toBe(5)
    expect(note.versions.since(2)).toBe(null)
    expect(note.versions.since(-1)).toBe(null)
    for (let i = 0; i < MAX_KEPT_VERSIONS; i++) note.insert(0, 'x')
    expect(note.versions.since(0)).toBe(null)
    expect(note.versions.since(1)?.length).toBe(11)
  })
})

describe('a late mark', () => {
  it('lands on the text it was made for after inserts before it and inside it', () => {
    const note = typing('hello world')
    // Made for version 0 on "world"
    const made = strong(6, 11)
    note.insert(0, 'oh ')
    note.insert(0, '> ')
    // "> oh hello world" with world at 11
    note.insert(13, '-')
    const [mapped] = note.versions.mapMarks([made], 0)!
    expect(mapped.kind).toBe('mark')
    const { from, to } = mapped as { from: number, to: number }
    expect(note.slice(from, to)).toBe('wo-rld')
  })

  it('drops a mark whose text was deleted and keeps the rest', () => {
    const note = typing('one two three')
    const marks = [strong(0, 3), strong(4, 7), { kind: 'hide', from: 8, to: 13 } as Mark]
    note.remove(3, 8)
    const mapped = note.versions.mapMarks(marks, 0)!
    expect(mapped.map(m => note.slice(m.from, 'to' in m ? m.to : m.from))).toEqual(['one', 'three'])
  })

  it('keeps a point widget at its place and a line style on its line', () => {
    const note = typing('a\nb')
    const marks: Mark[] = [{ kind: 'widget', from: 2, to: 2, text: '•' }, { kind: 'line', from: 2, style: 'h1' }]
    note.insert(0, 'zz\n')
    const mapped = note.versions.mapMarks(marks, 0)!
    expect(mapped).toEqual([{ kind: 'widget', from: 5, to: 5, text: '•' }, { kind: 'line', from: 5, style: 'h1' }])
  })

  it('answers null for marks made for a version it no longer keeps or one not made yet', () => {
    const note = typing('abc')
    for (let i = 0; i <= MAX_KEPT_VERSIONS; i++) note.insert(0, 'x')
    expect(note.versions.mapMarks([strong(0, 1)], 0)).toBe(null)
    expect(note.versions.mapMarks([strong(0, 1)], note.versions.version + 1)).toBe(null)
  })

  it('drops a mark reaching past the text it was made for', () => {
    const note = typing('abc')
    expect(note.versions.mapMarks([strong(1, 9)], 0)).toEqual([])
  })
})

describe('a stale edit', () => {
  it('applies as it is when made for the version now', () => {
    const note = typing('abc')
    const edit = ChangeSet.of({ from: 3, insert: '!' }, 3)
    const rebased = note.versions.rebase(edit, 0)
    expect(rebased).not.toBe('stale')
    note.apply(rebased as ChangeSet)
    expect(note.text()).toBe('abc!')
  })

  it('is mapped through the human typing elsewhere since its version', () => {
    const note = typing('first line\nsecond line')
    // The plugin read version 0 and fixes "second" while the human types at the top
    const edit = ChangeSet.of({ from: 11, to: 17, insert: 'Second' }, note.text().length)
    note.insert(0, 'typed ')
    note.insert(6, 'more ')
    const rebased = note.versions.rebase(edit, 0)
    expect(rebased).not.toBe('stale')
    note.apply(rebased as ChangeSet)
    expect(note.text()).toBe('typed more first line\nSecond line')
  })

  it('answers stale when it touches text changed since', () => {
    const note = typing('first line\nsecond line')
    const edit = ChangeSet.of({ from: 11, to: 17, insert: 'Second' }, note.text().length)
    note.insert(14, 'x')
    expect(note.versions.rebase(edit, 0)).toBe('stale')
  })

  it('answers stale when its length is not the length at its version', () => {
    const note = typing('abc')
    note.insert(0, 'x')
    expect(note.versions.rebase(ChangeSet.of({ from: 0, insert: '!' }, 4), 0)).toBe('stale')
  })

  it('answers stale for a version it no longer keeps or one not made yet', () => {
    const note = typing('abc')
    for (let i = 0; i <= MAX_KEPT_VERSIONS; i++) note.insert(0, 'x')
    expect(note.versions.rebase(ChangeSet.of({ from: 0, insert: '!' }, 3), 0)).toBe('stale')
    expect(note.versions.rebase(ChangeSet.empty(note.text().length), note.versions.version + 1)).toBe('stale')
  })
})

describe('the human typing', () => {
  it('maps with what EditorState makes, as the editor will push them', () => {
    let state = EditorState.create({ doc: 'abc' })
    const versions = new Versions(state.doc.length)
    const tr = state.update({ changes: { from: 1, insert: 'Z' } })
    versions.push(tr.changes)
    state = tr.state
    expect(versions.mapMarks([strong(1, 3)], 0)).toEqual([strong(2, 4)])
  })
})
