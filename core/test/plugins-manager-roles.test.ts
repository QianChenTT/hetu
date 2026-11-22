import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import type { Caller } from '../api/envelope.ts'
import {
  cleanup, coreInstall, entryFor, filesFor, harness, hostManifest, reasonOf, stateOf, until, workerManifest, writeFolder, type Listing,
} from './plugins-manager-fakes.ts'

afterEach(cleanup)

// The role the door calls, held by one plugin-folder plugin at a time
const role: Capability = { type: 'door.handle' }
const read: Capability = { type: 'luoshu.read', paths: ['notes/**'] }
const holder = (id: string, extra: Capability[] = []) => filesFor(workerManifest(id, { capabilities: [role, ...extra] }))
const holds = (extra: object = {}) => (root: string) => entryFor(root, { granted: [role], ...extra })
const http: Listing = { files: filesFor(hostManifest('mcp-http-handler')) }
const install = () => ({ ...coreInstall(), 'mcp-http-handler': http })
const httpHalf = () => ({ kind: 'plugin', id: 'mcp-http-handler', half: 'host', incarnation: 1 }) satisfies Caller
const editor: Caller = { kind: 'window', role: 'editor', n: 1 }

describe('the plugin holding a role', () => {
  it('is the one approved plugin whose entry holds the role\'s item, null for no holder and for an action that is no role', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), other: filesFor(workerManifest('other')) }, entries: { mcp: holds(), other: entryFor } })
    await made.pluginsManager.start()
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
    expect(made.pluginsManager.role('door.other')).toBeNull()
    expect(made.pluginsManager.role('mcp.handle')).toBeNull()
    expect(made.pluginsManager.role('toString')).toBeNull()
  })

  it('is none while no entry holds the item, a manifest asking for it with no approval included', async () => {
    const made = await harness({ folder: { mcp: holder('mcp') } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp')).toBe('found')
    expect(made.pluginsManager.role('door.handle')).toBeNull()
  })

  // Finding the holder is routing and not judging, so the item's switch holds with the gate off (D-680 F)
  it.each([
    ['on', {}],
    ['off', { off: ['gate' as const] }],
  ])('is none while the holder\'s item is switched off, with the gate %s, and the holder again once it is on', async (_gate, switches) => {
    const made = await harness({ folder: { mcp: holder('mcp', [read]) }, entries: { mcp: holds({ granted: [role, read] }) }, switches })
    await made.pluginsManager.start()
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'mcp', capability: role })
    expect(made.pluginsManager.role('door.handle')).toBeNull()
    // Another item switched off leaves the role served
    await made.pluginsManager.apply({ kind: 'item.on', plugin: 'mcp', capability: role })
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'mcp', capability: read })
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
  })

  it('is none while the holder is switched off or refused', async () => {
    const made = await harness({ folder: { mcp: holder('mcp') }, entries: { mcp: holds() } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'mcp' })
    expect(made.pluginsManager.role('door.handle')).toBeNull()
    const unsigned = await harness({ folder: { mcp: holder('mcp') }, entries: { mcp: holds() }, switches: { allowUnsigned: [] } })
    await unsigned.pluginsManager.start()
    expect(reasonOf(unsigned.pluginsManager, 'mcp')).toBe('unsigned')
    expect(unsigned.pluginsManager.role('door.handle')).toBeNull()
  })

  it('tells the router when the item is switched, so a call open on a holder that went ends', async () => {
    const made = await harness({ folder: { mcp: holder('mcp') }, entries: { mcp: holds() } })
    await made.pluginsManager.start()
    const before = made.link.changes
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'mcp', capability: role })
    expect(made.link.changes).toBeGreaterThan(before)
  })
})

