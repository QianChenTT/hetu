import { randomBytes } from 'node:crypto'
import { agentConnect, connectLabel, type AgentConnect } from '../../api/changes.ts'
import { agentDoor } from '../../api/policy-jobs.ts'

// A client's connect through mcp-http-handler's door: the change the core raises for it and the connect's state until mcp-http-handler
// collects the human's answer. The hosts are taken here with the URL parser mcp-http-handler's own process uses, so the host the
// human reads is the one mcp-http-handler reaches

// What mcp-http-handler sends for a connect: the client id, the name the client's document gives or null, the redirect and the
// number of the authorization
export type ConnectAsked = { client: string, name: string | null, redirect: string, number: number }

// An address's host with its port where one is named, null for text that is no URL or a URL with no host. user says it
// names a user or a password before the host, which can make it read as another host
function hostOf(address: string): { host: string, user: boolean } | null {
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  return url.host === '' ? null : { host: url.host, user: url.username !== '' || url.password !== '' }
}

// The connect as the human is shown it, or null for one the core refuses: a redirect with no host, a client id or a
// redirect with user info, or values out of the kind's form, a client id and a number that make no label among them
export function connectChange(asked: ConnectAsked): AgentConnect | null {
  const to = hostOf(asked.redirect)
  const from = hostOf(asked.client)
  if (to === null || to.user || from?.user === true) return null
  const change = {
    kind: 'consent.ask' as const, plugin: agentDoor.plugin, client: asked.client, clientHost: from?.host ?? null, name: asked.name,
    redirect: asked.redirect, redirectHost: to.host, number: asked.number,
  }
  return agentConnect.safeParse(change).success ? change : null
}

// How long a client id the human cancelled a connect of waits before it may connect again. The most answers mcp-http-handler has
// yet to collect that are kept, the oldest going first
export const AGENT_CONNECT_PAUSE_MS = 60_000
export const MAX_CONNECT_ANSWERS = 16

export type ConnectAnswer = 'waiting' | 'yes' | 'no' | 'gone'

// What the connect needs from the plugins manager, which holds the requests and the state
export type ConnectHost = {
  clock(): number
  // Whether a request holding this very change still waits for the human
  held(change: AgentConnect): boolean
  // Raises the change as a request, false when it took no place of its own
  raise(change: AgentConnect): boolean
  // Whether the core holds the label already: items, a revoked mark or an ask waiting
  inUse(label: string): boolean
}

// The connect's state, in memory alone so nothing of it outlives a run of hetu: the one connect waiting with the handle
// the core made for it, the answers mcp-http-handler has yet to collect and the client ids paused after a Cancel. It holds no list
// of agents and calls into no plugin, mcp-http-handler asks
export class Connects {
  private readonly host: ConnectHost
  private waiting: { handle: string, change: AgentConnect } | null = null
  private readonly answers = new Map<string, 'yes' | 'no'>()
  private readonly paused = new Map<string, number>()

  constructor(host: ConnectHost) {
    this.host = host
  }

  // Raises a connect and gives back its handle, random so no other caller can guess it. One waits in all, a client id
  // the human cancelled a connect of waits AGENT_CONNECT_PAUSE_MS and a label the core holds already is refused
  ask(asked: ConnectAsked): string {
    const change = connectChange(asked)
    if (change === null) throw { code: 'invalid' }
    const until = this.paused.get(change.client)
    if (until !== undefined && this.host.clock() < until) throw { code: 'throttled' }
    if (this.waits()) throw { code: 'throttled' }
    if (this.host.inUse(connectLabel(change))) throw { code: 'not-granted' }
    if (!this.host.raise(change)) throw { code: 'throttled' }
    const handle = randomBytes(24).toString('base64url')
    this.waiting = { handle, change }
    return handle
  }

  // The answer for a handle: yes or no once, waiting while its request waits, gone for any other
  answer(handle: string): ConnectAnswer {
    const given = this.answers.get(handle)
    if (given !== undefined) {
      this.answers.delete(handle)
      return given
    }
    return this.waits() && this.waiting!.handle === handle ? 'waiting' : 'gone'
  }

  // The human's Confirm, from the plugins manager's apply once its record landed. A label the core came to hold while the
  // connect waited fails it
  confirmed(change: AgentConnect): void {
    if (this.waiting?.change !== change) throw new Error('no connect waits for this Confirm')
    if (this.host.inUse(connectLabel(change))) throw new Error('the label is held already')
    this.answered('yes')
  }

  // The human's Cancel, which pauses the client id
  cancelled(change: AgentConnect): void {
    const now = this.host.clock()
    for (const [client, until] of this.paused) if (until <= now) this.paused.delete(client)
    this.paused.set(change.client, now + AGENT_CONNECT_PAUSE_MS)
    if (this.waiting?.change === change) this.answered('no')
  }

  // mcp-http-handler's way ended: its request went with it and no answer is handed to the next run of mcp-http-handler
  ended(): void {
    this.waiting = null
    this.answers.clear()
  }

  // Whether a connect waits, forgetting one whose request lapsed or was withdrawn
  private waits(): boolean {
    if (this.waiting !== null && !this.host.held(this.waiting.change)) this.waiting = null
    return this.waiting !== null
  }

  private answered(answer: 'yes' | 'no'): void {
    this.answers.set(this.waiting!.handle, answer)
    this.waiting = null
    for (const handle of this.answers.keys()) {
      if (this.answers.size <= MAX_CONNECT_ANSWERS) break
      this.answers.delete(handle)
    }
  }
}
