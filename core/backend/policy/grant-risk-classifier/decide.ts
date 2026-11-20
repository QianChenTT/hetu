import type { ClassAnswer, ClassOwed, ClassTable, ClassVerdict, StoredClass } from '../../../api/classes.ts'
import { alerts, classify, firstUse, moves, screen, type ClassMove } from './rules.ts'
import { connected, flow, holders, links, reachable } from './walk.ts'

// The answer to one class change: a verdict for the changed plugin while it stays, then for every other plugin with an
// entry whose links the change moves, or in a pass for every entry, each under the table as the change leaves it. With a
// Confirm on screen each move up is a line on it, after the changed plugin's screen
export function classes(table: ClassTable): ClassAnswer {
  const before = holders(table, false)
  const after = holders(table, true)
  const { change } = table
  const stored = new Map(table.plugins.map(row => [row.id, row.stored]))
  const verdicts: ClassVerdict[] = []
  const shown: ClassMove[] = []
  const judge = (id: string, own: StoredClass | null) => {
    const verdict = decided(table, id, own, after)
    verdicts.push(verdict.verdict)
    if (table.confirm && verdict.move !== null) shown.push(verdict.move)
  }
  if (change !== null && change.granted !== null) judge(change.id, stored.get(change.id) ?? null)
  for (const row of table.plugins) {
    if (row.stored === null || row.id === change?.id) continue
    if (change === null || links(before, row.id) !== links(after, row.id)) judge(row.id, row.stored)
  }
  const subject = change?.granted ?? null
  const lines = subject === null || change === null ? [] : screen({
    granted: subject, reachable: reachable(after, change.id), callers: connected(after, change.id), flow: flow(after, change.id),
  })
  return { plugins: verdicts, lines: [...lines, ...moves(shown)] }
}

// One plugin's class and the items that ask at first use under the table as the change leaves it, the move it makes from
// the class its entry holds and the notice it owes. A plugin never classed, approved now or with an entry written while
// the classifier was off and no class, moves from a class not known. For its notice that class counts as 0, since
// nothing showed the human any class, or as the class last shown when its mark holds one. Everywhere else it counts as 4.
// A notice owed is kept until answered, from the class last shown. One no move alerts for any more is owed no longer
function decided(table: ClassTable, id: string, stored: StoredClass | null, after: ReturnType<typeof holders>) {
  const granted = after.held(id)
  const reach = reachable(after, id)
  const moving = flow(after, id)
  const n = classify(granted, reach, moving)
  const unknown = stored === null ? table.cause === 'approve' : stored.class === null && stored.unclassed
  const from = stored?.class ?? null
  const move: ClassMove | null = (stored !== null || unknown) && n !== from ? { id, from, to: n } : null
  const raised = !table.confirm && move !== null && alerts(unknown ? { ...move, from: stored?.owed?.from ?? 0 } : move)
  const was = stored?.owed ?? null
  const notice = { cause: table.cause, by: table.change?.id ?? null }
  const owed: ClassOwed | null = raised ? { from: was !== null ? was.from : from, ...notice }
    : was !== null && alerts({ id, from: was.from ?? 0, to: n }) ? was : null
  return { verdict: { id, class: n, firstUse: firstUse(granted, reach, moving), owed }, move }
}
