import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_LABEL_LENGTH } from '../api/envelope.ts'
import { StateStore } from '../backend/boot/state.ts'
import {
  allowAll, cleanup, coreInstall, filesFor, firstPartyEntry, harness, hashOf, hostManifest, workerManifest,
} from './loader-fakes.ts'

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

const read = { type: 'luoshu.read' as const, paths: ['**'] }
const inbox = { type: 'luoshu.read' as const, paths: ['inbox/**'] }
const write = { type: 'luoshu.write' as const, paths: ['inbox/**'] }
const entry = (over: object = {}) => ({
  version: '1.0.0', contentHash: 'a'.repeat(64), signer: 'hetu first-party', granted: [read], class: 1, enabled: true, ...over,
})
// Two agents, one item each and one more for the first, beside mcp's own item
const agents = [{ agent: 'client#1', capability: inbox }, { agent: 'client#2', capability: write }, { agent: 'client#1', capability: write }]

describe('agents\' items in the agent host\'s entry', () => {
  let dir: string
  let store: StateStore
  const file = (id: string) => path.join(dir, 'state', 'plugins', `${id}.json`)

  // What a program that knows hetu does: the body and a hash line that matches it
  async function plant(id: string, body: object) {
    const text = `${JSON.stringify({ format: 2, ...body }, null, 2)}\n`
    await mkdir(path.dirname(file(id)), { recursive: true })
    await writeFile(file(id), `${text}${sha256(text)}\n`)
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hetu-agents-'))
    store = new StateStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips mcp\'s entry holding its own items and the agents\' labelled ones, each where it was', async () => {
    await store.writePlugin('mcp', entry({ agents }))
    const loaded = await store.load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'ok' })
    expect(loaded.state.plugins.mcp.granted).toEqual([read])
    expect(loaded.state.plugins.mcp.agents).toEqual(agents)
    await store.writePlugin('mcp', loaded.state.plugins.mcp)
    expect((await store.load()).state.plugins.mcp).toEqual(loaded.state.plugins.mcp)
  })

  it('reads an entry written before agents came, with no list, as holding no agent\'s item', async () => {
    await plant('mcp', entry())
    const loaded = await store.load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'ok' })
    expect(loaded.state.plugins.mcp.agents).toBeUndefined()
  })

  it('refuses an agent\'s item in any other plugin\'s entry, on the way in and on the way out, an empty list included', async () => {
    await expect(store.writePlugin('search', entry({ agents }))).rejects.toThrow()
    await expect(store.writePlugin('search', entry({ agents: [] }))).rejects.toThrow()
    await plant('search', entry({ agents }))
    await plant('git', entry({ agents: [] }))
    const loaded = await store.load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'search', result: 'invalid' })
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'git', result: 'invalid' })
    expect(loaded.state.plugins.search).toBeUndefined()
    expect(loaded.state.plugins.git).toBeUndefined()
    expect(loaded.suspect).toBe(true)
  })

  it('holds revoked labels on mcp\'s entry alone, each in the label\'s form and once, at most as many as items', async () => {
    await store.writePlugin('mcp', entry({ agents, revoked: ['client#3', 'https://claude.ai/oauth/claude-code-client-metadata#4'] }))
    expect((await store.load()).state.plugins.mcp.revoked).toEqual(['client#3', 'https://claude.ai/oauth/claude-code-client-metadata#4'])
    await expect(store.writePlugin('search', entry({ revoked: ['client#3'] }))).rejects.toThrow()
    await expect(store.writePlugin('mcp', entry({ revoked: ['client'] }))).rejects.toThrow()
    await expect(store.writePlugin('mcp', entry({ revoked: ['client#3', 'client#3'] }))).rejects.toThrow()
    await expect(store.writePlugin('mcp', entry({ revoked: Array.from({ length: 257 }, (_, i) => `client#${i + 1}`) }))).rejects.toThrow()
    await plant('git', entry({ revoked: [] }))
    expect((await store.load()).checks).toContainEqual({ check: 'plugin-entry', id: 'git', result: 'invalid' })
  })

  it('holds revoked labels in the switches while mcp has no entry, each in the label\'s form and once, at most 256', async () => {
    const switches = (await store.load()).state.switches
    await store.writeSwitches({ ...switches, revokedAgents: ['client#3', 'https://claude.ai/oauth/claude-code-client-metadata#4'] })
    expect((await store.load()).state.switches.revokedAgents).toEqual(['client#3', 'https://claude.ai/oauth/claude-code-client-metadata#4'])
    await expect(store.writeSwitches({ ...switches, revokedAgents: ['client'] })).rejects.toThrow()
    await expect(store.writeSwitches({ ...switches, revokedAgents: ['client#3', 'client#3'] })).rejects.toThrow()
    await expect(store.writeSwitches({ ...switches, revokedAgents: Array.from({ length: 257 }, (_, i) => `client#${i + 1}`) })).rejects.toThrow()
    // A switches file written before the list came reads as holding none
    await store.writeSwitches(switches)
    const loaded = await store.load()
    expect(loaded.checks).toContainEqual({ check: 'switches', result: 'ok' })
    expect(loaded.state.switches.revokedAgents).toBeUndefined()
  })

  it('keeps the agents\' items under the hash line, so a label changed by hand fails the check', async () => {
    await store.writePlugin('mcp', entry({ agents }))
    const text = await readFile(file('mcp'), 'utf8')
    await writeFile(file('mcp'), text.replace('"client#2"', '"client#1"'))
    const loaded = await store.load()
    expect(loaded.checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'hash-mismatch' })
    expect(loaded.state.plugins.mcp).toBeUndefined()
  })

  it.each([
    ['an empty label', [{ agent: '', capability: inbox }]],
    ['a label past the envelope\'s cap', [{ agent: 'a'.repeat(MAX_LABEL_LENGTH + 1), capability: inbox }]],
    ['a label with a bidi control', [{ agent: `client${String.fromCharCode(0x202e)}#1`, capability: inbox }]],
    ['a label with a control character', [{ agent: 'client\n#1', capability: inbox }]],
    ['an item with no label', [{ capability: inbox }]],
    ['an item with a field more', [{ agent: 'client#1', capability: inbox, off: true }]],
    ['an item of a type only core plugins hold', [{ agent: 'client#1', capability: { type: 'guard.hook' } }]],
    ['an item of no known type', [{ agent: 'client#1', capability: { type: 'host.replace' } }]],
    ['the same item twice for one agent', [{ agent: 'client#1', capability: inbox }, { agent: 'client#1', capability: { paths: ['inbox/**'], type: 'luoshu.read' } }]],
    ['more scopes of one type for one agent than a plugin may hold', [0, 1].map(n => ({ agent: 'client#1', capability: { type: 'luoshu.read', paths: Array.from({ length: 40 }, (_, i) => `n${n}-${i}/**`) } }))],
    ['more items than an entry holds', Array.from({ length: 257 }, (_, i) => ({ agent: `client#${i + 1}`, capability: inbox }))],
  ])('refuses %s', async (_name, items) => {
    await expect(store.writePlugin('mcp', entry({ agents: items }))).rejects.toThrow()
    await plant('mcp', entry({ agents: items }))
    expect((await store.load()).checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'invalid' })
  })

  // Labels with a character outside ASCII, which could read as another label, as two or as nothing, then labels out of
  // the <client id>#<n> form
  const cp = (...points: number[]) => String.fromCodePoint(...points)
  it.each([
    ['one space', ' '], ['a zero width space alone', cp(0x200b)], ['client#1 then a zero width space', `client#1${cp(0x200b)}`],
    ['a cyrillic first letter', `${cp(0x441)}lient#1`], ['an accent as a combining mark', `e${cp(0x301)}#1`], ['a line separator', `client${cp(0x2028)}#1`],
    ['a word joiner', `client${cp(0x2060)}#1`], ['a soft hyphen', `client${cp(0xad)}#1`], ['no number', 'client'], ['a plugin id', 'search'],
    ['no client id', '#1'], ['a number with a leading zero', 'client#01'], ['the number zero', 'client#0'], ['a second number sign', 'a#1#1'],
    ['a space in the client id', 'my client#1'], ['a quote', 'client"#1'], ['an angle bracket', '<b>#1'], ['a backslash', 'a\\b#1'],
    ['a name every object knows', '__proto__'], ['another', 'constructor'], ['a client id of 256 characters', `${'a'.repeat(256)}#1`], ['a number of 16 digits', `client#${'9'.repeat(16)}`],
  ])('refuses a label with %s', async (_name, label) => {
    await expect(store.writePlugin('mcp', entry({ agents: [{ agent: label, capability: inbox }] }))).rejects.toThrow()
    await plant('mcp', entry({ agents: [{ agent: label, capability: inbox }] }))
    expect((await store.load()).checks).toContainEqual({ check: 'plugin-entry', id: 'mcp', result: 'invalid' })
  })

  it('takes a client id that is a metadata document\'s address, one of 255 characters and a number of 15 digits', async () => {
    const labels = [
      'https://claude.ai/oauth/claude-code-client-metadata#3', 'https://client.example/a/b?x=1&y=%20#12', 'client#1',
      `${'a'.repeat(255)}#1`, `client#${'9'.repeat(15)}`,
    ]
    await store.writePlugin('mcp', entry({ agents: labels.map(agent => ({ agent, capability: inbox })) }))
    expect((await store.load()).state.plugins.mcp.agents!.map(item => item.agent)).toEqual(labels)
  })

  it('takes one item for each of many agents, the same item for two agents and a type\'s scopes counted per agent', async () => {
    const many = Array.from({ length: 256 }, (_, i) => ({ agent: `client#${i + 1}`, capability: inbox }))
    await store.writePlugin('mcp', entry({ agents: many }))
    expect((await store.load()).state.plugins.mcp.agents).toHaveLength(256)
    const wide = [1, 2].map(n => ({ agent: `client#${n}`, capability: { type: 'luoshu.read' as const, paths: Array.from({ length: 40 }, (_, i) => `n${i}/**`) } }))
    await store.writePlugin('mcp', entry({ agents: [...wide, { agent: 'client#2', capability: inbox }, { agent: 'client#1', capability: inbox }] }))
    expect((await store.load()).state.plugins.mcp.agents).toHaveLength(4)
  })
})

