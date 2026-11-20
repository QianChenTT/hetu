import { Refused } from '@hetu/sdk'
import { labelOk } from './checks.ts'

// The clients that reach mcp over a transport with no token, a local pipe: each connection gets a label of its own,
// the client's id, # and a number counted for the run of this half, which its calls carry as the field. The human
// confirms a client once a run, so its later sessions join with no connect of their own. Revoking the client in the
// trusted window closes every open connection it has at the next poll

// core.identities' own cap on the fields one call asks about
export const MAX_FIELDS = 64

// A core action by its name in the core namespace, with its args
export type CoreCall = (name: string, args: unknown) => Promise<unknown>

export type ClientsOptions = { call: CoreCall, answerEveryMs?: number, revokeEveryMs?: number }

// A connection that joined: its label and how the transport tells the table that it closed
export type Joined = { label: string, leave(): void }

export type Clients = {
  // Joins a connection of the client, the connect raised first when the client isn't confirmed in this run. null for a
  // client refused. close is how a revoke ends the connection
  join(client: string, name: string | null, close: () => void): Promise<Joined | null>
  // The labels of the open connections, in the order they joined
  connections(): string[]
  close(): void
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function clientsOf(options: ClientsOptions): Clients {
  const { call } = options
  const answerEveryMs = options.answerEveryMs ?? 500
  const revokeEveryMs = options.revokeEveryMs ?? 3000
  let count = 0
  let closed = false
  // The clients the human confirmed or turned away in this run, the connect still waiting for each client asking
  const confirmed = new Set<string>()
  const revoked = new Set<string>()
  const connecting = new Map<string, Promise<boolean>>()
  // Each open connection by its label
  const open = new Map<string, { client: string, close: () => void }>()

  // The human's answer to a connect, collected until it is no longer waiting. A lapsed or withdrawn connect is gone
  const answered = async (handle: string): Promise<boolean> => {
    while (!closed) {
      const { answer } = await call('consentAnswer', { handle }) as { answer: string }
      if (answer !== 'waiting') return answer === 'yes'
      await wait(answerEveryMs)
    }
    return false
  }

  // The core refuses a connect for a client it holds already: one this half connected before it restarted, holding
  // items or an ask, or one the human revoked. Only a revoked one stays out
  const held = async (client: string): Promise<boolean> => {
    const [one] = await call('identities', { fields: [client] }) as { holds: string }[]
    if (one?.holds !== 'revoked') return true
    revoked.add(client)
    return false
  }

  const connect = async (client: string, name: string | null, field: string): Promise<boolean> => {
    try {
      const { handle } = await call('consentAsk', { client, name, redirect: null, field }) as { handle: string }
      return await answered(handle)
    } catch (error) {
      return error instanceof Refused && error.code === 'not-granted' ? await held(client).catch(() => false) : false
    }
  }

  // Each client with an open connection asked about at once. A revoked one is turned away for the run and every
  // connection it has closed
  const poll = async () => {
    const clients = [...new Set([...open.values()].map(one => one.client))].slice(0, MAX_FIELDS)
    if (clients.length === 0) return
    const holds = await call('identities', { fields: clients }) as { field: string, holds: string }[]
    for (const { field, holds: what } of holds) {
      if (what !== 'revoked') continue
      revoked.add(field)
      confirmed.delete(field)
      for (const [label, one] of open) {
        if (one.client !== field) continue
        open.delete(label)
        one.close()
      }
    }
  }
  let polling = false
  const timer = setInterval(() => {
    if (polling) return
    polling = true
    poll().catch(() => {}).finally(() => { polling = false })
  }, revokeEveryMs)
  timer.unref?.()

  return {
    async join(client, name, close) {
      const label = `${client}#${++count}`
      if (closed || !labelOk(label) || revoked.has(client)) return null
      if (!confirmed.has(client)) {
        // Sessions joining while the client's connect waits wait for that one
        let asked = connecting.get(client)
        if (asked === undefined) {
          asked = connect(client, name, label).finally(() => connecting.delete(client))
          connecting.set(client, asked)
        }
        if (!await asked || revoked.has(client)) return null
        confirmed.add(client)
      }
      if (closed) return null
      open.set(label, { client, close })
      return { label, leave: () => { open.delete(label) } }
    },
    connections: () => [...open.keys()],
    close() {
      closed = true
      clearInterval(timer)
      open.clear()
    },
  }
}
