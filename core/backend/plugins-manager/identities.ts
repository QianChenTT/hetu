import type { ActionResults, ListedIdentity } from '../../api/actions.ts'
import { capabilityKey, folderCapabilities, type Capability } from '../../api/capabilities.ts'
import { identityAsk as identityAskChange, type Change, type IdentityAsk } from '../../api/changes.ts'
import type { Call, GrantedItem } from '../../api/policy-jobs.ts'
import type { AskRefusal, Asks } from '../router/header.ts'
import type { PairOf } from './connects.ts'
import { MAX_PENDING } from './requests.ts'
import { PluginsAgents } from './agents.ts'

// The items the pairs of one root plugin hold in all
export const MAX_PAIR_ITEMS = 256

// A pair as the plugins manager keys it: the root plugin's id and the field on two lines. An id holds no line break,
// so no two pairs share a key
const keyOf = (pair: PairOf) => `${pair.root}\n${pair.field}`

// The items a pair holds with each asked item it doesn't hold yet added. The raise counts the same list, so an ask that
// waits is one its Confirm can add
function withAsked(held: readonly Capability[], change: IdentityAsk): Capability[] {
  const keys = new Set(held.map(capabilityKey))
  return [...held, ...change.capabilities.filter(capability => !keys.has(capabilityKey(capability)))]
}

// The pairs' state, in memory alone so nothing of it outlives a run of hetu: the items each pair holds, the pairs the
// human revoked and a count per pair that an ask waiting for it is held against. Also the asks a plugin's own call
// raises at an item's first use
export abstract class PluginsIdentities extends PluginsAgents {
  // Each root plugin's pairs by field, each with its items in the order the human gave them
  private readonly pairs = new Map<string, Map<string, Capability[]>>()
  // The fields the human revoked under each root plugin, refused for the rest of the run
  private readonly revokedPairs = new Map<string, Set<string>>()
  // Raised by each change to a pair's items and by its revoke
  private readonly counts = new Map<string, number>()

  // The prompt behind the gate's ask: an item.on held for the item a plugin's call asked to use for the first time,
  // which the human opens from its notice. ask is the item's key as the gate gave it. Only a plugin's item whose first
  // use asks can be raised, one open per plugin within firstUseAsks
  readonly asks: Asks = {
    raise: (ask, access): string | AskRefusal => {
      const { caller } = access
      if (caller.kind !== 'plugin') return { code: 'not-granted' }
      const entry = this.known.get(caller.id)?.entry ?? null
      const item = entry?.firstUse?.find(asked => capabilityKey(asked) === ask)
      if (entry === null || item === undefined || !entry.granted.some(granted => capabilityKey(granted) === ask)) return { code: 'not-granted' }
      if (this.declinedAsks.has(`${caller.id}
${ask}`)) return { code: 'not-granted', reason: 'declined' }
      return this.requests.raise({ kind: 'item.on', plugin: caller.id, capability: item }, caller.id, this.link.limit(caller.id, 'firstUseAsks'))
    },
  }

  // The count an ask for the pair is fingerprinted with, so only a change to that pair stales it
  protected pairCount(pair: PairOf): number {
    return this.counts.get(keyOf(pair)) ?? 0
  }

  private itemsOf(pair: PairOf): Capability[] {
    return this.pairs.get(pair.root)?.get(pair.field) ?? []
  }

  private revoked(pair: PairOf): boolean {
    return this.revokedPairs.get(pair.root)?.has(pair.field) === true
  }

  private moved(pair: PairOf): void {
    this.counts.set(keyOf(pair), this.pairCount(pair) + 1)
  }

  private waitingFor(pair: PairOf): (change: Change) => boolean {
    return change => change.kind === 'identity.ask' && change.root === pair.root && change.field === pair.field
  }

  // Whether the asked items fit: the pair within a plugin's own list's caps and the root plugin's pairs within
  // MAX_PAIR_ITEMS in all
  private fits(change: IdentityAsk): boolean {
    const items = withAsked(this.itemsOf(change), change)
    let all = items.length
    for (const [field, held] of this.pairs.get(change.root) ?? []) if (field !== change.field) all += held.length
    return folderCapabilities.safeParse(items).success && all <= MAX_PAIR_ITEMS
  }

