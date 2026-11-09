import { describe, expect, it } from 'vitest'
import { CoreLink } from '../frontend/mount/link.ts'
import { fakeCore, settle } from './mount-fakes.ts'

describe("the window's link to the core", () => {
  it('sends a call and settles with its reply', async () => {
    const core = fakeCore({ 'core.self': () => ({ ok: true, result: { kind: 'window' } }) })
    const link = new CoreLink(core.bridge)
    link.start()
    expect(await link.call('core.self')).toEqual({ ok: true, result: { kind: 'window' } })
    expect(core.sent[0]).toEqual({ v: 1, kind: 'call', id: 1, action: 'core.self', args: undefined })
  })

  it('names onBehalf when asked', async () => {
    const core = fakeCore({ 'luoshu.write': () => ({ ok: true, result: { version: 'v' } }) })
    const link = new CoreLink(core.bridge)
    link.start()
    await link.call('luoshu.write', { path: 'a.md', text: 'x' }, { onBehalf: 'alpha,beta' })
    expect(core.sent[0].onBehalf).toBe('alpha,beta')
  })

  it('settles a refusal as a reply that is not ok', async () => {
    const core = fakeCore({ 'luoshu.read': () => ({ ok: false, refusal: { code: 'not-found' } }) })
    const link = new CoreLink(core.bridge)
    link.start()
    expect(await link.call('luoshu.read', { path: 'a.md' })).toEqual({ ok: false, refusal: { code: 'not-found' } })
  })

  it('acks each event once before its handlers run, then calls each handler for its topic', async () => {
    const core = fakeCore()
    const link = new CoreLink(core.bridge)
    const heard: string[] = []
    link.on('luoshu.outside', event => heard.push(`a ${event.path}`))
    link.on('luoshu.outside', event => {
      heard.push(`b ${event.path}`)
      link.call('core.self')
    })
    link.start()
    core.event('luoshu.outside', 'n.md')
    core.event('core.status')
    expect(heard).toEqual(['a n.md', 'b n.md'])
    expect(core.sent.map(message => message.kind)).toEqual(['ack', 'call', 'ack'])
  })

  it('subscribes to topics and keeps a handler that throws from stopping the others', async () => {
    const core = fakeCore({ 'events.subscribe': () => ({ ok: true, result: { standing: [] } }) })
    const link = new CoreLink(core.bridge)
    link.start()
    const heard: string[] = []
    link.on('core.security', () => {
      throw new Error('broken')
    })
    link.on('core.security', () => heard.push('second'))
    await link.subscribe(['core.security'])
    core.event('core.security')
    await settle()
    expect(core.calls('events.subscribe')[0].args).toEqual({ topics: ['core.security'] })
    expect(heard).toEqual(['second'])
  })

  it('ignores a reply it never asked for and anything that is no message', () => {
    const core = fakeCore()
    const link = new CoreLink(core.bridge)
    link.start()
    core.hears({ v: 1, kind: 'reply', id: 99, ok: true })
    core.hears(null)
    core.hears('text')
    expect(core.sent).toEqual([])
  })
})

describe('events the window missed past its credits', () => {
  it('hands each topic events.dropped names to its handlers with no path, and acks nothing for the signal', () => {
    const core = fakeCore()
    const link = new CoreLink(core.bridge)
    link.start()
    const heard: string[] = []
    link.on('core.security', event => heard.push(`${event.topic} ${event.path ?? '-'}`))
    link.on('luoshu.changed', event => heard.push(`${event.topic} ${event.path ?? '-'}`))
    core.hears({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.changed', 'core.security', 'other.topic'] })
    expect(heard).toEqual(['luoshu.changed -', 'core.security -'])
    expect(core.sent).toEqual([])
  })

  it('ignores an events.dropped whose topics are no list of names', () => {
    const core = fakeCore()
    const link = new CoreLink(core.bridge)
    link.start()
    const heard: string[] = []
    link.on('core.status', event => heard.push(event.topic))
    core.hears({ v: 1, kind: 'event', topic: 'events.dropped', topics: 'core.status' })
    core.hears({ v: 1, kind: 'event', topic: 'events.dropped', topics: [7, 'core.status'] })
    expect(heard).toEqual(['core.status'])
  })
})
