import type { CoreLink } from './link.ts'

// The editor's open notes: each read through luoshu.read into an instance with an opaque id, saved through luoshu.write
// with the version it was read at, and kept as a draft in the window's own storage space until a save lands. The
// views themselves are the page's, reached through Editors so this runs in the tests

export type Editors = {
  create(instance: string, text: string, path: string): void
  text(instance: string): string
  // remote marks a change from outside: kept out of undo and not the human's typing
  replace(instance: string, text: string, remote: boolean): void
  destroy(instance: string): void
}

export type NoteNotice =
  | { kind: 'draft', instance: string, path: string, at: number, changedSince: boolean }
  | { kind: 'stale' | 'outside', instance: string, path: string }
  | { kind: 'refused', instance: string, path: string, code: string, reason?: string }

// edits names the plugins whose edits the text holds, which the save after a Restore names as onBehalf
type Draft = { path: string, base: string, text: string, at: number, edits: string[] }

export type OpenNote = {
  readonly instance: string
  readonly path: string
  // Where its draft is kept, worked out once
  readonly key: string
  // The luoshu's version of the text the buffer started from or last saved
  version: string
  dirty: boolean
  // Counts the human's and the plugins' changes, so a save knows whether the text moved while it was on its way
  changes: number
  // The plugins whose edits the text holds since it was last saved
  readonly edits: Set<string>
  // A draft offered and not yet restored or discarded
  draft: Draft | null
  // The text of a save on its way, so the change event it makes isn't taken for someone else's
  saving: string | null
}

export class NoteRefused extends Error {
  readonly code: string
  readonly reason: string | undefined

  constructor(code: string, reason?: string) {
    super(`refused: ${code}${reason === undefined ? '' : ` ${reason}`}`)
    this.code = code
    this.reason = reason
  }
}

// A draft is kept this long after the last change
export const DRAFT_PAUSE_MS = 1000

// draft and the first 56 hex digits of the SHA-256 of the path: a storage key, one per note, that says nothing a
// listing of the space could read the path from
export async function draftKey(path: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)))
  return `draft${[...digest].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 56)}`
}

// A draft as stored. One kept before drafts named their plugins reads as naming none
function draftOf(value: unknown): Draft | null {
  if (typeof value !== 'object' || value === null) return null
  const { path, base, text, at, edits } = value as Record<string, unknown>
  if (typeof path !== 'string' || typeof base !== 'string' || typeof text !== 'string' || typeof at !== 'number') return null
  const named = Array.isArray(edits) ? edits.filter((plugin): plugin is string => typeof plugin === 'string') : []
  return { path, base, text, at, edits: named }
}

type Read = { text: string, version: string }

export class Notes {
  readonly opened = new Map<string, OpenNote>()
  private readonly link: CoreLink
  private readonly editors: Editors
  private readonly tell: (notice: NoteNotice) => void
  private readonly clock: () => number
  private readonly byPath = new Map<string, string>()
  private readonly opening = new Map<string, Promise<string>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private n = 0

  constructor(link: CoreLink, editors: Editors, tell: (notice: NoteNotice) => void, clock: () => number = () => Date.now()) {
    this.link = link
    this.editors = editors
    this.tell = tell
    this.clock = clock
  }

  // core.quitting comes on the shell's subscription. A save by hetu, this window's own included, is luoshu.changed and
  // one by another program luoshu.outside
  start(): void {
    this.link.on('core.quitting', () => void this.keepAll())
    // With no path the window missed these events, so every open note is read again
    for (const topic of ['luoshu.changed', 'luoshu.outside']) {
      this.link.on(topic, event => {
        if (event.path !== undefined) void this.outside(event.path)
        else for (const note of this.opened.values()) void this.outside(note.path)
      })
    }
    void this.link.subscribe(['luoshu.changed', 'luoshu.outside'])
  }

  // The instance holding the note, read into a new one the first time. Rejects with NoteRefused when it can't be read
  open(path: string): Promise<string> {
    const known = this.byPath.get(path)
    if (known !== undefined) return Promise.resolve(known)
    const pending = this.opening.get(path)
    if (pending !== undefined) return pending
    const opening = (async () => {
      const read = await this.read(path)
      const key = await draftKey(path)
      const instance = `n${++this.n}`
      this.editors.create(instance, read.text, path)
      const note: OpenNote = {
        instance, path, key, version: read.version, dirty: false, changes: 0, edits: new Set(), draft: null, saving: null,
      }
      this.opened.set(instance, note)
      this.byPath.set(path, instance)
      await this.offerDraft(note)
      return instance
    })().finally(() => this.opening.delete(path))
    this.opening.set(path, opening)
    return opening
  }

  // The human typed or a plugin edited: the note is dirty and a draft is kept a pause after the last change
  changed(instance: string): void {
    const note = this.opened.get(instance)
    if (note === undefined) return
    note.dirty = true
    note.changes++
    clearTimeout(this.timers.get(instance))
    const timer = setTimeout(() => {
      this.timers.delete(instance)
      void this.keep(note)
    }, DRAFT_PAUSE_MS)
    this.timers.set(instance, timer)
  }

