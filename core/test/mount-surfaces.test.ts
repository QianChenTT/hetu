import { describe, expect, it } from 'vitest'
import { MAX_SURFACES, type UiNode } from '../api/ui.ts'
import { Surfaces } from '../frontend/mount/surfaces.ts'

const text = (id: string, value: string): UiNode => ({ kind: 'text', id, text: value })

describe('the trees the drawer keeps', () => {
  it('keeps one tree per owner and surface, each changed only by its own operations', () => {
    const surfaces = new Surfaces()
    expect(surfaces.apply('alpha', 'v1', [{ op: 'tree', root: text('a', 'one') }], false)).toMatchObject({ tree: text('a', 'one') })
    expect(surfaces.apply('beta', 'v2', [{ op: 'tree', root: text('a', 'two') }], false)).toMatchObject({ tree: text('a', 'two') })
    surfaces.apply('alpha', 'v1', [{ op: 'text', id: 'a', text: 'ONE' }], false)
    expect(surfaces.tree('alpha', 'v1')).toEqual(text('a', 'ONE'))
    expect(surfaces.tree('beta', 'v2')).toEqual(text('a', 'two'))
    expect(surfaces.tree('beta', 'v1')).toBe(null)
  })

  it('answers invalid for refused operations and keeps what the surface had', () => {
    const surfaces = new Surfaces()
    surfaces.apply('alpha', 'v1', [{ op: 'tree', root: text('a', 'one') }], false)
    expect(surfaces.apply('alpha', 'v1', [{ op: 'text', id: 'b', text: 'x' }], false)).toMatchObject({ refusal: 'invalid' })
    expect(surfaces.apply('alpha', 'v1', [{ op: 'tree', root: { kind: 'slot', id: 's', instance: 'v1' } }], false)).toMatchObject({ refusal: 'invalid' })
    expect(surfaces.tree('alpha', 'v1')).toEqual(text('a', 'one'))
  })

  it(`holds an owner to ${MAX_SURFACES} surfaces`, () => {
    const surfaces = new Surfaces()
    for (let i = 0; i < MAX_SURFACES; i++) expect(surfaces.apply('alpha', `v${i}`, [{ op: 'tree', root: text('a', 'x') }], false)).toHaveProperty('tree')
    expect(surfaces.apply('alpha', 'v99', [{ op: 'tree', root: text('a', 'x') }], false)).toMatchObject({ refusal: 'invalid' })
    expect(surfaces.apply('beta', 'v99', [{ op: 'tree', root: text('a', 'x') }], false)).toHaveProperty('tree')
  })

  it('drops a surface or everything an owner drew', () => {
    const surfaces = new Surfaces()
    surfaces.apply('alpha', 'v1', [{ op: 'tree', root: text('a', 'x') }], false)
    surfaces.apply('alpha', 'layout', [{ op: 'tree', root: text('a', 'x') }], true)
    surfaces.dropSurface('alpha', 'v1')
    expect(surfaces.tree('alpha', 'v1')).toBe(null)
    expect(surfaces.tree('alpha', 'layout')).not.toBe(null)
    surfaces.drop('alpha')
    expect(surfaces.tree('alpha', 'layout')).toBe(null)
  })
})