  // An ask for the chain's pair from the plugin the root called, which the router let through. The pair comes from the
  // chain, never from an argument. The items the pair holds already are left out and the rest put in key order, so the
  // same ask in another order finds the request waiting. One ask waits for a pair at a time and a pair whose ask the
  // human cancelled waits IDENTITY_ASK_PAUSE_MS
  protected identityAsk(call: Call, capabilities: Capability[]): ActionResults['core.identityAsk'] {
    const { caller, root, onBehalf } = call
    if (caller.kind !== 'plugin' || root.kind !== 'plugin' || onBehalf === undefined) throw { code: 'not-granted' }
    const pair = { root: root.id, field: onBehalf }
    if (this.revoked(pair)) throw { code: 'not-granted' }
    const paused = this.askPaused.get(keyOf(pair))
    if (paused !== undefined && this.clock() < paused) throw { code: 'throttled' }
    const held = new Set(this.itemsOf(pair).map(capabilityKey))
    const wanted = new Map<string, Capability>()
    for (const capability of capabilities) if (!held.has(capabilityKey(capability))) wanted.set(capabilityKey(capability), capability)
    if (wanted.size === 0) return { asked: 'granted' }
    const keys = [...wanted.keys()].sort()
    const change: IdentityAsk = { kind: 'identity.ask', plugin: caller.id, ...pair, capabilities: keys.map(key => wanted.get(key)!) }
    // Refused here what a Confirm could never add, so no ask waits in front of the human only to fail: a type no pair
    // holds, an item with no scope or the pair's items past their caps
    if (!identityAskChange.safeParse(change).success) throw { code: 'invalid' }
    if (!this.fits(change)) throw { code: 'invalid', reason: 'too-large' }
    const waiting = this.requests.changes().find(({ change: one }) => this.waitingFor(pair)(one))?.change as IdentityAsk | undefined
    if (waiting !== undefined && (waiting.plugin !== change.plugin || waiting.capabilities.map(capabilityKey).join('\n') !== keys.join('\n'))) {
      throw { code: 'throttled' }
    }
    if (typeof this.requests.raise(change, null, MAX_PENDING, 'identity.ask') !== 'string') throw { code: 'throttled' }
    return { asked: 'waiting' }
  }

  // An ask confirmed: its items added to the pair's for the run, none when one can't be
  protected identityGrant(change: IdentityAsk): void {
    if (this.revoked(change)) throw new Error('a revoked pair')
    if (!this.fits(change)) throw new Error('past the caps')
    const fields = this.pairs.get(change.root) ?? new Map<string, Capability[]>()
    fields.set(change.field, withAsked(this.itemsOf(change), change))
    this.pairs.set(change.root, fields)
    this.moved(change)
    this.bump()
  }

  // Every item of the pair goes with its ask waiting and the pair is refused for the rest of the run. A pair that holds
  // nothing is revoked only when the core saw it ask in this run, its ask waiting or the pause after a Cancel still
  // running, so the human can turn away a pair that only asks and no window can fill the list with pairs that never
  // asked. Any other pair changes nothing and answers unchanged
  protected identityRevoke(pair: PairOf): void | 'unchanged' {
    const asked = this.requests.changes().some(({ change }) => this.waitingFor(pair)(change))
    this.requests.withdraw(this.waitingFor(pair))
    const paused = this.askPaused.get(keyOf(pair))
    const seen = asked || (paused !== undefined && this.clock() < paused)
    if (this.revoked(pair) || (this.itemsOf(pair).length === 0 && !seen)) return 'unchanged'
    this.drop(pair)
    const fields = this.revokedPairs.get(pair.root) ?? new Set<string>()
    this.revokedPairs.set(pair.root, fields.add(pair.field))
    this.moved(pair)
    this.bump()
  }

  private drop(pair: PairOf): void {
    const fields = this.pairs.get(pair.root)
    fields?.delete(pair.field)
    if (fields?.size === 0) this.pairs.delete(pair.root)
  }

  // A root plugin removed or reset takes its pairs' items with it, so a plugin given its id later finds none. The
  // revoked pairs stay refused for the run
  protected pairsGone(root: string): void {
    const fields = [...this.pairs.get(root)?.keys() ?? []]
    if (fields.length === 0) return
    for (const field of fields) this.moved({ root, field })
    this.pairs.delete(root)
    this.bump()
  }

  // Whether the core holds the pair already: items, a revoke or an ask waiting. A connect for such a pair would hand
  // a new client another's
  protected pairHeld(pair: PairOf): boolean {
    return this.itemsOf(pair).length > 0 || this.revoked(pair) || this.requests.changes().some(({ change }) => this.waitingFor(pair)(change))
  }

  // For a utility half, whether each field under its own plugin holds items, holds none or was revoked
  protected identitiesOf(root: string, fields: readonly string[]): ActionResults['core.identities'] {
    return fields.map(field => ({
      field, holds: this.revoked({ root, field }) ? 'revoked' : this.itemsOf({ root, field }).length > 0 ? 'items' : 'none',
    }))
  }

  // The trusted window's list: each pair holding items in the order its root plugin first got one, then each revoked
  protected listedIdentities(): ListedIdentity[] {
    const listed: ListedIdentity[] = []
    for (const [root, fields] of this.pairs) for (const [field, items] of fields) listed.push({ root, field, items: structuredClone(items), revoked: false })
    for (const [root, fields] of this.revokedPairs) for (const field of fields) listed.push({ root, field, items: [], revoked: true })
    return listed
  }

  // The pairs as the grants snapshot carries them, none of them the root plugin's own, so none switches off or asks at
  // first use
  protected pairsSnapshot(): { pairs: Record<string, Record<string, GrantedItem[]>>, revoked: Record<string, string[]> } {
    const pairs: Record<string, Record<string, GrantedItem[]>> = Object.create(null)
    for (const [root, fields] of this.pairs) {
      pairs[root] = Object.create(null)
      for (const [field, items] of fields) pairs[root][field] = items.map(capability => ({ capability: structuredClone(capability), off: false, firstUse: false }))
    }
    const revoked: Record<string, string[]> = Object.create(null)
    for (const [root, fields] of this.revokedPairs) revoked[root] = [...fields]
    return { pairs, revoked }
  }
}
