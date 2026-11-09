import { describe, expect, it } from 'vitest'
import { installIds, slotIds } from '../api/ids.ts'
import { plan, type Node, type Status } from '../backend/loader/graph.ts'
import { bootOrder } from '../backend/loader/loader.ts'

const ok: Status = { kind: 'ok' }
const node = (id: string, requires: string[] = [], status: Status = ok, rank = 0): Node => ({ id, status, requires, rank })
const verdict = (nodes: Node[], id: string) => plan(nodes).verdicts.get(id)

describe('the requires graph', () => {
  it('starts a plugin whose requirements can all start', () => {
    expect(verdict([node('luoshu'), node('search', ['luoshu'])], 'search')).toEqual({ kind: 'start' })
  })

  it('refuses every plugin in a cycle with cycle, and only those', () => {
    const nodes = [node('a', ['b']), node('b', ['c']), node('c', ['a']), node('d')]
    const { verdicts } = plan(nodes)
    for (const id of ['a', 'b', 'c']) expect(verdicts.get(id)).toEqual({ kind: 'refused', reason: 'cycle' })
    expect(verdicts.get('d')).toEqual({ kind: 'start' })
  })

  it('refuses a plugin that requires itself', () => {
    expect(verdict([node('a', ['a'])], 'a')).toEqual({ kind: 'refused', reason: 'cycle' })
  })

  it('leaves a dependent of a cycle waiting on the member it names, not in the cycle itself', () => {
    const nodes = [node('a', ['b']), node('b', ['a']), node('c', ['a'])]
    expect(verdict(nodes, 'c')).toEqual({ kind: 'waiting', reason: 'dependency:a:refused' })
  })

  it('finds no cycle through a plugin that is off, which waits instead', () => {
    const nodes = [node('a', ['b']), node('b', ['a'], { kind: 'off' })]
    expect(verdict(nodes, 'a')).toEqual({ kind: 'waiting', reason: 'dependency:b:off' })
    expect(verdict(nodes, 'b')).toEqual({ kind: 'off' })
  })

  it.each([
    ['absent', [] as Node[], 'absent'],
    ['new', [node('luoshu', [], { kind: 'found' })], 'new'],
    ['off', [node('luoshu', [], { kind: 'off' })], 'off'],
    ['refused', [node('luoshu', [], { kind: 'refused', reason: 'tampered' })], 'refused'],
    ['outside the API range', [node('luoshu', [], { kind: 'refused', reason: 'api' })], 'api'],
    ['crashed', [node('luoshu', [], { kind: 'held', state: 'crashed', reason: 'closed' })], 'crashed'],
    ['failed', [node('luoshu', [], { kind: 'held', state: 'failed', reason: 'start-timeout' })], 'failed'],
    ['stopped', [node('luoshu', [], { kind: 'held', state: 'stopped', reason: 'watchdog' })], 'stopped'],
  ])('leaves a dependent waiting with dependency:<id>:<why> when its requirement is %s', (_name, others, why) => {
    expect(verdict([...others, node('search', ['luoshu'])], 'search')).toEqual({ kind: 'waiting', reason: `dependency:luoshu:${why}` })
  })

  it('names only the direct dependency, never one further down', () => {
    const nodes = [node('a', ['b']), node('b', ['c']), node('c', [], { kind: 'off' })]
    expect(verdict(nodes, 'b')).toEqual({ kind: 'waiting', reason: 'dependency:c:off' })
    expect(verdict(nodes, 'a')).toEqual({ kind: 'waiting', reason: 'dependency:b:waiting' })
  })

  it('names the first requirement in the plugin\'s own list that cannot serve it', () => {
    const nodes = [node('x', [], { kind: 'off' }), node('y', [], { kind: 'refused', reason: 'tampered' }), node('p', ['y', 'x'])]
    expect(verdict(nodes, 'p')).toEqual({ kind: 'waiting', reason: 'dependency:y:refused' })
  })

  it('passes a status other than ok through as it is', () => {
    const held: Status = { kind: 'held', state: 'crashed', reason: 'flood' }
    expect(verdict([node('a', [], held)], 'a')).toEqual(held)
  })

  it('orders every plugin after what it requires, the lowest rank first among the rest', () => {
    const nodes = [node('search', ['luoshu'], ok, 1000), node('luoshu', ['storage'], ok, 5), node('storage', [], ok, 4), node('log', [], ok, 0), node('git', [], ok, 1000)]
    expect(plan(nodes).order).toEqual(['log', 'storage', 'luoshu', 'git', 'search'])
  })

  it('puts plugins in a cycle and behind one last, so every other plugin keeps its place', () => {
    const nodes = [node('a', ['b']), node('b', ['a']), node('c', ['a']), node('d', [], ok, 1)]
    expect(plan(nodes).order).toEqual(['d', 'a', 'b', 'c'])
  })

  it('walks a long chain without running out of stack', () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => node(`p${i}`, i === 0 ? [] : [`p${i - 1}`]))
    expect(plan(nodes).verdicts.get('p1999')).toEqual({ kind: 'start' })
    const looped = [...nodes.slice(1), node('p0', ['p1999'])]
    expect(plan(looped).verdicts.get('p1000')).toEqual({ kind: 'refused', reason: 'cycle' })
  })
})

describe('the boot order', () => {
  it('names every install plugin once, the slot holders first with the log at their head', () => {
    expect([...bootOrder].sort()).toEqual([...installIds].sort())
    expect(new Set(bootOrder.slice(0, slotIds.length))).toEqual(new Set(slotIds))
    expect(bootOrder[0]).toBe('log')
  })

  it('starts the providers before leases, the guard', () => {
    for (const provider of ['storage', 'luoshu', 'history', 'exec']) {
      expect(bootOrder.indexOf(provider as never)).toBeLessThan(bootOrder.indexOf('leases'))
    }
  })
})
