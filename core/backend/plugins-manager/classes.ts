import { type ClassRaised } from '../../api/changes.ts'
import { frozen } from '../../api/plain.ts'
import { capabilityKey, type Capability } from '../../api/capabilities.ts'
import { checkedAnswer, highestClass, type ClassAnswer, type ClassCause, type ClassTable, type ClassVerdict } from '../../api/classes.ts'
import type { Plugin } from '../boot/header.ts'
import { MAX_PENDING } from './requests.ts'
import { type Read } from './verify.ts'
import { PluginsIdentities } from './identities.ts'
import { type Known } from './base.ts'

// The grant risk classifier as classing reads it: on with its module serving, off once the human switched it off, down
// any other way
type Classing = 'on' | 'off' | 'down'

// What a class change comes to for one plugin: the entry stored, null once the plugin goes, whether its class, first-use
// list, confirmed record, mark or owed notice differ from the entry before and whether it rises and so is written before
// the change that causes it
type Decided = { readonly id: string, readonly entry: Plugin | null, readonly changed: boolean, readonly rises: boolean }

// A class change: the changed plugin, null in a pass, every other entry that comes out different, the lines its Confirm
// shows and for an update asked so whether it loads unasked
type Classed = { readonly own: Decided | null, readonly others: readonly Decided[], readonly lines: readonly string[], readonly unasked: boolean }

// The same items whatever their order, an item being its type with its scope
function sameItems(items: readonly Capability[], others: readonly Capability[] = []): boolean {
  const keys = new Set(others.map(capabilityKey))
  return items.length === others.length && items.every(item => keys.has(capabilityKey(item)))
}

// The classes: the table handed to the grant risk classifier, its answer stored by the one function every class change
// goes through, the writes ordered from the class numbers stored and the notices owed raised and withdrawn
export abstract class PluginsClasses extends PluginsIdentities {
  // ---- classes

  // The grant risk classifier as classing reads it: on while its module serves, off only once the human switched it off
  // and down for anything else, a failed module included
  protected classing(): Classing {
    const state = this.policyJob('grant-risk-classifier')
    if (state === 'off') return 'off'
    return this.modules.grantRiskClassifier() !== null ? 'on' : 'down'
  }

  // What the classifier is handed: every plugin the plugins manager knows with what it holds and what its entry stores
  // (a core plugin with none) and the change to one plugin, copied so nothing the classifier does reaches the state
  protected classTable(
    cause: ClassCause, id: string | null, granted: readonly Capability[] | null, confirm: boolean, requested?: readonly Capability[],
  ): ClassTable {
    const ids = new Set([...Object.keys(this.state.plugins), ...[...this.known.values()].filter(k => k.from === 'install').map(k => k.id)])
    const plugins = [...ids].map(other => {
      const entry = this.known.get(other)?.from === 'install' ? null : this.state.plugins[other] ?? null
      const stored = entry === null ? null
        : { class: entry.class, firstUse: entry.firstUse ?? [], unclassed: entry.unclassed === true, owed: entry.owed ?? null }
      return { id: other, granted: this.grantsOf(other), stored }
    })
    return frozen(structuredClone({ cause, change: id === null ? null : { id, granted }, confirm, plugins, ...(requested === undefined ? {} : { requested }) }))
  }

  // The classifier's answer once the shape check takes it. Null with the classifier not serving, for a throw and for an
  // answer the check refuses, each a fault
  protected askClasses(table: ClassTable): ClassAnswer | null {
    const classifier = this.modules.grantRiskClassifier()
    if (classifier === null) return null
    let answer: unknown
    try {
      answer = classifier.classes(table)
    } catch {
      // A throw leaves no answer, which the check below refuses and records as a fault
    }
    const checked = checkedAnswer(table, answer)
    if (checked === null) this.note('fault', { plugin: 'grant-risk-classifier', step: 'classify' })
    return checked
  }

