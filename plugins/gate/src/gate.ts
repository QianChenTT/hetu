import { capabilityKey, type Capability, type CapabilityType } from 'hetu-core/api/capabilities.ts'
import type { Caller } from 'hetu-core/api/envelope.ts'
import { compileScopes } from 'hetu-core/api/scope.ts'
import type { Access, Decision, Gate, GrantedItem, Scope, StateView } from 'hetu-core/api/slots.ts'
import { windowGrants } from 'hetu-core/api/windows.ts'

// How the gate reads each type's scope: paths through the matcher, every topic named, the target, held with no scope
// at all, or none for a type whose provider hasn't brought the fields the gate would need, which refuses
export type Rule = 'paths' | 'topics' | 'target' | 'held' | 'none'

export const scopeRules: Readonly<Record<CapabilityType, Rule>> = Object.freeze({
  'luoshu.read': 'paths',
  'luoshu.write': 'paths',
  'luoshu.list': 'paths',
  'events.subscribe': 'topics',
  'plugin.call': 'target',
  'log.read': 'held',
  'ui.view': 'held',
  'ui.decoration': 'held',
  'ui.command': 'held',
  'ui.layout': 'held',
  'ui.keys': 'held',
  storage: 'held',
  'guard.hook': 'held',
  // Scope holds no host, no read or commit and no command yet
  'net.fetch': 'none',
  history: 'none',
  exec: 'none',
})

// One item as the gate matches it, compiled once per StateView
type Compiled = { type: string, off: boolean, firstUse: boolean, key: string, covers: (part: string) => boolean }

const on = (item: Compiled) => !item.off && !item.firstUse

function compile(item: GrantedItem, foldCase: boolean): Compiled {
  const { capability, off, firstUse } = item
  if (typeof capability !== 'object' || capability === null || typeof capability.type !== 'string') throw new Error('an item with no capability')
  if (typeof off !== 'boolean' || typeof firstUse !== 'boolean') throw new Error('an item with no switch')
  const rule = scopeRules[capability.type]
  let covers: (part: string) => boolean = () => false
  if (rule === 'paths' && 'paths' in capability) covers = compileScopes(capability.paths, { foldCase })
  if (rule === 'topics' && 'topics' in capability) covers = set(capability.topics)
  if (rule === 'target' && 'targets' in capability) covers = set(capability.targets)
  if (rule === 'held') covers = () => true
  return { type: capability.type, off, firstUse, key: capabilityKey(capability), covers }
}

function set(values: readonly string[]): (part: string) => boolean {
  const held = new Set(values)
  return part => held.has(part)
}

// What a call reaches that the rule judges, each part needing an item that covers it. null when the scope lacks the
// field the rule needs, which refuses
function partsOf(rule: Rule, scope: Scope): readonly string[] | null {
  if (rule === 'paths') return Array.isArray(scope.paths) && scope.paths.length > 0 ? scope.paths : null
  if (rule === 'topics') return Array.isArray(scope.topics) && scope.topics.length > 0 ? scope.topics : null
  if (rule === 'target') return typeof scope.target === 'string' ? [scope.target] : null
  if (rule === 'held') return ['']
  return null
}

type Held = { view: number, foldCase: boolean, plugins: Map<string, Compiled[]>, windows: Map<string, Compiled[]> }

// The gate the gate plugin holds. It decides on the newest StateView and on core/api's fixed window grants, and keeps
// nothing else between calls
export function createGate(): Gate {
  let held: Held | null = null

  function itemsOf(caller: Caller): readonly Compiled[] {
    if (held === null) throw new Error('no StateView yet')
    if (caller.kind === 'plugin') return held.plugins.get(caller.id) ?? []
    if (caller.kind === 'window') return held.windows.get(caller.role) ?? []
    // A content caller is reserved for #97 and holds nothing
    return []
  }

  return {
    decide(access: Access): Decision {
      const items = itemsOf(access.caller)
      const view = held!.view
      const refused = (code: 'not-granted' | 'switched-off'): Decision => ({ allow: false, code, view })
      const rule = scopeRules[access.capability] ?? 'none'
      const parts = partsOf(rule, access.scope)
      if (parts === null) return refused('not-granted')
      const ofType = items.filter(item => item.type === access.capability)
      let switchedOff = false
      let ask: string | null = null
      for (const part of parts) {
        const inside = ofType.filter(item => item.covers(part))
        if (inside.length === 0) return refused('not-granted')
        if (inside.some(on)) continue
        const asking = inside.find(item => !item.off)
        if (asking === undefined) switchedOff = true
        else ask ??= asking.key
      }
      if (switchedOff) return refused('switched-off')
      // The raw stage can only refuse, so an item whose first use asks passes there and asks at the canonical one
      if (ask !== null && access.stage === 'canonical') return { ask, view }
      return { allow: true, view }
    },

    canRead(caller: Caller, path: string): boolean {
      return itemsOf(caller).some(item => item.type === 'luoshu.read' && on(item) && item.covers(path))
    },

    // A name is listed through luoshu.list, or through luoshu.read, which lists what it reads
    canList(caller: Caller, path: string): boolean {
      return itemsOf(caller).some(item => (item.type === 'luoshu.list' || item.type === 'luoshu.read') && on(item) && item.covers(path))
    },

    verbs(plugin: string, window: string): string[] {
      if (held === null || window !== 'editor') return []
      const items = held.plugins.get(plugin) ?? []
      return [...new Set(items.filter(item => item.type.startsWith('ui.') && on(item)).map(item => item.type))]
    },

    // Every item compiled once here. A throw marks the gate failed, so a view it can't read leaves it refusing
    stateChanged(next: StateView): void {
      const { n, foldCase, plugins } = next
      if (!Number.isSafeInteger(n) || typeof foldCase !== 'boolean' || typeof plugins !== 'object' || plugins === null) {
        throw new Error('a StateView the gate can\'t read')
      }
      const compiled = new Map<string, Compiled[]>()
      for (const [id, items] of Object.entries(plugins)) {
        if (!Array.isArray(items)) throw new Error('a plugin with no items')
        compiled.set(id, items.map(item => compile(item, foldCase)))
      }
      const windows = new Map<string, Compiled[]>()
      for (const [role, grants] of Object.entries(windowGrants)) {
        windows.set(role, grants.map((capability: Capability) => compile({ capability, off: false, firstUse: false }, foldCase)))
      }
      held = { view: n, foldCase, plugins: compiled, windows }
    },
  }
}