describe('agents\' items in the grants snapshot', () => {
  afterEach(cleanup)

  // mcp as the install's own copy with its entry seeded as a test does and alpha a plugin of the folder
  async function started(over: object = {}) {
    const gate = allowAll()
    const mcp = filesFor(workerManifest('mcp', { capabilities: [read] }))
    const made = await harness({
      install: { ...coreInstall(), gate: { files: filesFor(hostManifest('gate')) }, mcp: { files: mcp, firstParty: true } },
      folder: { mcp, alpha: filesFor(workerManifest('alpha', { capabilities: [read] })) },
      entries: {
        mcp: async root => firstPartyEntry(await hashOf(root), { granted: [read], class: 1, agents, ...over }),
        alpha: async root => ({ ...firstPartyEntry(await hashOf(root), { granted: [read], class: 1 }), signer: 'sigstore:someone' }),
      },
      behave: { gate: { exports: { gate } } },
    })
    await made.loader.start()
    return { ...made, gate }
  }

  const item = (capability: object) => ({ capability, off: false, firstUse: false })

  it('carries the agents\' items by label, apart from mcp\'s own, which holds only its unlabelled items', async () => {
    const { gate } = await started()
    const view = gate.seen.at(-1)!
    expect(view.plugins.mcp).toEqual([item(read)])
    expect(view.plugins.alpha).toEqual([item(read)])
    expect(view.agents).toEqual({ 'client#1': [item(inbox), item(write)], 'client#2': [item(write)] })
    expect(Object.getPrototypeOf(view.agents)).toBe(null)
    expect(Object.isFrozen(view.agents!['client#1'][0].capability)).toBe(true)
  })

  it('carries no agent while mcp\'s entry holds none or the human switched mcp off', async () => {
    expect((await started({ agents: undefined })).gate.seen.at(-1)!.agents).toEqual({})
    const off = await started({ enabled: false })
    expect(off.gate.seen.at(-1)!.agents).toEqual({})
    expect(off.gate.seen.at(-1)!.plugins.mcp).toBeUndefined()
  })
})
