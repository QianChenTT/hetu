import { describe, expect, it } from 'vitest'
import type { Capability } from 'hetu-core/api/capabilities.ts'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Access, GrantedItem, Scope, GrantsSnapshot } from 'hetu-core/api/policy-jobs.ts'
import { createGate } from '../src/gate.ts'

const mcp: Caller = { kind: 'plugin', id: 'mcp', half: 'worker', incarnation: 1 }
const search: Caller = { kind: 'plugin', id: 'search', half: 'worker', incarnation: 1 }

const item = (capability: Capability, more: Partial<GrantedItem> = {}): GrantedItem => ({ capability, off: false, firstUse: false, ...more })
const read = (...paths: string[]): Capability => ({ type: 'luoshu.read', paths })
const table = <T>(entries: Record<string, T>): Record<string, T> => Object.assign(Object.create(null), entries)

function access(caller: Caller, agent: string | undefined, capability: Access['capability'], scope: Scope, stage: Access['stage'] = 'canonical'): Access {
  return { stage, caller, action: 'test.action', capability, scope, ...(agent === undefined ? {} : { agent, onBehalf: agent }) }
}

// mcp holds inbox and private, agent #1 inbox and secret, agent #3 private. search holds everything
function gateWith(more: Partial<GrantsSnapshot> = {}) {
  const gate = createGate()
  gate.stateChanged({
    n: 4, foldCase: false, execAny: [],
    plugins: table({ mcp: [item(read('inbox/**', 'private/**'))], search: [item(read('**'))] }),
    agents: table({ 'client#1': [item(read('inbox/**', 'secret/**'))], 'client#3': [item(read('private/**'))] }),
    ...more,
  })
  return gate
}

const reads = (path: string) => ({ paths: [path] })

