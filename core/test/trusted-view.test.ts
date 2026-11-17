import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { HeldRequest, ListedPlugin, SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import { floorConstantNames, floorConstants } from '../api/floor.ts'
import { choiceChange, limitChange, screen, TrustedPage, type Screen } from '../frontend/trusted/view.ts'

const plugin = (over: Partial<ListedPlugin>): ListedPlugin => ({
  id: 'search', from: 'folder', place: 'sandboxed', state: 'ready', reason: null, security: false, firstParty: false, on: true, items: [], class: 1,
  ...over,
})

const calm = (over: Partial<SecurityList> = {}): SecurityList => ({
  plugins: [],
  switches: { devMode: [], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false, recordNothing: false },
  limits: { all: {}, plugins: {} },
  luoshu: null,
  requests: [],
  agents: [],
  stopped: null,
  ...over,
})

describe('what the trusted window draws', () => {
  it('shows the oldest request first and counts the ones behind it', () => {
    const drawn = screen(calm({
      requests: [
        { id: 'r1', kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', notes: ['n'], type: 'gate', agent: null },
        { id: 'r2', kind: 'confirmOff', plugin: null, text: 'Apply changes made in this window without a Confirm', notes: [], type: null, agent: null },
      ],
    }))
    expect(drawn.request).toMatchObject({ id: 'r1', text: 'Switch gate off', type: 'gate' })
    expect(drawn.behind).toBe(1)
  })

  it('names a plugin by its id with where it runs, its state and why, and a plugin-folder plugin’s class', () => {
    const drawn = screen(calm({
      plugins: [
        plugin({ id: 'gate', from: 'install', place: 'host', security: true, class: null }),
        plugin({ state: 'crashed', reason: 'flood' }),
        plugin({ id: 'tool', class: null }),
      ],
    }))
    expect(drawn.plugins.map(row => row.line)).toEqual([
      'gate · ships with hetu · host · ready · security',
      'search · plugin folder · sandboxed · crashed (flood) · class 1',
      'tool · plugin folder · sandboxed · ready · class unknown, counted as 4',
    ])
  })

  it('offers each plugin what fits its state: approve, switch, stop, restart, recover and remove', () => {
    const actions = (over: Partial<ListedPlugin>) => screen(calm({ plugins: [plugin(over)] })).plugins[0].actions
    expect(actions({ state: 'found', reason: 'new', on: false })).toEqual(['approve', 'remove'])
    expect(actions({})).toEqual(['switch-off', 'stop', 'reset', 'remove'])
    expect(actions({ state: 'unresponsive' })).toEqual(['switch-off', 'stop', 'reset', 'remove'])
    expect(actions({ state: 'crashed' })).toEqual(['switch-off', 'restart', 'reset', 'remove'])
    expect(actions({ on: false, state: 'off' })).toEqual(['switch-on', 'reset', 'remove'])
    expect(actions({ firstParty: true, id: 'git' })).toEqual(['switch-off', 'stop', 'reset', 'restore', 'remove'])
    // A host half stops only with its switch and restarts only with hetu
    expect(actions({ from: 'install', place: 'host', id: 'luoshu' })).toEqual(['switch-off', 'reset'])
    expect(actions({ from: 'install', place: 'host', id: 'luoshu', state: 'failed', reason: 'start-failed' })).toEqual(['switch-off', 'reset'])
    expect(actions({ from: 'install', place: 'page', id: 'hidden-marks' })).toEqual(['switch-off', 'reset'])
  })

  // A utility half stops and restarts within a run, so a human who freed the port it failed on brings it back here
  it('offers a utility half Stop while it runs and Restart once it stopped, crashed or failed, drawing why', () => {
    const http = (over: Partial<ListedPlugin>) => plugin({ id: 'http', from: 'install', place: 'utility', class: null, ...over })
    const actions = (over: Partial<ListedPlugin>) => screen(calm({ plugins: [http(over)] })).plugins[0].actions
    expect(actions({})).toEqual(['switch-off', 'stop', 'reset'])
    expect(actions({ state: 'starting' })).toEqual(['switch-off', 'stop', 'reset'])
    expect(actions({ state: 'failed', reason: 'port-taken' })).toEqual(['switch-off', 'restart', 'reset'])
    expect(actions({ state: 'crashed', reason: 'unresponsive' })).toEqual(['switch-off', 'restart', 'reset'])
    expect(actions({ state: 'stopped', reason: 'human' })).toEqual(['switch-off', 'restart', 'reset'])
    expect(actions({ on: false, state: 'off' })).toEqual(['switch-on', 'reset'])
    const drawn = screen(calm({ plugins: [http({ state: 'failed', reason: 'port-taken' })] }))
    expect(drawn.plugins[0].line).toBe('http · ships with hetu · utility · failed (port-taken)')
  })

  it('lists a plugin’s items with their switches and says when one switched off is still reached through another', () => {
    const drawn = screen(calm({
      plugins: [plugin({
        items: [
          { capability: { type: 'luoshu.read', paths: ['**'] }, off: false, firstUse: false },
          { capability: { type: 'luoshu.read', paths: ['notes/**'] }, off: true, firstUse: false },
          { capability: { type: 'storage' }, off: false, firstUse: true },
        ],
      })],
    }))
    expect(drawn.plugins[0].items).toMatchObject([
      { line: 'luoshu.read on "**" · on', on: true },
      { line: 'luoshu.read on "notes/**" · off · other luoshu.read items still on may reach the same paths', on: false },
      { line: 'storage · asks at first use', on: false },
    ])
  })

  it('gives each switch for all of hetu its state and the change its button asks for', () => {
    expect(screen(calm()).switches).toEqual([
      { line: 'Confirm off for this window: off', change: { kind: 'confirmOff', on: true } },
      { line: 'Verification skipped: off', change: { kind: 'skipVerification', on: true } },
      { line: 'Record nothing: off', change: { kind: 'recordNothing', on: true } },
    ])
    const drawn = screen(calm({
      switches: { devMode: ['search'], execAnyCommand: ['git'], skipVerification: true, allowUnsigned: ['a'.repeat(64)], confirmOff: true, recordNothing: true },
    }))
    expect(drawn.switches).toEqual([
      { line: 'Confirm off for this window: on', change: { kind: 'confirmOff', on: false } },
      { line: 'Verification skipped: on', change: { kind: 'skipVerification', on: false } },
      { line: 'Record nothing: on', change: { kind: 'recordNothing', on: false } },
      { line: 'dev mode: search', change: null },
      { line: 'any command: git', change: null },
      { line: 'unsigned builds trusted: 1', change: null },
    ])
  })

  it('says the macOS install is not protected from programs running as the human', () => {
    expect(screen(calm()).install).toBe('On macOS, programs running as you can change hetu’s install')
  })

  it('names the notes folder, or says none is picked', () => {
    expect(screen(calm()).luoshu).toBe('Notes folder: none picked')
    expect(screen(calm({ luoshu: '/Users/someone/notes' })).luoshu).toBe('Notes folder: /Users/someone/notes')
  })

  it('gives a folder plugin its dev mode switch and a plugin holding exec its any command switch', () => {
    const exec = { type: 'exec', commands: [['git', 'status']], env: [] } as unknown as ListedPlugin['items'][number]['capability']
    const drawn = screen(calm({
      plugins: [
        plugin({ id: 'search' }),
        plugin({ id: 'git', items: [{ capability: exec, off: false, firstUse: false }] }),
        plugin({ id: 'gate', from: 'install', place: 'host', security: true }),
      ],
      switches: { devMode: ['search'], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false, recordNothing: false },
    }))
    expect(drawn.plugins.map(row => row.switches)).toEqual([
      [{ line: 'dev mode: on', change: { kind: 'devMode', plugin: 'search', on: false } }],
      [
        { line: 'dev mode: off', change: { kind: 'devMode', plugin: 'git', on: true } },
        { line: 'any command: off', change: { kind: 'exec.anyCommand', plugin: 'git', on: true } },
      ],
      [],
    ])
  })

  it('lists each limit with the floor’s value and the values set for all and for each plugin', () => {
    const drawn = screen(calm({ limits: { all: { readyMs: 20000 }, plugins: { search: { readyMs: 5000, callsInFlight: 8 } } } }))
    expect(drawn.limits.map(limit => limit.constant)).toEqual(floorConstantNames)
    expect(drawn.limits.find(limit => limit.constant === 'readyMs')).toEqual({
      constant: 'readyMs', floor: floorConstants.readyMs, all: 20000, plugins: [{ plugin: 'search', value: 5000 }],
    })
    expect(drawn.limits.find(limit => limit.constant === 'callsInFlight')).toEqual({
      constant: 'callsInFlight', floor: floorConstants.callsInFlight, all: null, plugins: [{ plugin: 'search', value: 8 }],
    })
  })

  it('turns what the human typed for a limit into its change, or nothing for what isn’t a positive whole number', () => {
    expect(limitChange('readyMs', '20000', null)).toEqual({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    expect(limitChange('callsInFlight', ' 8 ', 'search')).toEqual({ kind: 'limit.set', constant: 'callsInFlight', value: 8, plugin: 'search' })
    for (const typed of ['', '0', '-5', '1.5', '1e3', 'ten', '99999999999999999999']) expect(limitChange('readyMs', typed, null)).toBeNull()
  })

  it('draws an agent\'s label in an ask\'s heading as a part of its own and every other heading whole', () => {
    const asked: Omit<HeldRequest, 'text' | 'agent'> = { id: 'r1', kind: 'agent.ask', plugin: 'mcp', notes: [], type: null }
    const label = `https://claude.ai/${'a'.repeat(200)}#12`
    expect(screen(calm({ requests: [{ ...asked, text: `Give the agent "${label}" what it asks for through mcp`, agent: label }] })).request!.heading).toEqual([
      { text: 'Give the agent ', label: false }, { text: `"${label}"`, label: true }, { text: ' what it asks for through mcp', label: false },
    ])
    expect(screen(calm({ requests: [{ ...asked, kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', agent: null }] })).request!.heading)
      .toEqual([{ text: 'Switch gate off', label: false }])
    // A label the text doesn't hold leaves the text whole, so nothing is drawn twice or out of order
    expect(screen(calm({ requests: [{ ...asked, text: 'Give the agent "a#1" what it asks for through mcp', agent: 'b#1' }] })).request!.heading)
      .toEqual([{ text: 'Give the agent "a#1" what it asks for through mcp', label: false }])
  })

  // The page's own stylesheet, which the trusted window's policy lets load from its own origin and nothing else
  it('draws a label in a fixed-width face the system has and wraps it and the lines holding it anywhere', async () => {
    const css = await readFile(new URL('../frontend/trusted/trusted.css', import.meta.url), 'utf8')
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*]/g, '\\$&')}[^{]*\\{([^}]*)\\}`))?.[1] ?? ''
    expect(rule('.label')).toMatch(/font-family:[^;]*\bmonospace;/)
    expect(rule('.label')).toMatch(/overflow-wrap: anywhere;/)
    expect(css).toMatch(/\.request h1,\s*\.agent \{\s*overflow-wrap: anywhere;/)
    expect(css).not.toMatch(/@font-face|url\(/)
  })

  it('quotes each target, topic and variable in a plugin\'s items and an agent\'s', () => {
    const items: Capability[] = [
      { type: 'plugin.call', targets: ['notes'] }, { type: 'events.subscribe', topics: ['notes.saved'] }, { type: 'exec', commands: [['git', 'status']], env: ['HOME'] },
    ]
    const drawn = screen(calm({
      plugins: [plugin({ items: items.map(capability => ({ capability, off: false, firstUse: false })) })],
      agents: [{ agent: 'client#1', items: [items[0]], revoked: false }],
    }))
    expect(drawn.plugins[0].items.map(item => item.line)).toEqual([
      'plugin.call to "notes" · on', 'events.subscribe to "notes.saved" · on', 'exec of ["git","status"] with "HOME" from your environment · on',
    ])
    expect(drawn.agents.rows[0].line).toContain('plugin.call to "notes"')
  })

  it('lists each agent by its label in quotes with its items and a Revoke, a revoked one with no button, then what it can\'t know', () => {
    const drawn = screen(calm({
      agents: [
        { agent: 'client#1', items: [{ type: 'luoshu.read', paths: ['inbox/**'] }, { type: 'luoshu.write', paths: ['say "hi"/**'] }], revoked: false },
        { agent: 'https://claude.ai/oauth/claude-code-client-metadata#3', items: [], revoked: true },
      ],
    }))
    expect(drawn.agents).toEqual({
      rows: [
        { label: '"client#1"', line: ' · luoshu.read on "inbox/**" · luoshu.write on "say \\"hi\\"/**"', change: { kind: 'agent.revoke', agent: 'client#1' } },
        { label: '"https://claude.ai/oauth/claude-code-client-metadata#3"', line: ' · revoked, its tokens end once http hears', change: null },
      ],
      about: 'Each agent is the client id and the number of one authorization. Its name and whether its token is live are http’s to know, not this list’s',
    })
    expect(screen(calm()).agents.rows).toEqual([])
  })

  describe('the stopped mode', () => {
    it('says which control stopped hetu and why, with the three choices for a control that failed', () => {
      const drawn = screen(calm({ stopped: { control: 'gate', why: 'failed', reason: 'start-failed', again: false } }))
      expect(drawn.stopped).toEqual({
        control: 'gate',
        lines: ['hetu stopped: the security plugin gate failed to start (start-failed)'],
        choices: ['switch-off', 'recover', 'quit'],
      })
    })

    it('sends the human to the installer for a control whose files are tampered or missing', () => {
      const tampered = screen(calm({ stopped: { control: 'gate', why: 'tampered', reason: 'tampered', again: true } }))
      expect(tampered.stopped).toEqual({
        control: 'gate',
        lines: [
          'hetu stopped: the security plugin gate failed its hash check',
          'hetu already started again once after a failure, so it didn’t start again on its own',
          'Repair hetu with its installer to get its files back',
        ],
        choices: ['switch-off', 'quit'],
      })
      expect(screen(calm({ stopped: { control: 'gate', why: 'absent', reason: 'missing', again: false } })).stopped?.lines[0])
        .toBe('hetu stopped: the security plugin gate is missing from the install')
    })

    it('turns each choice into the change it asks for', () => {
      expect(choiceChange('gate', 'switch-off')).toEqual({ kind: 'plugin.off', plugin: 'gate' })
      expect(choiceChange('gate', 'recover')).toEqual({ kind: 'plugin.reset', plugin: 'gate' })
      expect(choiceChange('log', 'switch-off')).toEqual({ kind: 'recordNothing', on: true })
      expect(choiceChange('gate', 'quit')).toBe(null)
    })

    it('offers to stop recording for a log that can’t write, and nothing to recover', () => {
      const drawn = screen(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: true } }))
      expect(drawn.stopped?.lines[0]).toBe('hetu stopped: the event log can’t write')
      expect(drawn.stopped?.choices).toEqual(['switch-off', 'quit'])
    })
  })
})

// The bridge the preload gives the page: what the page sent, and messages from the core to it
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

describe('the trusted page', () => {
  function started(list = calm()) {
    const made = bridge()
    const drawn: { screen: Screen, note: string | null }[] = []
    const page = new TrustedPage(made.bridge, (shown, note) => drawn.push({ screen: shown, note }))
    page.start()
    made.hears(replyTo(made.sent[1], list))
    return { ...made, page, drawn }
  }

  it('hears core.status and core.security, reads the list and draws it, then reads it again on each event, acking it', () => {
    const { sent, drawn, hears } = started()
    expect(sent.slice(0, 2).map(message => [message.action, message.args])).toEqual([
      ['events.subscribe', { topics: ['core.status', 'core.security'] }], ['security.list', undefined],
    ])
    expect(drawn).toHaveLength(1)
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 3 })
    expect(sent.slice(2)).toEqual([{ v: 1, kind: 'ack', seq: 3 }, expect.objectContaining({ action: 'security.list' })])
  })

  it('confirms a request with what was typed and reads the list again', () => {
    const { sent, page, hears } = started()
    page.confirm('r1', 'gate')
    expect(sent[2]).toMatchObject({ action: 'security.confirm', args: { requestId: 'r1', typed: 'gate' } })
    hears(replyTo(sent[2], null))
    expect(sent[3]).toMatchObject({ action: 'security.list' })
  })

  it('says why a Confirm counted for nothing', () => {
    const { sent, page, hears, drawn } = started()
    for (const [code, note] of [
      ['throttled', 'Too soon after the window showed. Read the change, then confirm'],
      ['invalid', 'What you typed doesn’t match'],
      ['stale', 'The settings changed since this was asked. Ask again'],
      ['failed', 'hetu couldn’t record or apply the change, so nothing changed'],
    ]) {
      page.confirm('r1')
      const confirm = sent.at(-1)!
      hears(refuse(confirm, code))
      hears(replyTo(sent.at(-1)!, calm()))
      expect(drawn.at(-1)?.note).toBe(note)
    }
  })

  it('draws a note of the page’s own, such as a limit that isn’t a number, with the list it reads again', () => {
    const { sent, page, hears, drawn } = started()
    page.say('Type a whole number from 1 up')
    expect(sent.at(-1)).toMatchObject({ action: 'security.list' })
    hears(replyTo(sent.at(-1)!, calm()))
    expect(drawn.at(-1)?.note).toBe('Type a whole number from 1 up')
  })

  it('picks a folder through main’s dialog and asks for it as luoshu.set, and asks nothing when the dialog was cancelled', () => {
    const { sent, page, hears } = started()
    page.pickFolder()
    expect(sent.at(-1)).toMatchObject({ action: 'core.pickFolder' })
    hears(replyTo(sent.at(-1)!, null))
    expect(sent.at(-1)).toMatchObject({ action: 'core.pickFolder' })
    page.pickFolder()
    hears(replyTo(sent.at(-1)!, '/Users/someone/notes'))
    expect(sent.at(-1)).toMatchObject({ action: 'security.request', args: { change: { kind: 'luoshu.set', folder: '/Users/someone/notes' } } })
  })

  it('asks for a limit as a request, which waits for the Confirm', () => {
    const { sent, page } = started()
    page.ask(limitChange('readyMs', '20000', 'search')!)
    expect(sent.at(-1)).toMatchObject({ action: 'security.request', args: { change: { kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: 'search' } } })
  })

  // With confirmOff on a choice applied through the request and hetu stayed stopped
  it('starts hetu again once a choice in the stopped mode applied at once', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'gate', why: 'failed', reason: 'start-failed', again: false } }))
    page.ask({ kind: 'plugin.reset', plugin: 'gate' })
    hears(replyTo(sent[2], { applied: true }))
    expect(sent.map(message => message.action)).toContain('core.relaunch')
  })

  it('starts nothing again for a choice that waits for its Confirm', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'gate', why: 'failed', reason: 'start-failed', again: false } }))
    page.ask({ kind: 'plugin.reset', plugin: 'gate' })
    hears(replyTo(sent[2], { held: 'r1' }))
    expect(sent.map(message => message.action)).not.toContain('core.relaunch')
  })

  it('says when too many requests wait, apart from a Confirm sent too soon', () => {
    const { sent, page, hears, drawn } = started()
    page.ask({ kind: 'confirmOff', on: true })
    hears(refuse(sent[2], 'throttled'))
    hears(replyTo(sent.at(-1)!, calm()))
    expect(drawn.at(-1)?.note).toBe('Too many requests are waiting. Answer or cancel some first')
  })

  it('starts hetu again once a choice in the stopped mode applied', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'gate', why: 'failed', reason: 'start-failed', again: false } }))
    page.confirm('r1', 'gate')
    hears(replyTo(sent[2], null))
    expect(sent.map(message => message.action)).toContain('core.relaunch')
  })

  it('asks for a change, stops and restarts a plugin, and quits', () => {
    const { sent, page } = started()
    page.ask({ kind: 'plugin.off', plugin: 'gate' })
    page.stop('search')
    page.restart('search')
    page.cancel('r1')
    page.quit()
    expect(sent.slice(2).map(message => [message.action, message.args])).toEqual([
      ['security.request', { change: { kind: 'plugin.off', plugin: 'gate' } }],
      ['core.stop', { plugin: 'search' }],
      ['core.restart', { plugin: 'search' }],
      ['security.cancel', { requestId: 'r1' }],
      ['core.quit', undefined],
    ])
  })
})
