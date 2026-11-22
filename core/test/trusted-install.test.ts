import { describe, expect, it } from 'vitest'
import type { SecurityList, Staged, StagedPlugin } from '../api/actions.ts'
import { capabilityTypes, type Capability } from '../api/capabilities.ts'
import { grantSentence } from '../api/trusted.ts'
import { installBox } from '../frontend/trusted/install.ts'
import { TrustedPage, type Screen } from '../frontend/trusted/view.ts'

const calm = (): SecurityList => ({
  plugins: [],
  switches: { devMode: [], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false },
  limits: { all: {}, plugins: {} },
  luoshu: null,
  requests: [],
  identities: [],
  stopped: null,
})

// One capability of each type, scoped where the type takes a scope
const one: Record<Capability['type'], Capability> = {
  'luoshu.read': { type: 'luoshu.read', paths: ['**'] },
  'luoshu.write': { type: 'luoshu.write', paths: ['inbox/**'] },
  'luoshu.list': { type: 'luoshu.list', paths: ['**'] },
  'net.fetch': { type: 'net.fetch', hosts: ['api.example.com'] },
  'ui.view': { type: 'ui.view' },
  'ui.layout': { type: 'ui.layout' },
  'ui.decoration': { type: 'ui.decoration' },
  'ui.command': { type: 'ui.command' },
  'ui.keys': { type: 'ui.keys' },
  'ui.edit': { type: 'ui.edit', paths: ['**'] },
  'ui.read': { type: 'ui.read', paths: ['**'] },
  'events.subscribe': { type: 'events.subscribe', topics: ['notes.saved'] },
  storage: { type: 'storage' },
  history: { type: 'history', access: 'read', paths: ['**'] },
  exec: { type: 'exec', commands: [['git', 'status']], env: [] },
  'plugin.call': { type: 'plugin.call', targets: ['notes'] },
  'guard.hook': { type: 'guard.hook' },
  'log.read': { type: 'log.read' },
  'lock.set': { type: 'lock.set', paths: ['**'] },
}

describe('a grant as a plain sentence', () => {
  it('has a sentence for every capability type, none of which names the type', () => {
    for (const type of capabilityTypes) {
      const sentence = grantSentence(one[type])
      expect(sentence, type).toMatch(/^[A-Z]/)
      expect(sentence, type).not.toContain(type)
    }
  })

  it('says all your notes for ** and **/*, quotes any other scope as data and says no notes for none', () => {
    expect(grantSentence({ type: 'luoshu.read', paths: ['**'] })).toBe('Read all your notes')
    expect(grantSentence({ type: 'luoshu.read', paths: ['**/*'] })).toBe('Read all your notes')
    expect(grantSentence({ type: 'luoshu.write', paths: ['inbox/**', 'say "hi"/*.md'] }))
      .toBe('Create, change, move and delete the notes at "inbox/**", "say \\"hi\\"/*.md"')
    expect(grantSentence({ type: 'luoshu.list', paths: [] })).toBe('See the names of no notes')
    expect(grantSentence({ type: 'ui.read', paths: ['**', 'a.md'] })).toBe('Read all your notes while you have them open')
  })

  it('tells history\'s reading from its saving and names each command, host, topic and plugin in quotes', () => {
    expect(grantSentence({ type: 'history', access: 'read', paths: ['a.md'] })).toBe('Read the earlier versions of the notes at "a.md"')
    expect(grantSentence({ type: 'history', access: 'commit', paths: ['**'] })).toBe('Save versions of all your notes into hetu’s history')
    expect(grantSentence({ type: 'exec', commands: [['git', 'status'], ['git', 'log']], env: ['HOME'] }))
      .toBe('Run the commands ["git","status"], ["git","log"] outside the sandbox with your rights on this computer, with "HOME" from your environment')
    expect(grantSentence({ type: 'exec', commands: [['node']], env: [] })).toBe('Run the command ["node"] outside the sandbox with your rights on this computer')
    expect(grantSentence({ type: 'net.fetch', hosts: ['api.example.com'] })).toBe('Send data to and get data from "api.example.com" over the network')
    expect(grantSentence({ type: 'net.fetch', hosts: ['*'] })).toBe('Send data to and get data from any site over the network')
    expect(grantSentence({ type: 'events.subscribe', topics: ['notes.saved'] })).toBe('Hear the events "notes.saved"')
    expect(grantSentence({ type: 'plugin.call', targets: ['notes', 'search'] })).toBe('Call the plugins "notes", "search"')
  })

  // The schema lets a list be empty, which grants nothing
  it('says an empty list grants nothing rather than leaving a gap', () => {
    expect(grantSentence({ type: 'net.fetch', hosts: [] })).toBe('Send data to and get data from no site')
    expect(grantSentence({ type: 'events.subscribe', topics: [] })).toBe('Hear no events')
    expect(grantSentence({ type: 'plugin.call', targets: [] })).toBe('Call no other plugin')
    expect(grantSentence({ type: 'lock.set', paths: [] })).toBe('Lock no notes so nothing else changes them for a while')
    expect(grantSentence({ type: 'history', access: 'commit', paths: ['**'] })).not.toContain('  ')
  })
})

