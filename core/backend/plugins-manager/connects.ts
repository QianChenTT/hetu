import { randomBytes } from 'node:crypto'
import { consentAsk, type ConsentAsk } from '../../api/changes.ts'

// A client's connect a utility half asks for: the change the core raises for it and the connect's state until the
// same plugin collects the human's answer. The hosts are taken here with the URL parser the utility process uses, so
// the host the human reads is the one the plugin reaches

// A pair as the plugins manager reads it: the root plugin's id and the field
export type PairOf = { readonly root: string, readonly field: string }

// What a utility half sends for a connect: the client id, the name the client's document gives or null, the redirect
// and the field the plugin's calls for the client will carry
export type ConnectAsked = { client: string, name: string | null, redirect: string, field: string }

// An address's host with its port where one is named, null for text that is no URL or a URL with no host. user says it
// names a user or a password before the host, which can make it read as another host
function hostOf(address: string): { host: string, user: boolean } | null {
  if (!URL.canParse(address)) return null
  const url = new URL(address)
  return url.host === '' ? null : { host: url.host, user: url.username !== '' || url.password !== '' }
}

// The connect as the human is shown it, or null for one the core refuses: a redirect with no host, a client id or a
// redirect with user info, or values out of the kind's form
export function connectChange(asked: ConnectAsked, plugin: string): ConsentAsk | null {
  const to = hostOf(asked.redirect)
  const from = hostOf(asked.client)
  if (to === null || to.user || from?.user === true) return null
  const change = {
    kind: 'consent.ask' as const, plugin, client: asked.client, clientHost: from?.host ?? null, name: asked.name,
    redirect: asked.redirect, redirectHost: to.host, field: asked.field,
  }
  return consentAsk.safeParse(change).success ? change : null
}

// How long a client id the human cancelled a connect of waits before its plugin may connect it again. The most answers
// yet to be collected that are kept, the oldest going first
export const CONSENT_PAUSE_MS = 60_000
export const MAX_CONSENT_ANSWERS = 16

export type ConnectAnswer = 'waiting' | 'yes' | 'no' | 'gone'

// What the connect needs from the plugins manager, which holds the requests and the pairs
export type ConnectHost = {
  clock(): number
  // Whether a request holding this very change still waits for the human
  held(change: ConsentAsk): boolean
  // Raises the change as a request, false when it took no place of its own
  raise(change: ConsentAsk): boolean
  // Whether the core holds the pair already: items, a revoke or an ask waiting
  inUse(pair: PairOf): boolean
}

// The connect's state, in memory alone so nothing of it outlives a run of hetu: the one connect waiting with the handle
// the core made for it, the answers yet to be collected with the plugin each is for and the client ids paused after a
// Cancel. It calls into no plugin, the plugin asks
export class Connects {
  private readonly host: ConnectHost
  private waiting: { handle: string, change: ConsentAsk } | null = null
  private readonly answers = new Map<string, { plugin: string, answer: 'yes' | 'no' }>()
  private readonly paused = new Map<string, number>()

  constructor(host: ConnectHost) {
    this.host = host
  }

  // Raises a connect for the plugin and gives back its handle, random so no other caller can guess it. One waits in
  // all, a client id the human cancelled a connect of waits CONSENT_PAUSE_MS for that plugin and a pair the core holds
  // already is refused
  ask(asked: ConnectAsked, plugin: string): string {
    const change = connectChange(asked, plugin)
    if (change === null) throw { code: 'invalid' }
    const until = this.paused.get(pausedKey(change))
    if (until !== undefined && this.host.clock() < until) throw { code: 'throttled' }
    if (this.waits()) throw { code: 'throttled' }
    if (this.host.inUse({ root: plugin, field: change.field })) throw { code: 'not-granted' }
    if (!this.host.raise(change)) throw { code: 'throttled' }
    const handle = randomBytes(24).toString('base64url')
    this.waiting = { handle, change }
    return handle
  }

  // The answer for a handle the plugin's own connect got: yes or no once, waiting while its request waits, gone for
  // any other and for another plugin's handle
  answer(handle: string, plugin: string): ConnectAnswer {
    const given = this.answers.get(handle)
    if (given !== undefined && given.plugin === plugin) {
      this.answers.delete(handle)
      return given.answer
    }
    return this.waits() && this.waiting!.handle === handle && this.waiting!.change.plugin === plugin ? 'waiting' : 'gone'
  }

  // The human's Confirm, from the plugins manager's apply once its record landed. A pair the core came to hold while
  // the connect waited fails it
  confirmed(change: ConsentAsk): void {
    if (this.waiting?.change !== change) throw new Error('no connect waits for this Confirm')
    if (this.host.inUse({ root: change.plugin, field: change.field })) throw new Error('the pair is held already')
    this.answered('yes')
  }

  // The human's Cancel, which pauses the client id for the plugin
  cancelled(change: ConsentAsk): void {
    const now = this.host.clock()
    for (const [key, until] of this.paused) if (until <= now) this.paused.delete(key)
    this.paused.set(pausedKey(change), now + CONSENT_PAUSE_MS)
    if (this.waiting?.change === change) this.answered('no')
  }

  // The plugin's way ended: its connect's request went with it and no answer of its is handed to its next run
  ended(plugin: string): void {
    if (this.waiting?.change.plugin === plugin) this.waiting = null
    for (const [handle, given] of this.answers) if (given.plugin === plugin) this.answers.delete(handle)
  }

  // Whether a connect waits, forgetting one whose request lapsed or was withdrawn
  private waits(): boolean {
    if (this.waiting !== null && !this.host.held(this.waiting.change)) this.waiting = null
    return this.waiting !== null
  }

  private answered(answer: 'yes' | 'no'): void {
    this.answers.set(this.waiting!.handle, { plugin: this.waiting!.change.plugin, answer })
    this.waiting = null
    for (const handle of this.answers.keys()) {
      if (this.answers.size <= MAX_CONSENT_ANSWERS) break
      this.answers.delete(handle)
    }
  }
}

const pausedKey = (change: ConsentAsk) => `${change.plugin}\n${change.client}`
