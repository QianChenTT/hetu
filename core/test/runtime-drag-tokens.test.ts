import { describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import { DRAG_TOKEN_MS } from '../api/ui-limits.ts'
import { DRAG_TOKENS_PER_PLUGIN, DragTokens } from '../backend/runtime/drag-tokens.ts'

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }

// kanban runs as incarnation 1 and reads notes/**, board runs and reads everything. Tokens count up
function tokens() {
  const running = new Map([['kanban', 1], ['board', 1]])
  let readable = (caller: Caller, path: string) => caller.kind === 'plugin' && (caller.id === 'board' || path.startsWith('notes/'))
  const asked: Caller[] = []
  let now = 0
  let n = 0
  const made = new DragTokens({
    running: plugin => running.get(plugin) ?? null,
    reads: (caller, path) => {
      asked.push(caller)
      return readable(caller, path)
    },
    token: () => (++n).toString(16).padStart(32, '0'),
    now: () => now,
  })
  return {
    made, running, asked,
    at: (ms: number) => {
      now = ms
    },
    reads: (next: (caller: Caller, path: string) => boolean) => {
      readable = next
    },
  }
}

describe('drag tokens', () => {
  it('mints one for the editor window for a running plugin whose luoshu.read reaches the note, asked as its worker', () => {
    const { made, asked } = tokens()
    expect(made.mint(editor, 'kanban', 'notes/a.md')).toBe('00000000000000000000000000000001')
    expect(asked).toEqual([{ kind: 'plugin', id: 'kanban', half: 'worker', incarnation: 1 }])
  })

  it('mints none for another window, a plugin not running or a note outside its read', () => {
    const { made } = tokens()
    expect(made.mint(trusted, 'kanban', 'notes/a.md')).toBeNull()
    expect(made.mint(editor, 'search', 'notes/a.md')).toBeNull()
    expect(made.mint(editor, 'kanban', 'a.md')).toBeNull()
  })

  it('answers a drop once with the plugin that asked and its note, then nothing, and nothing for a token never minted', () => {
    const { made } = tokens()
    const token = made.mint(editor, 'kanban', 'notes/a.md')!
    expect(made.redeem(editor, token)).toEqual({ plugin: 'kanban', path: 'notes/a.md' })
    expect(made.redeem(editor, token)).toBeNull()
    expect(made.redeem(editor, 'f'.repeat(32))).toBeNull()
  })

  it('answers a drop from another window with nothing and keeps the token for the editor', () => {
    const { made } = tokens()
    const token = made.mint(editor, 'kanban', 'notes/a.md')!
    expect(made.redeem(trusted, token)).toBeNull()
    expect(made.redeem(editor, token)).toEqual({ plugin: 'kanban', path: 'notes/a.md' })
  })

  it('answers nothing, using the token up, once its plugin stopped or runs again or no longer reads the note', () => {
    const { made, running, reads } = tokens()
    const stopped = made.mint(editor, 'kanban', 'notes/a.md')!
    const again = made.mint(editor, 'kanban', 'notes/b.md')!
    const lost = made.mint(editor, 'board', 'c.md')!
    running.delete('kanban')
    expect(made.redeem(editor, stopped)).toBeNull()
    running.set('kanban', 2)
    expect(made.redeem(editor, again)).toBeNull()
    reads(() => false)
    expect(made.redeem(editor, lost)).toBeNull()
    reads(() => true)
    expect(made.redeem(editor, lost)).toBeNull()
  })

  it(`answers nothing for a token past ${DRAG_TOKEN_MS} ms`, () => {
    const { made, at } = tokens()
    const late = made.mint(editor, 'kanban', 'notes/a.md')!
    at(1)
    const kept = made.mint(editor, 'kanban', 'notes/b.md')!
    at(DRAG_TOKEN_MS + 1)
    expect(made.redeem(editor, late)).toBeNull()
    expect(made.redeem(editor, kept)).toEqual({ plugin: 'kanban', path: 'notes/b.md' })
  })

  it('ends every token when the editor page unloads', () => {
    const { made } = tokens()
    const token = made.mint(editor, 'kanban', 'notes/a.md')!
    made.unloaded()
    expect(made.redeem(editor, token)).toBeNull()
  })

  it(`holds ${DRAG_TOKENS_PER_PLUGIN} for a plugin, its oldest going first, and leaves another plugin's be`, () => {
    const { made } = tokens()
    const board = made.mint(editor, 'board', 'a.md')!
    const minted = Array.from({ length: DRAG_TOKENS_PER_PLUGIN + 1 }, (_, at) => made.mint(editor, 'kanban', `notes/${at}.md`)!)
    expect(made.redeem(editor, minted[0]!)).toBeNull()
    expect(made.redeem(editor, minted[1]!)).toEqual({ plugin: 'kanban', path: 'notes/1.md' })
    expect(made.redeem(editor, minted.at(-1)!)).toEqual({ plugin: 'kanban', path: `notes/${DRAG_TOKENS_PER_PLUGIN}.md` })
    expect(made.redeem(editor, board)).toEqual({ plugin: 'board', path: 'a.md' })
  })
})
