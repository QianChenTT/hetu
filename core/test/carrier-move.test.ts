import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, code, harness, worker } from './carrier-fakes.ts'

afterEach(cleanup)

// What the gate was asked, a line per question
const asked = (gate: ReturnType<typeof harness>['gate']) =>
  gate.asked.map(access => `${access.stage} ${access.capability} ${access.scope.paths?.join(' ')}`)

describe('a move judged on both ends', () => {
  // With write alone, a plugin that writes everywhere and reads public/** could move a private note into public/ and
  // read it there
  it('refuses a plugin with write on ** and read on public/** moving a private note anywhere', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['public/**'] }]
    luoshu.files.set('private/x.md', 'secret')
    const sorter = connect(worker('sorter'))
    for (const to of ['public/x.md', 'private/y.md', 'x.md']) {
      expect(code(await sorter.ask('luoshu.move', { from: 'private/x.md', to }))).toBe('not-granted')
    }
    expect(luoshu.performed).toEqual([])
    expect(luoshu.files.get('private/x.md')).toBe('secret')
    expect(asked(gate).slice(0, 2)).toEqual(['raw luoshu.write private/x.md public/x.md', 'raw luoshu.read private/x.md'])
  })

  it('refuses a move whose to end is outside the write grant', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['public/**'] }, { type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('public/a.md', 'a')
    expect(code(await connect(worker('sorter')).ask('luoshu.move', { from: 'public/a.md', to: 'private/a.md' }))).toBe('not-granted')
    expect(luoshu.performed).toEqual([])
    expect(asked(gate)).toEqual(['raw luoshu.write public/a.md private/a.md'])
  })

  it('refuses a move whose from end is outside the write grant, read or not', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['public/**'] }, { type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('private/a.md', 'a')
    expect(code(await connect(worker('sorter')).ask('luoshu.move', { from: 'private/a.md', to: 'public/a.md' }))).toBe('not-granted')
    expect(luoshu.performed).toEqual([])
  })

  it('moves inside both grants, judging both requirements at both stages, and hands perform the canonical ends', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['notes/**'] }, { type: 'luoshu.read', paths: ['notes/**'] }]
    luoshu.files.set('notes/a.md', 'a')
    const reply = await connect(worker('sorter')).ask('luoshu.move', { from: 'notes/a.md', to: 'notes/old/a.md' })
    expect(reply.ok).toBe(true)
    expect(reply.result).toBeNull()
    expect(asked(gate)).toEqual([
      'raw luoshu.write notes/a.md notes/old/a.md',
      'raw luoshu.read notes/a.md',
      'canonical luoshu.write notes/a.md notes/old/a.md',
      'canonical luoshu.read notes/a.md',
    ])
    expect(luoshu.performed[0].prepared.scope.paths).toEqual(['notes/a.md', 'notes/old/a.md'])
    expect(luoshu.files.get('notes/old/a.md')).toBe('a')
  })

  // The text the caller wrote passes at precheck and the end prepare resolved is judged at decide
  it('judges the read on the canonical from end, so a spelling that resolves into a private folder is refused', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['public/**'] }]
    luoshu.files.set('private/x.md', 'secret')
    luoshu.short.set('LINK~1', 'private')
    // public/LINK~1/x.md is written under public/ and prepares to private/x.md
    luoshu.prepare = async call => {
      luoshu.prepared.push(call)
      const { from, to } = call.args as { from: string, to: string }
      return { scope: { paths: [from.replace('public/LINK~1/', 'private/'), to] } }
    }
    const reply = await connect(worker('sorter')).ask('luoshu.move', { from: 'public/LINK~1/x.md', to: 'public/x.md' })
    expect(code(reply)).toBe('not-granted')
    expect(asked(gate)).toEqual([
      'raw luoshu.write public/LINK~1/x.md public/x.md',
      'raw luoshu.read public/LINK~1/x.md',
      'canonical luoshu.write private/x.md public/x.md',
      'canonical luoshu.read private/x.md',
    ])
    expect(luoshu.performed).toEqual([])
    expect(luoshu.released).toHaveLength(1)
  })

  it.each([
    ['one end', { scope: { paths: ['a.md'] } }],
    ['three ends', { scope: { paths: ['a.md', 'b.md', 'c.md'] } }],
    ['no paths', { scope: {} }],
  ])('fails a move whose prepare gave %s', async (_name, given) => {
    const { connect, gate, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['**'] }]
    luoshu.prepare = async () => given as never
    expect(code(await connect(worker('sorter')).ask('luoshu.move', { from: 'a.md', to: 'b.md' }))).toBe('failed')
    expect(luoshu.performed).toEqual([])
    expect(asked(gate)).toEqual(['raw luoshu.write a.md b.md', 'raw luoshu.read a.md'])
  })

  it('answers switched-off when the read the second requirement needs is switched off', async () => {
    const { connect, gate, loader, luoshu } = harness()
    gate.decision = access => (access.capability === 'luoshu.read'
      ? { allow: false, code: 'switched-off', view: loader.current }
      : { allow: true, view: loader.current })
    luoshu.files.set('a.md', 'a')
    expect(code(await connect(worker('sorter')).ask('luoshu.move', { from: 'a.md', to: 'b.md' }))).toBe('switched-off')
    expect(luoshu.performed).toEqual([])
  })

  it('records the move with both canonical ends in its scope', async () => {
    const { carrier, connect, gate, log, luoshu } = harness()
    gate.grants.sorter = [{ type: 'luoshu.write', paths: ['**'] }, { type: 'luoshu.read', paths: ['**'] }]
    luoshu.files.set('a.md', 'a')
    expect((await connect(worker('sorter')).ask('luoshu.move', { from: 'a.md', to: 'b.md' })).ok).toBe(true)
    await carrier.flush()
    const record = log.events('audit.call').find(entry => entry.fields.action === 'luoshu.move')
    expect(record?.fields).toMatchObject({ paths: '["a.md","b.md"]', pathCount: 2, code: null })
  })
})

describe('a remove', () => {
  it('needs write on its path at both stages and nothing else', async () => {
    const { connect, gate, luoshu } = harness()
    gate.grants.cleaner = [{ type: 'luoshu.write', paths: ['public/**'] }]
    luoshu.files.set('public/a.md', 'a')
    luoshu.files.set('private/a.md', 'b')
    const cleaner = connect(worker('cleaner'))
    expect(code(await cleaner.ask('luoshu.remove', { path: 'private/a.md' }))).toBe('not-granted')
    expect(luoshu.files.has('private/a.md')).toBe(true)
    const reply = await cleaner.ask('luoshu.remove', { path: 'public/a.md' })
    expect(reply.ok).toBe(true)
    expect(luoshu.files.has('public/a.md')).toBe(false)
    expect(asked(gate)).toEqual(['raw luoshu.write private/a.md', 'raw luoshu.write public/a.md', 'canonical luoshu.write public/a.md'])
  })

  it('hands the guards and perform the version the caller read', async () => {
    const hash = 'a'.repeat(64)
    const { connect, gate, luoshu } = harness()
    gate.grants.cleaner = [{ type: 'luoshu.write', paths: ['**'] }]
    luoshu.files.set('a.md', 'a')
    expect((await connect(worker('cleaner')).ask('luoshu.remove', { path: 'a.md', baseVersion: hash })).ok).toBe(true)
    expect(luoshu.performed[0].prepared).toEqual({ scope: { paths: ['a.md'] }, baseVersion: hash })
  })
})