  // The one function every class change goes through, whatever causes it: a change to one plugin, which after is the
  // entry it leaves before it is classed, null once the plugin goes, or with id null a pass over every entry. The
  // classifier is handed the whole table and answers for every plugin the change moves. Without it the core can't tell
  // which plugins a change moves, so with the classifier switched off by the human or down every entry comes out of the
  // change as below. Switched off, a pass leaves each as stored and a change passes: the class the last one classed, the
  // entry marked as not classed and every item not confirmed listed, which the gate is handed only once the classifier
  // is on again. Down, a throw or an answer the check refuses, the class is not known and every item asks. Whether an
  // entry rises is read here from the class numbers stored, never from the classifier. requested is what an update's new
  // version asks for when the classifier is asked whether it loads unasked, which it never does while off or down
  protected classes(cause: ClassCause, id: string | null, after: Plugin | null, confirm: boolean, requested?: readonly Capability[]): Classed {
    let classing = this.classing()
    if (id === null && classing === 'off') return { own: null, others: [], lines: [], unasked: false }
    const answer = classing === 'on' ? this.askClasses(this.classTable(cause, id, after?.granted ?? null, confirm, requested)) : null
    if (answer === null && classing === 'on') classing = 'down'
    const verdicts = new Map(answer?.plugins.map(verdict => [verdict.id, verdict]))
    const notice = { cause, by: id }
    const entryOf = (other: string, before: Plugin | null, next: Plugin) =>
      this.decided({ id: other, before, after: next, verdict: verdicts.get(other) ?? null, classing, confirm, notice,
        fresh: other === id && cause === 'update' && !confirm })
    const before = id === null ? null : this.state.plugins[id] ?? null
    const own = id === null ? null : after === null ? { id, entry: null, changed: before !== null, rises: false } : entryOf(id, before, after)
    const others: Decided[] = []
    for (const [other, entry] of Object.entries(this.state.plugins)) {
      if (other === id || this.known.get(other)?.from === 'install' || (answer !== null && !verdicts.has(other))) continue
      const decided = entryOf(other, entry, entry)
      if (decided.changed) others.push(decided)
    }
    const down = `The grant risk classifier is down, so the class is unknown and counted as ${highestClass}: every item asks at its first use`
    const lines = answer !== null ? answer.lines : classing === 'down' && after !== null ? [down] : []
    return { own, others, lines, unasked: answer?.unasked === true }
  }

  // One plugin's entry as a class change leaves it, from the classifier's verdict or, with none, from the fallback the
  // classifier's state names. A confirmed item stays confirmed while the plugin holds it, until new code applies with no
  // Confirm on screen. Down, every item asks (confirmed ones too) and an entry stored with no Confirm on screen keeps the
  // class it held as the class last shown in its mark, so a move up made while the class is not known is measured from it
  // once the class is known again. An entry marked as not classed held no class the human was shown
  protected decided(change: {
    id: string, before: Plugin | null, after: Plugin, verdict: ClassVerdict | null, classing: Classing, confirm: boolean,
    notice: { cause: ClassCause, by: string | null }, fresh: boolean,
  }): Decided {
    const { id, before, after, verdict, classing, confirm, notice } = change
    const held = new Set(after.granted.map(capabilityKey))
    const confirmed = (change.fresh ? [] : before?.confirmed ?? []).filter(item => held.has(capabilityKey(item)))
    const known = new Set(confirmed.map(capabilityKey))
    const was = before?.owed
    const forgets = classing === 'down' && !confirm && was === undefined && before !== null && before.class !== null && before.unclassed !== true
    const n = verdict !== null ? verdict.class : classing === 'off' ? before?.class ?? null : null
    const asking = verdict !== null ? verdict.firstUse.filter(item => !known.has(capabilityKey(item)))
      : after.granted.filter(item => classing === 'down' || !known.has(capabilityKey(item)))
    const owed = verdict !== null ? verdict.owed ?? undefined : forgets ? { from: before.class, cause: notice.cause, by: notice.by } : was
    const next: Plugin = { ...after, class: n }
    delete next.firstUse
    delete next.confirmed
    delete next.unclassed
    delete next.owed
    if (asking.length > 0) next.firstUse = [...asking]
    if (confirmed.length > 0) next.confirmed = confirmed
    if (classing === 'off' || (classing === 'down' && after.unclassed === true)) next.unclassed = true
    if (owed !== undefined) next.owed = owed
    const listed = new Set((before?.firstUse ?? []).map(capabilityKey))
    const rank = (m: number | null | undefined) => m ?? highestClass
    const changed = before === null || n !== before.class || !sameItems(asking, before.firstUse) || !sameItems(confirmed, before.confirmed)
      || next.unclassed !== before.unclassed || JSON.stringify(owed) !== JSON.stringify(before.owed)
    const rises = asking.some(item => !listed.has(capabilityKey(item))) || (next.unclassed === true && before?.unclassed !== true)
      || rank(n) > rank(before?.class)
    return { id, entry: next, changed, rises }
  }

  // The plugins a change decided for
  protected touched(change: Classed): string[] {
    return [...(change.own === null ? [] : [change.own]), ...change.others].map(decided => decided.id)
  }

  // A plugin's new entry as classing gave it written with the others the change classed, a class that rises settled
  // before the write and one that falls after, then each notice owed raised
  protected async writeClassed(id: string, change: Classed): Promise<void> {
    const entry = change.own!.entry!
    await this.withClassChange(change, async () => {
      await this.store.writePlugin(id, entry)
      this.putEntry(id, entry)
    })
  }

