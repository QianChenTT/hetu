import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoreLink } from '../frontend/mount/link.ts'
import { draftKey, type Editors, type NoteNotice, Notes } from '../frontend/mount/notes.ts'
import { type Answer, fakeCore } from './mount-fakes.ts'

// The editor views as the notes see them: each instance's text, and each replace with whether it came from outside
function fakeEditors() {
  const texts = new Map<string, string>()
  const paths = new Map<string, string>()
  const replaced: { instance: string, text: string, remote: boolean }[] = []
  const editors: Editors = {
    create: (instance, text, path) => {
      texts.set(instance, text)
      paths.set(instance, path)
    },
    text: instance => texts.get(instance) ?? '',
    replace(instance, text, remote) {
      texts.set(instance, text)
      replaced.push({ instance, text, remote })
    },
    destroy: instance => void texts.delete(instance),
  }
  return { editors, texts, paths, replaced, type: (instance: string, text: string) => texts.set(instance, text) }
}

// A luoshu of notes by path, each with its version, and the window's storage space. A read answers the path the note
// is at, and links names other spellings that resolve to a note, as a junction or another case does
function started(files: Record<string, string> = { 'a.md': 'note a' }, links: Record<string, string> = {}) {
  const notes = new Map(Object.entries(files).map(([path, text]) => [path, { text, version: `v-${text}` }]))
  const space = new Map<string, unknown>()
  const ok = (result?: unknown): Answer => ({ ok: true, result })
  const core = fakeCore({
    'events.subscribe': () => ok({ standing: [] }),
    'luoshu.read': args => {
      const spelled = (args as { path: string }).path
      const path = links[spelled] ?? spelled
      const note = notes.get(path)
      return note === undefined ? { ok: false, refusal: { code: 'not-found' } } : ok({ ...note, path })
    },
    'luoshu.write': args => {
      const { path, text, baseVersion } = args as { path: string, text: string, baseVersion?: string }
      if (notes.get(path)?.version !== baseVersion) return { ok: false, refusal: { code: 'stale' } }
      notes.set(path, { text, version: `v-${text}` })
      return ok({ version: `v-${text}` })
    },
    'storage.get': args => ok(space.get((args as { key: string }).key) ?? null),
    'storage.set': args => {
      const { key, value } = args as { key: string, value: unknown }
      if (JSON.stringify(value).length > 2000) return { ok: false, refusal: { code: 'invalid', reason: 'too-large' } }
      space.set(key, value)
      return ok(null)
    },
    'storage.delete': args => {
      space.delete((args as { key: string }).key)
      return ok(null)
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  const views = fakeEditors()
  const told: NoteNotice[] = []
  const clock = { at: 1000 }
  const made = new Notes(link, views.editors, notice => told.push(notice), () => clock.at)
  made.start()
  // Someone else saves a note, as an outside program or another plugin would
  const saveOutside = (path: string, text: string) => notes.set(path, { text, version: `v-${text}` })
  return { core, notes: made, files: notes, space, views, told, clock, saveOutside }
}

const keyOf = (path: string) => `draft${createHash('sha256').update(path).digest('hex').slice(0, 56)}`

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('a draft key', () => {
  it('is draft and the first 56 hex digits of the SHA-256 of the path, a storage key', async () => {
    expect(await draftKey('notes/a.md')).toBe(keyOf('notes/a.md'))
    expect(keyOf('a').length).toBe(61)
  })
})

describe('opening a note', () => {
  it('reads it through luoshu.read into one instance per path', async () => {
    const { notes, views, core } = started()
    const instance = await notes.open('a.md')
    expect(instance).toMatch(/^n[0-9]+$/)
    expect(views.texts.get(instance)).toBe('note a')
    expect(notes.opened.get(instance)).toMatchObject({ path: 'a.md', version: 'v-note a', dirty: false })
    expect(await notes.open('a.md')).toBe(instance)
    expect(core.calls('luoshu.read')).toHaveLength(1)
  })

  it('names the note by the path the luoshu answered, one instance for every spelling of it', async () => {
    const { notes, views, core } = started({ 'private/x.md': 'secret' }, { 'public/link/x.md': 'private/x.md', 'Private/X.md': 'private/x.md' })
    const instance = await notes.open('public/link/x.md')
    expect(notes.opened.get(instance)).toMatchObject({ path: 'private/x.md', key: keyOf('private/x.md') })
    expect(views.paths.get(instance)).toBe('private/x.md')
    expect(await notes.open('Private/X.md')).toBe(instance)
    expect(await notes.open('private/x.md')).toBe(instance)
    expect(notes.opened.size).toBe(1)
    // The path it is named by needs no read
    expect(core.calls('luoshu.read')).toHaveLength(2)
  })

  it('opens one instance for two spellings opened at once', async () => {
    const { notes } = started({ 'private/x.md': 'secret' }, { 'public/link/x.md': 'private/x.md' })
    const [one, two] = await Promise.all([notes.open('public/link/x.md'), notes.open('private/x.md')])
    expect(one).toBe(two)
    expect(notes.opened.size).toBe(1)
  })

  it('opens nothing when reads says no to the path the luoshu resolved, whatever the spelling', async () => {
    const { notes } = started({ 'private/x.md': 'secret', 'public/a.md': 'a' }, { 'public/link/x.md': 'private/x.md' })
    const asked: string[] = []
    const reads = async (resolved: string) => {
      asked.push(resolved)
      return resolved.startsWith('public/')
    }
    await expect(notes.open('public/link/x.md', reads)).rejects.toMatchObject({ code: 'not-granted' })
    expect(notes.opened.size).toBe(0)
    expect(await notes.open('public/a.md', reads)).toMatch(/^n[0-9]+$/)
    // A note open already is judged too
    await notes.open('private/x.md')
    await expect(notes.open('private/x.md', reads)).rejects.toMatchObject({ code: 'not-granted' })
    await expect(notes.open('public/link/x.md', reads)).rejects.toMatchObject({ code: 'not-granted' })
    expect(asked).toEqual(['private/x.md', 'public/a.md', 'private/x.md', 'private/x.md'])
  })

  it('takes a change event on the path the luoshu resolved for a note opened under another spelling', async () => {
    const { notes, views, core, saveOutside } = started({ 'private/x.md': 'secret' }, { 'public/link/x.md': 'private/x.md' })
    notes.start()
    const instance = await notes.open('public/link/x.md')
    saveOutside('private/x.md', 'changed')
    core.event('luoshu.outside', 'private/x.md')
    await flush()
    await flush()
    expect(views.texts.get(instance)).toBe('changed')
  })

  it('refuses a read that answers no path, since the window could not say where the note is', async () => {
    const { notes, core } = started()
    core.answers['luoshu.read'] = () => ({ ok: true, result: { text: 'note a', version: 'v-note a' } })
    await expect(notes.open('a.md')).rejects.toMatchObject({ code: 'failed' })
    expect(notes.opened.size).toBe(0)
  })

  it('rejects with the refusal code when the note can not be read', async () => {
    const { notes } = started()
    await expect(notes.open('gone.md')).rejects.toMatchObject({ code: 'not-found' })
    expect(notes.opened.size).toBe(0)
  })

  it('offers a draft kept for the note, saying whether the note changed since', async () => {
    const { notes, space, told } = started()
    space.set(keyOf('a.md'), { path: 'a.md', base: 'v-note a', text: 'draft text', at: 500 })
    const instance = await notes.open('a.md')
    expect(told).toEqual([{ kind: 'draft', instance, path: 'a.md', at: 500, changedSince: false }])
  })

  it('says the note changed since a draft made on an older version', async () => {
    const { notes, space, told } = started()
    space.set(keyOf('a.md'), { path: 'a.md', base: 'v-older', text: 'draft text', at: 500 })
    await notes.open('a.md')
    expect(told[0]).toMatchObject({ kind: 'draft', changedSince: true })
  })

  it('offers nothing for a stored value that is no draft of this note', async () => {
    const { notes, space, told } = started()
    space.set(keyOf('a.md'), { path: 'b.md', base: 'v-note a', text: 'x', at: 1 })
    await notes.open('a.md')
    expect(told).toEqual([])
  })
})

describe('saving', () => {
  it('writes with the version read and takes the new one', async () => {
    const { notes, views, core } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'note a, changed')
    notes.changed(instance)
    expect(await notes.save(instance)).toBe('saved')
    expect(core.calls('luoshu.write')[0].args).toEqual({ path: 'a.md', text: 'note a, changed', baseVersion: 'v-note a' })
    expect(core.calls('luoshu.write')[0].onBehalf).toBeUndefined()
    expect(notes.opened.get(instance)).toMatchObject({ version: 'v-note a, changed', dirty: false })
  })

  it('keeps the text as a draft and tells stale when the note changed outside since it was read', async () => {
    const { notes, views, space, told, saveOutside } = started()
    const instance = await notes.open('a.md')
    saveOutside('a.md', 'someone else')
    views.type(instance, 'mine')
    notes.changed(instance)
    expect(await notes.save(instance)).toBe('stale')
    expect(space.get(keyOf('a.md'))).toEqual({ path: 'a.md', base: 'v-note a', text: 'mine', at: 1000, edits: [] })
    expect(told).toContainEqual({ kind: 'stale', instance, path: 'a.md' })
  })

  it('deletes the draft once a save lands', async () => {
    const { notes, views, space } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'typed')
    notes.changed(instance)
    await vi.advanceTimersByTimeAsync(1000)
    expect(space.has(keyOf('a.md'))).toBe(true)
    await notes.save(instance)
    expect(space.has(keyOf('a.md'))).toBe(false)
  })

  it('names the plugins whose edits the text holds as onBehalf, in name order, and none on the next save', async () => {
    const { notes, views, core } = started()
    const instance = await notes.open('a.md')
    notes.edited(instance, 'zeta')
    notes.edited(instance, 'alpha')
    notes.edited(instance, 'zeta')
    views.type(instance, 'edited by plugins')
    notes.changed(instance)
    await notes.save(instance)
    views.type(instance, 'then by the human')
    notes.changed(instance)
    await notes.save(instance)
    expect(core.calls('luoshu.write').map(call => call.onBehalf)).toEqual(['alpha,zeta', undefined])
  })

  it('tells a refusal with its code and reason and keeps the text', async () => {
    const { notes, views, told, core } = started()
    core.answers['luoshu.write'] = () => ({ ok: false, refusal: { code: 'invalid', reason: 'too-large' } })
    const instance = await notes.open('a.md')
    views.type(instance, 'big')
    notes.changed(instance)
    expect(await notes.save(instance)).toBe('refused')
    expect(told).toContainEqual({ kind: 'refused', instance, path: 'a.md', code: 'invalid', reason: 'too-large' })
    expect(views.texts.get(instance)).toBe('big')
    expect(notes.opened.get(instance)?.dirty).toBe(true)
  })

  it('stays dirty when the text changed while the save was on its way', async () => {
    const { notes, views, core } = started()
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const write = core.answers['luoshu.write']
    core.answers['luoshu.write'] = async (args, sent) => {
      await gate
      return write(args, sent)
    }
    const instance = await notes.open('a.md')
    views.type(instance, 'one')
    notes.changed(instance)
    const saving = notes.save(instance)
    views.type(instance, 'one two')
    notes.changed(instance)
    release()
    await saving
    expect(notes.opened.get(instance)?.dirty).toBe(true)
  })
})

describe('drafts', () => {
  it('keeps one a second after the last change, not before', async () => {
    const { notes, views, space, clock } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'one')
    notes.changed(instance)
    await vi.advanceTimersByTimeAsync(600)
    views.type(instance, 'one two')
    notes.changed(instance)
    await vi.advanceTimersByTimeAsync(600)
    expect(space.has(keyOf('a.md'))).toBe(false)
    clock.at = 2200
    await vi.advanceTimersByTimeAsync(400)
    expect(space.get(keyOf('a.md'))).toEqual({ path: 'a.md', base: 'v-note a', text: 'one two', at: 2200, edits: [] })
  })

  it('keeps every dirty note when the core says it is quitting', async () => {
    const { notes, views, space, core } = started({ 'a.md': 'a', 'b.md': 'b' })
    const a = await notes.open('a.md')
    await notes.open('b.md')
    views.type(a, 'a typed')
    notes.changed(a)
    core.event('core.quitting')
    await flush()
    expect([...space.keys()]).toEqual([keyOf('a.md')])
  })

  it('tells when a draft past the cap is not kept', async () => {
    const { notes, views, told, space } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'x'.repeat(3000))
    notes.changed(instance)
    await vi.advanceTimersByTimeAsync(1000)
    expect(space.size).toBe(0)
    expect(told).toContainEqual({ kind: 'refused', instance, path: 'a.md', code: 'invalid', reason: 'too-large' })
  })

  it('restores an offered draft into the buffer as the human would type it, and discards one', async () => {
    const { notes, views, space } = started({ 'a.md': 'a', 'b.md': 'b' })
    space.set(keyOf('a.md'), { path: 'a.md', base: 'v-a', text: 'draft a', at: 1 })
    space.set(keyOf('b.md'), { path: 'b.md', base: 'v-b', text: 'draft b', at: 1 })
    const a = await notes.open('a.md')
    const b = await notes.open('b.md')
    notes.restore(a)
    expect(views.replaced).toEqual([{ instance: a, text: 'draft a', remote: false }])
    expect(notes.opened.get(a)?.dirty).toBe(true)
    await notes.discard(b)
    expect(space.has(keyOf('b.md'))).toBe(false)
    expect(views.texts.get(b)).toBe('b')
  })
})

