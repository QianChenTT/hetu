import type { ActionResults, ListedAgent } from '../../api/actions.ts'
import { AGENT_ASK_PAUSE_MS, agentAsk as agentAskChange, type AgentAsk, type Change } from '../../api/changes.ts'
import { agentLabel } from '../../api/envelope.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import { agentHost } from '../../api/policy-jobs.ts'
import type { Plugin } from '../boot/header.ts'
import { agentItems } from '../lib/agent-items.ts'
import type { AskRefusal, Asks } from '../router/header.ts'
import { cleared, handedBack, heardOut, marksOf, revoked, revokedAside, setAside } from './marks.ts'
import { MAX_PENDING } from './requests.ts'
import { PluginsLifecycle } from './lifecycle.ts'

type AgentItem = NonNullable<Plugin['agents']>[number]

// The agents' items an ask's Confirm writes: those held, then each asked item the label doesn't hold yet. The raise
// parses the same list, so an ask that waits is one its Confirm can write
function withAsked(held: readonly AgentItem[], change: AgentAsk): AgentItem[] {
  const items = [...held]
  for (const capability of change.capabilities) {
    const key = capabilityKey(capability)
    if (!items.some(item => item.agent === change.agent && capabilityKey(item.capability) === key)) items.push({ agent: change.agent, capability })
  }
  return items
}

// The agents' state, kept together: the items each agent holds on the agent host's entry, their asks and connects, the
// labels the human revoked and the marks set aside while the host has no entry
export abstract class PluginsAgents extends PluginsLifecycle {
  // For the router, which refuses the door's call for a revoked label before the agent host sees it: the marks on the
  // agent host's entry or in the switches while it has none
  revoked(label: string): boolean {
    const k = this.known.get(agentHost)
    return marksOf(k?.from === 'folder' ? k.entry : null, this.state.switches).includes(label)
  }

  // The agent host's agents from the state alone, its entry on or off or gone: each label holding items in the order the
  // entry first names it, then each revoked label. Nothing here says whether a token is live or what a client calls
  // itself
  protected listedAgents(): ListedAgent[] {
    const k = this.known.get(agentHost)
    const entry = k?.from === 'folder' ? k.entry : null
    const listed = new Map<string, Capability[]>()
    for (const { agent, capability } of entry?.agents ?? []) listed.set(agent, [...listed.get(agent) ?? [], capability])
    return [
      ...[...listed].map(([agent, items]) => ({ agent, items, revoked: false })),
      ...marksOf(entry, this.state.switches).map(agent => ({ agent, items: [], revoked: true })),
    ]
  }

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

  // An agent's ask for items through the agent host, raised as a request only the core raises. The items the agent
  // holds already are left out and the rest put in key order, so the same ask in another order finds the request
  // waiting. One ask waits for a label at a time and a label whose ask the human cancelled waits AGENT_ASK_PAUSE_MS
  protected agentAsk(label: string | undefined, capabilities: Capability[]): ActionResults['core.identityAsk'] {
    if (!agentLabel.safeParse(label).success) throw { code: 'invalid' }
    const agent = label!
    const entry = this.hostEntry()
    if (entry === null) throw { code: 'unavailable' }
    // A revoked authorization asks for nothing again, an agent comes back only as a new one with a new number
    if (marksOf(entry, this.state.switches).includes(agent)) throw { code: 'not-granted' }
    const paused = this.askPaused.get(agent)
    if (paused !== undefined && this.clock() < paused) throw { code: 'throttled' }
    const held = new Set((entry.agents ?? []).filter(item => item.agent === agent).map(item => capabilityKey(item.capability)))
    const wanted = new Map<string, Capability>()
    for (const capability of capabilities) if (!held.has(capabilityKey(capability))) wanted.set(capabilityKey(capability), capability)
    if (wanted.size === 0) return { asked: 'granted' }
    const keys = [...wanted.keys()].sort()
    const change: AgentAsk = { kind: 'identity.ask', plugin: agentHost, agent, capabilities: keys.map(key => wanted.get(key)!) }
    // Refused here what a Confirm could never write, so no ask waits in front of the human only to fail: an item with
    // no scope or the items every agent holds with these added past the entry's caps for one agent or for all
    if (!agentAskChange.safeParse(change).success) throw { code: 'invalid' }
    // A plugin.call target names a plugin hetu knows, so an ask can't put words of its choosing in the target's place
    const unknown = (capability: Capability) => capability.type === 'plugin.call' && capability.targets.some(target => !this.known.has(target))
    if (change.capabilities.some(unknown)) throw { code: 'not-found' }
    if (!agentItems.safeParse(withAsked(entry.agents ?? [], change)).success) throw { code: 'invalid', reason: 'too-large' }
    const waiting = this.requests.changes().find(({ change: one }) => one.kind === 'identity.ask' && one.agent === agent)?.change as AgentAsk | undefined
    if (waiting !== undefined && waiting.capabilities.map(capabilityKey).join('\n') !== keys.join('\n')) throw { code: 'throttled' }
    if (typeof this.requests.raise(change, null, MAX_PENDING, 'identity.ask') !== 'string') throw { code: 'throttled' }
    return { asked: 'waiting' }
  }

