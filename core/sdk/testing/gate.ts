import type { Capability } from '../../api/capabilities.ts'
import type { Caller } from '../../api/envelope.ts'
import { scopeMatches } from '../../api/scope.ts'
import type { Access, Decision, Gate } from '../../api/slots.ts'

// manifest grants the plugin its manifest's capabilities, as a real hetu grants a first-party plugin. allow-all and
// deny-all grant it everything or nothing. gate-failed fails the gate slot, so every call with power answers
// policy-down. dependency-missing holds back the plugin's requires until the test restores them
export type FakeMode = 'manifest' | 'allow-all' | 'deny-all' | 'gate-failed' | 'dependency-missing'

// Whether grants hold an access, with core/api's matcher on a volume that keeps case. A plugin that passes here then
// leans on no volume that folds case
export function holds(granted: readonly Capability[], access: Pick<Access, 'capability' | 'scope'>): boolean {
  return granted.some(item => {
    if (item.type !== access.capability) return false
    if (item.type === 'luoshu.read' || item.type === 'luoshu.write' || item.type === 'luoshu.list' || item.type === 'ui.edit') {
      const paths = access.scope.paths ?? []
      return paths.every(path => item.paths.some(grant => scopeMatches(grant, path, { foldCase: false })))
    }
    if (item.type === 'plugin.call') return access.scope.target !== undefined && item.targets.includes(access.scope.target)
    if (item.type === 'events.subscribe') return (access.scope.topics ?? []).every(topic => item.topics.includes(topic))
    return true
  })
}

// The gate the mode gives the plugin under test. Every other plugin gets the grants the test named for it
export class ModeGate implements Gate {
  readonly grants = new Map<string, readonly Capability[]>()
  private readonly plugin: string
  private readonly mode: FakeMode
  private readonly manifest: readonly Capability[]

  constructor(plugin: string, mode: FakeMode, manifest: readonly Capability[]) {
    this.plugin = plugin
    this.mode = mode
    this.manifest = manifest
  }

  decide(access: Access): Decision {
    return this.answer(access.caller, granted => holds(granted, access))
      ? { allow: true, view: 1 }
      : { allow: false, code: 'not-granted', view: 1 }
  }

  canRead(caller: Caller, path: string): boolean {
    return this.answer(caller, granted => holds(granted, { capability: 'luoshu.read', scope: { paths: [path] } }))
  }

  canList(caller: Caller, path: string): boolean {
    return this.answer(caller, granted => ['luoshu.list', 'luoshu.read'].some(capability =>
      holds(granted, { capability: capability as 'luoshu.list', scope: { paths: [path] } })))
  }

  verbs(): string[] {
    return []
  }

  stateChanged(): void {}

  private answer(caller: Caller, check: (granted: readonly Capability[]) => boolean): boolean {
    if (caller.kind !== 'plugin') return false
    if (caller.id !== this.plugin) return check(this.grants.get(caller.id) ?? [])
    if (this.mode === 'allow-all') return true
    if (this.mode === 'deny-all') return false
    return check(this.manifest)
  }
}
