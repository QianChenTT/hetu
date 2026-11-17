import { describe, expect, it } from 'vitest'
import { coreActions } from '../api/actions.ts'
import {
  agentConnect, change, changeEffect, changeKinds, connectLabel, lapseOf, MAX_CLIENT_NAME_LENGTH, mustType, withdrawnWith, type AgentConnect,
} from '../api/changes.ts'
import { describeChange } from '../api/describe.ts'
import { connectChange } from '../backend/loader/connects.ts'

const CLAUDE = 'https://claude.ai/oauth/claude-code-client-metadata'
const ch = (code: number) => String.fromCharCode(code)
// Shalom in Hebrew letters, written right to left
const HEBREW = [0x5e9, 0x5dc, 0x5d5, 0x5dd].map(ch).join('')
const asked = { client: CLAUDE, name: 'Claude Code', redirect: 'http://localhost:33418/callback', number: 3 }
const built = (over: Partial<typeof asked> | { name: string | null } = {}) => connectChange({ ...asked, ...over })
const words = (over: Partial<typeof asked> | { name: string | null } = {}) => describeChange(built(over)!)

describe('the agent.connect kind', () => {
  const connect: AgentConnect = {
    kind: 'agent.connect', plugin: 'http', client: CLAUDE, clientHost: 'claude.ai', name: 'Claude Code', redirect: 'http://localhost:33418/callback',
    redirectHost: 'localhost:33418', number: 3,
  }

  it('is no change a window may send nor one security.request carries', () => {
    expect(agentConnect.parse(connect)).toEqual(connect)
    expect(change.safeParse(connect).success).toBe(false)
    expect(changeKinds).not.toContain('agent.connect')
    expect(coreActions['security.request'].args.safeParse({ change: connect }).success).toBe(false)
  })

  it('widens with nothing to type, lapses a minute after it was raised and goes when http stops', () => {
    expect(changeEffect(connect)).toBe('widens')
    expect(mustType(connect)).toBeNull()
    expect(lapseOf(connect)).toBe(60_000)
    expect(withdrawnWith(connect)).toEqual(['http'])
  })

  it('makes the label from the client id and the number in the agent label\'s form', () => {
    expect(connectLabel(connect)).toBe(`${CLAUDE}#3`)
    expect(connectLabel({ client: 'client', number: 120 })).toBe('client#120')
    expect(agentConnect.safeParse({ ...connect, client: 'client', number: 999_999_999_999_999 }).success).toBe(true)
    for (const over of [
      { client: '' }, { client: 'a#b' }, { client: 'a b' }, { client: 'x'.repeat(256) }, { client: `kl${ch(0x131)}ent` }, { number: 0 }, { number: -1 },
      { number: 1.5 }, { number: 1_000_000_000_000_000 },
    ]) expect(agentConnect.safeParse({ ...connect, ...over }).success, JSON.stringify(over)).toBe(false)
  })

  it('refuses a field it does not name', () => {
    expect(agentConnect.safeParse({ ...connect, handle: 'h' }).success).toBe(false)
    expect(agentConnect.safeParse({ ...connect, plugin: 'mcp' }).success).toBe(false)
  })
})

