import type { CoreLink } from './link.ts'
import type { Notes } from './notes.ts'

// Which note the raw view shows: the focused instance's buffer, unsaved text included, or with none focused the note
// written last by anyone, which the window hears through luoshu.changed and luoshu.outside. The core can't know what a
// plugin's own input holds, so whatever a plugin saved shows up here. The page draws it in the core layer as text

// Notes the raw view lists to switch between
export const RAW_RECENT = 10

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
