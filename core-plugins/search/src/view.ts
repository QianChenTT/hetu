import type { UiNode } from '@hetu/sdk'

// The most rows drawn. A path is at most 512 characters, so this many rows stay far under the nodes and bytes one draw
// may carry
export const MAX_ROWS = 200
// The most text a node may draw, so a longer paste in the input is cut to it
export const MAX_TEXT = 4000
const ROW_HEIGHT = 28

// The looks of the file explorer's view, in the properties and tokens the drawer takes
const ROOT = { display: 'flex', 'flex-direction': 'column', height: '100%', padding: '8px 4px', 'box-sizing': 'border-box' }
const INPUT = { padding: '2px 6px', margin: '0 4px', border: '1px solid var(--hetu-color-border)', 'border-radius': 'var(--hetu-radius)' }
const LIST = { flex: '1 1 0', 'min-height': '0' }
const ROW = {
  width: '100%',
  'text-align': 'left',
  border: '0',
  'background-color': 'transparent',
  'border-radius': 'var(--hetu-radius)',
  color: 'var(--hetu-color-fg)',
  'white-space': 'nowrap',
  overflow: 'hidden',
  'text-overflow': 'ellipsis',
  cursor: 'pointer',
}
const HOVER = { 'background-color': 'var(--hetu-color-surface)' }
const STATUS = { padding: '4px 8px', color: 'var(--hetu-color-muted)', 'font-size': '12px' }

// Node ids that stay with a path across draws, so a click names the note of the row it was made on and not the one
// drawn there since
export class Ids {
  private readonly byPath = new Map<string, string>()
  private readonly byId = new Map<string, string>()
  private n = 0

  id(path: string): string {
    let id = this.byPath.get(path)
    if (id === undefined) {
      id = `r${++this.n}`
      this.byPath.set(path, id)
      this.byId.set(id, path)
    }
    return id
  }

  path(id: string): string | undefined {
    return this.byId.get(id)
  }

  // Drops the ids of rows no longer drawn
  keep(paths: readonly string[]): void {
    const drawn = new Set(paths)
    for (const [path, id] of this.byPath) {
      if (drawn.has(path)) continue
      this.byPath.delete(path)
      this.byId.delete(id)
    }
  }
}

// Control characters and the marks that set the direction of text, which could reorder or hide the text around a path.
// Each is drawn as U+FFFD, so a path made only of them still draws as something and two paths that differ only in them
// still differ
const HIDING = /[\p{Cc}\p{Bidi_Control}]/gu

export function shown(text: string): string {
  return text.replace(HIDING, '�')
}

// What the status line says of a search that found total notes, null before any word is typed
export function counted(typed: string, total: number): string | null {
  if (typed.trim() === '') return null
  if (total === 0) return 'No note holds every word'
  if (total > MAX_ROWS) return `First ${MAX_ROWS} of ${total} notes`
  return total === 1 ? '1 note' : `${total} notes`
}

export type Look = { readonly typed: string, readonly hits: readonly string[], readonly ids: Ids, readonly status: string | null }

// The input, the status line and a button for each note found, up to MAX_ROWS
export function viewOf(look: Look): UiNode {
  const drawn = look.hits.slice(0, MAX_ROWS)
  look.ids.keep(drawn)
  const rows: UiNode[] = drawn.map(path => ({ id: look.ids.id(path), kind: 'button', text: shown(path), style: { ...ROW }, hover: { ...HOVER } }))
  return {
    id: 'root',
    kind: 'box',
    style: { ...ROOT },
    children: [
      { id: 'query', kind: 'input', value: look.typed, placeholder: 'Words to find', style: { ...INPUT } },
      ...(look.status === null ? [] : [{ id: 'status', kind: 'text', text: shown(look.status), style: { ...STATUS } } as UiNode]),
      { id: 'rows', kind: 'list', rowHeight: ROW_HEIGHT, rows, style: { ...LIST } },
    ],
  }
}
