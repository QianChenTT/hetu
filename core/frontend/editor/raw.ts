import type { Rect } from './drag.ts'
import type { CoreLink } from './link.ts'
import type { Notes } from './notes.ts'

// Which note the raw view shows: the focused instance's buffer, unsaved text included, or with none focused the note
// written last by anyone, which the window hears through luoshu.changed and luoshu.outside. The core can't know what a
// plugin's own input holds, so whatever a plugin saved shows up here. The page draws it in the core layer as text

// Notes the raw view lists to switch between
export const RAW_RECENT = 10

// The smallest box the raw view takes over the editor, in pixels and as a share of the stage, whichever is larger.
// Below it the raw view takes the whole stage
export const RAW_MIN_BOX = Object.freeze({ width: 320, height: 200, widthShare: 0.4, heightShare: 0.5 })

// Where the raw view sits, in window pixels: over the part of the editor's window box inside the stage, so the bar,
// the banner and the views around it stay in sight. The layout places the editor, so with no editor placed, or a box
// too small to read much of a note in, it takes the whole stage, and no layout can shrink or hide the real text
export function rawBox(editorInWindow: Rect | null, stage: Rect): Rect {
  if (editorInWindow === null) return stage
  const left = Math.max(editorInWindow.left, stage.left)
  const top = Math.max(editorInWindow.top, stage.top)
  const width = Math.min(editorInWindow.left + editorInWindow.width, stage.left + stage.width) - left
  const height = Math.min(editorInWindow.top + editorInWindow.height, stage.top + stage.height) - top
  const least = { width: Math.max(RAW_MIN_BOX.width, stage.width * RAW_MIN_BOX.widthShare), height: Math.max(RAW_MIN_BOX.height, stage.height * RAW_MIN_BOX.heightShare) }
  return width < least.width || height < least.height ? stage : { left, top, width, height }
}

export class RawSource {
  private readonly link: CoreLink
  private readonly notes: Notes
  private readonly text: (instance: string) => string
  private readonly latest: string[] = []

  constructor(link: CoreLink, notes: Notes, text: (instance: string) => string) {
    this.link = link
    this.notes = notes
    this.text = text
  }

  // The notes subscribe to both topics
  start(): void {
    for (const topic of ['luoshu.changed', 'luoshu.outside']) {
      this.link.on(topic, event => {
        if (event.path !== undefined) this.written(event.path)
      })
    }
  }

  written(path: string): void {
    const at = this.latest.indexOf(path)
    if (at >= 0) this.latest.splice(at, 1)
    this.latest.unshift(path)
    if (this.latest.length > RAW_RECENT) this.latest.length = RAW_RECENT
  }

  recent(): string[] {
    return [...this.latest]
  }

  // The note picked from the list, else the focused instance's, else the one written last. An open note shows its
  // buffer. Null when there is nothing to show or the note can't be read
  async show(focused: string | null, pick?: string): Promise<{ path: string, text: string } | null> {
    if (pick === undefined && focused !== null) {
      const note = this.notes.opened.get(focused)
      if (note !== undefined) return { path: note.path, text: this.text(focused) }
    }
    const path = pick ?? this.latest[0]
    if (path === undefined) return null
    for (const note of this.notes.opened.values()) if (note.path === path) return { path, text: this.text(note.instance) }
    const read = await this.link.call('luoshu.read', { path })
    return read.ok ? { path, text: (read.result as { text: string }).text } : null
  }
}