describe('the connect as the core builds it from what http sends', () => {
  it('takes the host of a client id that is a URL and of the redirect, with the port where one is named', () => {
    expect(built()).toEqual({
      kind: 'agent.connect', plugin: 'http', client: CLAUDE, clientHost: 'claude.ai', name: 'Claude Code', redirect: 'http://localhost:33418/callback',
      redirectHost: 'localhost:33418', number: 3,
    })
    expect(built({ client: 'https://Claude.AI:443/doc?x=1', redirect: 'http://[::1]:5000/cb' })).toMatchObject({ clientHost: 'claude.ai', redirectHost: '[::1]:5000' })
  })

  it('has no host for a client id that is not a URL with one', () => {
    for (const client of ['my-client', 'urn:ietf:client', '7c4d0c1e-5b1d-4d7e-9a8a-1d0f5a1b2c3d']) expect(built({ client })?.clientHost).toBeNull()
  })

  it('refuses a client id or a redirect with user info, a redirect with no host and one that is no URL', () => {
    expect(built({ redirect: 'http://claude.ai@localhost:33418/callback' })).toBeNull()
    expect(built({ redirect: 'http://user:pass@localhost/cb' })).toBeNull()
    expect(built({ client: 'https://claude.ai@evil.example/doc' })).toBeNull()
    expect(built({ redirect: 'com.example.app:/callback' })).toBeNull()
    expect(built({ redirect: 'localhost/callback' })).toBeNull()
  })

  it('refuses a client id and a number that make no label', () => {
    expect(built({ client: 'a#b' })).toBeNull()
    expect(built({ number: 0 })).toBeNull()
    expect(built({ client: '' })).toBeNull()
  })

  it('takes a name with a quote and right-to-left letters and one at the length cap', () => {
    expect(built({ name: 'say "yes"' })?.name).toBe('say "yes"')
    expect(built({ name: HEBREW })?.name).toBe(HEBREW)
    expect(built({ name: 'n'.repeat(MAX_CLIENT_NAME_LENGTH) })?.name).toHaveLength(MAX_CLIENT_NAME_LENGTH)
    expect(built({ name: null })?.name).toBeNull()
  })

  it('refuses a name past the cap, empty or with a control, bidi, zero width or line separator character', () => {
    for (const name of [
      'n'.repeat(MAX_CLIENT_NAME_LENGTH + 1), '', 'Claude\nCode', `Claude${ch(0x7)}`, `abc${ch(0x202e)}doc.exe`, `Cl${ch(0x2066)}aude`,
      `Cla${ch(0x200b)}ude`, `Claude${ch(0x200d)}`, `Claude${ch(0xfeff)}`, `Claude${ch(0x2028)}Code`, `Claude${ch(0xad)}`, `Claude${ch(0xd800)}`,
    ]) expect(built({ name }), JSON.stringify(name)).toBeNull()
  })
})

describe('the words of a connect', () => {
  const FIXED = [
    'Any program on this computer can connect under that client id and that name, so confirm only a connect you started just now',
    'It reaches no note yet. It asks for items later and each ask waits for your Confirm',
  ]

  it('names the client id\'s host first, then the name, the redirect\'s host and the label in quotes, then the two fixed lines', () => {
    expect(words()).toEqual({
      text: `Connect the client from "claude.ai" named "Claude Code", which returns to "localhost:33418", as the agent "${CLAUDE}#3"`,
      notes: FIXED,
    })
  })

  it('names a client id that is not a URL whole in quotes, then the rest in the same order', () => {
    expect(words({ client: 'my-client', number: 12 })).toEqual({
      text: 'Connect the client "my-client" named "Claude Code", which returns to "localhost:33418", as the agent "my-client#12"',
      notes: FIXED,
    })
  })

  it('says a client gives no name', () => {
    expect(words({ name: null }).text).toBe(`Connect the client from "claude.ai" with no name, which returns to "localhost:33418", as the agent "${CLAUDE}#3"`)
  })

  it('escapes a quote in the name, so it can\'t close its quotes and read as the core\'s words', () => {
    const { text } = words({ name: 'x", which returns to "claude.ai' })
    expect(text).toBe(`Connect the client from "claude.ai" named "x\\", which returns to \\"claude.ai", which returns to "localhost:33418", as the agent "${CLAUDE}#3"`)
  })

  it('shows right-to-left letters inside their quotes', () => {
    expect(words({ name: HEBREW }).text).toContain(`named "${HEBREW}", which`)
  })

  it('shows the redirect\'s host and never its user info or path', () => {
    const { text } = words({ redirect: 'http://127.0.0.1:8080/claude.ai/callback?to=evil.example' })
    expect(text).toContain('which returns to "127.0.0.1:8080", as')
    expect(text).not.toContain('evil')
    expect(text).not.toContain('/callback')
  })

  it('quotes every value from outside the core: the host, the name, the redirect\'s host and the label', () => {
    const { text } = words()
    for (const value of ['claude.ai', 'Claude Code', 'localhost:33418', `${CLAUDE}#3`]) expect(text).toContain(JSON.stringify(value))
    expect(text.replaceAll(/"(?:[^"\\]|\\.)*"/g, '')).toBe('Connect the client from  named , which returns to , as the agent ')
  })

  it('has the label in quotes as the last thing in its heading, the one place the trusted window draws it apart', () => {
    const label = JSON.stringify(`${CLAUDE}#3`)
    const { text } = words({ name: `${CLAUDE}#3` })
    expect(text.endsWith(` as the agent ${label}`)).toBe(true)
    expect(text.lastIndexOf(label)).toBe(text.length - label.length)
  })
})
