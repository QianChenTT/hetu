import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { Caller } from '../api/envelope.ts'
import type { Port } from '../backend/carrier/seams.ts'
import { cleanup, code, editor, harness, host, hostHalf, tick, trusted, windowWay, worker, type Message } from './carrier-fakes.ts'

afterEach(cleanup)

describe('ports bound by closure', () => {
  it('names the caller from the port, never from the message', async () => {
    const { connect, gate, vault } = harness()
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    vault.files.set('notes/a.md', 'hello')
    const search = connect(worker('search'))
    const reply = await search.ask('vault.read', { path: 'notes/a.md' })
    expect(reply.ok).toBe(true)
    expect(gate.asked.map(access => access.caller)).toEqual([worker('search'), worker('search')])
    expect(vault.prepared[0].caller).toEqual(worker('search'))
  })

  it('refuses a call that names a caller, and the gate never hears the claim', async () => {
    const { connect, gate } = harness()
    const search = connect(worker('search'))
    const reply = await search.ask('vault.read', { path: 'notes/a.md' }, { caller: host('gate') })
    expect(code(reply)).toBe('invalid')
    expect(gate.asked).toEqual([])
  })

  it('keeps two plugins apart, each call carrying its own port\'s caller', async () => {
    const { connect } = harness()
    const one = connect(worker('search'))
    const two = connect(worker('git', 3))
    const [a, b] = await Promise.all([one.ask('core.self'), two.ask('core.self')])
    expect(a.result).toEqual(worker('search'))
    expect(b.result).toEqual(worker('git', 3))
  })

  it('starts every port it registers and listens for close before any message', () => {
    const { carrier } = harness()
    const calls: string[] = []
    const port: Port = {
      postMessage: () => {},
      start: () => { calls.push('start') },
      close: () => {},
      on: event => { calls.push(event) },
    }
    carrier.register(port, worker('search'))
    expect(calls).toEqual(['message', 'messageerror', 'close', 'start'])
  })

  it('refuses a port registered twice, a caller registered twice and a caller that is not a plugin half', () => {
    const { carrier } = harness()
    const { port1, port2 } = new MessageChannel()
    try {
      carrier.register(port1, worker('search'))
      expect(() => carrier.register(port1, worker('git'))).toThrow()
      const other = new MessageChannel()
      expect(() => carrier.register(other.port1, worker('search'))).toThrow()
      expect(() => carrier.register(other.port1, editor)).toThrow()
      expect(() => carrier.register(other.port1, { kind: 'content', plugin: 'artifacts', token: 't' })).toThrow()
      expect(() => carrier.register(other.port1, { kind: 'plugin', id: 'my.plugin', half: 'worker', incarnation: 1 })).toThrow()
      other.port1.close()
    } finally {
      port1.close()
      port2.close()
    }
  })

  it('refuses a port and a handle once the carrier is closed', () => {
    const { carrier } = harness()
    carrier.close()
    const { port1, port2 } = new MessageChannel()
    try {
      expect(() => carrier.register(port1, worker('search'))).toThrow()
      expect(() => carrier.handle(host('vault'), () => {})).toThrow()
    } finally {
      port1.close()
      port2.close()
    }
  })

  it('refuses a port a plugin passes in a call, transferred or not', async () => {
    const { connect, vault, gate } = harness()
    gate.grants.search = [{ type: 'vault.read', paths: ['**'] }]
    const search = connect(worker('search'))
    const forged = new MessageChannel()
    const nested = new MessageChannel()
    search.port.postMessage({ v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'a.md', reply: forged.port2 } }, [forged.port2])
    search.port.postMessage({ v: 1, kind: 'call', id: 2, action: 'search.query', args: [{ deep: { port: nested.port2 } }] }, [nested.port2])
    expect(code(await search.reply(1))).toBe('invalid')
    expect(code(await search.reply(2))).toBe('invalid')
    expect(vault.prepared).toEqual([])
    expect(gate.asked).toEqual([])
    forged.port1.close()
    nested.port1.close()
  })

  it('reaches nothing through a channel it never registered', async () => {
    const { gate, vault } = harness()
    const { port1, port2 } = new MessageChannel()
    port2.postMessage({ v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'notes/a.md' } })
    await tick()
    expect(gate.asked).toEqual([])
    expect(vault.prepared).toEqual([])
    port1.close()
    port2.close()
  })

  it('passes ready, pong and stopped to the loader with the bound caller', async () => {
    const { connect, loader } = harness()
    const search = connect(worker('search'))
    for (const kind of ['ready', 'pong', 'stopped']) search.post({ v: 1, kind })
    await search.ask('core.self')
    expect(loader.lifecycle).toEqual(['ready', 'pong', 'stopped'].map(kind => ({ caller: worker('search'), kind })))
  })

  it('drops a message of another version or kind unread, with no reply', async () => {
    const { connect, gate, loader } = harness()
    const search = connect(worker('search'))
    search.post({ v: 2, kind: 'call', id: 101, action: 'vault.read', args: { path: 'a.md' } })
    search.post({ v: '1', kind: 'call', id: 102, action: 'vault.read', args: { path: 'a.md' } })
    search.post({ v: 1, kind: 'hello', id: 103 })
    search.post({ v: 2, kind: 'ready' })
    // Kinds only the carrier sends
    search.post({ v: 1, kind: 'init' })
    search.post({ v: 1, kind: 'deps' })
    const sentinel = search.call('core.self')
    await search.reply(sentinel)
    await tick()
    expect(search.inbox.filter(message => message.id !== sentinel)).toEqual([])
    expect(gate.asked).toEqual([])
    expect(loader.lifecycle).toEqual([])
  })
})

