import type { Recording } from '../backend/recording/header.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultLimits } from '../api/limits.ts'
import { MAX_CALL_TOPICS } from '../api/actions.ts'
import { event as eventShape, signal as signalShape } from '../api/envelope.ts'
import type { RouterOptions } from '../backend/router/header.ts'
import type { Router } from '../backend/router/router.ts'
import {
  cleanup, code, editor, harness, type HarnessOptions, host, hostHalf, tick, trusted, windowWay, worker, type FakeGate, type FakeLog, type Message, type Side,
} from './router-fakes.ts'

afterEach(cleanup)

// Ports deliver later than the reply the publisher waits for, so a test that expects nothing waits this long
const settle = () => tick(30)

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('nothing arrived in time')
    await tick(5)
  }
}

// A call on the half's own port, answered only once the router has read everything the half sent before it, acks
// included. Another port's messages can overtake them
const roundTrip = (side: Side) => side.ask('core.self')

const paths = (messages: Message[]) => messages.filter(message => message.kind === 'event' && 'path' in message).map(message => message.path)
const heard = (messages: Message[], topic: string) => messages.filter(message => message.kind === 'event' && message.topic === topic)
// The topics each signal of one kind named, in the order they came
const signals = (messages: Message[], topic: 'events.dropped' | 'events.ended') => heard(messages, topic).map(message => message.topics)

// The luoshu module publishes luoshu.changed and luoshu.outside with a path through the router, search publishes search.indexed with none. search reads
// notes/**, scribe reads every path and git hears search.indexed. way is the editor window and trustedWay the trusted one,
// each holding its window grants and each with its own inbox
function setup(over: HarnessOptions = {}) {
  const parts = harness(over)
  const { router, pluginsManager, gate, connect } = parts
  pluginsManager.sandboxed('search')
  pluginsManager.plugins.search.topics = ['indexed']
  pluginsManager.sandboxed('scribe')
  pluginsManager.sandboxed('git')
  gate.grants.search = [
    { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] },
    { type: 'luoshu.read', paths: ['notes/**'] },
  ]
  gate.grants.scribe = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'luoshu.read', paths: ['**'] }]
  gate.grants.git = [{ type: 'events.subscribe', topics: ['search.indexed'] }]
  const way = windowWay(router, { 'editor-1': editor })
  const trustedWay = windowWay(router, { trusted })
  const search = connect(worker('search'))
  const scribe = connect(worker('scribe'))
  const git = connect(worker('git'))
  // The luoshu telling its subscribers a note changed or changed outside hetu
  const edited = async (path: string) => router.publishCore('luoshu', 'changed', path)
  const outside = async (path: string) => router.publishCore('luoshu', 'outside', path)
  const indexed = () => search.ask('events.publish', { topic: 'search.indexed' })
  return { ...parts, way, trustedWay, search, scribe, git, edited, outside, indexed }
}

