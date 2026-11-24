import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { HeldRequest, ListedPlugin, SecurityList } from '../api/actions.ts'
import type { Capability } from '../api/capabilities.ts'
import { describeChange } from '../api/describe.ts'
import { limitNames, defaultLimits } from '../api/limits.ts'
import { connectChange } from '../backend/plugins-manager/connects.ts'
import { choiceChange, limitChange, screen, TrustedPage, type Screen } from '../frontend/trusted/view.ts'

const plugin = (over: Partial<ListedPlugin>): ListedPlugin => ({
  id: 'search', from: 'folder', place: 'sandboxed', state: 'ready', reason: null, security: false, on: true, items: [], class: 1,
  ...over,
})

const calm = (over: Partial<SecurityList> = {}): SecurityList => ({
  plugins: [],
  switches: { devMode: [], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false },
  limits: { all: {}, plugins: {} },
  luoshu: null,
  requests: [],
  identities: [],
  stopped: null,
  ...over,
})

// The body of the first rule in a stylesheet whose selector starts a line as written, empty for none
function ruleIn(css: string, selector: string): string {
  return css.match(new RegExp(`(?:^|\\n)${selector.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[^{]*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('what the trusted window draws', () => {
  it('shows the oldest request first and counts the ones behind it', () => {
    const drawn = screen(calm({
      requests: [
        { id: 'r1', kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', notes: ['n'], type: 'gate', root: null, field: null },
        { id: 'r2', kind: 'confirmOff', plugin: null, text: 'Apply changes made in this window without a Confirm', notes: [], type: null, root: null, field: null },
      ],
    }))
    expect(drawn.request).toMatchObject({ id: 'r1', text: 'Switch gate off', type: 'gate' })
    expect(drawn.behind).toBe(1)
  })

  it('names a plugin by its id with where it runs, its state and why, and a plugin-folder plugin’s class', () => {
    const drawn = screen(calm({
      plugins: [
        plugin({ id: 'gate', from: 'core', place: 'core', security: true, class: null }),
        plugin({ id: 'history', from: 'core', place: 'core', state: 'failed', reason: 'start-failed', class: null }),
        plugin({ state: 'crashed', reason: 'flood' }),
        plugin({ id: 'tool', class: null }),
      ],
    }))
    expect(drawn.plugins.map(row => row.line)).toEqual([
      'gate · ships with hetu · core · ready · security',
      'history · ships with hetu · core · failed (start-failed)',
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
    expect(actions({ id: 'layout' })).toEqual(['switch-off', 'stop', 'reset', 'remove'])
    // A core module has its switch alone, failed or not: nothing restarts it and Recover doesn't reset it
    expect(actions({ from: 'core', place: 'core', id: 'luoshu', class: null })).toEqual(['switch-off'])
    expect(actions({ from: 'core', place: 'core', id: 'luoshu', state: 'failed', reason: 'start-failed', class: null })).toEqual(['switch-off'])
    expect(actions({ from: 'core', place: 'core', id: 'gate', state: 'off', on: false, security: true, class: null })).toEqual(['switch-on'])
  })

  // A utility half stops and restarts within a run, so a human who freed the port it failed on brings it back here
  it('offers a utility half Stop while it runs and Restart once it stopped, crashed or failed, drawing why', () => {
    const http = (over: Partial<ListedPlugin>) => plugin({ id: 'mcp-http-handler', from: 'door', place: 'utility', class: null, ...over })
    const actions = (over: Partial<ListedPlugin>) => screen(calm({ plugins: [http(over)] })).plugins[0].actions
    expect(actions({})).toEqual(['switch-off', 'stop', 'reset'])
    expect(actions({ state: 'starting' })).toEqual(['switch-off', 'stop', 'reset'])
    expect(actions({ state: 'failed', reason: 'port-taken' })).toEqual(['switch-off', 'restart', 'reset'])
    expect(actions({ state: 'crashed', reason: 'unresponsive' })).toEqual(['switch-off', 'restart', 'reset'])
    expect(actions({ state: 'stopped', reason: 'human' })).toEqual(['switch-off', 'restart', 'reset'])
    expect(actions({ on: false, state: 'off' })).toEqual(['switch-on', 'reset'])
    const drawn = screen(calm({ plugins: [http({ state: 'failed', reason: 'port-taken' })] }))
    expect(drawn.plugins[0].line).toBe('mcp-http-handler · ships with hetu · utility · failed (port-taken)')
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
      { line: 'Read all your notes · on', on: true },
      { line: 'Read the notes at "notes/**" · off · other grants of the same kind still on may reach the same notes', on: false },
      { line: 'Keep data of its own · asks at first use', on: false },
    ])
  })

  it('gives each switch for all of hetu its state and the change its button asks for', () => {
    expect(screen(calm()).switches).toEqual([
      { line: 'Confirm off for this window: off', change: { kind: 'confirmOff', on: true } },
    ])
    const drawn = screen(calm({
      switches: { devMode: ['search'], execAnyCommand: ['git'], skipVerification: true, allowUnsigned: ['a'.repeat(64)], confirmOff: true },
    }))
    expect(drawn.switches).toEqual([
      { line: 'Confirm off for this window: on', change: { kind: 'confirmOff', on: false } },
      { line: 'any command: git', change: null },
    ])
  })

  // Dev mode is a group of settings, not a part of its own: which plugins load unhashed, the hash checks skipped and the
  // unsigned builds trusted
  it('draws a Dev group with each folder plugin\'s dev mode, the hash checks skipped and the unsigned builds trusted', () => {
    expect(screen(calm({ plugins: [plugin({ id: 'search' }), plugin({ id: 'gate', from: 'core', place: 'core', security: true, class: null })] })).dev).toEqual([
      { line: 'Verification skipped: off', change: { kind: 'skipVerification', on: true } },
      { line: 'dev mode for search: off', change: { kind: 'devMode', plugin: 'search', on: true } },
    ])
    const drawn = screen(calm({
      plugins: [plugin({ id: 'search' })],
      switches: { devMode: ['search'], execAnyCommand: [], skipVerification: true, allowUnsigned: ['a'.repeat(64)], confirmOff: false },
    }))
    expect(drawn.dev).toEqual([
      { line: 'Verification skipped: on', change: { kind: 'skipVerification', on: false } },
      { line: 'dev mode for search: on', change: { kind: 'devMode', plugin: 'search', on: false } },
      { line: 'unsigned builds trusted: 1', change: null },
    ])
  })

  // With the security view off nothing asks for a control's typed word, so no control's switch can be pressed off
  it('draws each security control locked while the security view is off, and the view itself with its switch', () => {
    const drawn = screen(calm({
      plugins: [
        plugin({ id: 'gate', from: 'core', place: 'core', security: true, class: null }),
        plugin({ id: 'security-view', from: 'core', place: 'core', security: true, class: null, on: false, state: 'off', reason: 'off' }),
        plugin({ id: 'storage', from: 'core', place: 'core', class: null }),
      ],
    }))
    expect(drawn.plugins.map(row => [row.id, row.actions])).toEqual([['gate', []], ['security-view', ['switch-on']], ['storage', ['switch-off']]])
    expect(drawn.plugins[0].line).toContain('locked while the security view is off')
    const on = screen(calm({ plugins: [plugin({ id: 'gate', from: 'core', place: 'core', security: true, class: null })] }))
    expect(on.plugins[0].actions).toEqual(['switch-off'])
  })

  it('says the heartbeat\'s off waits for a Confirm, though it is no security control', () => {
    const drawn = screen(calm({ plugins: [plugin({ id: 'heartbeat', from: 'core', place: 'core', class: null }), plugin({ id: 'storage', from: 'core', place: 'core', class: null })] }))
    expect(drawn.plugins[0].line).toBe('heartbeat · ships with hetu · core · ready · its off waits for a Confirm')
    expect(drawn.plugins[1].line).toBe('storage · ships with hetu · core · ready')
  })

  it('says the macOS install is not protected from programs running as the human', () => {
    expect(screen(calm()).installNote).toBe('On macOS, programs running as you can change hetu’s install')
  })

  it('names the notes folder, or says none is picked', () => {
    expect(screen(calm()).luoshu).toBe('Notes folder: none picked')
    expect(screen(calm({ luoshu: '/Users/someone/notes' })).luoshu).toBe('Notes folder: /Users/someone/notes')
  })

  it('gives a plugin holding exec its any command switch, its dev mode drawn in the Dev group', () => {
    const exec = { type: 'exec', commands: [['git', 'status']], env: [] } as unknown as ListedPlugin['items'][number]['capability']
    const drawn = screen(calm({
      plugins: [
        plugin({ id: 'search' }),
        plugin({ id: 'git', items: [{ capability: exec, off: false, firstUse: false }] }),
        plugin({ id: 'gate', from: 'core', place: 'core', security: true, class: null }),
      ],
      switches: { devMode: ['search'], execAnyCommand: [], skipVerification: false, allowUnsigned: [], confirmOff: false },
    }))
    expect(drawn.plugins.map(row => row.switches)).toEqual([
      [],
      [{ line: 'any command: off', change: { kind: 'exec.anyCommand', plugin: 'git', on: true } }],
      [],
    ])
  })

  it('lists each limit with the fixed value and the values set for all and for each plugin', () => {
    const drawn = screen(calm({ limits: { all: { readyMs: 20000 }, plugins: { search: { readyMs: 5000, callsInFlight: 8 } } } }))
    expect(drawn.limits.map(limit => limit.constant)).toEqual(limitNames)
    expect(drawn.limits.find(limit => limit.constant === 'readyMs')).toEqual({
      constant: 'readyMs', fixed: defaultLimits.readyMs, all: 20000, plugins: [{ plugin: 'search', value: 5000 }],
    })
    expect(drawn.limits.find(limit => limit.constant === 'callsInFlight')).toEqual({
      constant: 'callsInFlight', fixed: defaultLimits.callsInFlight, all: null, plugins: [{ plugin: 'search', value: 8 }],
    })
  })

  it('turns what the human typed for a limit into its change, or nothing for what isn’t a positive whole number', () => {
    expect(limitChange('readyMs', '20000', null)).toEqual({ kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: null })
    expect(limitChange('callsInFlight', ' 8 ', 'search')).toEqual({ kind: 'limit.set', constant: 'callsInFlight', value: 8, plugin: 'search' })
    for (const typed of ['', '0', '-5', '1.5', '1e3', 'ten', '99999999999999999999']) expect(limitChange('readyMs', typed, null)).toBeNull()
  })

  it('draws the field in an ask\'s heading as a part of its own and every other heading whole', () => {
    const asked: Omit<HeldRequest, 'text' | 'root' | 'field'> = { id: 'r1', kind: 'identity.ask', plugin: 'mcp', notes: [], type: null }
    const label = `https://claude.ai/${'a'.repeat(200)}#12`
    expect(screen(calm({ requests: [{ ...asked, text: `Give "${label}" under mcp-http-handler what it asks for through mcp`, root: 'mcp-http-handler', field: label }] })).request!.heading).toEqual([
      { text: 'Give ', label: false }, { text: `"${label}"`, label: true }, { text: ' under mcp-http-handler what it asks for through mcp', label: false },
    ])
    expect(screen(calm({ requests: [{ ...asked, kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', root: null, field: null }] })).request!.heading)
      .toEqual([{ text: 'Switch gate off', label: false }])
    // A field the text doesn't hold leaves the text whole, so nothing is drawn twice or out of order
    expect(screen(calm({ requests: [{ ...asked, text: 'Give "a#1" under mcp-http-handler what it asks for through mcp', root: 'mcp-http-handler', field: 'b#1' }] })).request!.heading)
      .toEqual([{ text: 'Give "a#1" under mcp-http-handler what it asks for through mcp', label: false }])
  })

  it('gives an ask for a pair\'s items a third button that revokes the pair its heading shows and gives any other request none', () => {
    const asked: HeldRequest = {
      id: 'r1', kind: 'identity.ask', plugin: 'mcp', notes: [], type: null, text: 'Give "client#2" under mcp-http-handler what it asks for through mcp', root: 'mcp-http-handler', field: 'client#2',
    }
    const drawn = screen(calm({ requests: [asked], identities: [{ root: 'mcp-http-handler', field: 'client#1', items: [{ type: 'luoshu.read', paths: ['**'] }], revoked: false }] }))
    expect(drawn.request!.heading.find(part => part.label)!.text).toBe('"client#2"')
    expect(drawn.request!.revoke).toEqual({ kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client#2' })
    expect(screen(calm({ requests: [{ ...asked, kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', root: null, field: null }] })).request!.revoke).toBeNull()
  })

  it('draws a connect from the core\'s words, the label it gets apart at the heading\'s end, with Confirm and Cancel alone', () => {
    const label = 'https://claude.ai/oauth/claude-code-client-metadata#3'
    const connect = describeChange(connectChange({ client: label.slice(0, -2), name: 'Claude Code', redirect: 'http://localhost:33418/callback', field: label }, 'mcp-http-handler')!)
    const held: HeldRequest = { id: 'r1', kind: 'consent.ask', plugin: 'mcp-http-handler', notes: connect.notes, type: null, text: connect.text, root: 'mcp-http-handler', field: label }
    const drawn = screen(calm({ requests: [held] })).request!
    expect(drawn.heading).toEqual([
      { text: 'Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", through mcp-http-handler as ', label: false },
      { text: JSON.stringify(label), label: true },
    ])
    expect(drawn.notes).toEqual(connect.notes)
    expect(drawn.revoke).toBeNull()
  })

  it('draws a connect with no redirect as a program on this computer, the label still apart at the heading\'s end', () => {
    const connect = describeChange(connectChange({ client: 'claude-code', name: 'Claude Code', redirect: null, field: 'claude-code#1' }, 'mcp-http-handler')!)
    const held: HeldRequest = { id: 'r1', kind: 'consent.ask', plugin: 'mcp-http-handler', notes: connect.notes, type: null, text: connect.text, root: 'mcp-http-handler', field: 'claude-code#1' }
    expect(screen(calm({ requests: [held] })).request!.heading).toEqual([
      { text: 'Connect the client "claude-code" named "Claude Code", a program on this computer reaching hetu over the local pipe, through mcp-http-handler as ', label: false },
      { text: '"claude-code#1"', label: true },
    ])
  })

  it('draws apart the label at a connect\'s end and not a name that reads as the label', () => {
    const connect = describeChange(connectChange({ client: 'client', name: 'client#3', redirect: 'http://127.0.0.1:5000/cb', field: 'client#3' }, 'mcp-http-handler')!)
    const held: HeldRequest = { id: 'r1', kind: 'consent.ask', plugin: 'mcp-http-handler', notes: [], type: null, text: connect.text, root: 'mcp-http-handler', field: 'client#3' }
    expect(screen(calm({ requests: [held] })).request!.heading).toEqual([
      { text: 'Connect the client "client" named "client#3", which returns to "127.0.0.1:5000", through mcp-http-handler as ', label: false },
      { text: '"client#3"', label: true },
    ])
  })

  it('finds a stylesheet rule by its selector as written, a backslash and every other metacharacter in it taken as text', () => {
    expect(ruleIn('.a:b { x: 1; }\n', '.a\\:b')).toBe('')
    expect(ruleIn('.a\\:b { x: 1; }\n', '.a\\:b')).toBe(' x: 1; ')
    expect(ruleIn('.aab { x: 1; }\n', '.a+b')).toBe('')
    expect(ruleIn('.a+b { x: 1; }\n', '.a+b')).toBe(' x: 1; ')
    expect(ruleIn('xlabel { x: 1; }\n', '.label')).toBe('')
  })

  // The page's own stylesheet, which the trusted window's policy lets load from its own origin and nothing else
  it('draws a label in a fixed-width face the system has and wraps it and the lines holding it anywhere', async () => {
    const css = await readFile(new URL('../frontend/trusted/trusted.css', import.meta.url), 'utf8')
    const rule = (selector: string) => ruleIn(css, selector)
    expect(rule('.label')).toMatch(/font-family:[^;]*\bmonospace;/)
    expect(rule('.label')).toMatch(/overflow-wrap: anywhere;/)
    expect(css).toMatch(/\.request h1,\s*\.identity \{\s*overflow-wrap: anywhere;/)
    expect(css).not.toMatch(/@font-face|url\(/)
  })

  it('quotes each target, topic and variable in a plugin\'s items and a pair\'s', () => {
    const items: Capability[] = [
      { type: 'plugin.call', targets: ['notes'] }, { type: 'events.subscribe', topics: ['notes.saved'] }, { type: 'exec', commands: [['git', 'status']], env: ['HOME'] },
    ]
    const drawn = screen(calm({
      plugins: [plugin({ items: items.map(capability => ({ capability, off: false, firstUse: false })) })],
      identities: [{ root: 'mcp-http-handler', field: 'client#1', items: [items[0]], revoked: false }],
    }))
    expect(drawn.plugins[0].items.map(item => item.line)).toEqual([
      'Call the plugin "notes" · on', 'Hear the events "notes.saved" · on', 'Run the command ["git","status"] outside the sandbox with your rights on this computer, with "HOME" from your environment · on',
    ])
    expect(drawn.identities.rows[0].line).toContain('Call the plugin "notes"')
  })

  it('lists each pair by its field in quotes under its root plugin with its items and a Revoke, a revoked one with no button, then what the list holds', () => {
    const drawn = screen(calm({
      identities: [
        { root: 'mcp-http-handler', field: 'client#1', items: [{ type: 'luoshu.read', paths: ['inbox/**'] }, { type: 'luoshu.write', paths: ['say "hi"/**'] }], revoked: false },
        { root: 'mcp-http-handler', field: 'https://claude.ai/oauth/claude-code-client-metadata#3', items: [], revoked: true },
      ],
    }))
    expect(drawn.identities).toEqual({
      rows: [
        {
          label: '"client#1"', line: ' under mcp-http-handler · Read the notes at "inbox/**" · Create, change, move and delete the notes at "say \\"hi\\"/**"',
          change: { kind: 'identity.revoke', root: 'mcp-http-handler', field: 'client#1' },
        },
        { label: '"https://claude.ai/oauth/claude-code-client-metadata#3"', line: ' under mcp-http-handler · revoked until hetu quits', change: null },
      ],
      about: 'Each is the field a plugin sets on the calls it makes for one of its clients, under that plugin. What it holds and a revoke last until hetu quits',
    })
    expect(screen(calm()).identities.rows).toEqual([])
  })

  it('has no word agent in what the trusted window draws of its own', () => {
    const drawn = screen(calm({ identities: [{ root: 'beta', field: 'f', items: [], revoked: true }] }))
    const words = JSON.stringify(drawn.identities)
    expect(words).not.toMatch(/\bagents?\b/i)
  })

  describe('the stopped mode', () => {
    // A core module that fails stops nothing, so only the log and the install list stop hetu
    it('sends the human to the installer for an install list that doesn’t check out, with Quit alone', () => {
      const drawn = screen(calm({ stopped: { control: 'install', why: 'tampered', reason: 'tampered', again: true } }))
      expect(drawn.stopped).toEqual({
        control: 'install',
        lines: [
          'hetu stopped: its install list doesn’t check out',
          'hetu already started again once after a failure, so it didn’t start again on its own',
          'Repair hetu with its installer to get its files back',
        ],
        choices: ['quit'],
      })
    })

    it('offers Try again, Start with it switched off and Quit for a control that judges yes or no and failed at start', () => {
      const drawn = screen(calm({ stopped: { control: 'gate', why: 'start-failed', reason: 'state-changed', again: false } }))
      expect(drawn.stopped).toEqual({
        control: 'gate',
        lines: [
          'hetu stopped: gate failed at start',
          'Try again starts hetu again, for a failure that has passed',
          'Start with it switched off runs hetu with gate off until you switch it on, after its Confirm and its name typed',
        ],
        choices: ['retry', 'switch-off', 'quit'],
      })
      expect(choiceChange('gate', 'switch-off')).toEqual({ kind: 'plugin.off', plugin: 'gate' })
      expect(choiceChange('gate', 'retry')).toBe(null)
    })

    it('turns each choice into the change it asks for', () => {
      expect(choiceChange('log', 'switch-off')).toEqual({ kind: 'plugin.off', plugin: 'recording' })
      expect(choiceChange('log', 'quit')).toBe(null)
      expect(choiceChange('install', 'quit')).toBe(null)
    })

    it('offers to stop recording for a log that can’t write, and nothing to recover', () => {
      const drawn = screen(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: true } }))
      expect(drawn.stopped).toEqual({
        control: 'log',
        lines: [
          'hetu stopped: the event log can’t write',
          'hetu already started again once after a failure, so it didn’t start again on its own',
          'Free space or fix the data folder’s permissions, or stop recording to start without the log',
        ],
        choices: ['switch-off', 'quit'],
      })
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

  // Main asks for the folder its dialog picked, since closing the dialog restarts the window's input delay and a request
  // the page sent then would count for nothing
  it('picks a folder through main’s dialog, which asks for it as luoshu.pick, and sends no request of its own', () => {
    const { sent, page, hears } = started()
    page.pickFolder()
    expect(sent.at(-1)).toMatchObject({ action: 'app.pickFolder' })
    hears(replyTo(sent.at(-1)!, null))
    expect(sent.at(-1)).toMatchObject({ action: 'app.pickFolder' })
    page.pickFolder()
    hears(replyTo(sent.at(-1)!, { held: 'r1' }))
    expect(sent.map(message => message.action)).not.toContain('security.request')
    expect(sent.at(-1)).toMatchObject({ action: 'security.list' })
  })

  it('starts hetu again once a folder picked in the stopped mode applied at once', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))
    page.pickFolder()
    hears(replyTo(sent.at(-1)!, { applied: true }))
    expect(sent.map(message => message.action)).toContain('app.relaunch')
  })

  // A request answers throttled both inside the input delay and when its sender's places are full
  it('says a refused request came too soon while the delay since the window gained focus runs, else that too many wait', () => {
    let inDelay = true
    const made = bridge()
    const drawn: { screen: Screen, note: string | null }[] = []
    const page = new TrustedPage(made.bridge, (shown, note) => drawn.push({ screen: shown, note }), () => inDelay)
    page.start()
    made.hears(replyTo(made.sent[1], calm()))
    for (const [delayRuns, note] of [
      [true, 'Too soon after the window showed or gained focus. Wait a moment, then ask again'],
      [false, 'Too many requests are waiting. Answer or cancel some first'],
    ] as const) {
      inDelay = delayRuns
      page.ask({ kind: 'skipVerification', on: true })
      made.hears(refuse(made.sent.at(-1)!, 'throttled'))
      made.hears(replyTo(made.sent.at(-1)!, calm()))
      expect(drawn.at(-1)?.note).toBe(note)
    }
  })

  it('draws one tab at a time, Plugins first, and keeps the tab picked across answers', () => {
    const { page, hears, sent, drawn } = started(calm({ plugins: [plugin({ id: 'layout', items: [{ capability: { type: 'ui.layout' }, off: false, firstUse: false }] })] }))
    expect(drawn.at(-1)?.screen.tab).toBe('plugins')
    expect(drawn.at(-1)?.screen.tabs.map(tab => tab.label)).toEqual(['Get started', 'Plugins', 'Switches', 'Notes folder', 'Identities', 'Limits'])
    const before = sent.length
    page.pickTab('limits')
    expect(drawn.at(-1)?.screen.tab).toBe('limits')
    // Picking a tab asks the core for nothing
    expect(sent.length).toBe(before)
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 4 })
    hears(replyTo(sent.at(-1)!, calm({ plugins: [plugin({ id: 'layout', items: [{ capability: { type: 'ui.layout' }, off: false, firstUse: false }] })] })))
    expect(drawn.at(-1)?.screen.tab).toBe('limits')
  })

  it('marks the Plugins tab with how many plugins wait for the human', () => {
    const marks = (list: SecurityList) => screen(list).tabs.map(tab => tab.mark)
    expect(marks(calm())).toEqual([null, null, null, null, null, null])
    const waiting = calm({
      plugins: [
        plugin({ id: 'new-one', state: 'found', reason: 'new', on: false }),
        plugin({ id: 'broke', state: 'crashed', reason: 'flood' }),
        plugin({ id: 'fine' }),
      ],
    })
    expect(marks(waiting)).toEqual([null, '2 waiting', null, null, null, null])
  })

  // A request waiting for its Confirm is drawn above whichever tab is picked, so none sits unseen on a tab not shown
  it('draws a request waiting for its Confirm whatever tab is picked', () => {
    const { page, hears, sent, drawn } = started()
    page.pickTab('identities')
    hears({ v: 1, kind: 'event', topic: 'core.security', seq: 4 })
    hears(replyTo(sent.at(-1)!, calm({ requests: [{ id: 'r1', kind: 'plugin.off', plugin: 'gate', text: 'Switch gate off', notes: [], type: 'gate', root: null, field: null }] })))
    expect(drawn.at(-1)?.screen.tab).toBe('identities')
    expect(drawn.at(-1)?.screen.request).not.toBeNull()
  })

  it('asks for a limit as a request, which waits for the Confirm', () => {
    const { sent, page } = started()
    page.ask(limitChange('readyMs', '20000', 'search')!)
    expect(sent.at(-1)).toMatchObject({ action: 'security.request', args: { change: { kind: 'limit.set', constant: 'readyMs', value: 20000, plugin: 'search' } } })
  })

  // With confirmOff on a choice applied through the request and hetu stayed stopped
  it('starts hetu again once a choice in the stopped mode applied at once', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))
    page.ask({ kind: 'plugin.off', plugin: 'recording' })
    hears(replyTo(sent[2], { applied: true }))
    expect(sent.map(message => message.action)).toContain('app.relaunch')
  })

  it('starts nothing again for a choice that waits for its Confirm', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))
    page.ask({ kind: 'plugin.off', plugin: 'recording' })
    hears(replyTo(sent[2], { held: 'r1' }))
    expect(sent.map(message => message.action)).not.toContain('app.relaunch')
  })

  it('says when too many requests wait, apart from a Confirm sent too soon', () => {
    const { sent, page, hears, drawn } = started()
    page.ask({ kind: 'confirmOff', on: true })
    hears(refuse(sent[2], 'throttled'))
    hears(replyTo(sent.at(-1)!, calm()))
    expect(drawn.at(-1)?.note).toBe('Too many requests are waiting. Answer or cancel some first')
  })

  it('starts hetu again once a choice in the stopped mode applied', () => {
    const { sent, page, hears } = started(calm({ stopped: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }))
    page.confirm('r1', 'gate')
    hears(replyTo(sent[2], null))
    expect(sent.map(message => message.action)).toContain('app.relaunch')
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
      ['app.quit', undefined],
    ])
  })
})