describe('the end of a way in', () => {
  it('reports a port closed under its plugin as crashed and answers the calls it held crashed', async () => {
    const { connect, loader, gate } = harness()
    loader.sandboxed('search', { query: {} })
    gate.grants.mcp = [{ type: 'plugin.call', targets: ['search'] }]
    const mcp = connect(worker('mcp'))
    const search = connect(worker('search'))
    const id = mcp.call('search.query', { text: 'x' })
    await search.delivered('search.query')
    search.port.close()
    const reply = await mcp.reply(id)
    expect(code(reply)).toBe('crashed')
    expect(loader.crashes).toEqual([{ caller: worker('search'), reason: 'closed' }])
  })

  it('reports nothing for its own close and tells the callee nothing more', async () => {
    const { carrier, connect, loader } = harness()
    const search = connect(worker('search'))
    const closed = new Promise(resolve => search.port.once('close', resolve))
    carrier.end(worker('search'))
    await closed
    await tick()
    expect(loader.crashes).toEqual([])
    // A new incarnation may take the half again
    const again = connect(worker('search', 2))
    expect((await again.ask('core.self')).result).toEqual(worker('search', 2))
  })

  it('answers the calls a planned stop held with stopped', async () => {
    const { carrier, connect, loader, gate } = harness()
    loader.sandboxed('search', { query: {} })
    gate.grants.mcp = [{ type: 'plugin.call', targets: ['search'] }]
    const mcp = connect(worker('mcp'))
    const search = connect(worker('search'))
    const id = mcp.call('search.query')
    await search.delivered('search.query')
    carrier.end(worker('search'))
    expect(code(await mcp.reply(id))).toBe('stopped')
  })
})

describe('host handles', () => {
  it('binds a host half by closure and copies each message, so a change after posting reaches nothing', async () => {
    const { carrier, gate, vault } = harness()
    gate.grants.history = [{ type: 'vault.read', paths: ['notes/**'] }]
    vault.files.set('notes/a.md', 'x')
    const got: Message[] = []
    const handle = carrier.handle(host('history'), message => { got.push(message as Message) })
    const message = { v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'notes/a.md' } }
    handle.post(message)
    message.args.path = 'secret/b.md'
    for (let i = 0; i < 50 && got.length === 0; i++) await tick(2)
    expect(got[0].ok).toBe(true)
    expect(vault.prepared[0].args).toEqual({ path: 'notes/a.md' })
    expect(gate.asked[0].caller).toEqual(host('history'))
  })

  it('drops a message that can not be copied', async () => {
    const { carrier, gate } = harness()
    const got: Message[] = []
    const handle = carrier.handle(host('history'), message => { got.push(message as Message) })
    handle.post({ v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'a.md', f: () => 1 } })
    handle.post({ v: 1, kind: 'call', id: 2, action: 'core.self' })
    for (let i = 0; i < 50 && got.length === 0; i++) await tick(2)
    expect(got.map(reply => reply.id)).toEqual([2])
    expect(gate.asked).toEqual([])
  })

  it('reads a host half\'s message only after post returns', () => {
    const { carrier, gate } = harness()
    const handle = carrier.handle(host('history'), () => {})
    handle.post({ v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'a.md' } })
    expect(gate.asked).toEqual([])
  })

  it('hands a host half a copy of what it is sent, never the provider\'s own object', async () => {
    const { carrier, gate, vault } = harness()
    gate.grants.history = [{ type: 'vault.read', paths: ['**'] }]
    const kept = { text: 'x' }
    vault.perform_ = () => kept
    const reply = await hostHalf(carrier, host('history')).ask('vault.read', { path: 'a.md' })
    expect(reply.result).toEqual({ text: 'x' })
    expect(reply.result).not.toBe(kept)
  })

  // A throw out of a queued microtask would be an uncaught exception in main
  it('keeps answering a host half whose receive throws, with nothing escaping', async () => {
    const escaped: unknown[] = []
    const heard = (err: unknown) => { escaped.push(err) }
    process.on('uncaughtException', heard)
    try {
      const { carrier } = harness()
      let answers = 0
      const handle = carrier.handle(host('history'), () => {
        answers++
        throw new Error('broken half')
      })
      handle.post({ v: 1, kind: 'call', id: 1, action: 'core.self', args: {} })
      handle.post({ v: 1, kind: 'call', id: 2, action: 'core.self', args: {} })
      for (let i = 0; i < 50 && answers < 2; i++) await tick(2)
      await tick()
      expect(answers).toBe(2)
      expect(escaped).toEqual([])
    } finally {
      process.off('uncaughtException', heard)
    }
  })

  // A handle has no close, so after its incarnation was revoked only the shut way stands between it and the steps
  it('acts on nothing a host half posts after its incarnation was ended', async () => {
    const { carrier, gate, vault } = harness()
    gate.grants.history = [{ type: 'vault.write', paths: ['**'] }]
    const half = hostHalf(carrier, host('history'))
    carrier.end(host('history'))
    half.handle.post({ v: 1, kind: 'call', id: 1, action: 'vault.write', args: { path: 'a.md', text: 'x' } })
    await tick(20)
    expect(gate.asked).toEqual([])
    expect(vault.files.size).toBe(0)
    expect(half.inbox).toEqual([])
  })
})