describe('a gate outage end to end, the bus\'s proof', () => {
  it('holds every path back while the gate is down, keeps path-less events flowing and resyncs each path subscriber exactly once', async () => {
    const { router, connect, pluginsManager, search, scribe, git, way, trustedWay, edited, indexed } = setup()
    expect((await search.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    expect((await git.ask('events.subscribe', { topics: ['search.indexed'] })).result).toEqual({ standing: [] })
    expect((await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed', 'core.status'] })).result).toEqual({ standing: [] })
    expect((await trustedWay.ask('trusted', 'events.subscribe', { topics: ['core.status'] })).result).toEqual({ standing: [] })
    await edited('notes/a.md')
    await until(() => paths(search.events()).length === 1)
    expect(paths(way.events())).toEqual(['notes/a.md'])

    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    // Subscribes made while the gate is down stand. scribe holds the grant and ghost doesn't, which nobody can tell yet
    const ghost = connect(worker('ghost'))
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    expect((await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    await edited('notes/b.md')
    await indexed()
    // The gate's next push throwing too is the same outage
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await edited('notes/c.md')
    await indexed()
    await until(() => heard(git.events(), 'search.indexed').length === 2)
    await settle()
    // Nothing with a path arrived while the gate was down and nobody was told of a drop yet
    expect(paths(search.events())).toEqual(['notes/a.md'])
    expect(paths(way.events())).toEqual(['notes/a.md'])
    expect(paths(scribe.events())).toEqual([])
    expect(paths(ghost.events())).toEqual([])
    for (const messages of [search.events(), git.events(), way.events(), trustedWay.events(), scribe.events(), ghost.events()]) {
      expect(signals(messages, 'events.dropped')).toEqual([])
    }
    // Path-less events kept arriving, core.status to each window once per change among them
    expect(heard(way.events(), 'core.status')).toHaveLength(2)
    expect(heard(trustedWay.events(), 'core.status')).toHaveLength(2)

    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await edited('notes/d.md')
    await until(() => paths(scribe.events()).length === 1 && paths(search.events()).length === 2)
    await settle()
    // Every path subscriber gets exactly one events.dropped, the trusted window, which hears only core.*, none
    expect(signals(search.events(), 'events.dropped')).toEqual([['luoshu.changed']])
    expect(signals(git.events(), 'events.dropped')).toEqual([['search.indexed']])
    expect(signals(way.events(), 'events.dropped')).toEqual([['luoshu.changed']])
    expect(signals(trustedWay.events(), 'events.dropped')).toEqual([])
    expect(heard(trustedWay.events(), 'core.status')).toHaveLength(3)
    // The standing subscription the gate allows starts with one events.dropped, the one it refuses ends with events.ended
    expect(signals(scribe.events(), 'events.dropped')).toEqual([['luoshu.changed']])
    expect(signals(ghost.events(), 'events.ended')).toEqual([['luoshu.changed']])
    expect(signals(ghost.events(), 'events.dropped')).toEqual([])
    expect(paths(ghost.events())).toEqual([])
    // Paths flow again, each after its subscriber's events.dropped
    expect(paths(search.events())).toEqual(['notes/a.md', 'notes/d.md'])
    expect(paths(scribe.events())).toEqual(['notes/d.md'])
    for (const messages of [search.events(), scribe.events()]) {
      const resync = messages.findIndex(message => message.topic === 'events.dropped')
      const next = messages.findIndex(message => message.path === 'notes/d.md')
      expect(resync).toBeGreaterThanOrEqual(0)
      expect(resync).toBeLessThan(next)
    }
  })

  // Sent whether or not a path was held back, so the signal can't tell a subscriber that a note it can't read changed
  it('gives each outage its own events.dropped, one with nothing published included, and none to a later subscriber', async () => {
    const { router, pluginsManager, search, scribe, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    for (let round = 1; round <= 2; round++) {
      pluginsManager.policyJobs.gate = 'failed'
      router.changed()
      if (round === 1) await edited('secret/x.md')
      pluginsManager.policyJobs.gate = 'on'
      router.changed()
      await until(() => signals(search.events(), 'events.dropped').length === round)
    }
    // scribe subscribes only now and gets nothing to resync
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    router.changed()
    await edited('notes/y.md')
    await until(() => paths(scribe.events()).length === 1)
    expect(signals(scribe.events(), 'events.dropped')).toEqual([])
    expect(signals(search.events(), 'events.dropped')).toEqual([['luoshu.changed'], ['luoshu.changed']])
  })

  it.each(['absent'] as const)('keeps a subscribe made while the gate is %s standing', async state => {
    const { router, pluginsManager, scribe, edited } = setup()
    pluginsManager.policyJobs.gate = state
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    await edited('notes/a.md')
    await settle()
    expect(scribe.events()).toEqual([])
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await edited('notes/b.md')
    await until(() => paths(scribe.events()).length === 1)
    expect(signals(scribe.events(), 'events.dropped')).toEqual([['luoshu.changed']])
  })

  it('sees a gate that came back though the plugins manager never said so, before the next path goes out', async () => {
    const { pluginsManager, search, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'failed'
    await edited('notes/a.md')
    pluginsManager.policyJobs.gate = 'on'
    await edited('notes/b.md')
    await until(() => paths(search.events()).length === 1)
    const events = search.events()
    expect(events.map(message => message.topic)).toEqual(['events.dropped', 'luoshu.changed'])
    expect(events[1].path).toBe('notes/b.md')
  })

  it('treats a gate on with no holder to ask as down, then resyncs', async () => {
    let holder = true
    let held: FakeGate | null = null
    const { router, search, edited, gate } = setup({ gate: () => holder ? held : null })
    held = gate
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    holder = false
    router.changed()
    await edited('notes/a.md')
    holder = true
    router.changed()
    await edited('notes/b.md')
    await until(() => paths(search.events()).length === 1)
    expect(search.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/b.md'])
  })

  // One rule for whether the gate can be asked, so the bus and a subscribe never disagree
  it('stands a subscribe while the gate is on with no holder, as the bus holds paths back then', async () => {
    let holder = true
    let held: FakeGate | null = null
    const { router, scribe, edited, gate } = setup({ gate: () => holder ? held : null })
    held = gate
    holder = false
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    holder = true
    router.changed()
    await edited('notes/a.md')
    await until(() => paths(scribe.events()).length === 1)
    expect(scribe.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/a.md'])
  })

  it('holds paths back and stands a subscribe while the grants snapshot can\'t be read, since every call is refused then', async () => {
    const { router, pluginsManager, search, scribe, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    pluginsManager.view = () => { throw new Error('unreadable') }
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    await edited('notes/secret-while-unreadable.md')
    await settle()
    expect(search.events()).toEqual([])
    expect(scribe.events()).toEqual([])
    pluginsManager.view = () => pluginsManager.current
    router.changed()
    await edited('notes/b.md')
    await until(() => paths(search.events()).length === 1 && paths(scribe.events()).length === 1)
    for (const subscriber of [search, scribe]) {
      expect(subscriber.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/b.md'])
    }
  })

  // A gate that throws when asked again gave no answer, so nothing it holds hears anything until it answers. The bus
  // asks again at every sync rather than waiting for the key to move
  it('holds back every subscription the gate throws on when asked again and starts them at the next sync it answers', async () => {
    const { router, pluginsManager, gate, search, scribe, edited, log } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    gate.decision = () => { throw new Error('broken') }
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await edited('notes/a.md')
    await settle()
    // Neither started nor ended. The live one waits too, since the gate gave no answer
    expect(search.events()).toEqual([])
    expect(scribe.events()).toEqual([])
    gate.decision = null
    // No state and no grants snapshot moved
    router.changed()
    await edited('notes/b.md')
    await until(() => paths(scribe.events()).length === 1 && paths(search.events()).length === 1)
    for (const subscriber of [search, scribe]) {
      expect(subscriber.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/b.md'])
    }
    router.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toContainEqual({ plugin: 'gate', step: 'precheck', count: 1 })
  })

  it('ends a live subscription a new grants snapshot took away though the gate threw when first asked again', async () => {
    const { router, pluginsManager, gate, scribe, git, edited, indexed } = setup()
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    gate.grants.scribe = [{ type: 'luoshu.read', paths: ['**'] }]
    gate.grants.git = []
    let throws = true
    gate.decision = access => {
      if (throws) throw new Error('broken')
      return gate.granted(access)
    }
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await indexed()
    await settle()
    // Path-less events wait too
    expect(scribe.events()).toEqual([])
    expect(git.events()).toEqual([])
    throws = false
    await edited('notes/b.md')
    await indexed()
    await until(() => signals(scribe.events(), 'events.ended').length === 1 && signals(git.events(), 'events.ended').length === 1)
    await settle()
    expect(paths(scribe.events())).toEqual([])
    expect(heard(git.events(), 'search.indexed')).toEqual([])
  })
})

describe('asking again', () => {
  it('ends a subscription a new grants snapshot no longer grants with events.ended and sends it nothing more', async () => {
    const { router, pluginsManager, gate, search, scribe, edited, outside } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    gate.grants.search = [{ type: 'events.subscribe', topics: ['luoshu.outside'] }, { type: 'luoshu.read', paths: ['**'] }]
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await outside('notes/b.md')
    await until(() => paths(scribe.events()).length === 1 && paths(search.events()).length === 1)
    await settle()
    expect(signals(search.events(), 'events.ended')).toEqual([['luoshu.changed']])
    // The other subscription and the other subscriber stay
    expect(paths(search.events())).toEqual(['notes/b.md'])
    expect(signals(scribe.events(), 'events.ended')).toEqual([])
  })

  it('asks the gate nothing again while neither its state nor the grants snapshot moved', async () => {
    const { router, gate, search } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    router.changed()
    const asked = gate.asked.length
    router.changed()
    router.changed()
    expect(gate.asked).toHaveLength(asked)
  })

  it('asks again at both stages and never about a topic no gate holds', async () => {
    const { router, pluginsManager, gate, connect, search } = setup()
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await panel.ask('events.subscribe', { topics: ['search.indexed'] })
    gate.asked.length = 0
    pluginsManager.current = 2
    router.changed()
    expect(gate.asked.map(access => [access.stage, access.caller, access.capability, access.scope])).toEqual([
      ['raw', worker('search'), 'events.subscribe', { topics: ['luoshu.changed'] }],
      ['canonical', worker('search'), 'events.subscribe', { topics: ['luoshu.changed'] }],
    ])
  })

  // An answer on an older grants snapshot means the gate hasn't caught up yet, which refuses nothing
  it('holds back a subscription the gate answers on an older grants snapshot and starts it once the gate answers on this one', async () => {
    const { router, pluginsManager, gate, search, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    gate.decision = () => ({ allow: true, view: 1 })
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await settle()
    expect(search.events()).toEqual([])
    gate.decision = null
    await edited('notes/b.md')
    await until(() => paths(search.events()).length === 1)
    expect(search.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/b.md'])
    expect(signals(search.events(), 'events.ended')).toEqual([])
  })

  it('narrows when the gate is switched back on: what was taken with the gate off and isn\'t granted ends', async () => {
    const { router, pluginsManager, connect, edited } = setup()
    pluginsManager.policyJobs.gate = 'off'
    router.changed()
    const ghost = connect(worker('ghost'))
    expect((await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    await edited('secret/a.md')
    await until(() => paths(ghost.events()).length === 1)
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await edited('secret/b.md')
    await until(() => signals(ghost.events(), 'events.ended').length === 1)
    await settle()
    expect(paths(ghost.events())).toEqual(['secret/a.md'])
  })

  // No gate ever allowed what was taken with the gate off, so a gate switched back on that fails at start holds it
  // back, path-less events included
  it('holds back what was taken with the gate off when the gate switched back on fails, until the gate judges it', async () => {
    const { router, pluginsManager, connect, indexed } = setup()
    pluginsManager.policyJobs.gate = 'off'
    router.changed()
    const ghost = connect(worker('ghost'))
    await ghost.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await until(() => heard(ghost.events(), 'search.indexed').length === 1)
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await indexed()
    await settle()
    expect(heard(ghost.events(), 'search.indexed')).toHaveLength(1)
    // A repeat now stands, so the plugin and the topic get one answer
    expect((await ghost.ask('events.subscribe', { topics: ['search.indexed'] })).result).toEqual({ standing: ['search.indexed'] })
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await until(() => signals(ghost.events(), 'events.ended').length === 1)
    await indexed()
    await settle()
    expect(heard(ghost.events(), 'search.indexed')).toHaveLength(1)
  })

  // A narrowing never asks the gate, so a grants snapshot that moves while the gate is down holds back
  // everything the gate allowed on the old one. What it didn't touch starts again once the gate answers
  it('holds back what the gate allowed on an older grants snapshot when the grants snapshot moves while the gate is down', async () => {
    const { router, pluginsManager, gate, git, search, indexed, edited } = setup()
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await indexed()
    await until(() => heard(git.events(), 'search.indexed').length === 1)
    gate.grants.git = []
    pluginsManager.current = 2
    router.changed()
    await indexed()
    await settle()
    expect(heard(git.events(), 'search.indexed')).toHaveLength(1)
    expect((await git.ask('events.subscribe', { topics: ['search.indexed'] })).result).toEqual({ standing: ['search.indexed'] })
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await edited('notes/a.md')
    await indexed()
    await until(() => signals(git.events(), 'events.ended').length === 1 && paths(search.events()).length === 1)
    await settle()
    expect(heard(git.events(), 'search.indexed')).toHaveLength(1)
    expect(search.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/a.md'])
  })
})

// A subscription live when its item comes to ask at first use, as when another plugin's change moves its plugin into
// class 4, is in use. It waits for the human's Confirm the gate's ask raises, hears nothing meanwhile and goes on after
// it with one events.dropped. A refusal ends it as before
describe('a subscription whose first use the gate comes to ask about', () => {
  const asking = (gate: FakeGate, view: number) => {
    gate.decision = access => access.stage === 'raw' ? gate.granted(access) : { ask: 'events.subscribe luoshu.changed', view }
  }

  it('waits, delivering nothing and ending nothing, and raises the Confirm for its item', async () => {
    const { router, pluginsManager, gate, search, asks, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    asking(gate, 2)
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await edited('notes/b.md')
    await settle()
    expect(search.events()).toEqual([])
    expect(asks.length).toBeGreaterThan(0)
    for (const { ask, access } of asks) {
      expect(ask).toBe('events.subscribe luoshu.changed')
      expect(access).toMatchObject({ stage: 'canonical', caller: worker('search'), capability: 'events.subscribe', scope: { topics: ['luoshu.changed'] } })
    }
  })

  it('goes on after the Confirm with one events.dropped for what it missed while it waited', async () => {
    const { router, pluginsManager, gate, search, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    asking(gate, 2)
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await settle()
    // The Confirm applies the item, which moves the grants snapshot
    gate.decision = null
    pluginsManager.current = 3
    router.changed()
    await edited('notes/b.md')
    await until(() => paths(search.events()).length === 1)
    await settle()
    expect(search.events().map(message => message.path ?? message.topic)).toEqual(['events.dropped', 'notes/b.md'])
    expect(signals(search.events(), 'events.dropped')).toEqual([['luoshu.changed']])
  })

  it('ends a waiting subscription the gate refuses and tells the plugin', async () => {
    const { router, pluginsManager, gate, search, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    asking(gate, 2)
    pluginsManager.current = 2
    router.changed()
    gate.decision = null
    gate.grants.search = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    pluginsManager.current = 3
    router.changed()
    await until(() => signals(search.events(), 'events.ended').length === 1)
    expect(signals(search.events(), 'events.ended')).toEqual([['luoshu.changed']])
    // Gone for good: granted again, it hears nothing until it subscribes again
    gate.grants.search = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'luoshu.read', paths: ['notes/**'] }]
    pluginsManager.current = 4
    router.changed()
    await edited('notes/a.md')
    await settle()
    expect(search.events().map(message => message.topic)).toEqual(['events.ended'])
  })

  it('ends a waiting subscription once the human declined its Confirm, with no grants snapshot moved', async () => {
    let declined = false
    const { router, pluginsManager, gate, search, edited } = setup({
      asks: { raise: () => (declined ? { code: 'not-granted', reason: 'declined' } : 'req-1') },
    })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    asking(gate, 2)
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await settle()
    expect(search.events()).toEqual([])
    declined = true
    await edited('notes/b.md')
    await until(() => signals(search.events(), 'events.ended').length === 1)
    await settle()
    expect(search.events().map(message => message.topic)).toEqual(['events.ended'])
  })

  it('keeps waiting while its Confirm can\'t be raised and raises it at a later sync', async () => {
    let throttled = true
    const raised: string[] = []
    const { router, pluginsManager, gate, search, edited } = setup({
      asks: { raise: ask => {
        if (throttled) return { code: 'throttled' }
        raised.push(ask)
        return 'req-1'
      } },
    })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    asking(gate, 2)
    pluginsManager.current = 2
    router.changed()
    await edited('notes/a.md')
    await settle()
    expect(search.events()).toEqual([])
    expect(raised).toEqual([])
    throttled = false
    await edited('notes/b.md')
    await settle()
    expect(raised).toContain('events.subscribe luoshu.changed')
    expect(search.events()).toEqual([])
  })

  it('records the subscription as waiting, then as started after the Confirm', async () => {
    const { router, pluginsManager, gate, search, log } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    asking(gate, 2)
    pluginsManager.current = 2
    router.changed()
    gate.decision = null
    pluginsManager.current = 3
    router.changed()
    router.close()
    await tick()
    const fields = (event: string) => log.events(event).map(record => record.fields)
    expect(fields('events.waiting')).toEqual([{ plugin: 'search', half: 'worker', topics: 'luoshu.changed', count: 1 }])
    expect(fields('events.started')).toEqual([{ plugin: 'search', half: 'worker', topics: 'luoshu.changed', count: 1 }])
    expect(fields('events.ended')).toEqual([])
  })
})

// A path with a dot segment names no note. The contract's path schema refuses one in a plugin's publish and the core's
// own publish drops one, so a luoshu gone wrong reaches no subscriber with it either
describe('a path with a dot segment', () => {
  const dotted = ['.obsidian/plugins/x/main.js', '.env', 'notes/.hidden.md', 'notes/deep/.config/x.md', '\u200c.obsidian/app.json', '.git/config']

  it.each(['on', 'off'] as const)('reaches no subscriber with the gate %s whatever the gate says, a plugin\'s publish answering invalid', async state => {
    const { router, pluginsManager, gate, search, scribe, git, edited } = setup()
    gate.listable = () => true
    pluginsManager.policyJobs.gate = state
    router.changed()
    for (const side of [search, scribe]) expect((await side.ask('events.subscribe', { topics: ['luoshu.changed'] })).ok).toBe(true)
    expect((await git.ask('events.subscribe', { topics: ['search.indexed'] })).ok).toBe(true)
    for (const path of dotted) {
      await edited(path)
      expect(await search.ask('events.publish', { topic: 'search.indexed', path }), path).toMatchObject({ ok: false, refusal: { code: 'invalid' } })
    }
    await edited('notes/a.md')
    await search.ask('events.publish', { topic: 'search.indexed', path: 'notes/a.md' })
    await until(() => [search, scribe, git].every(side => paths(side.events()).includes('notes/a.md')))
    await settle()
    for (const side of [search, scribe, git]) expect(paths(side.events())).toEqual(['notes/a.md'])
    expect(gate.lists.filter(asked => asked.path !== 'notes/a.md')).toEqual([])
  })
})

describe('the gate off by the human', () => {
  // A bus on a clock the test moves and a log that can't write, with one record queued that waits from 0
  async function failing() {
    let now = 0
    const parts = setup({ clock: () => now })
    parts.pluginsManager.policyJobs.gate = 'off'
    parts.log.failing = true
    await parts.scribe.ask('events.unsubscribe', { topics: ['luoshu.changed'] })
    return { ...parts, at: (ms: number) => { now = ms } }
  }

  it.each([['on', false], ['off', true]] as const)('lets any subscribe through and every path out with recording %s', async (_name, nothing) => {
    const { router, pluginsManager, connect, gate, edited } = setup()
    pluginsManager.policyJobs.gate = 'off'
    pluginsManager.nothing = nothing
    router.changed()
    const ghost = connect(worker('ghost'))
    expect((await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    await edited('secret/a.md')
    await until(() => paths(ghost.events()).length === 1)
    expect(gate.asked).toEqual([])
    expect(gate.lists).toEqual([])
  })

  it('answers a subscribe policy-down once the log has failed for logFailMs, as any call with power', async () => {
    const { at, scribe } = await failing()
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).ok).toBe(true)
    at(30_000)
    expect(code(await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] }))).toBe('policy-down')
    // Free subscribes have no power and still pass
    expect((await scribe.ask('events.unsubscribe', { topics: ['luoshu.changed'] })).ok).toBe(true)
  })

  // canList is true with the gate off by the human and deliveries are never logged, so the log's tie to calls with
  // power doesn't reach them, as filterReadable passes every path then too
  it('delivers every path once the log has failed, since only calls with power need the log', async () => {
    const { at, router, gate, search, edited } = await failing()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    at(30_000)
    router.changed()
    await edited('secret/a.md')
    await edited('secret/b.md')
    await until(() => paths(search.events()).length === 2)
    expect(paths(search.events())).toEqual(['secret/a.md', 'secret/b.md'])
    expect(signals(search.events(), 'events.dropped')).toEqual([])
    expect(gate.lists).toEqual([])
  })

  it('passes everything once the log has failed if the human turned recording off too', async () => {
    const { at, router, pluginsManager, connect, edited } = await failing()
    at(30_000)
    pluginsManager.nothing = true
    router.changed()
    const ghost = connect(worker('ghost'))
    expect((await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })).ok).toBe(true)
    await edited('secret/a.md')
    await until(() => paths(ghost.events()).length === 1)
  })

  it('starts the subscriptions that stood once the human switches a failed gate off', async () => {
    const { router, pluginsManager, connect, edited } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    const ghost = connect(worker('ghost'))
    expect((await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'off'
    router.changed()
    await edited('secret/a.md')
    await until(() => paths(ghost.events()).length === 1)
    expect(signals(ghost.events(), 'events.dropped')).toEqual([['luoshu.changed']])
  })

  // The floor keeps identity, not limits, so its rules stay with the gate off
  it('still keeps core.* to windows and a plugin to its own declared topics', async () => {
    const { router, pluginsManager, search, scribe } = setup()
    pluginsManager.policyJobs.gate = 'off'
    router.changed()
    expect(code(await scribe.ask('events.subscribe', { topics: ['core.status'] }))).toBe('not-granted')
    expect(code(await scribe.ask('events.publish', { topic: 'luoshu.changed', path: 'notes/a.md' }))).toBe('not-granted')
    expect(code(await search.ask('events.publish', { topic: 'search.other' }))).toBe('not-granted')
  })
})

describe('owned topics', () => {
  it.each(['on', 'off', 'failed'] as const)('lets a plugin publish only the topics its manifest declared, with the gate %s', async state => {
    const { pluginsManager, connect, gate, search, scribe, way, trustedWay } = setup()
    pluginsManager.policyJobs.gate = state
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    // Its own declared topic from any of its halves
    expect((await search.ask('events.publish', { topic: 'search.indexed' })).ok).toBe(true)
    expect((await panel.ask('events.publish', { topic: 'search.indexed', path: 'notes/a.md' })).ok).toBe(true)
    // An undeclared topic of its own, another plugin's, a core topic, a signal and a plugin the plugins manager doesn't know
    for (const topic of ['search.other', 'luoshu.changed', 'git.indexed', 'core.status', 'events.dropped']) {
      expect(code(await search.ask('events.publish', { topic }))).toBe('not-granted')
    }
    expect(code(await connect(worker('ghost')).ask('events.publish', { topic: 'ghost.indexed' }))).toBe('not-granted')
    expect(code(await scribe.ask('events.publish', { topic: 'scribe.handle' }))).toBe('not-granted')
    // Windows publish nothing
    expect(code(await way.ask('editor-1', 'events.publish', { topic: 'luoshu.changed', path: 'notes/a.md' }))).toBe('not-granted')
    expect(code(await trustedWay.ask('trusted', 'events.publish', { topic: 'core.status' }))).toBe('not-granted')
    expect(gate.asked).toEqual([])
  })

  it('reads the declared topics as names under the plugin\'s own id and nothing else', async () => {
    const { pluginsManager, search } = setup()
    // An id as long as search's can't borrow a name search declared
    expect(code(await search.ask('events.publish', { topic: 'ghosts.indexed' }))).toBe('not-granted')
    pluginsManager.plugins.search.topics = ['search.indexed', 'indexed.more']
    expect(code(await search.ask('events.publish', { topic: 'search.indexed' }))).toBe('not-granted')
    expect(code(await search.ask('events.publish', { topic: 'search.search' }))).toBe('not-granted')
  })

  it.each([
    ['a topics list that is not an array', () => ({ state: 'ready', place: 'sandboxed', incarnation: 1, serves: 'worker', actions: {}, topics: 'indexed' })],
    ['a plugin that throws on its topics', () => ({ state: 'ready', place: 'sandboxed', incarnation: 1, serves: 'worker', actions: {}, get topics() { throw new Error('no') } })],
    ['a plugins manager that throws', () => { throw new Error('no state') }],
  ])('refuses a publish when the plugins manager gives %s', async (_name, info) => {
    const { pluginsManager, search } = setup()
    pluginsManager.plugin = info as never
    expect(code(await search.ask('events.publish', { topic: 'search.indexed' }))).toBe('not-granted')
  })

  it('resyncs a plugin\'s own subscription made while the gate was down, though a window\'s core.* needs none', async () => {
    const { router, connect, pluginsManager, way } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    expect((await panel.ask('events.subscribe', { topics: ['search.indexed'] })).result).toEqual({ standing: [] })
    await way.ask('editor-1', 'events.subscribe', { topics: ['core.status'] })
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await until(() => signals(panel.events(), 'events.dropped').length === 1)
    expect(signals(panel.events(), 'events.dropped')).toEqual([['search.indexed']])
    expect(signals(way.events(), 'events.dropped')).toEqual([])
  })

  it('lets a plugin hear its own topics for free and never asks the gate about them', async () => {
    const { connect, gate, pluginsManager, search } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    expect((await panel.ask('events.subscribe', { topics: ['search.indexed'] })).result).toEqual({ standing: [] })
    await search.ask('events.publish', { topic: 'search.indexed' })
    await until(() => heard(panel.events(), 'search.indexed').length === 1)
    expect(gate.asked).toEqual([])
  })
})

describe('core.*', () => {
  it('refuses a plugin, a host half included, a core topic whatever its grants and the gate', async () => {
    const { router, connect, pluginsManager, gate, search } = setup()
    pluginsManager.utility('mcp-http-handler')
    const http = connect(host('mcp-http-handler'))
    gate.grants.search.push({ type: 'events.subscribe', topics: ['core.status'] })
    for (const state of ['on', 'off', 'failed'] as const) {
      pluginsManager.policyJobs.gate = state
      expect(code(await search.ask('events.subscribe', { topics: ['core.status'] }))).toBe('not-granted')
      expect(code(await search.ask('events.subscribe', { topics: ['luoshu.changed', 'core.security'] }))).toBe('not-granted')
      expect(code(await http.ask('events.subscribe', { topics: ['core.status'] }))).toBe('not-granted')
    }
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await settle()
    expect(search.events()).toEqual([])
    expect(http.events()).toEqual([])
  })

  // core.* reaches the trusted window by subscription, so the floor lets it subscribe to the core topics only
  it('lets the trusted window hear the core topics and nothing else, with the gate failed', async () => {
    const { router, pluginsManager, trustedWay, gate } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    expect((await trustedWay.ask('trusted', 'events.subscribe', { topics: ['core.status', 'core.security'] })).result).toEqual({ standing: [] })
    expect(code(await trustedWay.ask('trusted', 'events.subscribe', { topics: ['luoshu.changed'] }))).toBe('not-granted')
    expect(code(await trustedWay.ask('trusted', 'events.subscribe', { topics: ['core.status', 'luoshu.changed'] }))).toBe('not-granted')
    expect(code(await trustedWay.ask('trusted', 'events.subscribe', { topics: ['search.indexed'] }))).toBe('not-granted')
    router.changed()
    expect(trustedWay.events().map(message => message.topic)).toEqual(['core.status'])
    expect(gate.asked).toEqual([])
    expect((await trustedWay.ask('trusted', 'events.unsubscribe', { topics: ['core.security'] })).ok).toBe(true)
    // It holds the fixed credits like any window and its ack frees them
    const credits = defaultLimits.eventCredits
    for (let i = 0; i < credits; i++) router.changed()
    trustedWay.post('trusted', { v: 1, kind: 'ack', seq: credits })
    router.changed()
    const seqs = trustedWay.events().map(message => message.seq ?? message.topic)
    expect(seqs.slice(-3)).toEqual([credits, 'events.dropped', credits + 1])
  })

  // The first grants snapshot the router reads is where it starts, so the first changed() sends no core.security
  it('sends core.status to the windows on every change and core.security once per new grants snapshot, never a path', async () => {
    const { router, pluginsManager, way } = setup()
    await way.ask('editor-1', 'events.subscribe', { topics: ['core.status', 'core.security'] })
    router.changed()
    router.changed()
    pluginsManager.current = 2
    router.changed()
    router.changed()
    const events = way.events()
    expect(events.map(message => message.topic)).toEqual(['core.status', 'core.status', 'core.status', 'core.security', 'core.status'])
    expect(events.every(message => !('path' in message) && eventShape.safeParse(message).success)).toBe(true)
  })

  // So the editor can keep a draft before hetu ends
  it('sends core.quitting to the windows that hear it when hetu is about to quit', async () => {
    const { router, way } = setup()
    await way.ask('editor-1', 'events.subscribe', { topics: ['core.quitting'] })
    router.quitting()
    expect(way.events().map(message => message.topic)).toEqual(['core.quitting'])
  })

  it('refuses a core topic the core never sends', async () => {
    const { way } = setup()
    expect(code(await way.ask('editor-1', 'events.subscribe', { topics: ['core.secret'] }))).toBe('invalid')
  })

  it('lets the editor hear core.status with the gate down while its luoshu topics stand', async () => {
    const { router, pluginsManager, way } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    expect((await way.ask('editor-1', 'events.subscribe', { topics: ['core.status', 'luoshu.changed'] })).result).toEqual({ standing: ['luoshu.changed'] })
    router.changed()
    expect(way.events().map(message => message.topic)).toEqual(['core.status'])
  })
})

describe('subscribing', () => {
  it('keeps one subscription per half and topic, so a repeat replaces it and an event arrives once', async () => {
    const { search, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => paths(search.events()).length === 1)
    await settle()
    expect(search.events()).toHaveLength(1)
  })

  it('keeps a live subscription live when it is repeated while the gate is down', async () => {
    const { pluginsManager, git, indexed } = setup()
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    pluginsManager.policyJobs.gate = 'failed'
    expect((await git.ask('events.subscribe', { topics: ['search.indexed'] })).result).toEqual({ standing: [] })
    await indexed()
    await until(() => heard(git.events(), 'search.indexed').length === 1)
  })

  it('starts a standing subscription with events.dropped when a repeat finds the gate up', async () => {
    const { router, pluginsManager, scribe, edited } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'on'
    // The bus sees the gate again before it judges the repeat, so the subscription starts once
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    await edited('notes/a.md')
    await until(() => paths(scribe.events()).length === 1)
    expect(signals(scribe.events(), 'events.dropped')).toEqual([['luoshu.changed']])
  })

  // Nothing moved for the bus to ask again, so only the repeat's own judgement can start it
  it('starts a standing subscription with events.dropped when a repeat is allowed after the gate could not answer about it', async () => {
    const { router, pluginsManager, gate, scribe, edited } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    let throws = true
    gate.decision = access => {
      if (throws) throw new Error('broken')
      return gate.granted(access)
    }
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await settle()
    expect(scribe.events()).toEqual([])
    throws = false
    expect((await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })).result).toEqual({ standing: [] })
    await edited('notes/a.md')
    await until(() => paths(scribe.events()).length === 1)
    expect(signals(scribe.events(), 'events.dropped')).toEqual([['luoshu.changed']])
    expect(scribe.events()[0].topic).toBe('events.dropped')
  })

  it('judges a subscribe under events.subscribe scoped by the topics the gate holds, at both stages', async () => {
    const { connect, gate } = setup()
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    expect((await panel.ask('events.subscribe', { topics: ['search.indexed', 'luoshu.changed'] })).ok).toBe(true)
    expect(gate.asked.map(access => [access.stage, access.action, access.capability, access.scope])).toEqual([
      ['raw', 'events.subscribe', 'events.subscribe', { topics: ['luoshu.changed'] }],
      ['canonical', 'events.subscribe', 'events.subscribe', { topics: ['luoshu.changed'] }],
    ])
  })

  it('refuses a subscribe the gate refuses and changes nothing, a topic it grants in the same call included', async () => {
    const { search, edited } = setup()
    expect(code(await search.ask('events.subscribe', { topics: ['luoshu.changed', 'git.log'] }))).toBe('not-granted')
    await edited('notes/a.md')
    await settle()
    expect(search.events()).toEqual([])
  })

  it('answers needs-confirm for a first use the gate asks about and subscribes nothing', async () => {
    const { gate, search, asks, edited } = setup()
    gate.decision = access => access.stage === 'raw' ? gate.granted(access) : { ask: 'events.subscribe luoshu.changed', view: 1 }
    expect((await search.ask('events.subscribe', { topics: ['luoshu.changed'] })).refusal).toEqual({ code: 'needs-confirm', action: 'events.subscribe', request: 'req-1' })
    expect(asks[0].access).toMatchObject({ stage: 'canonical', capability: 'events.subscribe', scope: { topics: ['luoshu.changed'] } })
    await edited('notes/a.md')
    await settle()
    expect(search.events()).toEqual([])
  })

  it('subscribes nothing when the gate ran past the call\'s deadline', async () => {
    let clock = 1_000_000
    const { pluginsManager, gate, search, edited } = setup({ clock: () => clock })
    pluginsManager.human.plugins.search = { callDeadlineMs: 5000 }
    gate.decision = access => {
      if (access.stage === 'canonical') clock += 5000
      return gate.granted(access)
    }
    expect(code(await search.ask('events.subscribe', { topics: ['luoshu.changed'] }))).toBe('timeout')
    await edited('notes/a.md')
    await settle()
    expect(search.events()).toEqual([])
  })

  // The gate is on, so the subscribe doesn't stand
  it('refuses a subscribe policy-down when the gate is on and throws', async () => {
    const { gate, search } = setup()
    gate.decision = () => { throw new Error('broken') }
    expect(code(await search.ask('events.subscribe', { topics: ['luoshu.changed'] }))).toBe('policy-down')
  })

  it('caps the topics a half holds, counting a topic it holds once and a standing one too', async () => {
    const { router, pluginsManager, connect, gate, search } = setup()
    gate.grants.search.push({ type: 'events.subscribe', topics: ['git.a', 'git.b'] })
    pluginsManager.human.plugins.search = { topicsPerHalf: 2 }
    expect((await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })).ok).toBe(true)
    expect((await search.ask('events.subscribe', { topics: ['git.a'] })).refusal).toEqual({ code: 'invalid', action: 'events.subscribe', reason: 'too-large' })
    expect((await search.ask('events.subscribe', { topics: ['luoshu.changed'] })).ok).toBe(true)
    // Another half has its own cap
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    expect((await panel.ask('events.subscribe', { topics: ['git.a', 'git.b'] })).ok).toBe(true)
    // Unsubscribing makes room
    await search.ask('events.unsubscribe', { topics: ['luoshu.outside'] })
    expect((await search.ask('events.subscribe', { topics: ['git.a'] })).ok).toBe(true)
    // Standing ones count
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await panel.ask('events.unsubscribe', { topics: ['git.a', 'git.b'] })
    expect((await panel.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })).result).toEqual({ standing: ['luoshu.changed', 'luoshu.outside'] })
    expect(code(await panel.ask('events.subscribe', { topics: ['git.b'] }))).toBe('invalid')
  })

  it('takes the human\'s raised topic cap and a lowered one', async () => {
    const { pluginsManager, gate, git } = setup()
    const topics = Array.from({ length: 64 }, (_, i) => `t${i}.indexed`)
    gate.grants.git = [{ type: 'events.subscribe', topics: [...topics, 'u1.indexed', 'u2.indexed'] }]
    expect((await git.ask('events.subscribe', { topics })).ok).toBe(true)
    expect(code(await git.ask('events.subscribe', { topics: ['u1.indexed'] }))).toBe('invalid')
    pluginsManager.human.all = { topicsPerHalf: 65 }
    expect((await git.ask('events.subscribe', { topics: ['u1.indexed'] })).ok).toBe(true)
    pluginsManager.human.plugins.git = { topicsPerHalf: 1 }
    expect(code(await git.ask('events.subscribe', { topics: ['u2.indexed'] }))).toBe('invalid')
  })

  it(`names at most ${MAX_CALL_TOPICS} topics in one call`, async () => {
    const { git } = setup()
    const topics = Array.from({ length: MAX_CALL_TOPICS + 1 }, (_, i) => `t${i}.indexed`)
    expect(code(await git.ask('events.subscribe', { topics }))).toBe('invalid')
  })

  it.each([
    ['no topic', []],
    ['a topic with no name', ['search']],
    ['a pattern', ['search.*']],
    ['a prefix', ['search.']],
    ['a topic outside the grammar', ['Search.indexed']],
    ['a signal', ['events.dropped']],
    ['a topic in another core namespace', ['security.request']],
    ['a ui verb', ['ui.view']],
    ['an Object member', ['constructor']],
    ['a key plain data refuses', ['__proto__']],
  ])('refuses a subscribe naming %s invalid before the gate hears of it', async (_name, topics) => {
    const { gate, search } = setup()
    expect(code(await search.ask('events.subscribe', { topics }))).toBe('invalid')
    expect(gate.asked).toEqual([])
  })

  it('refuses a subscribe with a field beside its topics', async () => {
    const { search } = setup()
    expect(code(await search.ask('events.subscribe', { topics: ['luoshu.changed'], canRead: true }))).toBe('invalid')
  })

  it('does not widen a subscription when a host half changes its array after posting', async () => {
    const { router, gate, edited, outside } = setup()
    gate.grants.history = [{ type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] }, { type: 'luoshu.read', paths: ['**'] }]
    const history = hostHalf(router, host('history'))
    const topics = ['luoshu.changed']
    history.handle.post({ v: 1, kind: 'call', id: 1, action: 'events.subscribe', args: { topics } })
    topics.push('luoshu.outside')
    await until(() => history.inbox.some(message => message.kind === 'reply'))
    await outside('notes/a.md')
    await edited('notes/b.md')
    await until(() => history.inbox.filter(message => message.kind === 'event').length === 1)
    await settle()
    expect(paths(history.inbox)).toEqual(['notes/b.md'])
  })
})

describe('unsubscribing', () => {
  it('stops delivery to that half and to no other', async () => {
    const { search, scribe, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => paths(search.events()).length === 1 && paths(scribe.events()).length === 1)
    await search.ask('events.unsubscribe', { topics: ['luoshu.changed'] })
    await edited('notes/b.md')
    await until(() => paths(scribe.events()).length === 2)
    await settle()
    expect(paths(search.events())).toEqual(['notes/a.md'])
  })

  it('does nothing the second time or for a topic it never held, and removes nobody else', async () => {
    const { search, scribe, way, edited } = setup()
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed'] })
    for (let i = 0; i < 2; i++) expect((await search.ask('events.unsubscribe', { topics: ['luoshu.changed', 'git.log'] })).ok).toBe(true)
    await edited('notes/a.md')
    await until(() => paths(scribe.events()).length === 1)
    expect(paths(way.events())).toEqual(['notes/a.md'])
  })

  it('keeps two halves with the same topics apart', async () => {
    const { connect, edited, search } = setup()
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await panel.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await panel.ask('events.unsubscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => paths(search.events()).length === 1)
    await settle()
    expect(panel.events()).toEqual([])
  })

  it('never starts a standing subscription it took back', async () => {
    const { router, pluginsManager, scribe } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.unsubscribe', { topics: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await settle()
    expect(scribe.events()).toEqual([])
  })
})

describe('read scope', () => {
  it('never hands a subscriber a path outside its read scope', async () => {
    const { search, scribe, way, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed'] })
    for (const path of ['notes/a.md', 'secret/b.md', '.trash/c.md', 'notes/.todo.md', 'notes/d.md']) await edited(path)
    await until(() => paths(scribe.events()).length === 3)
    await settle()
    expect(paths(search.events())).toEqual(['notes/a.md', 'notes/d.md'])
    expect(paths(scribe.events())).toEqual(['notes/a.md', 'secret/b.md', 'notes/d.md'])
    expect(paths(way.events())).toEqual(['notes/a.md', 'secret/b.md', 'notes/d.md'])
  })

  it('asks canList about the exact path for each subscriber on every delivery', async () => {
    const { search, edited, gate } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    const path = 'notes/\u00dcn\u00ef code.md'
    await edited(path)
    await edited(path)
    await until(() => paths(search.events()).length === 2)
    expect(gate.lists).toEqual([{ caller: worker('search'), path }, { caller: worker('search'), path }])
  })

  it('delivers a path to a subscriber that may only list it, and to none that may neither list nor read it', async () => {
    const { search, git, edited, gate } = setup()
    gate.grants.search = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'luoshu.list', paths: ['projects/**'] }]
    gate.grants.git = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }]
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await git.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('projects/plan.md')
    await edited('notes/a.md')
    await until(() => paths(search.events()).length === 1)
    await settle()
    expect(paths(search.events())).toEqual(['projects/plan.md'])
    expect(git.events()).toEqual([])
  })

  it('does not ask canList about an event with no path, and delivers it', async () => {
    const { git, indexed, gate } = setup()
    gate.listable = () => false
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await until(() => heard(git.events(), 'search.indexed').length === 1)
    expect(gate.lists).toEqual([])
    expect('path' in git.events()[0]).toBe(false)
  })

  it('does not ask canList about a topic the subscriber did not name', async () => {
    const { search, gate, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.outside'] })
    await edited('notes/a.md')
    await settle()
    expect(gate.lists).toEqual([])
    expect(search.events()).toEqual([])
  })

  // An async or sloppy canList answers with something truthy that is not a yes
  it.each([
    ['a number', 1],
    ['a string', 'yes'],
    ['an object', {}],
    ['a promise of yes', Promise.resolve(true)],
    ['undefined', undefined],
  ])('reads %s from canList as a no', async (_name, answer) => {
    const { search, scribe, edited, gate } = setup()
    gate.listable = caller => (caller as { id: string }).id === 'search' ? answer : true
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => paths(scribe.events()).length === 1)
    await settle()
    expect(search.events()).toEqual([])
  })

  it('treats a canList that throws as a no, records the fault and still serves the others', async () => {
    const { router, search, scribe, edited, gate, log } = setup()
    gate.listable = caller => {
      if ((caller as { id: string }).id === 'search') throw new Error('matcher bug at /Users/han/luoshu')
      return true
    }
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => paths(scribe.events()).length === 1)
    await settle()
    expect(search.events()).toEqual([])
    router.close()
    await tick()
    expect(log.events('fault').map(record => record.fields)).toEqual([{ plugin: 'gate', step: 'canList', count: 1 }])
  })

  it('gives a standing subscription nothing, path-less events included', async () => {
    const { router, pluginsManager, gate, connect, indexed } = setup()
    gate.grants.ghost = [{ type: 'events.subscribe', topics: ['search.indexed'] }]
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    const ghost = connect(worker('ghost'))
    await ghost.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await settle()
    expect(ghost.events()).toEqual([])
  })
})

describe('what a subscriber receives', () => {
  it('holds the topic, its seq and the path and nothing else, and a publish carrying more is refused', async () => {
    const { search, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    expect(code(await search.ask('events.publish', { topic: 'search.indexed', path: 'notes/a.md', text: 'the whole note' }))).toBe('invalid')
    await edited('notes/a.md')
    await until(() => search.events().length === 1)
    expect(search.events()).toStrictEqual([{ v: 1, kind: 'event', seq: 1, topic: 'luoshu.changed', path: 'notes/a.md' }])
    expect(eventShape.safeParse(search.events()[0]).success).toBe(true)
  })

  it('has no path key at all when the event has none', async () => {
    const { git, indexed } = setup()
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await until(() => git.events().length === 1)
    expect(git.events()).toStrictEqual([{ v: 1, kind: 'event', seq: 1, topic: 'search.indexed' }])
  })

  it('shapes its signals with no seq and the subscriber\'s own topics', async () => {
    const { router, pluginsManager, search } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await until(() => search.events().length === 1)
    expect(search.events()).toStrictEqual([{ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.changed'] }])
    expect(signalShape.safeParse(search.events()[0]).success).toBe(true)
    expect(eventShape.safeParse(search.events()[0]).success).toBe(false)
  })

  it.each([
    ['no topic', {}],
    ['a topic that is not a string', { topic: 5 }],
    ['an empty topic', { topic: '' }],
    ['a path that is not a string', { topic: 'search.indexed', path: 5 }],
    ['a null path', { topic: 'search.indexed', path: null }],
    ['an empty path', { topic: 'search.indexed', path: '' }],
    ['a path with a dot segment', { topic: 'search.indexed', path: 'notes/../secret/a.md' }],
    ['a path with a backslash', { topic: 'search.indexed', path: 'notes\\a.md' }],
    ['a path with a control character', { topic: 'search.indexed', path: `notes/a${String.fromCharCode(10)}.md` }],
    ['a path past the longest scope', { topic: 'search.indexed', path: `${'a/'.repeat(300)}b.md` }],
  ])('refuses a publish with %s and tells nobody', async (_name, args) => {
    const { search, git } = setup()
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    expect(code(await search.ask('events.publish', args))).toBe('invalid')
    await settle()
    expect(git.events()).toEqual([])
  })

  // The luoshu module publishes with no call to refuse, so a path events.publish would refuse reaches nobody
  it.each([
    ['an empty path', ''],
    ['a path with a dot segment', 'notes/../secret/a.md'],
    ['a path with a backslash', 'notes\\a.md'],
    ['a path with a control character', `notes/a${String.fromCharCode(10)}.md`],
    ['a path past the longest scope', `${'a/'.repeat(300)}b.md`],
  ])('delivers no luoshu publish with %s', async (_name, path) => {
    const { router, gate, search, scribe, edited } = setup()
    gate.listable = () => true
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited(path)
    router.publishCore('luoshu', 'outside', path)
    await edited('notes/a.md')
    await until(() => [search, scribe].every(side => paths(side.events()).includes('notes/a.md')))
    await settle()
    expect(paths(search.events())).toEqual(['notes/a.md'])
    expect(paths(scribe.events())).toEqual(['notes/a.md'])
  })

  it('matches a topic exactly, never as a prefix', async () => {
    const { pluginsManager, gate, search, git } = setup()
    pluginsManager.plugins.search.topics = ['indexed', 'indexedAll']
    gate.grants.git = [{ type: 'events.subscribe', topics: ['search.indexedAll'] }]
    await git.ask('events.subscribe', { topics: ['search.indexedAll'] })
    await search.ask('events.publish', { topic: 'search.indexed' })
    await search.ask('events.publish', { topic: 'search.indexedAll' })
    await until(() => git.events().length === 1)
    await settle()
    expect(git.events().map(message => message.topic)).toEqual(['search.indexedAll'])
  })

  it('takes a topic named like an Object member as a plain topic', async () => {
    const { pluginsManager, gate, search, git } = setup()
    pluginsManager.plugins.search.topics = ['constructor', 'toString']
    gate.grants.git = [{ type: 'events.subscribe', topics: ['search.toString'] }]
    await git.ask('events.subscribe', { topics: ['search.toString'] })
    expect((await search.ask('events.publish', { topic: 'search.constructor' })).ok).toBe(true)
    expect((await search.ask('events.publish', { topic: 'search.toString' })).ok).toBe(true)
    await until(() => git.events().length === 1)
    await settle()
    expect(git.events().map(message => message.topic)).toEqual(['search.toString'])
  })

  it('numbers each half\'s events on its own from 1', async () => {
    const { search, scribe, edited } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/b.md')
    await until(() => search.events().length === 2 && scribe.events().length === 1)
    expect(search.events().map(message => message.seq)).toEqual([1, 2])
    expect(scribe.events().map(message => message.seq)).toEqual([1])
  })
})

describe('credits', () => {
  it('drops past the credits, sends nothing more until the subscriber catches up and then one events.dropped', async () => {
    const { pluginsManager, git, indexed } = setup()
    pluginsManager.human.plugins.git = { eventCredits: 3 }
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    for (let i = 0; i < 5; i++) await indexed()
    await until(() => git.events().length === 3)
    await settle()
    expect(git.events().map(message => message.seq)).toEqual([1, 2, 3])
    // A credit back is not catching up, the subscriber missed events and has to read again first
    git.ack(2)
    await roundTrip(git)
    await indexed()
    await settle()
    expect(git.events()).toHaveLength(3)
    git.ack(3)
    await until(() => git.events().length === 4)
    expect(git.events()[3]).toStrictEqual({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['search.indexed'] })
    await indexed()
    await until(() => git.events().length === 5)
    expect(git.events()[4]).toMatchObject({ seq: 4, topic: 'search.indexed' })
  })

  it('counts an ack past the last event sent as the last and ignores one that goes back', async () => {
    const { pluginsManager, git, indexed } = setup()
    pluginsManager.human.plugins.git = { eventCredits: 2 }
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await until(() => git.events().length === 1)
    git.ack(1000)
    git.ack(0)
    await roundTrip(git)
    for (let i = 0; i < 3; i++) await indexed()
    await until(() => git.events().length === 3)
    await settle()
    // The ack past the last event freed only the one sent, so the third publish after it is dropped
    expect(git.events().map(message => message.seq)).toEqual([1, 2, 3])
  })

  it.each([
    ['a negative seq', -1],
    ['a seq that is not whole', 1.5],
    ['a seq as text', '3'],
    ['no seq', undefined],
  ])('drops an ack with %s unread', async (_name, seq) => {
    const { pluginsManager, git, indexed } = setup()
    pluginsManager.human.plugins.git = { eventCredits: 1 }
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await until(() => git.events().length === 1)
    git.ack(seq)
    git.post({ v: 1, kind: 'ack', seq: 1, extra: true })
    await roundTrip(git)
    await indexed()
    await settle()
    expect(git.events()).toHaveLength(1)
  })

  it('frees no credits of another half with an ack', async () => {
    const { pluginsManager, git, search, scribe, edited } = setup()
    pluginsManager.human.plugins.scribe = { eventCredits: 1 }
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => scribe.events().length === 1)
    git.ack(1)
    search.ack(1)
    await roundTrip(git)
    await roundTrip(search)
    await edited('notes/b.md')
    await settle()
    expect(scribe.events()).toHaveLength(1)
  })

  it('stops sending to a subscriber that never acknowledges and keeps the others going', async () => {
    const { pluginsManager, search, scribe, edited } = setup()
    pluginsManager.human.all = { eventCredits: 4 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    for (let i = 0; i < 8; i++) {
      await edited(`notes/${i}.md`)
      await until(() => scribe.events().length === i + 1)
      scribe.ack(i + 1)
      await roundTrip(scribe)
    }
    await settle()
    expect(search.events()).toHaveLength(4)
    expect(scribe.events()).toHaveLength(8)
  })

  it('reaches a subscriber past its credits with events.ended, since a signal takes no credit', async () => {
    const { router, pluginsManager, gate, search, edited } = setup()
    pluginsManager.human.plugins.search = { eventCredits: 1 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await edited('notes/b.md')
    await until(() => search.events().length === 1)
    gate.grants.search = []
    pluginsManager.current = 2
    router.changed()
    await until(() => search.events().length === 2)
    expect(signals(search.events(), 'events.ended')).toEqual([['luoshu.changed']])
  })

  it('folds a gate outage into the one events.dropped a subscriber past its credits gets once it catches up', async () => {
    const { router, pluginsManager, search, edited } = setup()
    pluginsManager.human.plugins.search = { eventCredits: 1 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await edited('notes/a.md')
    await edited('notes/b.md')
    await until(() => search.events().length === 1)
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    await settle()
    expect(search.events()).toHaveLength(1)
    search.ack(1)
    await until(() => search.events().length === 2)
    await settle()
    expect(signals(search.events(), 'events.dropped')).toEqual([['luoshu.changed', 'luoshu.outside']])
  })

  it('names in the catch-up events.dropped only the topics the subscriber still holds', async () => {
    const { pluginsManager, search, edited, outside } = setup()
    pluginsManager.human.plugins.search = { eventCredits: 1 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await edited('notes/a.md')
    await outside('notes/b.md')
    await edited('notes/c.md')
    await until(() => search.events().length === 1)
    await search.ask('events.unsubscribe', { topics: ['luoshu.outside'] })
    search.ack(1)
    await until(() => search.events().length === 2)
    expect(search.events()[1]).toStrictEqual({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.changed'] })
  })

  it('names every topic missed while past the credits in the one catch-up events.dropped', async () => {
    const { pluginsManager, search, edited, outside } = setup()
    pluginsManager.human.plugins.search = { eventCredits: 1 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await edited('notes/a.md')
    // Both dropped, each topic in its turn
    await outside('notes/b.md')
    await edited('notes/c.md')
    await until(() => search.events().length === 1)
    await settle()
    search.ack(1)
    await until(() => search.events().length === 2)
    expect(search.events()[1]).toStrictEqual({ v: 1, kind: 'event', topic: 'events.dropped', topics: ['luoshu.outside', 'luoshu.changed'] })
  })

  it('keeps credits per half and keeps a window on the fixed credits when the value for all is lower', async () => {
    const { connect, pluginsManager, search, way, edited } = setup()
    pluginsManager.human.all = { eventCredits: 2 }
    pluginsManager.human.plugins.search = { eventCredits: 1 }
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await panel.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed'] })
    for (const path of ['notes/a.md', 'notes/b.md', 'notes/c.md']) await edited(path)
    await until(() => panel.events().length === 1)
    await settle()
    expect(search.events()).toHaveLength(1)
    expect(panel.events()).toHaveLength(1)
    expect(paths(way.events())).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md'])
  })

  it('counts an ack against the rate like any message', async () => {
    let clock = 1_000_000
    const { pluginsManager, git, indexed } = setup({ clock: () => clock })
    pluginsManager.human.plugins.git = { messagesPerSecond: 3, eventCredits: 1 }
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await indexed()
    await until(() => git.events().length === 1)
    // The subscribe and two acks fill git's second, so the ack that would catch it up is dropped unread
    git.ack(0)
    git.ack(0)
    git.ack(1)
    await indexed()
    await settle()
    expect(git.events()).toHaveLength(1)
    clock += 1000
    git.ack(1)
    await until(() => git.events().length === 2)
    expect(git.events()[1]).toMatchObject({ topic: 'events.dropped', topics: ['search.indexed'] })
  })
})

describe('the end of a way', () => {
  it('drops a crashed half\'s subscriptions and credits at once and a new incarnation starts with none', async () => {
    const { connect, pluginsManager, search, scribe, edited } = setup()
    pluginsManager.human.plugins.search = { eventCredits: 1 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/a.md')
    await until(() => search.events().length === 1)
    search.port.close()
    await until(() => pluginsManager.crashes.length === 1)
    pluginsManager.sandboxed('search', {}, 'ready', 2)
    const again = connect(worker('search', 2))
    await edited('notes/b.md')
    await until(() => scribe.events().length === 2)
    await settle()
    expect(again.events()).toEqual([])
    // Its credits start full and its events count from 1 again
    await again.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/c.md')
    await until(() => again.events().length === 1)
    expect(again.events()[0]).toMatchObject({ seq: 1, path: 'notes/c.md' })
  })

  it.each([
    ['a planned stop', (parts: ReturnType<typeof setup>) => parts.router.end(worker('search'))],
    ['a revoked incarnation', (parts: ReturnType<typeof setup>) => parts.router.end(worker('search'), 'crashed')],
  ])('drops a half\'s subscriptions on %s', async (_name, end) => {
    const parts = setup()
    const { search, scribe, edited } = parts
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    end(parts)
    await edited('notes/a.md')
    await until(() => scribe.events().length === 1)
    await settle()
    expect(search.events()).toEqual([])
  })

  // A shut way gets no event either way, so only the gate shows what the bus still holds
  it('asks the gate nothing about the subscriptions of a way that ended by a stop or a crash', async () => {
    const { router, pluginsManager, gate, search, scribe } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    router.end(worker('search'))
    scribe.port.close()
    await until(() => pluginsManager.crashes.length === 1)
    gate.asked.length = 0
    pluginsManager.current = 2
    router.changed()
    expect(gate.asked).toEqual([])
  })

  it('drops the subscriptions of a half closed for a flood', async () => {
    const clock = 1_000_000
    const { pluginsManager, search, scribe, edited } = setup({ clock: () => clock })
    pluginsManager.human.plugins.search = { messagesPerSecond: 2, floodMs: 1000 }
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    for (let i = 0; i < 21; i++) search.post({ v: 1, kind: 'pong' })
    await until(() => pluginsManager.crashes.length === 1)
    await edited('notes/a.md')
    await until(() => scribe.events().length === 1)
    await settle()
    expect(search.events()).toEqual([])
  })

  it('drops a host half\'s subscriptions once its incarnation is ended', async () => {
    const { router, gate, edited } = setup()
    gate.grants.history = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'luoshu.read', paths: ['**'] }]
    const history = hostHalf(router, host('history'))
    await history.ask('events.subscribe', { topics: ['luoshu.changed'] })
    router.end(host('history'))
    await edited('notes/a.md')
    await settle()
    expect(history.inbox.filter(message => message.kind === 'event')).toEqual([])
  })

  it('drops a window\'s subscriptions when its way ends, so its next page starts with none', async () => {
    const { router, way, edited } = setup()
    await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed', 'core.status'] })
    router.end(editor)
    router.changed()
    await edited('notes/a.md')
    await settle()
    expect(way.events()).toEqual([])
    await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed'] })
    await edited('notes/b.md')
    expect(way.events()).toMatchObject([{ seq: 1, path: 'notes/b.md' }])
  })
})

describe('failing subscribers', () => {
  it('lets the others hear an event when a host half\'s receive throws, with nothing escaping', async () => {
    const escaped: unknown[] = []
    const record = (err: unknown) => { escaped.push(err) }
    process.on('uncaughtException', record)
    try {
      const { router, gate, scribe, edited } = setup()
      gate.grants.history = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'luoshu.read', paths: ['**'] }]
      let calls = 0
      const handle = router.handle(host('history'), message => {
        if ((message as Message).kind !== 'event') return
        calls++
        throw new Error('plugin bug')
      })
      handle.post({ v: 1, kind: 'call', id: 1, action: 'events.subscribe', args: { topics: ['luoshu.changed'] } })
      await settle()
      await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
      await edited('notes/a.md')
      await edited('notes/b.md')
      await until(() => scribe.events().length === 2 && calls === 2)
      await settle()
      expect(escaped).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }
  })

  it('leaves no rejected promise unhandled when a host half\'s async receive fails', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    try {
      const { router, gate, scribe, edited } = setup()
      gate.grants.history = [{ type: 'events.subscribe', topics: ['luoshu.changed'] }, { type: 'luoshu.read', paths: ['**'] }]
      const handle = router.handle(host('history'), async () => { throw new Error('plugin failed later') })
      handle.post({ v: 1, kind: 'call', id: 1, action: 'events.subscribe', args: { topics: ['luoshu.changed'] } })
      await settle()
      await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
      await edited('notes/a.md')
      await until(() => scribe.events().length === 1)
      await tick(30)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })
})

// What the core's writer put in the log as audit.call lines once the queue is flushed. idOf reads a line's caller id
async function written(recording: Recording, log: FakeLog) {
  await recording.flush()
  return log.events('audit.call').map(record => record.fields)
}
const idOf = (fields: Record<string, unknown>) => String(fields.caller).split('/')[0]

describe('records', () => {
  it('keeps a subscribe one audit record with its topics as scope and the gate\'s state', async () => {
    const clock = 1_000_000
    const { recording, router, log, search } = setup({ now: () => clock })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    const records = await written(recording, log)
    expect(records.map(record => [record.action, record.topics, record.code, record.gate, record.count])).toEqual([
      ['events.subscribe', '["luoshu.changed"]', null, 'on', 1],
      ['events.subscribe', '["luoshu.changed"]', null, 'on', 1],
    ])
  })

  // A subscribe that only stands used no power, so the log never shows one passing a failed gate. What the gate later
  // decides about it is recorded with the topics
  it('records what stands apart from the call, then what asking again started, held back or ended, with the topics', async () => {
    const clock = 1_000_000
    const { recording, router, pluginsManager, gate, log, search, scribe, connect, git } = setup({ now: () => clock })
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    const before = (await written(recording, log)).length
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    const ghost = connect(worker('ghost'))
    await scribe.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })
    await ghost.ask('events.subscribe', { topics: ['luoshu.changed'] })
    // Its own topic goes live with no power and the luoshu's stands
    await panel.ask('events.subscribe', { topics: ['search.indexed', 'luoshu.changed'] })
    const records = (await written(recording, log)).slice(before)
    expect(records.map(record => [idOf(record), record.topics, record.code, record.gate, record.count])).toEqual([
      ['scribe', undefined, null, 'failed', 1],
      ['ghost', undefined, null, 'failed', 2],
      ['search', '["search.indexed"]', null, 'failed', 1],
    ])
    // git's grant goes while the gate is down, so its subscription waits
    gate.grants.git = []
    pluginsManager.current = 2
    router.changed()
    pluginsManager.policyJobs.gate = 'on'
    router.changed()
    router.close()
    await tick()
    const fields = (event: string) => log.events(event).map(record => record.fields)
    expect(fields('events.waiting')).toEqual([
      { plugin: 'scribe', half: 'worker', topics: 'luoshu.changed', count: 1 },
      { plugin: 'ghost', half: 'worker', topics: 'luoshu.changed', count: 1 },
      { plugin: 'search', half: 'panel', topics: 'luoshu.changed', count: 1 },
      { plugin: 'git', half: 'worker', topics: 'search.indexed', count: 1 },
      // ghost's two subscribes coalesced
      { plugin: 'ghost', half: 'worker', topics: 'luoshu.changed', count: 1 },
    ])
    expect(fields('events.started')).toEqual([
      { plugin: 'scribe', half: 'worker', topics: 'luoshu.changed', count: 1 },
      { plugin: 'search', half: 'panel', topics: 'luoshu.changed', count: 1 },
    ])
    expect(fields('events.ended')).toEqual([
      { plugin: 'git', half: 'worker', topics: 'search.indexed', count: 1 },
      { plugin: 'ghost', half: 'worker', topics: 'luoshu.changed', count: 1 },
    ])
  })

  it('coalesces a half\'s events.waiting per second whatever topics each subscribe names', async () => {
    const { router, pluginsManager, log, connect } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    const ghost = connect(worker('ghost'))
    // Each subscribe names another set, which made each its own record with its own fsync
    const sets = [['luoshu.changed'], ['luoshu.outside'], ['search.indexed', 'luoshu.changed'], ['luoshu.outside', 'search.indexed']]
    for (let i = 0; i < 40; i++) await ghost.ask('events.subscribe', { topics: sets[i % sets.length] })
    router.close()
    await tick()
    expect(log.events('events.waiting').map(record => record.fields)).toEqual([
      { plugin: 'ghost', half: 'worker', topics: 'luoshu.changed', count: 1 },
      // The later ones join one record when the second ends, naming every topic they stood
      { plugin: 'ghost', half: 'worker', topics: 'luoshu.outside search.indexed luoshu.changed', count: 39 },
    ])
  })

  it('keeps the joined record of a half\'s events.waiting within the topics text cap', async () => {
    const { router, pluginsManager, log, connect } = setup()
    pluginsManager.policyJobs.gate = 'failed'
    router.changed()
    const ghost = connect(worker('ghost'))
    const long = (i: number) => `p${String(i).padStart(2, '0')}${'x'.repeat(60)}.${'y'.repeat(60)}`
    await ghost.ask('events.subscribe', { topics: [long(0)] })
    for (let i = 1; i < 64; i++) await ghost.ask('events.subscribe', { topics: [long(i)] })
    router.close()
    await tick()
    const joined = log.events('events.waiting')[1].fields
    expect(joined.count).toBe(63)
    expect((joined.topics as string).length).toBeLessThanOrEqual(4096)
    expect((joined.topics as string).split(' ')).toEqual(Array.from({ length: 32 }, (_, i) => long(i + 1)))
  })

  it('coalesces publishes, free subscribes and unsubscribes per caller per second and records no delivery or ack', async () => {
    const clock = 1_000_000
    const { recording, router, connect, git, indexed, log } = setup({ now: () => clock })
    const panel = connect({ kind: 'plugin', id: 'search', half: 'panel', incarnation: 1 })
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    const before = (await written(recording, log)).length
    for (let i = 0; i < 3; i++) await indexed()
    await panel.ask('events.subscribe', { topics: ['search.indexed'] })
    await panel.ask('events.subscribe', { topics: ['search.indexed'] })
    await git.ask('events.unsubscribe', { topics: ['search.indexed'] })
    await until(() => git.events().length === 3)
    git.ack(3)
    await settle()
    const records = (await written(recording, log)).slice(before)
    expect(records.map(record => [record.action, idOf(record), record.count])).toEqual([
      ['events.publish', 'search', 3], ['events.subscribe', 'search', 2], ['events.unsubscribe', 'git', 1],
    ])
  })

  it('counts drops in a coalesced core record per subscriber and why', async () => {
    const { router, pluginsManager, log, git, search, indexed, edited } = setup()
    pluginsManager.human.plugins.git = { eventCredits: 1 }
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    for (let i = 0; i < 4; i++) await indexed()
    pluginsManager.policyJobs.gate = 'failed'
    await edited('notes/a.md')
    await edited('notes/b.md')
    router.close()
    await tick()
    expect(log.events('events.dropped').map(record => record.fields)).toEqual([
      { plugin: 'git', half: 'worker', why: 'credits', count: 1 },
      { plugin: 'search', half: 'worker', why: 'gate-down', count: 1 },
      { plugin: 'git', half: 'worker', why: 'credits', count: 2 },
      { plugin: 'search', half: 'worker', why: 'gate-down', count: 1 },
    ])
  })

  it('writes one events.ended record per subscriber with the count each change ended', async () => {
    const { recording, router, pluginsManager, gate, log, search, way } = setup()
    await search.ask('events.subscribe', { topics: ['luoshu.changed', 'luoshu.outside'] })
    await way.ask('editor-1', 'events.subscribe', { topics: ['luoshu.changed'] })
    gate.grants.search = []
    gate.decision = access => access.caller.kind === 'window' ? { allow: false, code: 'not-granted', view: 2 } : gate.granted(access)
    pluginsManager.current = 2
    router.changed()
    await recording.flush()
    expect(log.events('events.ended').map(record => record.fields)).toEqual([
      { plugin: 'search', half: 'worker', topics: 'luoshu.changed luoshu.outside', count: 2 },
      { window: 'editor', topics: 'luoshu.changed', count: 1 },
    ])
  })

  it('records nothing of the bus while the human turned recording off, and no count from the gap lands later', async () => {
    const { recording, router, pluginsManager, gate, log, git, search, indexed } = setup()
    pluginsManager.nothing = true
    pluginsManager.human.plugins.git = { eventCredits: 1 }
    await git.ask('events.subscribe', { topics: ['search.indexed'] })
    await search.ask('events.subscribe', { topics: ['luoshu.changed'] })
    for (let i = 0; i < 3; i++) await indexed()
    gate.grants.search = []
    pluginsManager.current = 2
    router.changed()
    await until(() => signals(search.events(), 'events.ended').length === 1)
    pluginsManager.nothing = false
    router.close()
    await recording.flush()
    expect(log.records).toEqual([])
  })
})