  // The agent host's entry while the host is a plugin-folder plugin the human has on, the one entry agents' items sit in
  protected hostEntry(): Plugin | null {
    const k = this.known.get(agentHost)
    return k?.from === 'folder' && k.entry !== null && k.entry.enabled ? k.entry : null
  }

  // Whether the core holds the label already, from what it holds for the agent host and no list of its own: items on
  // the entry, a revoked mark or an ask waiting. A connect for such a label would hand a new authorization another's
  protected labelHeld(label: string): boolean {
    const k = this.known.get(agentHost)
    const entry = k?.from === 'folder' ? k.entry : null
    return (entry?.agents ?? []).some(item => item.agent === label) || marksOf(entry, this.state.switches).includes(label)
      || this.requests.changes().some(({ change }) => change.kind === 'identity.ask' && change.agent === label)
  }

  // Every item of the label goes with its ask waiting, then the label is marked revoked until mcp-http-handler says it ended its
  // tokens, on the entry or in the switches while the agent host has none. Only that label: a label another one begins
  // with keeps its own. A label that holds nothing is marked only when the core saw it ask in this run, its ask waiting
  // or the pause after a Cancel still running, so the human can turn away an agent that only asks and no window can
  // fill the list with labels that never asked. Any other label that holds nothing changes nothing and answers unchanged
  protected async agentRevoke(agent: string): Promise<void | 'unchanged'> {
    const k = this.known.get(agentHost)
    const entry = k?.from === 'folder' ? k.entry : null
    const waiting = (change: Change) => change.kind === 'identity.ask' && change.agent === agent
    const asked = this.requests.changes().some(({ change }) => waiting(change))
    this.requests.withdraw(waiting)
    const holds = (entry?.agents ?? []).some(item => item.agent === agent)
    const paused = this.askPaused.get(agent)
    const seen = asked || (paused !== undefined && this.clock() < paused)
    if (!holds && (!seen || marksOf(entry, this.state.switches).includes(agent))) return 'unchanged'
    if (entry === null) {
      const aside = revokedAside(this.state.switches, agent)
      await this.writeSwitches(aside.switches)
      return this.markDropped(aside.dropped, agent)
    }
    const next = revoked(entry, agent)
    await this.store.writePlugin(agentHost, next.entry)
    this.putEntry(agentHost, next.entry)
    this.bump()
    this.markDropped(next.dropped, agent)
  }

  // A mark dropped to make room for a newer one, recorded with the label whose revoke or hand back dropped it
  protected markDropped(dropped: readonly string[], agent: string | null): void {
    for (const target of dropped) this.note('agent.markDropped', { target, for: agent })
  }

  // Before the agent host's entry goes in a Reset or a Remove: its marks held in the switches, so no revoked label is
  // taken as unknown while the host has no entry
  protected async setMarksAside(id: string): Promise<void> {
    if (id !== agentHost) return
    const aside = setAside(this.state.switches, this.state.plugins[id] ?? null)
    if (aside === null) return
    await this.writeSwitches(aside.switches)
    this.markDropped(aside.dropped, null)
  }

  // The agent host's next entry with the marks the switches hold
  protected withMarks(id: string, entry: Plugin): Plugin {
    if (id !== agentHost) return entry
    const back = handedBack(entry, this.state.switches)
    this.markDropped(back.dropped, null)
    return back.entry
  }

  // Once the agent host's entry holds the marks, the switches hold none
  protected async marksHandedBack(id: string): Promise<void> {
    if (id !== agentHost) return
    const next = cleared(this.state.switches)
    if (next !== null) await this.writeSwitches(next)
  }

  // For mcp-http-handler, whether each label holds items, holds none or is revoked, after the marks of the labels mcp-http-handler heard went.
  // A mark goes only for a label marked, so a heard naming none writes nothing and stales no ask
  protected agentsFor(agents: string[], heard: string[]): Promise<ActionResults['core.identities']> {
    return this.serial(async () => {
      const k = this.known.get(agentHost)
      let entry = k?.from === 'folder' ? k.entry : null
      const out = heardOut(entry, this.state.switches, heard)
      if (out.entry !== null) {
        await this.store.writePlugin(agentHost, out.entry)
        this.putEntry(agentHost, out.entry)
        entry = out.entry
      }
      if (out.switches !== null) await this.writeSwitches(out.switches)
      const marks = marksOf(entry, this.state.switches)
      return agents.map(agent => ({
        agent,
        holds: marks.includes(agent) ? 'revoked' : (entry?.agents ?? []).some(item => item.agent === agent) ? 'items' : 'none',
      }))
    })
  }

  // An agent's ask confirmed: its items added to that label's on the agent host's entry in one write through the entry's
  // own schema, so none are written when one can't be. No class moves, since no agent's item counts as the host's own
  protected async agentGrant(change: AgentAsk): Promise<void> {
    const entry = this.hostEntry()
    if (entry === null) throw new Error('the agent host is not on')
    if (marksOf(entry, this.state.switches).includes(change.agent)) throw new Error('a revoked agent')
    const next: Plugin = { ...entry, agents: withAsked(entry.agents ?? [], change) }
    await this.store.writePlugin(agentHost, next)
    this.putEntry(agentHost, next)
    this.bump()
  }
}
