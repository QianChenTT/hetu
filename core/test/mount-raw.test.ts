import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/mount/link.ts'
import { Notes } from '../frontend/mount/notes.ts'
import { RAW_RECENT, RawSource } from '../frontend/mount/raw.ts'
import { fakeCore, settle } from './mount-fakes.ts'

function started(files: Record<string, string>) {
  const core = fakeCore({
    'events.subscribe': () => ({ ok: true, result: { standing: [] } }),
    'storage.get': () => ({ ok: true, result: null }),
    'luoshu.read': args => {
      const path = (args as { path: string }).path
      return path in files ? { ok: true, result: { text: files[path], version: `v-${files[path]}`, path } } : { ok: false, refusal: { code: 'not-found' } }
    },
  })
  const link = new CoreLink(core.bridge)
  link.start()
  const texts = new Map<string, string>()
  const notes = new Notes(link, {
    create: (instance, text) => void texts.set(instance, text),
    text: instance => texts.get(instance) ?? '',
    replace: (instance, text) => void texts.set(instance, text),
    destroy: instance => void texts.delete(instance),
  }, () => {})
  notes.start()
  const raw = new RawSource(link, notes, instance => texts.get(instance) ?? '')
  raw.start()
  return { core, notes, raw, texts }
}

describe('the raw view', () => {
  it("shows the focused instance's buffer, unsaved text included", async () => {
    const { notes, raw, texts } = started({ 'a.md': '**a**' })
    const instance = await notes.open('a.md')
    texts.set(instance, '**a** typed')
    expect(await raw.show(instance)).toEqual({ path: 'a.md', text: '**a** typed' })
  })

  it('with nothing focused shows the note written last, read through luoshu.read', async () => {
    const { raw, core } = started({ 'a.md': 'a', 'b.md': 'b' })
    core.event('luoshu.changed', 'a.md')
    core.event('luoshu.outside', 'b.md')
    expect(await raw.show(null)).toEqual({ path: 'b.md', text: 'b' })
  })

  it('shows nothing with nothing focused and nothing written', async () => {
    const { raw } = started({})
    expect(await raw.show(null)).toBe(null)
  })

  it('keeps the ten notes written last, newest first, with no repeats', () => {
    const { raw, core } = started({})
    for (let i = 0; i < 12; i++) core.event('luoshu.changed', `n${i}.md`)
    core.event('luoshu.changed', 'n5.md')
    expect(RAW_RECENT).toBe(10)
    expect(raw.recent()).toEqual(['n5.md', 'n11.md', 'n10.md', 'n9.md', 'n8.md', 'n7.md', 'n6.md', 'n4.md', 'n3.md', 'n2.md'])
  })

  it('shows a picked note, from its buffer when it is open', async () => {
    const { notes, raw, texts } = started({ 'a.md': 'a', 'b.md': 'b' })
    const a = await notes.open('a.md')
    texts.set(a, 'a unsaved')
    expect(await raw.show(null, 'a.md')).toEqual({ path: 'a.md', text: 'a unsaved' })
    expect(await raw.show(a, 'b.md')).toEqual({ path: 'b.md', text: 'b' })
  })

  it('shows nothing for a note it can not read', async () => {
    const { raw } = started({})
    expect(await raw.show(null, 'gone.md')).toBe(null)
    await settle()
  })
})