  // A plugin-folder entry gone with the class change its going makes, then gone run
  protected async entryGone(id: string, change: Classed, gone: () => void = () => {}): Promise<void> {
    await this.withClassChange(change, async () => {
      await this.store.removePlugin(id)
      delete this.state.plugins[id]
      gone()
    })
  }

  // The changed plugin's own write with the entries the change moves: those that rise written before it and the rest
  // after, then the notices owed raised
  protected async withClassChange(change: Classed, write: () => Promise<void>): Promise<void> {
    await this.settle(change.others, true)
    await write()
    await this.settle(change.others, false)
    this.raiseOwed(this.touched(change))
  }

  // A notice in the trusted window for each of these plugins whose entry owes one, from the class last shown to the one
  // it holds, naming the cause and the plugin whose change it was. Notices take places of their own. One that finds no
  // place stays owed and is raised again once a notice is answered or at the next start, and a notice that says what is
  // no longer owed goes. The class and its asks are stored already, so a notice holds nothing back
  protected raiseOwed(ids: Iterable<string>): void {
    for (const id of ids) {
      const entry = this.state.plugins[id]
      const owed = entry?.owed
      // A class not known while the policy job is down: the notice held stays as it was until the class is known again
      if (owed !== undefined && entry!.class === null) continue
      const notice: ClassRaised | null = owed === undefined
        ? null : { kind: 'class.raised', plugin: id, from: owed.from, to: entry!.class!, cause: owed.cause, by: owed.by }
      this.requests.withdraw(held => held.kind === 'class.raised' && held.plugin === id
        && (notice === null || held.from !== notice.from || held.to !== notice.to || held.cause !== notice.cause || held.by !== notice.by))
      if (notice === null) continue
      if (typeof this.requests.raise(notice, null, MAX_PENDING, 'class.raised') !== 'string') this.note('fault', { plugin: id, step: 'class.raised' })
    }
  }

  // The human answered a plugin's notice, with Confirm or Cancel: its entry owes it no longer, and a notice that found
  // no place before can take the one freed
  protected async answered(id: string): Promise<void> {
    const entry = this.state.plugins[id]
    if (entry?.owed !== undefined) {
      const next: Plugin = { ...entry }
      delete next.owed
      await this.store.writePlugin(id, next)
      this.putEntry(id, next)
    }
    this.raiseOwed([id])
    this.raiseOwed(Object.keys(this.state.plugins))
  }

  // An approval's entry before it is classed, from the one read the request was made on: its hash, version and the
  // manifest's grants
  protected approval(k: Known): Plugin {
    const manifest = k.read.manifest!
    return { version: manifest.version, contentHash: k.read.hash!, signer: null, granted: manifest.capabilities ?? [], class: null, enabled: true }
  }

  // Every plugin-folder entry classed again at start from the graph as it stands, before any plugin-folder plugin runs:
  // an app update can change what a core plugin holds with no change to any entry and an entry can be out of date.
  // Only an entry that comes out different is written. One that rises and can't be written still asks in the run, one
  // that lowers keeps its entry. The same pass runs once the human switches the grant risk classifier on again in the run.
  // A move up there that alerts gets its notice
  protected async classAll(cause: 'start' | 'slot-on'): Promise<void> {
    let changed = false
    for (const decided of this.classes(cause, null, null, false).others) {
      const { id } = decided
      if (decided.entry === null) continue
      try {
        await this.store.writePlugin(id, decided.entry)
      } catch {
        this.note('fault', { plugin: id, step: 'reclass' })
        if (!decided.rises) continue
      }
      this.putEntry(id, decided.entry)
      changed = true
    }
    if (changed) this.bump()
    // Every notice an entry owes, a new one or one a run before never saw answered
    this.raiseOwed(Object.keys(this.state.plugins))
  }

  // Writes the entries of the other plugins a change moves: those that rise before the change's own write and the rest
  // after it, so a write that fails between them leaves a class too high or an item asking, never a class too low. A
  // write after the change that fails leaves that entry as it was, higher
  protected async settle(others: readonly Decided[], rises: boolean): Promise<void> {
    for (const other of others) {
      if (other.rises !== rises || other.entry === null) continue
      const written = this.store.writePlugin(other.id, other.entry)
      if (rises) await written
      else if (!await written.then(() => true, () => false)) {
        this.note('fault', { plugin: other.id, step: 'reclass' })
        continue
      }
      this.putEntry(other.id, other.entry)
    }
  }
}
