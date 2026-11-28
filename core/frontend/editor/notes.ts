import type { CoreLink } from './link.ts'

// The editor's open notes: each read through luoshu.read into an instance with an opaque id, saved through luoshu.write
// with the version it was read at, and kept as a draft in the window's own storage space until a save lands. A note is
// named by the path the luoshu answered the read with, where the note is, so a note opened under two spellings is one
// note and a plugin's reach to it is judged on where it is. The views themselves are the page's, reached through
// Editors so this runs in the tests

export type Editors = {
  create(instance: string, text: string, path: string): void
  text(instance: string): string
  // remote marks a change from outside: kept out of undo and not the human's typing
  replace(instance: string, text: string, remote: boolean): void
  destroy(instance: string): void
  // hetu moved the note: its tab is named by the new path from now on
  moved(instance: string, path: string): void
}

export type NoteNotice =
  | { kind: 'draft', instance: string, path: string, at: number, changedSince: boolean }
  | { kind: 'stale' | 'outside' | 'locked', instance: string, path: string }
  // kept says whether the tab's unsaved text is kept as a draft
  | { kind: 'gone', instance: string, path: string, kept: boolean }
  | { kind: 'refused', instance: string, path: string, code: string, reason?: string }

// edits names the plugins whose edits the text holds, which the save after a Restore names as onBehalf
type Draft = { path: string, base: string, text: string, at: number, edits: string[] }