describe('a save from outside', () => {
  it('reloads a clean buffer as a change from outside', async () => {
    const { notes, views, core, saveOutside } = started()
    const instance = await notes.open('a.md')
    saveOutside('a.md', 'new text')
    core.event('luoshu.outside', 'a.md')
    await flush()
    expect(views.replaced).toEqual([{ instance, text: 'new text', remote: true }])
    expect(notes.opened.get(instance)?.version).toBe('v-new text')
  })

  it('keeps a dirty buffer and tells the human', async () => {
    const { notes, views, core, told, saveOutside } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'mine')
    notes.changed(instance)
    saveOutside('a.md', 'theirs')
    core.event('luoshu.changed', 'a.md')
    await flush()
    expect(views.replaced).toEqual([])
    expect(views.texts.get(instance)).toBe('mine')
    expect(told).toContainEqual({ kind: 'outside', instance, path: 'a.md' })
  })

  it("does nothing for the window's own save or a note not open", async () => {
    const { notes, views, core, told } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'saved here')
    notes.changed(instance)
    await notes.save(instance)
    core.event('luoshu.changed', 'a.md')
    core.event('luoshu.changed', 'other.md')
    await flush()
    expect(views.replaced).toEqual([])
    expect(told).toEqual([])
  })

  it("takes a change event that comes before its own save's reply as its own", async () => {
    const { notes, views, core, told } = started()
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const write = core.answers['luoshu.write']
    core.answers['luoshu.write'] = async (args, sent) => {
      const written = await write(args, sent)
      await gate
      return written
    }
    const instance = await notes.open('a.md')
    views.type(instance, 'mine')
    notes.changed(instance)
    const saving = notes.save(instance)
    await flush()
    core.event('luoshu.changed', 'a.md')
    await flush()
    release()
    expect(await saving).toBe('saved')
    expect(views.replaced).toEqual([])
    expect(told).toEqual([])
  })

  it('reads every open note again when the window missed luoshu events, since it cannot know which changed', async () => {
    const { notes, views, core, saveOutside } = started({ 'a.md': 'a', 'b.md': 'b' })
    const a = await notes.open('a.md')
    await notes.open('b.md')
    saveOutside('a.md', 'a changed while the window was behind')
    core.hears({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.outside'] })
    await flush()
    expect(views.replaced).toEqual([{ instance: a, text: 'a changed while the window was behind', remote: true }])
  })

  it('refuses to reload over a dirty buffer whose draft could not be kept, so the only copy stays', async () => {
    const { notes, views, core, told, saveOutside } = started()
    core.answers['storage.set'] = () => ({ ok: false, refusal: { code: 'unavailable' } })
    const instance = await notes.open('a.md')
    views.type(instance, 'mine, unsaved')
    notes.changed(instance)
    saveOutside('a.md', 'theirs')
    await notes.reload(instance)
    expect(views.replaced).toEqual([])
    expect(views.texts.get(instance)).toBe('mine, unsaved')
    expect(notes.opened.get(instance)).toMatchObject({ dirty: true, version: 'v-note a' })
    expect(told).toContainEqual({ kind: 'refused', instance, path: 'a.md', code: 'unavailable' })
  })

  it('keeps the plugins whose edits a draft holds and names them on the save after Restore', async () => {
    const { notes, views, core, space, saveOutside } = started()
    const instance = await notes.open('a.md')
    notes.edited(instance, 'spy')
    views.type(instance, 'pay mallory')
    notes.changed(instance)
    saveOutside('a.md', 'theirs')
    await notes.reload(instance)
    expect(space.get(keyOf('a.md'))).toMatchObject({ text: 'pay mallory', edits: ['spy'] })
    notes.restore(instance)
    await notes.save(instance)
    expect(core.calls('luoshu.write').at(-1)?.onBehalf).toBe('spy')
  })

  it('names the plugins of a draft offered when the note opens again, as after the page reloaded', async () => {
    const { notes, space, core } = started()
    space.set(keyOf('a.md'), { path: 'a.md', base: 'v-note a', text: 'pay mallory', at: 5, edits: ['spy'] })
    const instance = await notes.open('a.md')
    notes.restore(instance)
    await notes.save(instance)
    expect(core.calls('luoshu.write').at(-1)?.onBehalf).toBe('spy')
  })

  it('keeps a dirty buffer as a draft before reloading over it', async () => {
    const { notes, views, space, saveOutside } = started()
    const instance = await notes.open('a.md')
    views.type(instance, 'mine, unsaved')
    notes.changed(instance)
    saveOutside('a.md', 'theirs')
    await notes.reload(instance)
    expect(space.get(keyOf('a.md'))).toMatchObject({ text: 'mine, unsaved', base: 'v-note a' })
    expect(views.texts.get(instance)).toBe('theirs')
  })

  it('reloads after a stale save and offers the kept draft again', async () => {
    const { notes, views, told, saveOutside } = started()
    const instance = await notes.open('a.md')
    saveOutside('a.md', 'theirs')
    views.type(instance, 'mine')
    notes.changed(instance)
    await notes.save(instance)
    await notes.reload(instance)
    expect(views.texts.get(instance)).toBe('theirs')
    expect(notes.opened.get(instance)).toMatchObject({ version: 'v-theirs', dirty: false })
    expect(told.at(-1)).toEqual({ kind: 'draft', instance, path: 'a.md', at: 1000, changedSince: true })
  })
})