  // A plugin's edit through the bridge, which the next save names as onBehalf
  edited(instance: string, plugin: string): void {
    this.opened.get(instance)?.edits.add(plugin)
  }

  async save(instance: string): Promise<'saved' | 'stale' | 'refused'> {
    const note = this.opened.get(instance)
    if (note === undefined) return 'refused'
    clearTimeout(this.timers.get(instance))
    this.timers.delete(instance)
    const text = this.editors.text(instance)
    const changes = note.changes
    const edits = [...note.edits].sort()
    note.saving = text
    const written = await this.link.call(
      'luoshu.write',
      { path: note.path, text, baseVersion: note.version },
      edits.length > 0 ? { onBehalf: edits.join(',') } : {},
    ).finally(() => {
      note.saving = null
    })
    if (written.ok) {
      note.version = (written.result as { version: string }).version
      // Changes made while the save was on its way keep the note dirty and their plugins named
      if (note.changes === changes) {
        note.dirty = false
        note.edits.clear()
      }
      note.draft = null
      await this.link.call('storage.delete', { key: note.key })
      return 'saved'
    }
    const code = written.refusal?.code ?? 'failed'
    if (code === 'stale') {
      await this.keep(note)
      this.tell({ kind: 'stale', instance, path: note.path })
      return 'stale'
    }
    this.refused(note, code, written.refusal?.reason)
    return 'refused'
  }

  async keepAll(): Promise<void> {
    await Promise.all([...this.opened.values()].filter(note => note.dirty).map(note => this.keep(note)))
  }

  // The offered draft into the buffer, as the human would type it. It stays stored until a save or Discard
  restore(instance: string): void {
    const note = this.opened.get(instance)
    if (note?.draft == null) return
    const { text, edits } = note.draft
    note.draft = null
    this.editors.replace(instance, text, false)
    note.dirty = true
    note.changes++
    for (const plugin of edits) note.edits.add(plugin)
  }

  async discard(instance: string): Promise<void> {
    const note = this.opened.get(instance)
    if (note === undefined) return
    note.draft = null
    await this.link.call('storage.delete', { key: note.key })
  }

  // Reads the note again over the buffer, after a stale save or an outside change, and offers a draft still kept. A
  // dirty buffer is kept as a draft first, and stays as it is when that fails, so nothing typed is lost
  async reload(instance: string): Promise<void> {
    const note = this.opened.get(instance)
    if (note === undefined) return
    if (!await this.keep(note)) return
    let read: Read
    try {
      read = await this.read(note.path)
    } catch (err) {
      return this.refused(note, (err as NoteRefused).code, (err as NoteRefused).reason)
    }
    note.version = read.version
    this.editors.replace(instance, read.text, true)
    note.dirty = false
    note.edits.clear()
    await this.offerDraft(note)
  }

  // A save of an open note by anyone. A clean buffer takes the new text, a dirty one keeps the human's and says so. The
  // window's own save, whose event can come before its reply, changes nothing
  async outside(path: string): Promise<void> {
    const instance = this.byPath.get(path)
    const note = instance === undefined ? undefined : this.opened.get(instance)
    if (note === undefined) return
    let read: Read
    try {
      read = await this.read(path)
    } catch {
      return
    }
    if (read.version === note.version || read.text === note.saving) return
    if (note.dirty || note.saving !== null) return this.tell({ kind: 'outside', instance: note.instance, path })
    note.version = read.version
    this.editors.replace(note.instance, read.text, true)
  }

  private async read(path: string): Promise<Read> {
    const got = await this.link.call('luoshu.read', { path })
    if (!got.ok) throw new NoteRefused(got.refusal?.code ?? 'failed', got.refusal?.reason)
    return got.result as Read
  }

  // A dirty note's text as its draft. False when the draft couldn't be kept, which the human is told
  private async keep(note: OpenNote): Promise<boolean> {
    if (!note.dirty || !this.opened.has(note.instance)) return true
    const value: Draft = {
      path: note.path, base: note.version, text: this.editors.text(note.instance), at: this.clock(), edits: [...note.edits].sort(),
    }
    const kept = await this.link.call('storage.set', { key: note.key, value })
    if (!kept.ok) this.refused(note, kept.refusal?.code ?? 'failed', kept.refusal?.reason)
    return kept.ok
  }

  private async offerDraft(note: OpenNote): Promise<void> {
    const got = await this.link.call('storage.get', { key: note.key })
    const draft = got.ok ? draftOf(got.result) : null
    if (draft === null || draft.path !== note.path) return
    note.draft = draft
    this.tell({ kind: 'draft', instance: note.instance, path: note.path, at: draft.at, changedSince: draft.base !== note.version })
  }

  private refused(note: OpenNote, code: string, reason: string | undefined): void {
    this.tell(reason === undefined
      ? { kind: 'refused', instance: note.instance, path: note.path, code }
      : { kind: 'refused', instance: note.instance, path: note.path, code, reason })
  }
}
