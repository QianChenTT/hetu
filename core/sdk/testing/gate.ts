import { capabilityTypes, pairTypes, scopedUiTypes, type Capability } from '../../api/capabilities.ts'
import type { Caller } from '../../api/envelope.ts'
import { commandKey } from '../../api/exec.ts'
import { scopeMatches } from '../../api/scope.ts'
import type { Access, Decision, Gate, Pair } from '../../api/policy-jobs.ts'
import { windowGrants } from '../../api/windows.ts'

// manifest grants the plugin its manifest's capabilities, as a real hetu's approval grants them. allow-all and
// deny-all grant it everything or nothing. gate-failed fails the gate policy job, so every call with power answers
// policy-down. dependency-missing holds back the plugin's requires until the test restores them
export type FakeMode = 'manifest' | 'allow-all' | 'deny-all' | 'gate-failed' | 'dependency-missing'

// Whether grants hold an access, with core/api's matcher on a volume that keeps case. A plugin that passes here then
// leans on no volume that folds case. An access whose scope lacks what its type is judged on is held by nothing, as the
// gate refuses it, and so is net.fetch, whose scope holds no host yet
export function holds(granted: readonly Capability[], access: Pick<Access, 'capability' | 'scope'>): boolean {
  const { paths, topics, command } = access.scope
  const covered = (grants: readonly string[]) => paths !== undefined && paths.length > 0
    && paths.every(path => grants.some(grant => scopeMatches(grant, path, { foldCase: false })))
  return granted.some(item => {
    if (item.type !== access.capability) return false
    if (item.type === 'luoshu.read' || item.type === 'luoshu.write' || item.type === 'luoshu.list' || item.type === 'ui.edit' || item.type === 'ui.read' || item.type === 'lock.set') {
      return covered(item.paths)
    }
    // A history item counts only for the access it names, so a read item never covers a commit
    if (item.type === 'history') return item.access === access.scope.access && covered(item.paths)
    if (item.type === 'plugin.call') return access.scope.target !== undefined && item.targets.includes(access.scope.target)
    if (item.type === 'events.subscribe') return topics !== undefined && topics.length > 0 && topics.every(topic => item.topics.includes(topic))
    // The whole argument array, so a command matches only the same arguments in the same order
    if (item.type === 'exec') return command !== undefined && command.length > 0 && item.commands.some(held => commandKey(held) === commandKey(command))
    if (item.type === 'net.fetch') return false
    return true
  })
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