const found = (over: Partial<StagedPlugin>): StagedPlugin => ({
  id: 'search', name: 'Search', version: '1.2.0', capabilities: [{ type: 'luoshu.read', paths: ['**'] }], class: 1, lines: [], replaces: null,
  digest: (over.id ?? 'search').padEnd(64, '0').replace(/[^0-9a-f]/g, '0').slice(0, 64), problem: null,
  ...over,
})

describe('what the install box draws', () => {
  const staging = (plugins: StagedPlugin[]) => ({ step: 'found' as const, staged: 's1', busy: false, picked: new Set(['search']), plugins, source: { kind: 'zip' as const, path: 'C:\\plugins.zip' } })

  it('draws nothing while nothing is being installed', () => {
    expect(installBox(null)).toBeNull()
  })

  it('names the source and that the plugins are unsigned, then each plugin with its grants as sentences', () => {
    const box = installBox(staging([found({}), found({ id: 'layout', name: 'Layout', version: '0.3.0', capabilities: [{ type: 'ui.layout' }], class: 0 })]))
    expect(box).toMatchObject({
      step: 'found',
      source: 'From the zip "C:\\\\plugins.zip"',
      unsigned: 'Unsigned: nothing proves who made these plugins. Install only what comes from a source you trust',
      ready: true,
    })
    if (box?.step !== 'found') throw new Error('no found box')
    expect(box.plugins).toEqual([
      { id: 'search', label: '"Search" (search), version 1.2.0', line: 'class 1, Reader', high: false, lines: [], grants: ['Read all your notes'], problem: null, picked: true },
      {
        id: 'layout', label: '"Layout" (layout), version 0.3.0', line: 'class 0, Contained', high: false, lines: [],
        grants: ['Lay out the whole editor window once you pick it as the layout'], problem: null, picked: false,
      },
    ])
  })

  it('says what a plugin replaces, a class it couldn’t give, a plugin that asks for nothing and why one can’t be installed', () => {
    const box = installBox(staging([
      found({ replaces: '1.0.0', class: null, capabilities: [] }),
      found({ id: 'odd', name: null, version: null, capabilities: [{ type: 'storage' }], class: null, problem: 'api' }),
      found({ id: 'broken', name: null, version: null, capabilities: [], class: null, problem: 'invalid' }),
    ]))
    if (box?.step !== 'found') throw new Error('no found box')
    expect(box.plugins[0]).toMatchObject({ line: 'Higher risk: class unknown, counted as 4 · replaces version 1.0.0', high: true, grants: ['It asks for nothing'] })
    expect(box.plugins[1]).toMatchObject({ label: 'odd', grants: ['Keep data of its own'], problem: 'It needs a hetu API this hetu doesn’t have, so it can’t be installed', picked: false })
    // A manifest that doesn't check out says nothing of what it asks for
    expect(box.plugins[2]).toMatchObject({ grants: [], problem: 'Its manifest doesn’t parse or check out, so what it asks for can’t be read and it can’t be installed' })
  })

  // The same reasons the approval's Confirm showed, from the grant risk classifier through the core
  it('marks class 3 and 4 as higher risk and shows the classifier’s lines on why under the grants', () => {
    const lines = ['It can read notes and reach the network, so it could send notes out']
    const box = installBox(staging([found({ class: 4, lines }), found({ id: 'net', class: 3 }), found({ id: 'tags', class: 2 })]))
    if (box?.step !== 'found') throw new Error('no found box')
    expect(box.plugins.map(row => [row.line, row.high, row.lines])).toEqual([
      ['Higher risk: class 4, Powerful', true, lines], ['Higher risk: class 3, Network', true, []], ['class 2, Writer', false, []],
    ])
  })

  it('isn’t ready with nothing ticked and names a link’s asset with its release', () => {
    const box = installBox({ ...staging([found({})]), picked: new Set(), source: { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'plugins.zip', tag: 'v1.0.0' } })
    expect(box).toMatchObject({ ready: false, source: 'From "plugins.zip" in the release "v1.0.0" of "https://github.com/someone/plugins"' })
  })

  it('lists a release\'s zip assets with their sizes', () => {
    expect(installBox({ step: 'assets', link: 'https://github.com/someone/plugins', tag: 'v2', assets: [{ name: 'a.zip', bytes: 2048 }, { name: 'b.zip', bytes: 3 * 1024 * 1024 }] })).toEqual({
      step: 'assets',
      heading: 'Pick a zip from the release "v2" of "https://github.com/someone/plugins"',
      assets: [{ name: 'a.zip', line: '"a.zip", 2 KB' }, { name: 'b.zip', line: '"b.zip", 3.0 MB' }],
    })
  })
})