describe('an agent\'s call', () => {
  it('is allowed only inside both the agent\'s own items and the caller\'s', () => {
    const gate = gateWith()
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md')))).toEqual({ allow: true, view: 4 })
    // Inside mcp's, outside the agent's
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('private/b.md')))).toEqual({ allow: false, code: 'not-granted', view: 4 })
    // Inside the agent's, outside mcp's
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('secret/c.md')))).toEqual({ allow: false, code: 'not-granted', view: 4 })
    expect(gate.decide(access(mcp, 'client#3', 'luoshu.read', reads('private/b.md')))).toEqual({ allow: true, view: 4 })
    // Every path of the call inside both
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', { paths: ['inbox/a.md', 'private/b.md'] }))).toMatchObject({ allow: false })
  })

  it('reaches nothing for an agent with no item, the caller\'s own items notwithstanding', () => {
    const gate = gateWith()
    expect(gate.decide(access(mcp, 'client#2', 'luoshu.read', reads('inbox/a.md')))).toEqual({ allow: false, code: 'not-granted', view: 4 })
    expect(gate.decide(access(search, 'client#2', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false, code: 'not-granted' })
    expect(gate.canRead(mcp, 'inbox/a.md', 'client#2')).toBe(false)
    expect(gate.canList(mcp, 'inbox/a.md', 'client#2')).toBe(false)
  })

  it('reads one agent\'s items for its own label only', () => {
    const gate = gateWith()
    expect(gate.decide(access(mcp, 'client#3', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false, code: 'not-granted' })
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('private/b.md')))).toMatchObject({ allow: false, code: 'not-granted' })
    // A label that only differs in case or by a suffix is another agent
    expect(gate.decide(access(mcp, 'CLIENT#1', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false })
    expect(gate.decide(access(mcp, 'client#1 ', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false })
  })

  it('judges the agent beside whichever plugin makes the call, a plugin under mcp included', () => {
    const gate = gateWith()
    expect(gate.decide(access(search, 'client#1', 'luoshu.read', reads('secret/c.md')))).toMatchObject({ allow: true })
    expect(gate.decide(access(search, 'client#1', 'luoshu.read', reads('private/b.md')))).toMatchObject({ allow: false, code: 'not-granted' })
  })

  it('takes nothing from mcp\'s own unlabelled items for an agent, nor from an onBehalf that isn\'t an agent', () => {
    const gate = gateWith()
    // onBehalf alone grants nothing and takes nothing away
    expect(gate.decide({ ...access(mcp, undefined, 'luoshu.read', reads('private/b.md')), onBehalf: 'client#1' })).toMatchObject({ allow: true })
    expect(gate.decide({ ...access(mcp, undefined, 'luoshu.read', reads('secret/c.md')), onBehalf: 'client#1' })).toMatchObject({ allow: false })
  })

  it('asks for the caller\'s own item at its first use, never for an agent\'s and an agent\'s item off or asking covers nothing', () => {
    const asking = gateWith({ plugins: table({ mcp: [item(read('inbox/**'), { firstUse: true })] }) })
    expect(asking.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md')))).toEqual({ ask: JSON.stringify([['paths', ['inbox/**']], ['type', 'luoshu.read']]), view: 4 })
    expect(asking.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md'), 'raw'))).toEqual({ allow: true, view: 4 })
    // An agent outside its own items is refused before the caller's item asks
    expect(asking.decide(access(mcp, 'client#2', 'luoshu.read', reads('inbox/a.md')))).toEqual({ allow: false, code: 'not-granted', view: 4 })
    for (const more of [{ off: true }, { firstUse: true }]) {
      const gate = gateWith({ agents: table({ 'client#1': [item(read('inbox/**'), more)] }) })
      expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md')))).toEqual({ allow: false, code: 'not-granted', view: 4 })
      expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md'), 'raw'))).toEqual({ allow: false, code: 'not-granted', view: 4 })
      expect(gate.canRead(mcp, 'inbox/a.md', 'client#1')).toBe(false)
    }
  })

  it('keeps the caller\'s switched-off answer under an agent whose own items allow the call', () => {
    const gate = gateWith({ plugins: table({ mcp: [item(read('inbox/**'), { off: true })] }) })
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md')))).toEqual({ allow: false, code: 'switched-off', view: 4 })
  })

  // What mcp's own items answer on on/, off/, asks/ and none/: allow, switched-off, an ask and not-granted. Agent #1 holds
  // every folder, #2 nothing and #4 an item outside the four
  describe('answers not-granted to an agent whose own items don\'t allow, whatever mcp\'s own items would have answered', () => {
    const own = [item(read('on/**')), item(read('off/**'), { off: true }), item(read('asks/**'), { firstUse: true })]
    const gate = gateWith({
      plugins: table({ mcp: own, search: own }),
      agents: table({ 'client#1': [item(read('on/**', 'off/**', 'asks/**', 'none/**'))], 'client#4': [item(read('elsewhere/**'))] }),
    })
    const asked = { ask: JSON.stringify([['paths', ['asks/**']], ['type', 'luoshu.read']]), view: 4 }
    const allow = { allow: true, view: 4 }
    const refused = (code: string) => ({ allow: false, code, view: 4 })
    const ownAnswers = { on: allow, off: refused('switched-off'), asks: asked, none: refused('not-granted') }
    const none = { on: refused('not-granted'), off: refused('not-granted'), asks: refused('not-granted'), none: refused('not-granted') }
    const cases: [string, string | undefined, Record<string, object>][] = [
      ['its own call', undefined, ownAnswers], ['an agent whose items cover it', 'client#1', ownAnswers],
      ['an agent with no item', 'client#2', none], ['an agent with an item outside', 'client#4', none],
    ]
    it.each(cases)('for %s', (_who, agent, expected) => {
      for (const folder of ['on', 'off', 'asks', 'none']) {
        for (const from of [mcp, search]) expect(gate.decide(access(from, agent, 'luoshu.read', reads(`${folder}/n.md`)))).toEqual(expected[folder])
        // The raw stage never asks. An agent its own items refuse is refused there too, so no prompt is ever raised for it
        const raw = gate.decide(access(mcp, agent, 'luoshu.read', reads(`${folder}/n.md`), 'raw'))
        expect('ask' in raw).toBe(false)
        if (expected === none) expect(raw).toEqual(refused('not-granted'))
      }
    })
  })

  it('needs the agent\'s item of the call\'s own type, so a read item gives no write and no plugin call', () => {
    const gate = gateWith({
      plugins: table({ mcp: [item(read('**')), item({ type: 'luoshu.write', paths: ['**'] }), item({ type: 'plugin.call', targets: ['search'] })] }),
    })
    expect(gate.decide(access(mcp, 'client#1', 'luoshu.write', reads('inbox/a.md')))).toMatchObject({ allow: false, code: 'not-granted' })
    expect(gate.decide(access(mcp, 'client#1', 'plugin.call', { target: 'search' }))).toMatchObject({ allow: false, code: 'not-granted' })
  })

  it('gives every agent nothing on a view with no agents and fails on one whose agents it can\'t read', () => {
    const none = gateWith({ agents: undefined })
    expect(none.decide(access(mcp, 'client#1', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false, code: 'not-granted' })
    for (const agents of [null, [], { 'client#1': 'inbox/**' }, { 'client#1': [{ capability: read('inbox/**') }] }]) {
      expect(() => gateWith({ agents: agents as never })).toThrow()
    }
  })

  it('keeps a label every object knows as one agent\'s', () => {
    const gate = gateWith({ agents: table({ ['__proto__']: [item(read('inbox/**'))] }) })
    expect(gate.decide(access(mcp, '__proto__', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: true })
    expect(gate.decide(access(mcp, 'constructor', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false })
    expect(gate.decide(access(mcp, 'toString', 'luoshu.read', reads('inbox/a.md')))).toMatchObject({ allow: false })
  })
})

describe('what an agent may read and list', () => {
  it('answers canRead and canList inside both the caller\'s items and the agent\'s, the caller\'s alone with no agent', () => {
    const gate = gateWith()
    expect(gate.canRead(mcp, 'inbox/a.md', 'client#1')).toBe(true)
    expect(gate.canRead(mcp, 'private/b.md', 'client#1')).toBe(false)
    expect(gate.canRead(mcp, 'secret/c.md', 'client#1')).toBe(false)
    expect(gate.canRead(mcp, 'private/b.md')).toBe(true)
    expect(gate.canList(mcp, 'inbox/a.md', 'client#1')).toBe(true)
    expect(gate.canList(mcp, 'private/b.md', 'client#1')).toBe(false)
    expect(gate.canList(mcp, 'private/b.md', 'client#3')).toBe(true)
    expect(gate.canList(mcp, 'private/b.md')).toBe(true)
  })

  it('lists for an agent through its luoshu.list item as a plugin lists through one', () => {
    const gate = gateWith({ agents: table({ 'client#1': [item({ type: 'luoshu.list', paths: ['private/**'] })] }) })
    expect(gate.canList(mcp, 'private/b.md', 'client#1')).toBe(true)
    expect(gate.canRead(mcp, 'private/b.md', 'client#1')).toBe(false)
  })
})