// One holder at a time: an entry holds the role, on or off, until it is removed (D-680)
describe('a second plugin asking for a role', () => {
  it('is refused role-taken before any approval while another entry holds it, with no notice, and found once that one is removed', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), copy: holder('copy') }, entries: { mcp: holds() } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'copy')).toBe('refused')
    expect(reasonOf(made.pluginsManager, 'copy')).toBe('role-taken')
    expect(made.link.events('plugin.refused')).toContainEqual({ plugin: 'copy', reason: 'role-taken' })
    expect(made.pluginsManager.pending().filter(held => held.plugin === 'copy')).toEqual([])
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'mcp' })
    await until(() => stateOf(made.pluginsManager, 'copy') === 'found')
    expect(made.pluginsManager.pending()).toContainEqual(expect.objectContaining({ kind: 'plugin.approve', plugin: 'copy' }))
  })

  it('is refused while the holder is switched off, since an entry holds the role until removed', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), copy: holder('copy') }, entries: { mcp: holds({ enabled: false }) } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp')).toBe('off')
    expect(reasonOf(made.pluginsManager, 'copy')).toBe('role-taken')
  })

  it('is never approved once another plugin took the role first, both having been found', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), copy: holder('copy') } })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp')).toBe('found')
    expect(stateOf(made.pluginsManager, 'copy')).toBe('found')
    await made.pluginsManager.apply({ kind: 'plugin.approve', plugin: 'mcp' })
    expect(reasonOf(made.pluginsManager, 'copy')).toBe('role-taken')
    await expect(made.pluginsManager.apply({ kind: 'plugin.approve', plugin: 'copy' })).rejects.toThrow()
    expect((await made.store.load()).state.plugins.copy).toBeUndefined()
  })

  // Its approval could never apply, so the notice raised while it was found goes, recorded as withdrawn
  it('has its pending approval withdrawn once another plugin takes the role, and the holder\'s kept', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), copy: holder('copy') } })
    await made.pluginsManager.start()
    const approvals = () => made.pluginsManager.pending().filter(held => held.kind === 'plugin.approve').map(held => held.plugin).sort()
    expect(approvals()).toEqual(['copy', 'mcp'])
    await made.pluginsManager.apply({ kind: 'plugin.approve', plugin: 'mcp' })
    expect(reasonOf(made.pluginsManager, 'copy')).toBe('role-taken')
    expect(approvals()).not.toContain('copy')
    expect(made.link.events('security.withdrawn')).toContainEqual(expect.objectContaining({ kind: 'plugin.approve', target: 'copy' }))
    expect(made.link.events('security.withdrawn')).not.toContainEqual(expect.objectContaining({ target: 'mcp' }))
  })

  it('is refused a widen to the role while another entry holds it, asked or applied, the entry left as it was', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), tool: filesFor(workerManifest('tool')) }, entries: { mcp: holds(), tool: entryFor } })
    await made.pluginsManager.start()
    await expect(made.pluginsManager.request({ kind: 'grant.widen', plugin: 'tool', capability: role }, editor)).rejects.toMatchObject({ code: 'invalid' })
    await expect(made.pluginsManager.apply({ kind: 'grant.widen', plugin: 'tool', capability: role })).rejects.toThrow()
    expect((await made.store.load()).state.plugins.tool?.granted).toEqual([])
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
  })

  // An update keeps the entry's grants, so a new version asking for the role gets no item and no second holder comes of
  // it. The role comes only by an approval or a widen, each refused while another entry holds it
  it('gets no item from an update whose new version asks for the role, the holder kept and neither refused', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), tool: filesFor(workerManifest('tool')) }, entries: { mcp: holds(), tool: entryFor } })
    await made.pluginsManager.start()
    const dir = path.join(made.dataDir, 'staging', 'tool-next')
    await writeFolder(dir, filesFor(workerManifest('tool', { version: '1.1.0', capabilities: [role] })))
    expect(await made.pluginsManager.update('tool', dir)).toMatchObject({ outcome: 'confirm' })
    await made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'tool' })
    await until(() => stateOf(made.pluginsManager, 'tool') === 'ready')
    expect((await made.store.load()).state.plugins.tool).toMatchObject({ version: '1.1.0', granted: [] })
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
    expect(reasonOf(made.pluginsManager, 'mcp')).toBeNull()
  })

  it('gets no item from such an update with the role free either', async () => {
    const made = await harness({ folder: { tool: filesFor(workerManifest('tool')) }, entries: { tool: entryFor } })
    await made.pluginsManager.start()
    const dir = path.join(made.dataDir, 'staging', 'tool-next')
    await writeFolder(dir, filesFor(workerManifest('tool', { version: '1.1.0', capabilities: [role] })))
    await made.pluginsManager.update('tool', dir)
    await made.pluginsManager.apply({ kind: 'plugin.update', plugin: 'tool' })
    await until(() => stateOf(made.pluginsManager, 'tool') === 'ready')
    expect(made.pluginsManager.role('door.handle')).toBeNull()
  })

  it('is let widen to the role when no other entry holds it', async () => {
    const made = await harness({ folder: { tool: filesFor(workerManifest('tool')) }, entries: { tool: entryFor } })
    await made.pluginsManager.start()
    await made.pluginsManager.apply({ kind: 'grant.widen', plugin: 'tool', capability: role })
    expect(made.pluginsManager.role('door.handle')).toBe('tool')
  })

  // Only an edited state file holds two, and entries carry no order, so neither serves until the human removes one
  it('leaves both refused role-taken when two entries hold it at start, and the other serves once one is removed', async () => {
    const made = await harness({ folder: { mcp: holder('mcp'), copy: holder('copy') }, entries: { mcp: holds(), copy: holds() } })
    await made.pluginsManager.start()
    expect(reasonOf(made.pluginsManager, 'mcp')).toBe('role-taken')
    expect(reasonOf(made.pluginsManager, 'copy')).toBe('role-taken')
    expect(made.pluginsManager.role('door.handle')).toBeNull()
    await made.pluginsManager.apply({ kind: 'plugin.remove', plugin: 'copy' })
    await until(() => stateOf(made.pluginsManager, 'mcp') === 'ready')
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
  })
})