describe('the window way in', () => {
  it('drops a sender the check does not name, unread and unanswered', async () => {
    const { carrier, gate, vault } = harness()
    const way = windowWay(carrier, { 'editor-1': editor })
    way.post('frame-in-editor', { v: 1, kind: 'call', id: 1, action: 'vault.read', args: { path: 'notes/a.md' } })
    await tick()
    expect(way.replies).toEqual([])
    expect(gate.asked).toEqual([])
    expect(vault.prepared).toEqual([])
  })

  it('runs the sender check before anything else, in the same turn as the message', () => {
    const { carrier } = harness()
    const order: string[] = []
    const receive = carrier.window<string>(sender => {
      order.push(`check ${sender}`)
      return sender === 'editor-1' ? editor : null
    })
    receive('editor-1', { get v() { order.push('read'); return 1 }, kind: 'call', id: 1, action: 'core.self' }, () => {})
    order.push('returned')
    expect(order[0]).toBe('check editor-1')
    expect(order.at(-1)).toBe('returned')
  })

  it.each([
    ['throws', () => { throw new Error('detached') }],
    ['names a plugin', () => worker('search')],
    ['names a window outside the grammar', () => ({ kind: 'window', role: 'editor', n: -1 })],
    ['names a window with more fields', () => ({ kind: 'window', role: 'trusted', n: 0, onBehalf: 'x' })],
  ])('drops a message when the check %s', async (_name, check) => {
    const { carrier, gate } = harness()
    const replies: unknown[] = []
    const receive = carrier.window<string>(check as (sender: string) => Caller | null)
    receive('x', { v: 1, kind: 'call', id: 1, action: 'core.self' }, reply => { replies.push(reply) })
    await tick()
    expect(replies).toEqual([])
    expect(gate.asked).toEqual([])
  })

  it('answers a named window with the window as the caller', async () => {
    const { carrier, gate, vault } = harness()
    vault.files.set('notes/a.md', 'x')
    const way = windowWay(carrier, { 'editor-1': editor, trusted: trusted })
    expect((await way.ask('editor-1', 'core.self')).result).toEqual(editor)
    expect((await way.ask('trusted', 'core.self')).result).toEqual(trusted)
    expect((await way.ask('editor-1', 'vault.read', { path: 'notes/a.md' })).ok).toBe(true)
    expect(gate.asked[0].caller).toEqual(editor)
  })

  it('never takes a parent from a window, which no call is delivered to', async () => {
    const { carrier } = harness()
    const way = windowWay(carrier, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'core.self', undefined, { parent: 'abc' }))).toBe('invalid')
  })

  it('takes a window again once its way was ended', async () => {
    const { carrier } = harness()
    const way = windowWay(carrier, { 'editor-1': editor })
    expect((await way.ask('editor-1', 'core.self')).ok).toBe(true)
    carrier.end(editor)
    expect((await way.ask('editor-1', 'core.self')).ok).toBe(true)
  })

  it('passes no lifecycle message from a window to the loader', async () => {
    const { carrier, loader } = harness()
    const way = windowWay(carrier, { 'editor-1': editor })
    for (const kind of ['ready', 'pong', 'stopped']) way.post('editor-1', { v: 1, kind })
    await way.ask('editor-1', 'core.self')
    expect(loader.lifecycle).toEqual([])
  })
})

describe('the carrier\'s imports', () => {
  it('imports nothing from boot, so the state store and the log arrive only through its seams', () => {
    const folder = path.join(import.meta.dirname, '..', 'backend', 'carrier')
    const files = readdirSync(folder).filter(name => name.endsWith('.ts'))
    expect(files.sort()).toEqual(['carrier.ts', 'limits.ts', 'records.ts', 'seams.ts'])
    for (const name of files) {
      const source = readFileSync(path.join(folder, name), 'utf8')
      const specifiers = [...source.matchAll(/\bfrom\s*'([^']*)'/g)].map(match => match[1])
      expect(specifiers.filter(specifier => specifier.includes('/boot/') || specifier.includes('/events/'))).toEqual([])
      expect(specifiers.every(specifier => specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../../api/') || specifier.startsWith('../../lib/'))).toBe(true)
    }
  })
})
