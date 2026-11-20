import { afterEach, describe, expect, it } from 'vitest'
import { Refused } from '@hetu/sdk'
import { MAX_FIELDS_ASKED } from 'hetu-core/api/actions.ts'
import { type Clients, clientsOf, MAX_FIELDS } from '../src/clients.ts'

const made: Clients[] = []
afterEach(() => {
  for (const clients of made.splice(0)) clients.close()
})

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > ms) throw new Error('never held')
    await tick()
  }
}

type Holds = 'items' | 'none' | 'revoked'

// The core as the handler reaches it through core.consentAsk, core.consentAnswer and core.identities. Each connect
// waits for the test's answer. pair says what the core holds for a client: a connect for a client it holds is refused
// not-granted as the core refuses it
function fakeCore() {
  const asked: { client: string, name: string | null, redirect: string | null, field: string }[] = []
  const answers = new Map<string, 'waiting' | 'yes' | 'no' | 'gone'>()
  const pair = new Map<string, Holds>()
  const identities: string[][] = []
  let failing = false
  const call = async (name: string, args: unknown): Promise<unknown> => {
    if (failing) throw new Refused('unavailable', `core.${name}`)
    if (name === 'consentAsk') {
      const given = args as typeof asked[number]
      if (pair.has(given.field.slice(0, given.field.indexOf('#')))) throw new Refused('not-granted', 'core.consentAsk')
      asked.push(given)
      const handle = `h${asked.length}`
      answers.set(handle, 'waiting')
      return { handle }
    }
    if (name === 'consentAnswer') {
      const { handle } = args as { handle: string }
      const answer = answers.get(handle) ?? 'gone'
      if (answer !== 'waiting') answers.delete(handle)
      return { answer }
    }
    if (name === 'identities') {
      const { fields } = args as { fields: string[] }
      identities.push(fields)
      return fields.map(field => ({ field, holds: pair.get(field.split('#')[0]!) ?? 'none' }))
    }
    throw new Error(`no core.${name}`)
  }
  // The human's answer to the nth connect
  const answer = (n: number, given: 'yes' | 'no' | 'gone') => answers.set(`h${n}`, given)
  return { call, asked, pair, identities, answer, fail: () => { failing = true } }
}

function started(core = fakeCore()) {
  const clients = clientsOf({ call: core.call, answerEveryMs: 5, revokeEveryMs: 10 })
  made.push(clients)
  // A connection of the client with a close the transport gives, which records that it was closed
  const closed: string[] = []
  const join = async (client: string, name: string | null = 'Claude Code') => {
    let label = ''
    const joined = await clients.join(client, name, () => closed.push(label))
    if (joined !== null) label = joined.label
    return joined
  }
  return { core, clients, closed, join }
}

