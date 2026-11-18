import { MAX_AGENT_ITEMS, type Plugin, type Switches } from '../boot/state.ts'

// The revoked marks: each label the human revoked whose tokens mcp-http-handler has not yet said it ended. They sit on the agent
// host's entry while it has one and in the switches while it has none, so a Reset or a Remove of the host drops no
// mark. What changes them is worked out here and the plugins manager writes it

// Each label once in the order first named, at most as many as an entry holds: the oldest go to make room
function capped(labels: readonly string[]): { marks: string[], dropped: string[] } {
  const once = [...new Set(labels)]
  const over = Math.max(0, once.length - MAX_AGENT_ITEMS)
  return { marks: once.slice(over), dropped: once.slice(0, over) }
}

// Every label marked, on the entry or in the switches. Both hold one only between the two writes of a hand back
export function marksOf(entry: Plugin | null, switches: Switches): string[] {
  return [...new Set([...switches.revokedAgents ?? [], ...entry?.revoked ?? []])]
}

// A revoke: every item of the label goes and the label is marked newest, a label it was marked already moved last.
// Always written in full, the oldest mark dropped when the list is full
export function revoked(entry: Plugin, agent: string): { entry: Plugin, dropped: string[] } {
  const { marks, dropped } = capped([...(entry.revoked ?? []).filter(label => label !== agent), agent])
  const agents = (entry.agents ?? []).filter(item => item.agent !== agent)
  const next: Plugin = { ...entry, revoked: marks }
  if (agents.length > 0) next.agents = agents
  else delete next.agents
  return { entry: next, dropped }
}

// A revoke while the agent host has no entry, its mark held in the switches
export function revokedAside(switches: Switches, agent: string): { switches: Switches, dropped: string[] } {
  const { marks, dropped } = capped([...(switches.revokedAgents ?? []).filter(label => label !== agent), agent])
  return { switches: { ...switches, revokedAgents: marks }, dropped }
}

// Before the agent host's entry goes: its marks added to those the switches hold. null when the entry holds none
export function setAside(switches: Switches, entry: Plugin | null): { switches: Switches, dropped: string[] } | null {
  if (entry?.revoked === undefined || entry.revoked.length === 0) return null
  const { marks, dropped } = capped([...switches.revokedAgents ?? [], ...entry.revoked])
  return { switches: { ...switches, revokedAgents: marks }, dropped }
}

// The agent host's next entry with the marks the switches hold, the ones it carries kept newest
export function handedBack(entry: Plugin, switches: Switches): { entry: Plugin, dropped: string[] } {
  const aside = switches.revokedAgents ?? []
  if (aside.length === 0) return { entry, dropped: [] }
  const { marks, dropped } = capped([...aside, ...entry.revoked ?? []])
  return { entry: { ...entry, revoked: marks }, dropped }
}

// The switches with no mark held, once the entry holds them. null when they hold none
export function cleared(switches: Switches): Switches | null {
  if (switches.revokedAgents === undefined) return null
  const { revokedAgents, ...rest } = switches
  return rest
}

// The marks of the labels mcp-http-handler heard taken out of each place. null for a place that changes nothing, so a heard naming
// no marked label writes nothing
export function heardOut(entry: Plugin | null, switches: Switches, heard: readonly string[]): { entry: Plugin | null, switches: Switches | null } {
  const gone = (label: string) => heard.includes(label)
  let nextEntry: Plugin | null = null
  if (entry !== null && (entry.revoked ?? []).some(gone)) {
    nextEntry = { ...entry, revoked: entry.revoked!.filter(label => !gone(label)) }
    if (nextEntry.revoked!.length === 0) delete nextEntry.revoked
  }
  let nextSwitches: Switches | null = null
  if ((switches.revokedAgents ?? []).some(gone)) {
    const kept = switches.revokedAgents!.filter(label => !gone(label))
    nextSwitches = kept.length > 0 ? { ...switches, revokedAgents: kept } : cleared(switches)
  }
  return { entry: nextEntry, switches: nextSwitches }
}