export type OpenNote = {
  readonly instance: string
  // The path the luoshu resolved, never the spelling it was opened under, the new one once hetu moved the note
  path: string
  // Where its draft is kept, worked out once and again when the note leaves its path
  key: string
  // Where its draft goes once the note leaves its path
  goneKey: string
  // The luoshu's version of the text the buffer started from or last saved
  version: string
  dirty: boolean
  // Counts the human's and the plugins' changes, so a save knows whether the text moved while it was on its way
  changes: number
  // The plugins whose edits the text holds since it was last saved
  readonly edits: Set<string>
  // A draft offered and not yet restored or discarded, and the key it is kept under
  draft: Draft | null
  draftFrom: string | null
  // The key of a draft restored from a note that left this path, which goes once a save lands
  restoredFrom: string | null
  // The text of a save on its way, so the change event it makes isn't taken for someone else's
  saving: string | null
  // The note left its path, moved or removed. The tab keeps its text, with its draft under a key of its own, and never
  // saves to the path again. The path opens anew in a tab of its own
  gone: boolean
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

// Where the draft of a tab whose note left the path is kept, apart from the draft of a note opened at the path since
export function goneKey(path: string): Promise<string> {
  return draftKey(`${path}\u0000gone`)
}

// A draft as stored. One kept before drafts named their plugins reads as naming none
function draftOf(value: unknown): Draft | null {
  if (typeof value !== 'object' || value === null) return null
  const { path, base, text, at, edits } = value as Record<string, unknown>
  if (typeof path !== 'string' || typeof base !== 'string' || typeof text !== 'string' || typeof at !== 'number') return null
  const named = Array.isArray(edits) ? edits.filter((plugin): plugin is string => typeof plugin === 'string') : []
  return { path, base, text, at, edits: named }
}

type Read = { text: string, version: string, path: string }

export class Notes {
  readonly opened = new Map<string, OpenNote>()
  private readonly link: CoreLink
  private readonly editors: Editors
  private readonly tell: (notice: NoteNotice) => void
  private readonly clock: () => number
  private readonly byPath = new Map<string, string>()
  private readonly opening = new Map<string, Promise<string>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  // The notes whose last save answered locked and that no take over has started on since
  private readonly locked = new Set<string>()
  // Each tab's draft work in turn: a write, a delete or its keys following a move, so none lands under a key the tab
  // left. A step never waits on another step of its own tab
  private readonly chains = new Map<string, Promise<unknown>>()
  // Gone tabs a move may be bringing back, until the note at its new end is read
  private readonly reviving = new Map<string, Promise<void>>()
  // How many moves each tab followed, so a read sent before one says nothing about where the note is now
  private readonly moves = new Map<string, number>()
  private n = 0

  constructor(link: CoreLink, editors: Editors, tell: (notice: NoteNotice) => void, clock: () => number = () => Date.now()) {
    this.link = link
    this.editors = editors
    this.tell = tell
    this.clock = clock
  }

  // core.quitting comes on the shell's subscription. A save by hetu, this window's own included, is luoshu.changed and
  // one by another program luoshu.outside. A move by hetu is luoshu.changed at the end it left, then at its new end
  // naming the one it left
  start(): void {
    this.link.on('core.quitting', () => void this.keepAll())
    // With no path the window missed these events, so every open note is read again
    for (const topic of ['luoshu.changed', 'luoshu.outside']) {
      this.link.on(topic, event => {
        if (event.path !== undefined && event.from !== undefined && this.follow(event.from, event.path)) return
        if (event.path !== undefined) void this.outside(event.path)
        else for (const note of this.opened.values()) void this.outside(note.path)
      })
    }
    void this.link.subscribe(['luoshu.changed', 'luoshu.outside'])
  }

  // The instance holding the note, read into a new one the first time. Rejects with NoteRefused when it can't be read,
  // or with not-granted when reads, a plugin's open, says no to the path the luoshu resolved. A path an open note is
  // named by is that note with no read
  open(path: string, reads?: (resolved: string) => Promise<boolean>): Promise<string> {
    const known = this.byPath.get(path)
    if (known !== undefined) return this.allowed(path, reads).then(() => known)
    const pending = this.opening.get(path)
    if (pending !== undefined) {
      return pending.then(async instance => {
        await this.allowed(this.opened.get(instance)?.path ?? path, reads)
        return instance
      })
    }
    const opening = (async () => {
      const read = await this.read(path)
      await this.allowed(read.path, reads)
      const [key, gone] = await Promise.all([draftKey(read.path), goneKey(read.path)])
      // Another spelling of the note may have opened it while this one read
      const held = this.byPath.get(read.path)
      if (held !== undefined) return held
      const instance = `n${++this.n}`
      this.editors.create(instance, read.text, read.path)
      const note: OpenNote = {
        instance, path: read.path, key, goneKey: gone, version: read.version, dirty: false, changes: 0, edits: new Set(), draft: null, saving: null,
        draftFrom: null, restoredFrom: null, gone: false,
      }
      this.opened.set(instance, note)
      this.byPath.set(read.path, instance)
      await this.offerDraft(note)
      return instance
    })().finally(() => this.opening.delete(path))
    this.opening.set(path, opening)
    return opening
  }

  private async allowed(resolved: string, reads: ((resolved: string) => Promise<boolean>) | undefined): Promise<void> {
    if (reads !== undefined && !(await reads(resolved))) throw new NoteRefused('not-granted')
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

  async save(instance: string): Promise<'saved' | 'stale' | 'locked' | 'refused' | 'gone'> {
    const note = this.opened.get(instance)
    if (note === undefined) return 'refused'
    clearTimeout(this.timers.get(instance))
    this.timers.delete(instance)
    if (note.gone) {
      if (!note.dirty || await this.keep(note)) this.tell({ kind: 'gone', instance, path: note.path, kept: note.dirty })
      return 'gone'
    }
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
    // A note that left its path while the save was on its way keeps its draft
    if (written.ok && note.gone) return 'gone'
    if (written.ok) {
      note.version = (written.result as { version: string }).version
      // Changes made while the save was on its way keep the note dirty and their plugins named
      if (note.changes === changes) {
        note.dirty = false
        note.edits.clear()
      }
      note.draft = null
      await this.step(note, async () => {
        await this.link.call('storage.delete', { key: note.key })
        if (note.restoredFrom !== null) await this.link.call('storage.delete', { key: note.restoredFrom })
        note.restoredFrom = null
      })
      return 'saved'
    }
    const code = written.refusal?.code ?? 'failed'
    // A lock answers with no holder, so the notice names none
    if (code === 'stale' || code === 'locked') {
      if (code === 'locked') this.locked.add(instance)
      await this.keep(note)
      this.tell({ kind: code, instance, path: note.path })
      return code
    }
    this.refused(note, code, written.refusal?.reason)
    return 'refused'
  }

  // The human takes a locked note over: the window clears the lock on that note alone, whoever holds it, then saves
  // again. No Confirm, the human is the policy. Once per locked answer, so a second click saves nothing on the old
  // version and answers null
  async takeOver(instance: string): Promise<'saved' | 'stale' | 'locked' | 'refused' | 'gone' | null> {
    const note = this.opened.get(instance)
    if (note === undefined || !this.locked.delete(instance)) return null
    const cleared = await this.link.call('lock.clear', { paths: [note.path] })
    if (!cleared.ok) {
      this.refused(note, cleared.refusal?.code ?? 'failed', cleared.refusal?.reason)
      return 'refused'
    }
    return this.save(instance)
  }

  // Each in its tab's turn, after the keys of a move before it, so a quit keeps none under the path the note left
  async keepAll(): Promise<void> {
    await Promise.all([...this.opened.values()].filter(note => note.dirty).map(note => this.keep(note)))
  }

  // The offered draft into the buffer, as the human would type it. It stays stored until a save or Discard
  restore(instance: string): void {
    const note = this.opened.get(instance)
    if (note?.draft == null) return
    const { text, edits } = note.draft
    note.draft = null
    if (note.draftFrom !== note.key) note.restoredFrom = note.draftFrom
    this.editors.replace(instance, text, false)
    note.dirty = true
    note.changes++
    for (const plugin of edits) note.edits.add(plugin)
  }

  async discard(instance: string): Promise<void> {
    const note = this.opened.get(instance)
    if (note === undefined) return
    note.draft = null
    await this.step(note, async () => {
      await this.link.call('storage.delete', { key: note.draftFrom ?? note.key })
    })
  }

  // Reads the note again over the buffer, after a stale save or an outside change, and offers a draft still kept. A
  // dirty buffer is kept as a draft first, and stays as it is when that fails, so nothing typed is lost
  async reload(instance: string): Promise<void> {
    const note = this.opened.get(instance)
    if (note === undefined || note.gone) return
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
    await this.step(note, () => this.offerDraft(note))
  }

  // A save of an open note by anyone. A clean buffer takes the new text, a dirty one keeps the human's and says so. The
  // window's own save, whose event can come before its reply, changes nothing. A note no longer found at its path left
  // it, as a move or a remove by hetu does. A read the tab followed a move during, back to this path included, is
  // older than the move's own events, which say where the note is
  async outside(path: string): Promise<void> {
    const instance = this.byPath.get(path)
    const note = instance === undefined ? undefined : this.opened.get(instance)
    if (note === undefined) return
    const moves = this.moves.get(note.instance)
    let read: Read
    try {
      read = await this.read(path)
    } catch (err) {
      const here = this.byPath.get(path) === note.instance && this.moves.get(note.instance) === moves
      if ((err as NoteRefused).code === 'not-found' && here) await this.markGone(note)
      return
    }
    if (this.moves.get(note.instance) !== moves) return
    if (read.version === note.version || read.text === note.saving) return
    if (note.dirty || note.saving !== null) return this.tell({ kind: 'outside', instance: note.instance, path })
    note.version = read.version
    this.editors.replace(note.instance, read.text, true)
  }

  // The note left its path: the path is no longer its own, nor its lock, a dirty text is kept as a draft under a key of
  // the tab's own at once and the human told. A draft that can't be kept is told as refused instead. A move brought
  // to light meanwhile takes the tab and its draft on, and nothing is told
  private async markGone(note: OpenNote): Promise<void> {
    const path = note.path
    const still = () => note.gone && note.path === path
    note.gone = true
    this.byPath.delete(path)
    this.locked.delete(note.instance)
    clearTimeout(this.timers.get(note.instance))
    this.timers.delete(note.instance)
    const kept = await this.step(note, async () => {
      if (!still()) return false
      note.key = note.goneKey
      return !note.dirty || await this.write(note)
    })
    await this.reviving.get(note.instance)
    if (kept && still()) this.tell({ kind: 'gone', instance: note.instance, path, kept: note.dirty })
  }

  // hetu moved the note at from to the path to. A live tab at from is named by the new path before anything awaits, so
  // a read of from that answers not-found after finds the path no longer the tab's and leaves it live. A tab already
  // gone from there is brought back once the note at to reads as the version the tab holds, so a note made at from
  // since and moved is never taken for it. Whatever the tab held at from no longer holds: a lock answer and a gone
  // notice. False when no tab was at from, or another tab is at to already, which then reads as a change at to
  private follow(from: string, to: string): boolean {
    if (this.byPath.has(to)) return false
    const live = this.byPath.get(from)
    if (live !== undefined) {
      this.moved(this.opened.get(live)!, from, to)
      return true
    }
    const gone = [...this.opened.values()].reverse().find(open => open.gone && open.path === from)
    if (gone === undefined) return false
    const reviving = this.read(to).then(read => {
      if (gone.gone && gone.path === from && !this.byPath.has(to) && read.path === to && read.version === gone.version) this.moved(gone, from, to)
    }, () => {}).finally(() => this.reviving.delete(gone.instance))
    this.reviving.set(gone.instance, reviving)
    return true
  }

  private moved(note: OpenNote, from: string, to: string): void {
    this.moves.set(note.instance, (this.moves.get(note.instance) ?? 0) + 1)
    this.byPath.delete(from)
    this.byPath.set(to, note.instance)
    note.path = to
    note.gone = false
    this.locked.delete(note.instance)
    this.editors.moved(note.instance, to)
    void this.step(note, () => this.rekeyed(note))
  }

  // The tab's draft keys for the path it is at, each draft kept under a key it left rewritten under the new one and the
  // old one deleted: its own key's, for a dirty text or an offer, and the gone key's of the path it left for a draft
  // offered or restored from there. Moved again while the keys were worked out, the next step does it
  private async rekeyed(note: OpenNote): Promise<void> {
    const path = note.path
    const [key, gone] = await Promise.all([draftKey(path), goneKey(path)])
    if (note.path !== path) return
    const moves = new Map([[note.key, key]])
    if (!moves.has(note.goneKey) && [note.draftFrom, note.restoredFrom].includes(note.goneKey)) moves.set(note.goneKey, gone)
    note.key = key
    note.goneKey = gone
    if (note.draftFrom !== null) note.draftFrom = moves.get(note.draftFrom) ?? note.draftFrom
    if (note.restoredFrom !== null) note.restoredFrom = moves.get(note.restoredFrom) ?? note.restoredFrom
    if (note.draft !== null) note.draft = { ...note.draft, path }
    for (const [old, now] of moves) {
      if (old === now) continue
      const got = await this.link.call('storage.get', { key: old })
      const draft = got.ok ? draftOf(got.result) : null
      if (draft === null) continue
      const set = await this.link.call('storage.set', { key: now, value: { ...draft, path } })
      if (!set.ok) return this.refused(note, set.refusal?.code ?? 'failed', set.refusal?.reason)
      await this.link.call('storage.delete', { key: old })
    }
    if (note.dirty) await this.write(note)
  }

  // work in the tab's turn, after every step asked before it
  private step<T>(note: OpenNote, work: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(note.instance) ?? Promise.resolve()).then(work)
    // A step that failed already answered whoever asked it, so the turn only goes on to the next
    this.chains.set(note.instance, run.catch(() => {}))
    return run
  }

  private async read(path: string): Promise<Read> {
    const got = await this.link.call('luoshu.read', { path })
    if (!got.ok) throw new NoteRefused(got.refusal?.code ?? 'failed', got.refusal?.reason)
    const read = got.result as Read
    // With no path the window couldn't say where the note is
    if (typeof read.path !== 'string') throw new NoteRefused('failed')
    return read
  }

  // A dirty note's text as its draft, in the tab's turn. False when the draft couldn't be kept, which the human is told
  private keep(note: OpenNote): Promise<boolean> {
    return this.step(note, () => this.write(note))
  }

  // keep, from a step of the tab's own
  private async write(note: OpenNote): Promise<boolean> {
    if (!note.dirty || !this.opened.has(note.instance)) return true
    const value: Draft = {
      path: note.path, base: note.version, text: this.editors.text(note.instance), at: this.clock(), edits: [...note.edits].sort(),
    }
    const kept = await this.link.call('storage.set', { key: note.key, value })
    if (!kept.ok) this.refused(note, kept.refusal?.code ?? 'failed', kept.refusal?.reason)
    return kept.ok
  }

  // The note's own draft, else one a tab kept when a note left this path
  private async offerDraft(note: OpenNote): Promise<void> {
    for (const key of [note.key, note.goneKey]) {
      const got = await this.link.call('storage.get', { key })
      const draft = got.ok ? draftOf(got.result) : null
      if (draft === null || draft.path !== note.path) continue
      note.draft = draft
      note.draftFrom = key
      this.tell({ kind: 'draft', instance: note.instance, path: note.path, at: draft.at, changedSince: draft.base !== note.version })
      return
    }
  }

  private refused(note: OpenNote, code: string, reason: string | undefined): void {
    this.tell(reason === undefined
      ? { kind: 'refused', instance: note.instance, path: note.path, code }
      : { kind: 'refused', instance: note.instance, path: note.path, code, reason })
  }
}
