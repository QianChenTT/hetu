import { describe, expect, it } from 'vitest'
import { noteBar, refusalText } from '../frontend/editor/note-bar.ts'

const at = { instance: 'n1', path: 'a.md' }

describe('the note bar', () => {
  // The refusal names no holder, so neither does the bar, whatever else the notice carried
  it('says a locked note is held with no word of who and offers Take over in one click', () => {
    const bar = { text: 'This note is locked, so it wasn\'t saved. Your text is kept as a draft. Take over frees it and saves', actions: ['take-over', 'dismiss'] }
    expect(noteBar({ kind: 'locked', ...at })).toEqual(bar)
    expect(noteBar({ kind: 'locked', ...at, holder: 'claude-code#2', reason: 'client#1' } as never)).toEqual(bar)
  })

  it('keeps what it said of a draft, a stale save, an outside change and a refusal', () => {
    const when = new Date(5000).toLocaleString()
    expect(noteBar({ kind: 'draft', ...at, at: 5000, changedSince: true })).toEqual({
      text: `A draft of this note from ${when} is kept, made before the note last changed`, actions: ['restore', 'discard'],
    })
    expect(noteBar({ kind: 'draft', ...at, at: 5000, changedSince: false }).text).toBe(`A draft of this note from ${when} is kept`)
    expect(noteBar({ kind: 'stale', ...at })).toEqual({
      text: 'This note changed outside hetu since it was opened, so it wasn\'t saved. Your text is kept as a draft', actions: ['reload'],
    })
    expect(noteBar({ kind: 'outside', ...at })).toEqual({
      text: 'This note changed outside hetu while it has unsaved text. Reload keeps your text as a draft', actions: ['reload', 'keep-mine'],
    })
    expect(noteBar({ kind: 'refused', ...at, code: 'failed' })).toEqual({ text: 'hetu refused: failed', actions: ['dismiss'] })
  })

  it('says what a refusal means to the human', () => {
    expect(refusalText('invalid', 'too-large')).toBe('This note is past the size hetu takes, so it can\'t be saved or kept as a draft')
    expect(refusalText('unavailable')).toBe('No notes folder is picked, so nothing can be saved')
    expect(refusalText('throttled')).toBe('hetu is busy, so not every note is listed yet. Open this again in a moment')
    expect(refusalText('failed', 'quota')).toBe('hetu refused: failed (quota)')
  })
})
