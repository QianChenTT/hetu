import { readdirSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import { parse } from 'acorn'
import { simple } from 'acorn-walk'
import { afterEach, describe, expect, it } from 'vitest'
import { coreActions, eventActions, providerActions } from '../api/actions.ts'
import { capabilityTypes } from '../api/capabilities.ts'
import { namespaces, providers, serverOf } from '../api/ids.ts'
import type { Call, LiveCall } from '../api/policy-jobs.ts'
import { cleanup, code, editor, harness, trusted, windowWay, worker } from './router-fakes.ts'

afterEach(cleanup)

const folder = path.join(import.meta.dirname, '..', 'backend', 'router')
const namespaceOf = (action: string) => action.slice(0, action.indexOf('.'))

// Every string the code of a file holds: its literals and the text of its template literals, types and comments left out
function stringsOf(source: string): string[] {
  const found: string[] = []
  const tree = parse(stripTypeScriptTypes(source, { mode: 'strip' }), { ecmaVersion: 'latest', sourceType: 'module' })
  simple(tree, {
    Literal(node) {
      if (typeof node.value === 'string') found.push(node.value)
    },
    TemplateElement(node) {
      if (node.value.cooked !== null && node.value.cooked !== undefined) found.push(node.value.cooked)
    },
  })
  return found
}

// Words the router still writes that a namespace or a part spells the same: the capability types it asks the gate
// about, plugin among what a caller is and the policy jobs, whose states it reads by id until their doors say them. A
// capability type an action spells too comes through the contract, as the action does
const actionNames = new Set<string>([...Object.keys(coreActions), ...Object.keys(eventActions), ...Object.keys(providerActions)])
const kept = new Set<string>([...capabilityTypes, 'plugin', 'gate', 'grant-risk-classifier'].filter(word => !actionNames.has(word)))

describe('the namespace table', () => {
  it('gives every action of the contract a server, by the route its table takes', () => {
    for (const action of Object.keys(coreActions)) expect([action, serverOf(namespaceOf(action))?.route]).toEqual([action, 'action'])
    for (const action of Object.keys(eventActions)) expect([action, serverOf(namespaceOf(action))?.route]).toEqual([action, 'bus'])
    for (const action of Object.keys(providerActions)) expect([action, serverOf(namespaceOf(action))?.route]).toEqual([action, 'provider'])
    expect(providers).toEqual({ luoshu: 'luoshu', leases: 'leases', history: 'history', exec: 'exec', storage: 'storage', cache: 'storage', net: 'net' })
  })

  it('leaves no action name, namespace or part as a string in the router', () => {
    const names = new Set<string>([...actionNames, ...Object.keys(namespaces), ...Object.values(namespaces).map(server => server.part)])
    const found: string[] = []
    for (const file of readdirSync(folder).filter(name => name.endsWith('.ts')).sort()) {
      for (const text of stringsOf(readFileSync(path.join(folder, file), 'utf8'))) {
        if (names.has(text) && !kept.has(text)) found.push(`${file} ${text}`)
      }
    }
    expect(found).toEqual([])
  })

  it('hands each core action to the part the table names, as that part was handed in under its name', async () => {
    const seen: string[] = []
    const part = (name: string) => async (call: Call) => { seen.push(`${name} ${call.action}`); return null }
    const { router } = harness({ armed: () => true })
    router.serve('plugins-manager', part('plugins-manager'))
    router.serve('runtime', part('runtime'))
    const way = windowWay(router, { 'editor-1': editor, trusted })
    await way.ask('editor-1', 'core.status')
    await way.ask('trusted', 'security.list')
    await way.ask('editor-1', 'app.quit')
    await way.ask('editor-1', 'editor.frame', { plugin: 'search', frame: 'panel' })
    await way.ask('trusted', 'app.relaunch')
    expect(seen).toEqual([
      'plugins-manager core.status', 'plugins-manager security.list', 'runtime app.quit', 'runtime editor.frame', 'runtime app.relaunch',
    ])
    expect((await way.ask('editor-1', 'log.verify')).result).toEqual({ ok: true })
  })

  it('answers unavailable for a namespace whose part nobody handed in, ui.* going to the drawer', async () => {
    const { router, connect } = harness({ core: async () => null })
    const search = connect(worker('search'))
    expect(code(await search.ask('ui.view', { title: 'x' }))).toBe('unavailable')
    router.serve('drawer', async () => 'mounted')
    expect((await search.ask('ui.view', { title: 'x' })).result).toBe('mounted')
  })

  // The trusted window's reads are marked in the contract. Anything else it sends inside its input delay is refused at
  // the floor, before flood control charges it
  it('refuses the trusted window inside its input delay at the floor for every core action the contract marks as no read', async () => {
    const seen: string[] = []
    const { router } = harness({ core: async call => { seen.push(call.action); return null }, armed: () => false })
    const way = windowWay(router, { trusted })
    for (const [action, spec] of Object.entries(coreActions)) {
      const args = action === 'security.confirm' ? { requestId: 'req-1' } : undefined
      if (spec.from === 'http' || spec.from === 'agent' || !spec.args.safeParse(args).success) continue
      const reply = await way.ask('trusted', action, args)
      if (spec.reads === true) expect([action, code(reply)]).not.toEqual([action, 'throttled'])
      else expect([action, code(reply)]).toEqual([action, 'throttled'])
    }
    expect(seen).not.toContain('security.confirm')
    expect(Object.entries(coreActions).filter(([, spec]) => spec.reads === true).map(([action]) => action).sort()).toEqual([
      'core.self', 'core.status', 'gate.filterReadable', 'gate.reach', 'log.segments', 'log.verify', 'security.list',
    ])
  })

  // The gate's own actions are the gate module's, handed in as any part is. The router resolves the live call
  // gate.filterReadable names on the caller's own way and hands a view of it with the call, never the call itself
  it("hands the gate a view of the live call gate.filterReadable names, on the asking callee's own way only", async () => {
    const seen: Call[] = []
    const parts = harness()
    const { router, connect, pluginsManager, gate } = parts
    router.serve('gate', async call => { seen.push(call); return [] })
    pluginsManager.sandboxed('search', { query: {} })
    gate.grants.scribe = [{ type: 'plugin.call', targets: ['search'] }]
    const scribe = connect(worker('scribe'))
    const search = connect(worker('search'))
    const id = scribe.call('search.query', { text: 'x' })
    const got = await search.delivered('search.query')
    expect((await search.ask('gate.filterReadable', { call: got.callId, paths: ['notes/a.md'] })).result).toEqual([])
    expect(code(await scribe.ask('gate.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
    expect(code(await search.ask('gate.filterReadable', { call: 'a'.repeat(22), paths: ['notes/a.md'] }))).toBe('invalid')
    expect(seen).toHaveLength(1)
    const live = seen[0].live as LiveCall
    expect([seen[0].caller, live.caller, live.agent, live.door, live.open()]).toEqual([worker('search'), worker('scribe'), undefined, false, true])
    expect(Object.keys(live).sort()).toEqual(['caller', 'door', 'open', 'plugin', 'principal'])
    search.answer(got.callId, [])
    await scribe.reply(id)
    expect(live.open()).toBe(false)
    expect(code(await search.ask('gate.filterReadable', { call: got.callId, paths: ['notes/a.md'] }))).toBe('invalid')
    expect(seen).toHaveLength(1)
  })

  it("answers unavailable for the gate's actions while no gate part was handed in", async () => {
    const { router } = harness({ gateActions: false })
    const way = windowWay(router, { 'editor-1': editor })
    expect(code(await way.ask('editor-1', 'gate.reach', { plugin: 'search', path: 'notes/a.md' }))).toBe('unavailable')
  })
})
