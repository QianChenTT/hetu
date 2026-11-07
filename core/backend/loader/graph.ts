import { dependencyReason, type DependencyWhy } from '../../api/lifecycle.ts'

// A plugin as its checks and its run left it. ok passed every check and is switched on. found has no entry yet. held
// is what happened in this run: a crash, a failed host half or a stop by the watchdog or the human, which only a
// restart clears
export type Status =
  | { kind: 'ok' }
  | { kind: 'found' }
  | { kind: 'off' }
  | { kind: 'refused', reason: string }
  | { kind: 'held', state: 'crashed' | 'failed' | 'stopped', reason: string }

// rank orders plugins the graph leaves free: lower starts first
export type Node = { readonly id: string, readonly status: Status, readonly requires: readonly string[], readonly rank: number }

export type Verdict = Exclude<Status, { kind: 'ok' }> | { kind: 'start' } | { kind: 'waiting', reason: string }

// order holds every plugin, each after the plugins it requires, so the reverse stops dependents first. Plugins in a
// cycle and behind one come last
export type Plan = { verdicts: Map<string, Verdict>, order: string[] }

const byRank = (a: Node, b: Node) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// Every ok plugin in a cycle of requires among ok plugins, a plugin that requires itself included. Tarjan's strongly
// connected components with a stack of its own, so a long chain can't run out of call stack
function cycles(nodes: readonly Node[], byId: ReadonlyMap<string, Node>): Set<string> {
  const ok = (id: string) => byId.get(id)?.status.kind === 'ok'
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const found = new Set<string>()
  let next = 0
  for (const root of nodes) {
    if (index.has(root.id)) continue
    const work: { id: string, edge: number }[] = [{ id: root.id, edge: 0 }]
    index.set(root.id, next)
    low.set(root.id, next++)
    stack.push(root.id)
    onStack.add(root.id)
    while (work.length > 0) {
      const top = work[work.length - 1]
      const requires = byId.get(top.id)!.requires
      if (top.edge < requires.length) {
        const to = requires[top.edge++]
        if (!ok(to)) continue
        if (to === top.id) found.add(to)
        if (!index.has(to)) {
          index.set(to, next)
          low.set(to, next++)
          stack.push(to)
          onStack.add(to)
          work.push({ id: to, edge: 0 })
        } else if (onStack.has(to)) {
          low.set(top.id, Math.min(low.get(top.id)!, index.get(to)!))
        }
        continue
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1].id
        low.set(parent, Math.min(low.get(parent)!, low.get(top.id)!))
      }
      if (low.get(top.id) !== index.get(top.id)) continue
      const members: string[] = []
      for (;;) {
        const member = stack.pop()!
        onStack.delete(member)
        members.push(member)
        if (member === top.id) break
      }
      if (members.length > 1) for (const member of members) found.add(member)
    }
  }
  return found
}

// Kahn's order over every plugin with an edge from each requirement the graph knows to its dependent, the lowest rank
// first among those free to go
function topological(nodes: readonly Node[], byId: ReadonlyMap<string, Node>): string[] {
  const waiting = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    const known = [...new Set(node.requires)].filter(id => byId.has(id) && id !== node.id)
    waiting.set(node.id, known.length)
    for (const id of known) dependents.set(id, [...(dependents.get(id) ?? []), node.id])
  }
  const free = nodes.filter(node => waiting.get(node.id) === 0).sort(byRank)
  const order: string[] = []
  while (free.length > 0) {
    const node = free.shift()!
    order.push(node.id)
    for (const id of dependents.get(node.id) ?? []) {
      const left = waiting.get(id)! - 1
      waiting.set(id, left)
      if (left !== 0) continue
      const dependent = byId.get(id)!
      const at = free.findIndex(other => byRank(dependent, other) < 0)
      free.splice(at === -1 ? free.length : at, 0, dependent)
    }
  }
  const placed = new Set(order)
  return [...order, ...nodes.filter(node => !placed.has(node.id)).sort(byRank).map(node => node.id)]
}

// Resolves the requires graph before anything starts and after every change. A cycle refuses every plugin in it. A
// plugin whose requirement is absent, new, off, refused, outside the API range, failed, crashed, stopped or waiting
// itself waits, naming only that direct requirement, the first in its own list that can't serve it
export function plan(nodes: readonly Node[]): Plan {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const cyclic = cycles(nodes.filter(node => node.status.kind === 'ok'), byId)
  const verdicts = new Map<string, Verdict>()
  for (const node of nodes) {
    if (node.status.kind !== 'ok') verdicts.set(node.id, node.status)
    else if (cyclic.has(node.id)) verdicts.set(node.id, { kind: 'refused', reason: 'cycle' })
  }

  const why = (id: string): DependencyWhy | null => {
    const verdict = verdicts.get(id)
    if (verdict === undefined) return 'absent'
    if (verdict.kind === 'start') return null
    if (verdict.kind === 'found') return 'new'
    if (verdict.kind === 'off') return 'off'
    if (verdict.kind === 'refused') return verdict.reason === 'api' ? 'api' : 'refused'
    if (verdict.kind === 'held') return verdict.state
    return 'waiting'
  }

  // The ok plugins left once cycles are refused hold none, so Kahn's order reaches every one of them, each after its
  // requirements. No recursion, so a long chain can't run out of call stack
  const rest = nodes.filter(node => !verdicts.has(node.id))
  const inRest = new Set(rest.map(node => node.id))
  for (const id of topological(rest, new Map(rest.map(node => [node.id, node])))) {
    const node = byId.get(id)!
    let verdict: Verdict = { kind: 'start' }
    for (const required of node.requires) {
      // Never true once cycles are out, kept so a slip can't read a requirement before its own verdict
      if (inRest.has(required) && !verdicts.has(required)) {
        verdict = { kind: 'refused', reason: 'cycle' }
        break
      }
      const blocked = why(required)
      if (blocked === null) continue
      verdict = { kind: 'waiting', reason: dependencyReason(required, blocked) }
      break
    }
    verdicts.set(id, verdict)
  }
  return { verdicts, order: topological(nodes, byId) }
}
