import { describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import { checkedAnswer, highestClass, type ClassTable } from '../api/classes.ts'

const read: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const fetchOne: Capability = { type: 'net.fetch', hosts: ['example.com'] }
const stored = { class: 1, firstUse: [], unclassed: false, owed: null }

// sync is approved now, reader has an entry and gate is a core plugin with no entry
const table: ClassTable = {
  cause: 'approve',
  change: { id: 'sync', granted: [read, fetchOne] },
  confirm: true,
  plugins: [{ id: 'reader', granted: [read], stored }, { id: 'gate', granted: [], stored: null }],
}
const pass: ClassTable = { cause: 'start', change: null, confirm: false, plugins: table.plugins }
const removal: ClassTable = { ...table, cause: 'remove', change: { id: 'reader', granted: null } }
const verdict = (over: object = {}) => ({ id: 'sync', class: 4, firstUse: [{ hosts: ['example.com'], type: 'net.fetch' }], owed: null, ...over })
const answer = (over: object = {}) => ({ plugins: [verdict()], lines: ['Class 4, Powerful'], ...over })

describe('the shape check on the classifier\'s answer', () => {
  it('takes an answer of the right shape and hands back each item as the table holds it', () => {
    expect(checkedAnswer(table, answer())).toEqual({ plugins: [{ id: 'sync', class: 4, firstUse: [fetchOne], owed: null }], lines: ['Class 4, Powerful'] })
    expect(checkedAnswer(table, answer())!.plugins[0].firstUse[0]).toBe(fetchOne)
  })

  it('takes a notice owed naming a plugin in the table and the highest class', () => {
    const owed = { from: null, cause: 'approve', by: 'sync' }
    expect(checkedAnswer(table, answer({ plugins: [verdict({ class: highestClass, owed })] }))!.plugins[0].owed).toEqual(owed)
    expect(highestClass).toBe(4)
  })

  it('takes a verdict for another plugin with an entry beside the changed plugin\'s', () => {
    const both = answer({ plugins: [verdict(), verdict({ id: 'reader', class: 4, firstUse: [] })] })
    expect(checkedAnswer(table, both)!.plugins.map(one => one.id)).toEqual(['sync', 'reader'])
  })

  it('takes a removal answered for no plugin and a pass answered for every entry', () => {
    expect(checkedAnswer(removal, { plugins: [], lines: [] })).toEqual({ plugins: [], lines: [] })
    expect(checkedAnswer(pass, { plugins: [verdict({ id: 'reader', class: 1, firstUse: [] })], lines: [] })).not.toBeNull()
  })

  it.each([
    ['nothing', undefined],
    ['a list', []],
    ['a field it does not know', answer({ extra: true })],
    ['plugins that are no list', answer({ plugins: 'all' })],
    ['a line that is no text', answer({ lines: [1] })],
    ['a class past the highest', answer({ plugins: [verdict({ class: 5 })] })],
    ['a class below 0', answer({ plugins: [verdict({ class: -1 })] })],
    ['a class that is not whole', answer({ plugins: [verdict({ class: 1.5 })] })],
    ['a class as text', answer({ plugins: [verdict({ class: '4' })] })],
    ['first use that is no list', answer({ plugins: [verdict({ firstUse: 'all' })] })],
    ['a first-use item the plugin does not hold', answer({ plugins: [verdict({ firstUse: [{ type: 'net.fetch', hosts: ['*'] }] })] })],
    ['a first-use item that is no item', answer({ plugins: [verdict({ firstUse: [null] })] })],
    ['a verdict naming a plugin it was not handed', answer({ plugins: [verdict(), verdict({ id: 'stranger', firstUse: [] })] })],
    ['a verdict for a core plugin', answer({ plugins: [verdict(), verdict({ id: 'gate', firstUse: [] })] })],
    ['a plugin answered twice', answer({ plugins: [verdict(), verdict()] })],
    ['no verdict for the changed plugin', answer({ plugins: [] })],
    ['a verdict missing a field', answer({ plugins: [{ id: 'sync', class: 4, firstUse: [] }] })],
    ['a verdict with a field it does not know', answer({ plugins: [verdict({ unclassed: true })] })],
    ['a notice from a class out of range', answer({ plugins: [verdict({ owed: { from: 7, cause: 'approve', by: null } })] })],
    ['a notice with a cause it does not know', answer({ plugins: [verdict({ owed: { from: 0, cause: 'moved', by: null } })] })],
    ['a notice naming a plugin not in the table', answer({ plugins: [verdict({ owed: { from: 0, cause: 'approve', by: 'stranger' } })] })],
  ])('refuses %s', (_name, given) => {
    expect(checkedAnswer(table, given)).toBeNull()
  })

  it('refuses a verdict for the plugin a removal takes away and a pass that leaves an entry out', () => {
    expect(checkedAnswer(removal, { plugins: [verdict({ id: 'reader', firstUse: [] })], lines: [] })).toBeNull()
    expect(checkedAnswer(pass, { plugins: [], lines: [] })).toBeNull()
  })
})