describe('a client joining', () => {
  it('keeps the core\'s own cap on the fields one core.identities asks about', () => {
    expect(MAX_FIELDS).toBe(MAX_FIELDS_ASKED)
  })

  it('connects a new client once the human confirms, with no redirect and the connection\'s label as the field', async () => {
    const { core, clients, join } = started()
    const joining = join('claude-code')
    await until(() => core.asked.length === 1)
    expect(core.asked).toEqual([{ client: 'claude-code', name: 'Claude Code', redirect: null, field: 'claude-code#1' }])
    await tick(20)
    expect(clients.connections()).toEqual([])
    core.answer(1, 'yes')
    expect(await joining).toMatchObject({ label: 'claude-code#1' })
    expect(clients.connections()).toEqual(['claude-code#1'])
  })

  it('refuses a client the human cancelled or never answered and keeps nothing of it', async () => {
    const { core, clients, join } = started()
    for (const [n, given] of [[1, 'no'], [2, 'gone']] as const) {
      const joining = join('claude-code')
      await until(() => core.asked.length === n)
      core.answer(n, given)
      expect(await joining).toBeNull()
    }
    expect(clients.connections()).toEqual([])
  })

  it('raises one connect for a client however many sessions join, before and after the Confirm, each with its own label', async () => {
    const { core, clients, join } = started()
    const first = join('claude-code')
    const second = join('claude-code')
    await until(() => core.asked.length === 1)
    await tick(20)
    core.answer(1, 'yes')
    expect([(await first)?.label, (await second)?.label]).toEqual(['claude-code#1', 'claude-code#2'])
    expect((await join('claude-code'))?.label).toBe('claude-code#3')
    expect(core.asked).toHaveLength(1)
    expect(clients.connections()).toEqual(['claude-code#1', 'claude-code#2', 'claude-code#3'])
  })

  it('raises a connect of its own for another client', async () => {
    const { core, join } = started()
    const one = join('claude-code')
    await until(() => core.asked.length === 1)
    core.answer(1, 'yes')
    await one
    const other = join('other-client', null)
    await until(() => core.asked.length === 2)
    expect(core.asked[1]).toEqual({ client: 'other-client', name: null, redirect: null, field: 'other-client#2' })
  })

  it('refuses a client id outside the label\'s form with no connect', async () => {
    const { core, join } = started()
    for (const client of ['', 'a#b', 'cl aude', 'x'.repeat(256), 'café']) expect(await join(client), client).toBeNull()
    expect(core.asked).toEqual([])
  })

  it('refuses when the core can\'t be reached', async () => {
    const { core, join } = started()
    core.fail()
    expect(await join('claude-code')).toBeNull()
  })
})

describe('a client the core holds already', () => {
  // The handler's process restarted while hetu kept running, so the core holds the client from before and refuses its
  // connect
  it('joins with no Confirm a client the core holds items or an ask for, its connect refused not-granted', async () => {
    for (const holds of ['items', 'none'] as const) {
      const { core, join } = started()
      core.pair.set('claude-code', holds)
      expect((await join('claude-code'))?.label, holds).toBe('claude-code#1')
      expect(core.identities).toEqual([['claude-code']])
      expect((await join('claude-code'))?.label).toBe('claude-code#2')
      expect(core.identities).toHaveLength(1)
    }
  })

  it('refuses a client the core holds as revoked', async () => {
    const { core, clients, join } = started()
    core.pair.set('claude-code', 'revoked')
    expect(await join('claude-code')).toBeNull()
    expect(await join('claude-code')).toBeNull()
    expect(clients.connections()).toEqual([])
  })
})

describe('a revoke', () => {
  it('closes every open connection of the client at the next poll, refuses its next session and leaves another client open', async () => {
    const { core, clients, closed, join } = started()
    core.pair.set('other-client', 'items')
    const first = join('claude-code')
    await until(() => core.asked.length === 1)
    core.answer(1, 'yes')
    await first
    await join('claude-code')
    await join('other-client')
    core.pair.set('claude-code', 'revoked')
    await until(() => closed.length === 2)
    expect(closed.sort()).toEqual(['claude-code#1', 'claude-code#2'])
    expect(clients.connections()).toEqual(['other-client#3'])
    expect(await join('claude-code')).toBeNull()
    expect(core.asked).toHaveLength(1)
  })

  it('asks the core about each client with an open connection once a poll and about nothing with none open', async () => {
    const { core, join } = started()
    core.pair.set('claude-code', 'items')
    const one = await join('claude-code')
    const two = await join('claude-code')
    core.identities.length = 0
    await until(() => core.identities.length >= 2)
    expect(core.identities.every(fields => fields.length === 1 && fields[0] === 'claude-code')).toBe(true)
    one!.leave()
    two!.leave()
    await tick(30)
    const asked = core.identities.length
    await tick(50)
    expect(core.identities.length).toBe(asked)
  })

  it('forgets a connection that left, so a revoke closes only those still open', async () => {
    const { core, clients, closed, join } = started()
    core.pair.set('claude-code', 'items')
    const one = await join('claude-code')
    await join('claude-code')
    one!.leave()
    expect(clients.connections()).toEqual(['claude-code#2'])
    core.pair.set('claude-code', 'revoked')
    await until(() => closed.length === 1)
    expect(closed).toEqual(['claude-code#2'])
  })
})