// The door learns the role is served from deps by the role's action, as a plugin hears its requires
describe('a role in deps', () => {
  it('tells a utility half whether the role\'s holder is ready, starting or gone, and a worker nothing of it', async () => {
    const made = await harness({
      install: install(),
      folder: { mcp: holder('mcp'), tool: filesFor(workerManifest('tool')) },
      entries: { mcp: holds(), tool: entryFor },
    })
    await made.pluginsManager.start()
    const door = made.runtime.half('mcp-http-handler', 1, 'utility')
    const last = () => (door.got('deps').at(-1)?.deps ?? door.got('init')[0].deps) as Record<string, string>
    await until(() => last()['door.handle'] === 'ready')
    expect(made.runtime.half('tool').got('init')[0].deps).toEqual({})
    await made.pluginsManager.apply({ kind: 'item.off', plugin: 'mcp', capability: role })
    await until(() => last()['door.handle'] === 'unavailable')
    await made.pluginsManager.apply({ kind: 'item.on', plugin: 'mcp', capability: role })
    await until(() => last()['door.handle'] === 'ready')
    await made.pluginsManager.apply({ kind: 'plugin.off', plugin: 'mcp' })
    await until(() => last()['door.handle'] === 'unavailable')
    expect(made.link.sent.some(sent => sent.caller.kind === 'plugin' && sent.caller.id === httpHalf().id)).toBe(true)
  })

  it('is the holder\'s own state, so a holder waiting on a requirement is no holder that serves', async () => {
    const made = await harness({
      install: install(),
      folder: { mcp: filesFor(workerManifest('mcp', { capabilities: [role], requires: ['ghost'] })) },
      entries: { mcp: holds() },
    })
    await made.pluginsManager.start()
    expect(stateOf(made.pluginsManager, 'mcp')).toBe('waiting')
    expect(made.pluginsManager.role('door.handle')).toBe('mcp')
    const door = made.runtime.half('mcp-http-handler', 1, 'utility')
    // A change that tells the router and sends deps, the role's holder unchanged
    await made.pluginsManager.apply({ kind: 'limit.set', plugin: 'mcp', constant: 'readyMs', value: 2000 })
    await made.pluginsManager.settled()
    expect(door.got('deps').at(-1)?.deps ?? door.got('init')[0].deps).toEqual({ 'door.handle': 'unavailable' })
  })

  it('is unavailable to the door while no plugin holds the role', async () => {
    const made = await harness({ install: install() })
    await made.pluginsManager.start()
    expect(made.runtime.half('mcp-http-handler', 1, 'utility').got('init')[0].deps).toEqual({ 'door.handle': 'unavailable' })
  })
})