// The bridge the preload gives the page, as trusted-view.test.ts has it
function bridge() {
  const sent: Record<string, unknown>[] = []
  let listener: ((message: unknown) => void) | null = null
  return {
    sent,
    bridge: { send: (message: unknown) => sent.push(message as Record<string, unknown>), listen: (next: (message: unknown) => void) => { listener = next } },
    hears: (message: unknown) => listener?.(message),
  }
}

const replyTo = (message: Record<string, unknown>, result: unknown) => ({ v: 1, kind: 'reply', id: message.id, ok: true, result })
const refuse = (message: Record<string, unknown>, code: string) => ({ v: 1, kind: 'reply', id: message.id, ok: false, refusal: { code, action: message.action } })

describe('the install flow against a fake main', () => {
  function started() {
    const made = bridge()
    const drawn: { screen: Screen, note: string | null }[] = []
    const page = new TrustedPage(made.bridge, (shown, note) => drawn.push({ screen: shown, note }))
    page.start()
    made.hears(replyTo(made.sent[1], calm()))
    // Answers the last call sent, then the list the page reads after it if it reads one
    const answer = (result: unknown) => {
      made.hears(replyTo(made.sent.at(-1)!, result))
      if (made.sent.at(-1)?.action === 'security.list') made.hears(replyTo(made.sent.at(-1)!, calm()))
    }
    const last = () => drawn.at(-1)!
    return { ...made, page, drawn, answer, last }
  }
  const staged = (plugins: StagedPlugin[]): Staged => ({ staged: 's1', source: { kind: 'zip', path: '/tmp/p.zip' }, plugins })

  it('picks a zip in main\'s dialog, stages it and draws what was found with the plugins that can install ticked', () => {
    const { sent, page, answer, last } = started()
    page.installer.pick('zip')
    expect(sent.at(-1)).toMatchObject({ action: 'app.pickPlugins', args: { source: 'zip' } })
    answer('/tmp/p.zip')
    expect(sent.at(-1)).toMatchObject({ action: 'core.stage', args: { source: { kind: 'zip', path: '/tmp/p.zip' } } })
    answer(staged([found({}), found({ id: 'bad', problem: 'invalid' })]))
    const box = last().screen.installing
    if (box?.step !== 'found') throw new Error('no found box')
    expect(box.plugins.map(row => [row.id, row.picked])).toEqual([['search', true], ['bad', false]])
  })

  it('asks for nothing more when the dialog was cancelled', () => {
    const { sent, page, answer } = started()
    page.installer.pick('folder')
    expect(sent.at(-1)).toMatchObject({ action: 'app.pickPlugins', args: { source: 'folder' } })
    const before = sent.length
    answer(null)
    expect(sent.length).toBe(before)
  })

  it('stages a link\'s one zip at once and lists several for the human to pick', () => {
    const one = started()
    one.page.installer.find('  https://github.com/someone/plugins ')
    expect(one.sent.at(-1)).toMatchObject({ action: 'core.findRelease', args: { link: 'https://github.com/someone/plugins' } })
    one.answer({ tag: 'v1', assets: [{ name: 'plugins.zip', bytes: 10 }] })
    expect(one.sent.at(-1)).toMatchObject({ action: 'core.stage', args: { source: { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'plugins.zip' } } })

    const two = started()
    two.page.installer.find('https://github.com/someone/plugins')
    two.answer({ tag: 'v1', assets: [{ name: 'a.zip', bytes: 10 }, { name: 'b.zip', bytes: 10 }] })
    expect(two.last().screen.installing).toMatchObject({ step: 'assets' })
    two.page.installer.asset('b.zip')
    expect(two.sent.at(-1)).toMatchObject({ action: 'core.stage', args: { source: { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'b.zip' } } })
    // The release the core staged from, which can be newer than the one listed
    two.answer({ staged: 's2', source: { kind: 'link', link: 'https://github.com/someone/plugins', asset: 'b.zip', tag: 'v2' }, plugins: [found({})] })
    expect(two.last().screen.installing).toMatchObject({ source: 'From "b.zip" in the release "v2" of "https://github.com/someone/plugins"' })
  })

  it('says in plain words why a link or a source gave nothing, and why an empty link asks for nothing', () => {
    const { sent, page, answer, last } = started()
    page.installer.find('https://github.com/someone/nothing')
    answer({ problem: 'no-release' })
    expect(last()).toMatchObject({ note: 'That repository has no release', screen: { installing: null } })
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer({ problem: 'same-id' })
    expect(last().note).toBe('It holds two plugins with one id, so nothing was taken')
    const before = sent.length
    page.installer.find('   ')
    expect(sent.slice(before).map(message => message.action)).toEqual(['security.list'])
    answer(calm())
    expect(last().note).toBe('Paste a link to a GitHub repository or release')
  })

  it('installs the ticked plugins in the order found with one Confirm, then says which', () => {
    const { sent, page, answer, last } = started()
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer(staged([found({ id: 'search' }), found({ id: 'layout' }), found({ id: 'tags' })]))
    page.installer.tick('search', false)
    page.installer.tick('tags', true)
    page.installer.tick('layout', true)
    page.installer.install('s1')
    expect(sent.at(-1)).toMatchObject({
      action: 'core.install', args: { staged: 's1', plugins: [{ id: 'layout', digest: found({ id: 'layout' }).digest }, { id: 'tags', digest: found({ id: 'tags' }).digest }] },
    })
    answer({ installed: ['layout', 'tags'] })
    expect(last()).toMatchObject({ note: 'Installed layout, tags', screen: { installing: null } })
  })

  it('never ticks or sends a plugin that can’t be installed', () => {
    const { sent, page, answer, last } = started()
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer(staged([found({}), found({ id: 'bad', problem: 'reserved' })]))
    page.installer.tick('bad', true)
    const box = last().screen.installing
    if (box?.step !== 'found') throw new Error('no found box')
    expect(box.plugins.map(row => row.picked)).toEqual([true, false])
    page.installer.install('s1')
    expect(sent.at(-1)).toMatchObject({ action: 'core.install', args: { plugins: [{ id: 'search' }] } })
    expect((sent.at(-1)!.args as { plugins: unknown[] }).plugins).toHaveLength(1)
  })

  it('sends no Confirm with nothing ticked and keeps the box when the Confirm came too soon', () => {
    const { sent, page, answer, hears, last } = started()
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer(staged([found({})]))
    page.installer.tick('search', false)
    const before = sent.length
    page.installer.install('s1')
    expect(sent.length).toBe(before)
    page.installer.tick('search', true)
    page.installer.install('s1')
    hears(refuse(sent.at(-1)!, 'throttled'))
    answer(calm())
    expect(last().note).toBe('Too soon after the window showed. Read the change, then confirm')
    expect(last().screen.installing).toMatchObject({ step: 'found' })
  })

  it('drops the box when its staging is gone', () => {
    const { sent, page, answer, hears, last } = started()
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer(staged([found({})]))
    page.installer.install('s1')
    hears(refuse(sent.at(-1)!, 'not-found'))
    answer(calm())
    expect(last().screen.installing).toBeNull()
  })

  it('drops a staging on Cancel and the one it replaces once a newer one is drawn, keeping a good box when the newer fails', () => {
    const { sent, page, answer, last } = started()
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer(staged([found({})]))
    page.installer.pick('folder')
    answer('/tmp/bad')
    answer({ problem: 'none' })
    expect(last().screen.installing).toMatchObject({ step: 'found', staged: 's1' })
    expect(sent.some(message => message.action === 'core.unstage')).toBe(false)
    page.installer.pick('folder')
    answer('/tmp/plugins')
    answer({ ...staged([found({})]), staged: 's2' })
    expect(last().screen.installing).toMatchObject({ staged: 's2' })
    expect(sent.filter(message => message.action === 'core.unstage').map(message => message.args)).toEqual([{ staged: 's1' }])
    page.installer.cancel()
    expect(sent.filter(message => message.action === 'core.unstage').map(message => message.args)).toEqual([{ staged: 's1' }, { staged: 's2' }])
    expect(last().screen.installing).toBeNull()
  })

  it('drops a found box’s staging once a link’s list of zips takes its place', () => {
    const { sent, page, answer, last } = started()
    page.installer.pick('zip')
    answer('/tmp/p.zip')
    answer(staged([found({})]))
    page.installer.find('https://github.com/someone/plugins')
    answer({ tag: 'v1', assets: [{ name: 'a.zip', bytes: 1 }, { name: 'b.zip', bytes: 1 }] })
    expect(last().screen.installing).toMatchObject({ step: 'assets' })
    expect(sent.filter(message => message.action === 'core.unstage').map(message => message.args)).toEqual([{ staged: 's1' }])
  })

  it('says a link that isn’t a GitHub repository or release isn’t one, asking the core nothing', () => {
    const { sent, page, answer, last } = started()
    for (const link of ['https://example.com/someone/plugins', 'github.com/someone/plugins', 'https://github.com/someone', `https://github.com/someone/${'x'.repeat(2048)}`]) {
      page.installer.find(link)
      answer(calm())
      expect(last().note).toBe('That isn’t a link to a GitHub repository or release')
    }
    expect(sent.some(message => message.action === 'core.findRelease')).toBe(false)
  })
})

