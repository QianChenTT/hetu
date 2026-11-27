import { capabilityTypes, pairTypes, scopedUiTypes, type Capability } from '../../api/capabilities.ts'
import type { Caller } from '../../api/envelope.ts'
import { commandKey } from '../../api/exec.ts'
import { scopeMatches } from '../../api/scope.ts'
import type { Access, Decision, Gate, Pair } from '../../api/policy-jobs.ts'
import { windowGrants } from '../../api/windows.ts'

// manifest grants the plugin its manifest's capabilities, as a real hetu's approval grants them. allow-all and
// deny-all grant it everything or nothing and never reach a window, which holds core/api's window grants in every mode.
// gate-failed fails the gate policy job, so every call with power answers policy-down. dependency-missing holds back the
// plugin's requires until the test restores them
export type FakeMode = 'manifest' | 'allow-all' | 'deny-all' | 'gate-failed' | 'dependency-missing'

// Whether grants hold an access, with core/api's matcher on a volume that keeps case. A plugin that passes here then
// leans on no volume that folds case. Each path, topic or command of the access needs an item of its type that covers
// it, any item for each, as the gate judges each part. An access whose scope lacks what its type is judged on is held by
// nothing, as the gate refuses it, and so is net.fetch, whose scope holds no host yet. A type no branch here models
// throws, so a new one can't pass unjudged
export function holds(granted: readonly Capability[], access: Pick<Access, 'capability' | 'scope'>): boolean {
  const { capability, scope } = access
  const items = granted.filter(item => item.type === capability)
  // Every part covered by some item, none at all for an empty or missing list
  const each = <T>(parts: readonly T[] | undefined, covers: (item: Capability, part: T) => boolean) =>
    Array.isArray(parts) && parts.length > 0 && parts.every(part => items.some(item => covers(item, part)))
  const inPaths = (item: Capability, path: string) => 'paths' in item && item.paths.some(grant => scopeMatches(grant, path, { foldCase: false }))
  switch (capability) {
    case 'luoshu.read': case 'luoshu.write': case 'luoshu.list': case 'ui.edit': case 'ui.read': case 'lock.set':
      return each(scope.paths, inPaths)
    // A history item counts only for the access it names, so a read item never covers a commit
    case 'history':
      return (scope.access === 'read' || scope.access === 'commit')
        && each(scope.paths, (item, path) => item.type === 'history' && item.access === scope.access && inPaths(item, path))
    case 'plugin.call':
      return typeof scope.target === 'string' && each([scope.target], (item, target) => item.type === 'plugin.call' && item.targets.includes(target))
    case 'events.subscribe':
      return each(scope.topics, (item, topic) => item.type === 'events.subscribe' && item.topics.includes(topic))
    // The whole argument array as one part, every argument a string, so a command matches only the same arguments in
    // the same order
    case 'exec': {
      const { command } = scope
      if (!Array.isArray(command) || command.length === 0 || !command.every(arg => typeof arg === 'string')) return false
      return each([commandKey(command)], (item, key) => item.type === 'exec' && item.commands.some(held => commandKey(held) === key))
    }
    case 'net.fetch':
      return false
    case 'ui.view': case 'ui.decoration': case 'ui.command': case 'ui.keystream': case 'storage': case 'guard.hook': case 'log.read': case 'door.handle':
      return items.length > 0
    default:
      throw new Error(`the fake gate does not model ${String(capability satisfies never)}`)
  }
}

// A pair's key in ModeGate.pairs: the root plugin's id and the grant key of its field
export const pairKey = (pair: Pair) => `${pair.plugin}\n${pair.field}`

// The gate the mode gives the plugin under test. Every other plugin gets the grants the test named for it, and each
// pair the grants the test named for it by pairKey. The mode never reaches a pair's grants. A window holds core/api's
// fixed window grants, as at the gate. Switches, a first use that asks, a volume that folds case and a revoked pair are
// not modelled: grants come from the test, never from a grants snapshot, so stateChanged refuses one
export class ModeGate implements Gate {
  readonly grants = new Map<string, readonly Capability[]>()
  readonly pairs = new Map<string, readonly Capability[]>()
  private readonly plugin: string
  private readonly mode: FakeMode
  private readonly manifest: readonly Capability[]

  constructor(plugin: string, mode: FakeMode, manifest: readonly Capability[]) {
    this.plugin = plugin
    this.mode = mode
    this.manifest = manifest
  }

  decide(access: Access): Decision {
    return this.judge(access.caller, access.pair, granted => holds(granted, access))
      ? { allow: true, view: 1 }
      : { allow: false, code: 'not-granted', view: 1 }
  }

  canRead(caller: Caller, path: string, pair?: Pair): boolean {
    return this.judge(caller, pair, granted => holds(granted, { capability: 'luoshu.read', scope: { paths: [path] } }))
  }

  canList(caller: Caller, path: string, pair?: Pair): boolean {
    return this.judge(caller, pair, granted => ['luoshu.list', 'luoshu.read'].some(capability =>
      holds(granted, { capability: capability as 'luoshu.list', scope: { paths: [path] } })))
  }

  // The ui verbs a plugin holds whole in the editor, a ui item scoped by paths left out, as the gate answers gate.reach
  verbs(plugin: string, window: string): string[] {
    if (window !== 'editor') return []
    const whole = capabilityTypes.filter(type => type.startsWith('ui.') && !(scopedUiTypes as readonly string[]).includes(type))
    const caller: Caller = { kind: 'plugin', id: plugin, half: 'worker', incarnation: 1 }
    return whole.filter(type => this.answer(caller, granted => granted.some(item => item.type === type)))
  }

  stateChanged(): void {
    throw new Error('the fake gate takes grants from the test and does not model a grants snapshot')
  }

  // A call for a pair needs the caller's grants and the pair's both, as the gate judges it. A pair holds only the
  // types pairTypes lists
  private judge(caller: Caller, pair: Pair | undefined, check: (granted: readonly Capability[]) => boolean): boolean {
    if (!this.answer(caller, check)) return false
    if (pair === undefined) return true
    return check((this.pairs.get(pairKey(pair)) ?? []).filter(item => (pairTypes as readonly string[]).includes(item.type)))
  }

  private answer(caller: Caller, check: (granted: readonly Capability[]) => boolean): boolean {
    if (caller.kind === 'window') return check(windowGrants[caller.role] ?? [])
    if (caller.kind !== 'plugin') return false
    if (caller.id !== this.plugin) return check(this.grants.get(caller.id) ?? [])
    if (this.mode === 'allow-all') return true
    if (this.mode === 'deny-all') return false
    return check(this.manifest)
  }
}
