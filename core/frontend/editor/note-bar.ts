// The note bar's words and buttons for a notice about the note on screen, kept apart from the DOM so it runs in tests.
// The page draws the text as text and a button for each action
import type { NoteNotice } from './notes.ts'

export type NoteAction = 'restore' | 'discard' | 'reload' | 'keep-mine' | 'dismiss' | 'take-over'

// What a refusal means to the human
export function refusalText(code: string, reason?: string): string {
  if (reason === 'too-large') return 'This note is past the size hetu takes, so it can\'t be saved or kept as a draft'
  if (code === 'unavailable') return 'No notes folder is picked, so nothing can be saved'
  if (code === 'throttled') return 'hetu is busy, so not every note is listed yet. Open this again in a moment'
  return `hetu refused: ${code}${reason === undefined ? '' : ` (${reason})`}`
}

// A locked note names no holder, since the refusal carries none
export function noteBar(notice: NoteNotice): { text: string, actions: NoteAction[] } {
  switch (notice.kind) {
    case 'draft': {
      const when = new Date(notice.at).toLocaleString()
      return {
        text: `A draft of this note from ${when} is kept${notice.changedSince ? ', made before the note last changed' : ''}`,
        actions: ['restore', 'discard'],
      }
    }
    case 'stale':
      return { text: 'This note changed outside hetu since it was opened, so it wasn\'t saved. Your text is kept as a draft', actions: ['reload'] }
    case 'outside':
      return { text: 'This note changed outside hetu while it has unsaved text. Reload keeps your text as a draft', actions: ['reload', 'keep-mine'] }
    case 'locked':
      return { text: 'This note is locked, so it wasn\'t saved. Your text is kept as a draft. Take over frees it and saves', actions: ['take-over', 'dismiss'] }
    case 'refused':
      return { text: refusalText(notice.code, notice.reason), actions: ['dismiss'] }
  }
}