// A reply is for the flow as it was when its call went: one for anything but the latest start is dropped, a staging it
// carries unstaged, and the Confirm names the staging the human saw
describe('the install flow when answers come late, out of order or twice', () => {
  function started() {
    const made = bridge()
    const drawn: { screen: Screen, note: string | null }[] = []
    const page = new TrustedPage(made.bridge, (shown, note) => drawn.push({ screen: shown, note }))
    page.start()
    made.hears(replyTo(made.sent[1], calm()))
    const answerTo = (message: Record<string, unknown>, result: unknown) => {
      made.hears(replyTo(message, result))
      if (made.sent.at(-1)?.action === 'security.list') made.hears(replyTo(made.sent.at(-1)!, calm()))
    }
    const lastOf = (action: string) => made.sent.findLast(message => message.action === action)!
    const unstaged = () => made.sent.filter(message => message.action === 'core.unstage').map(message => (message.args as { staged: string }).staged)
    return { ...made, page, drawn, answerTo, lastOf, unstaged, last: () => drawn.at(-1)! }
  }
  const staging = (staged: string, path = '/tmp/p.zip'): Staged => ({ staged, source: { kind: 'zip', path }, plugins: [found({})] })

  it('drops a staging that answers after a newer one and unstages it', () => {
    const { page, answerTo, lastOf, unstaged, last } = started()
    page.installer.pick('zip')
    answerTo(lastOf('app.pickPlugins'), '/tmp/a.zip')
    const first = lastOf('core.stage')
    page.installer.pick('folder')
    answerTo(lastOf('app.pickPlugins'), '/tmp/b')
    const second = lastOf('core.stage')
    answerTo(second, staging('s2', '/tmp/b'))
    answerTo(first, staging('s1'))
    expect(last().screen.installing).toMatchObject({ staged: 's2' })
    expect(unstaged()).toEqual(['s1'])
  })

  it('drops a release that answers after a newer start', () => {
    const { sent, page, answerTo, lastOf, last } = started()
    page.installer.find('https://github.com/someone/plugins')
    const release = lastOf('core.findRelease')
    page.installer.pick('folder')
    answerTo(lastOf('app.pickPlugins'), '/tmp/b')
    answerTo(lastOf('core.stage'), staging('s2', '/tmp/b'))
    const before = sent.length
    answerTo(release, { tag: 'v1', assets: [{ name: 'a.zip', bytes: 1 }] })
    expect(sent.slice(before).some(message => message.action === 'core.stage')).toBe(false)
    expect(last().screen.installing).toMatchObject({ staged: 's2' })
  })

  it('drops a staging that answers after Cancel and unstages it', () => {
    const { page, answerTo, lastOf, unstaged, last } = started()
    page.installer.pick('zip')
    answerTo(lastOf('app.pickPlugins'), '/tmp/a.zip')
    const stage = lastOf('core.stage')
    page.installer.cancel()
    answerTo(stage, staging('s1'))
    expect(last().screen.installing).toBeNull()
    expect(unstaged()).toEqual(['s1'])
  })

  it('sends nothing for a click on a staging that is no longer the one shown', () => {
    const { sent, page, answerTo, lastOf } = started()
    page.installer.pick('zip')
    answerTo(lastOf('app.pickPlugins'), '/tmp/a.zip')
    answerTo(lastOf('core.stage'), staging('s1'))
    page.installer.pick('folder')
    answerTo(lastOf('app.pickPlugins'), '/tmp/b')
    answerTo(lastOf('core.stage'), staging('s2', '/tmp/b'))
    page.installer.install('s1')
    expect(sent.some(message => message.action === 'core.install')).toBe(false)
  })

  it('sends one Confirm for a double click and draws Install busy until it answers', () => {
    const { sent, page, answerTo, lastOf, last } = started()
    page.installer.pick('zip')
    answerTo(lastOf('app.pickPlugins'), '/tmp/a.zip')
    answerTo(lastOf('core.stage'), staging('s1'))
    page.installer.install('s1')
    page.installer.install('s1')
    expect(sent.filter(message => message.action === 'core.install')).toHaveLength(1)
    expect(last().screen.installing).toMatchObject({ busy: true })
    answerTo(lastOf('core.install'), { installed: ['search'] })
    expect(last()).toMatchObject({ note: 'Installed search', screen: { installing: null } })
  })

  it('never clears a newer box with a late answer to an older Confirm', () => {
    const { page, answerTo, lastOf, unstaged, last } = started()
    page.installer.pick('zip')
    answerTo(lastOf('app.pickPlugins'), '/tmp/a.zip')
    answerTo(lastOf('core.stage'), staging('s1'))
    page.installer.install('s1')
    const confirm = lastOf('core.install')
    page.installer.pick('folder')
    answerTo(lastOf('app.pickPlugins'), '/tmp/b')
    answerTo(lastOf('core.stage'), staging('s2', '/tmp/b'))
    // The staging being installed is the core's to drop
    expect(unstaged()).toEqual([])
    answerTo(confirm, { installed: ['search'] })
    expect(last()).toMatchObject({ note: 'Installed search', screen: { installing: { staged: 's2' } } })
  })
})
