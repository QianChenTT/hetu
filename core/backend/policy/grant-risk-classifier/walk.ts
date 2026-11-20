import type { Capability } from '../../../api/capabilities.ts'
import type { ClassTable } from '../../../api/classes.ts'
import type { Flow, Peer } from './rules.ts'

// Every plugin in the table and what each holds, before the change or as the change leaves it
export type Holders = { readonly ids: readonly string[], readonly held: (id: string) => readonly Capability[] }

const targetsOf = (granted: readonly Capability[]) => granted.flatMap(item => (item.type === 'plugin.call' ? item.targets : []))
// The plugins whose topics a grant hears, each topic published as <id>.<name> by that plugin alone
const publishersOf = (granted: readonly Capability[]) =>
  granted.flatMap(item => (item.type === 'events.subscribe' ? item.topics.map(topic => topic.slice(0, topic.indexOf('.'))) : []))

// Every plugin the links lead to from the plugins in start, followed in turn and never through the one asking
function followed(links: ReadonlyMap<string, ReadonlySet<string>>, start: readonly string[], asking: string): Set<string> {
  const seen = new Set<string>([asking])
  const queue = start.flatMap(from => [...(links.get(from) ?? [])])
  while (queue.length > 0) {
    const other = queue.shift()!
    if (seen.has(other)) continue
    seen.add(other)
    queue.push(...(links.get(other) ?? []))
  }
  seen.delete(asking)
  return seen
}

// The plugins in the table and what each holds, before the change or once it applies, which adds a plugin approved now
// and takes away one that goes
export function holders(table: ClassTable, after: boolean): Holders {
  const rows = new Map(table.plugins.map(row => [row.id, row.granted]))
  const { change } = table
  if (after && change !== null) {
    if (change.granted === null) rows.delete(change.id)
    else rows.set(change.id, change.granted)
  }
  return { ids: [...rows.keys()], held: id => rows.get(id) ?? [] }
}

// Every plugin connected to id through plugin.call, either way round and followed in turn, with what each holds. A
// callee answers its caller, so data moves both ways along a call: a reader and a network plugin that share a callee
// can pass notes out through it
export function connected({ ids, held }: Holders, id: string): Peer[] {
  const links = new Map<string, Set<string>>(ids.map(other => [other, new Set<string>()]))
  for (const from of ids) {
    for (const to of targetsOf(held(from))) {
      if (to === from) continue
      if (!links.has(to)) links.set(to, new Set())
      links.get(from)!.add(to)
      links.get(to)!.add(from)
    }
  }
  return [...followed(links, [id], id)].sort().map(other => ({ id: other, granted: held(other) }))
}

// Where data can move to and from id, for the pair rule: along plugin.call both ways, and along a subscription to
// another plugin's topics from the plugin that owns the topic to id, never back. Publishing needs no grant, so a
// plugin can signal every plugin that hears its topics by what and when it publishes, while a plugin that hears
// another passes it nothing. Two plugins hearing one topic share nothing through it
export function flow({ ids, held }: Holders, id: string): Flow {
  const out = new Map<string, Set<string>>()
  const into = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (from === to) return
    if (!out.has(from)) out.set(from, new Set())
    if (!into.has(to)) into.set(to, new Set())
    out.get(from)!.add(to)
    into.get(to)!.add(from)
  }
  for (const from of ids) {
    for (const to of targetsOf(held(from))) {
      link(from, to)
      link(to, from)
    }
    for (const owner of publishersOf(held(from))) link(owner, from)
  }
  const peers = (others: Set<string>) => [...others].sort().map(other => ({ id: other, granted: held(other) }))
  const heard = held(id).flatMap(item => {
    const owners = publishersOf([item]).filter(owner => owner !== id)
    if (owners.length === 0) return []
    const upstream = new Set([...owners, ...followed(into, owners, id)])
    upstream.delete(id)
    return [{ item, upstream: peers(upstream).flatMap(peer => [...peer.granted]) }]
  })
  return { upstream: peers(followed(into, [id], id)), downstream: peers(followed(out, [id], id)), heard }
}

export const reachable = (holding: Holders, id: string): Capability[] => connected(holding, id).flatMap(other => [...other.granted])

// What a plugin's class rests on past its own grants: what it reaches through plugin.call and where data moves to and
// from it
export const links = (holding: Holders, id: string): string => JSON.stringify([reachable(holding, id), flow(holding, id)])
