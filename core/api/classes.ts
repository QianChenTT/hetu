import { capabilityKey, type Capability } from './capabilities.ts'
import { classCauses } from './changes.ts'
import { classNames } from './policy-jobs.ts'

// The highest class, the one a class not known counts as
export const highestClass = classNames.length - 1

// What moves a class: a change to one plugin or a pass over every entry
export type ClassCause = typeof classCauses[number]

// A notice owed for a move up with no Confirm on screen: the class last shown, null for one never known, what moved it
// and the plugin whose change it was, null for a pass
export type ClassOwed = { readonly from: number | null, readonly cause: ClassCause, readonly by: string | null }

// What a plugin's entry stores about its class: the class, null for one not known, the items that ask at first use,
// whether it was written while the human had the classifier off and the notice it owes, null for none
export type StoredClass = {
  readonly class: number | null
  readonly firstUse: readonly Capability[]
  readonly unclassed: boolean
  readonly owed: ClassOwed | null
}

// One plugin as the classifier is handed it: what it holds now and what its entry stores, null for a core plugin, which
// has no entry and is never classed
export type ClassRow = { readonly id: string, readonly granted: readonly Capability[], readonly stored: StoredClass | null }

// What the classifier is handed at every class change: the cause, the change to one plugin with what it would hold,
// null once it goes, null for a pass over every entry, whether a Confirm for the change is on screen and every plugin
// the core knows. A plugin approved now is in the change alone. An update asked whether it loads unasked carries what
// its new version asks for
export type ClassTable = {
  readonly cause: ClassCause
  readonly change: { readonly id: string, readonly granted: readonly Capability[] | null } | null
  readonly confirm: boolean
  readonly plugins: readonly ClassRow[]
  readonly requested?: readonly Capability[]
}

// The classifier's answer for one plugin: its class, the items that ask at first use whether or not the human confirmed
// them and the notice it owes, null for none
export type ClassVerdict = {
  readonly id: string
  readonly class: number
  readonly firstUse: readonly Capability[]
  readonly owed: ClassOwed | null
}

// One verdict for each plugin the change moves, the changed plugin while it stays and every entry in a pass, the lines
// the change's Confirm shows under the core's words and for an update asked so whether it loads unasked, false for
// every other change
export type ClassAnswer = { readonly plugins: readonly ClassVerdict[], readonly lines: readonly string[], readonly unasked: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const isClass = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= highestClass

// What each plugin the classifier may answer for holds once the change applies: every entry and the changed plugin
// while it stays
function answerable(table: ClassTable): Map<string, readonly Capability[]> {
  const held = new Map<string, readonly Capability[]>()
  for (const row of table.plugins) if (row.stored !== null) held.set(row.id, row.granted)
  if (table.change !== null) {
    if (table.change.granted === null) held.delete(table.change.id)
    else held.set(table.change.id, table.change.granted)
  }
  return held
}

function owedOf(value: unknown, known: ReadonlySet<string>): ClassOwed | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasOnly(value, ['from', 'cause', 'by'])) return undefined
  const { from, cause, by } = value
  if (from !== null && !isClass(from)) return undefined
  if (typeof cause !== 'string' || !classCauses.includes(cause as ClassCause)) return undefined
  if (by !== null && (typeof by !== 'string' || !known.has(by))) return undefined
  return { from: from as number | null, cause: cause as ClassCause, by: by as string | null }
}

// The classifier's answer as the core takes it, or null for one it refuses: a class a whole number from 0 to the
// highest, every field of its type and no other, a verdict only for a plugin with an entry or the changed plugin while
// it stays, each once, one for the changed plugin and in a pass one for every entry, first-use items only of what the
// plugin holds, a notice naming only plugins in the table and an update loading unasked only when the table asks.
// Each item comes back as the table holds it
export function checkedAnswer(table: ClassTable, answer: unknown): ClassAnswer | null {
  if (!isRecord(answer) || !hasOnly(answer, ['plugins', 'lines', 'unasked'])) return null
  const { plugins, lines, unasked } = answer
  if (!Array.isArray(plugins) || !Array.isArray(lines) || !lines.every(line => typeof line === 'string')) return null
  if (typeof unasked !== 'boolean' || (unasked && table.requested === undefined)) return null
  const held = answerable(table)
  const known = new Set([...table.plugins.map(row => row.id), ...(table.change === null ? [] : [table.change.id])])
  const verdicts: ClassVerdict[] = []
  for (const verdict of plugins as unknown[]) {
    if (!isRecord(verdict) || !hasOnly(verdict, ['id', 'class', 'firstUse', 'owed'])) return null
    const { id, firstUse } = verdict
    const granted = typeof id === 'string' ? held.get(id) : undefined
    if (granted === undefined || verdicts.some(seen => seen.id === id) || !isClass(verdict.class) || !Array.isArray(firstUse)) return null
    const items = new Map(granted.map(item => [capabilityKey(item), item]))
    const asks = new Map<string, Capability>()
    for (const item of firstUse as unknown[]) {
      const own = isRecord(item) ? items.get(capabilityKey(item as Capability)) : undefined
      if (own === undefined) return null
      asks.set(capabilityKey(own), own)
    }
    const owed = owedOf(verdict.owed, known)
    if (owed === undefined) return null
    verdicts.push({ id: id as string, class: verdict.class as number, firstUse: [...asks.values()], owed })
  }
  const answered = new Set(verdicts.map(verdict => verdict.id))
  const owedAnswers = table.change === null ? [...held.keys()] : table.change.granted === null ? [] : [table.change.id]
  if (!owedAnswers.every(id => answered.has(id))) return null
  return { plugins: verdicts, lines: [...lines as string[]], unasked }
}

// The grant risk classifier: handed the whole table at every class change, it answers for every plugin the change moves.
// The core checks each answer. A throw or an answer the check refuses counts as the classifier down for that one
// decision: the class not known and counted as the highest, every item asking
export type GrantRiskClassifier = { classes(table: ClassTable): ClassAnswer }
