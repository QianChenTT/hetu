import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/editor/link.ts'
import { Notes } from '../frontend/editor/notes.ts'
import { RAW_MIN_BOX, RAW_RECENT, RawSource, rawBox } from '../frontend/editor/raw.ts'
import { fakeCore, settle } from './editor-fakes.ts'

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

// The stage under the bar, in window pixels
const stage = { left: 0, top: 40, width: 1200, height: 800 }

describe('where the real text sits', () => {
  it('covers the editor the layout placed, leaving the bar and the views around it', () => {
    expect(rawBox({ left: 300, top: 40, width: 600, height: 800 }, stage)).toEqual({ left: 300, top: 40, width: 600, height: 800 })
  })

  it('covers the whole stage when no editor is placed', () => {
    expect(rawBox(null, stage)).toEqual(stage)
  })

  // A layout can't make the real text unreadable by shrinking or hiding the box the editor sits in
  it('covers the whole stage for an editor box too small to read much in, by pixels or by its share of the stage', () => {
    expect(rawBox({ left: 300, top: 40, width: stage.width * RAW_MIN_BOX.widthShare - 1, height: 800 }, stage)).toEqual(stage)
    expect(rawBox({ left: 300, top: 40, width: 600, height: stage.height * RAW_MIN_BOX.heightShare - 1 }, stage)).toEqual(stage)
    expect(rawBox({ left: 0, top: 40, width: 0, height: 0 }, stage)).toEqual(stage)
    const small = { left: 0, top: 0, width: 500, height: 300 }
    expect(rawBox({ left: 0, top: 0, width: RAW_MIN_BOX.width - 1, height: 300 }, small)).toEqual(small)
    expect(rawBox({ left: 0, top: 0, width: 400, height: RAW_MIN_BOX.height - 1 }, small)).toEqual(small)
    expect(rawBox({ left: 0, top: 0, width: 400, height: 250 }, small)).toEqual({ left: 0, top: 0, width: 400, height: 250 })
  })

  it('keeps to the part of the editor inside the stage, and to the stage when too little is left', () => {
    expect(rawBox({ left: -100, top: 0, width: 600, height: 900 }, stage)).toEqual({ left: 0, top: 40, width: 500, height: 800 })
    expect(rawBox({ left: 1100, top: 40, width: 600, height: 800 }, stage)).toEqual(stage)
    expect(rawBox({ left: 5000, top: 5000, width: 600, height: 800 }, stage)).toEqual(stage)
  })
})
