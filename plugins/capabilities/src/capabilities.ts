import type { Capability } from 'hetu-core/api/capabilities.ts'
import { classNames, type Capabilities, type ScreenSubject } from 'hetu-core/api/slots.ts'
import { capabilityText } from 'hetu-core/api/trusted.ts'

// A scope whose first part is ** reaches the notes of every folder
const everywhere = (paths: readonly string[]) => paths.some(scope => scope === '**' || scope.startsWith('**/'))

// One grant's class, from the table Han took on 2026-10-23. A subscription reaches nothing on its own, since an event
// carries a path only to a subscriber that may list it. The key stream holds what is typed, so it reads
function classOf(granted: Capability): number {
  switch (granted.type) {
    case 'ui.keys':
    case 'luoshu.read':
    case 'luoshu.list':
      return 1
    case 'luoshu.write':
      return everywhere(granted.paths) ? 4 : 2
    case 'history':
      return 2
    case 'net.fetch':
      return granted.hosts.includes('*') ? 4 : 3
    case 'exec':
    case 'guard.hook':
    case 'log.read':
      return 4
    default:
      return 0
  }
}

const reads = (granted: Capability) => granted.type === 'luoshu.read' || granted.type === 'luoshu.list' || granted.type === 'ui.keys'
  || (granted.type === 'history' && granted.access === 'read')
const network = (granted: Capability) => granted.type === 'net.fetch'

// Reading and network anywhere in what a plugin holds and reaches, which together could send notes out (Han)
const paired = (all: readonly Capability[]) => all.some(reads) && all.some(network)

export function createCapabilities(): Capabilities {
  const classify = (granted: readonly Capability[], reachable: readonly Capability[]): number => {
    const all = [...granted, ...reachable]
    return paired(all) ? 4 : Math.max(0, ...all.map(classOf))
  }

  return {
    classify,

    // The items whose own class is 4, and for a pair the items that close it: the plugin's network items, or with none of
    // its own the plugin.call items that bring the network in
    firstUse(granted: readonly Capability[], reachable: readonly Capability[]): Capability[] {
      const pair = paired([...granted, ...reachable])
      const closing = granted.some(network) ? network : (item: Capability) => item.type === 'plugin.call'
      return granted.filter(item => classOf(item) === 4 || (pair && closing(item)))
    },

    // A plugin with network, its own or reached, names the plugins that read and can reach it
    screen({ granted, reachable, callers }: ScreenSubject): string[] {
      const n = classify(granted, reachable)
      const readers = [...granted, ...reachable].some(network) ? callers.filter(caller => caller.granted.some(reads)).map(caller => caller.id) : []
      let head = `Class ${n}, ${classNames[n]}`
      if (n === 4 && paired([...granted, ...reachable])) head += ': it can read notes and reach the network, so it could send notes out'
      else if (n === 4) head += `: ${granted.filter(item => classOf(item) === 4).map(capabilityText).join(', ')}`
      const lines = [head]
      if (reachable.length > 0) lines.push(`Through plugin.call it reaches: ${[...new Set(reachable.map(capabilityText))].join(', ')}`)
      if (readers.length > 0) lines.push(`Plugins that read and can reach it: ${readers.join(', ')}`)
      return lines
    },
  }
}
