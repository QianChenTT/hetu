import type { Capability } from 'hetu-core/api/capabilities.ts'
import { classNames, type Capabilities, type ScreenSubject } from 'hetu-core/api/slots.ts'
import { capabilityText } from 'hetu-core/api/trusted.ts'

// A scope stays inside one place when its first part is a plain folder or note name. One with a wildcard there, **
// or * or another, reaches across the whole notes folder, whatever comes after
const confined = (scope: string) => {
  const first = scope.split('/')[0]
  return first !== '' && !/[*?[\]{}]/.test(first)
}

// One grant's class, from the table Han took on 2026-10-23. A subscription reaches nothing on its own, since an event
// carries a path only to a subscriber that may list it. The key stream holds what is typed, so it reads. A type this
// plugin doesn't know is 4, so nothing new is ever class 0 and updates on its own by default
function classOf(granted: Capability): number {
  switch (granted.type) {
    case 'ui.view':
    case 'ui.decoration':
    case 'ui.command':
    case 'ui.layout':
    case 'storage':
    case 'events.subscribe':
    case 'plugin.call':
      return 0
    case 'ui.keys':
    case 'luoshu.read':
    case 'luoshu.list':
      return 1
    case 'luoshu.write':
      return granted.paths.every(confined) ? 2 : 4
    case 'history':
      return 2
    case 'net.fetch':
      return granted.hosts.includes('*') ? 4 : 3
    case 'exec':
    case 'guard.hook':
    case 'log.read':
      return 4
    default:
      return 4
  }
}

// What tells a plugin a note's content: reading it, listing it, the key stream and history read, and a write, whose
// version check answers whether a guessed text is the note's
const reads = (granted: Capability) => granted.type === 'luoshu.read' || granted.type === 'luoshu.list' || granted.type === 'ui.keys'
  || granted.type === 'luoshu.write' || (granted.type === 'history' && granted.access === 'read')
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

    // A plugin with network, its own or through the plugins it is connected to, names the connected plugins that read
    screen({ granted, reachable, callers }: ScreenSubject): string[] {
      const n = classify(granted, reachable)
      const readers = [...granted, ...reachable].some(network) ? callers.filter(caller => caller.granted.some(reads)).map(caller => caller.id) : []
      let head = `Class ${n}, ${classNames[n]}`
      if (n === 4 && paired([...granted, ...reachable])) head += ': it can read notes and reach the network, so it could send notes out'
      else if (n === 4) head += `: ${granted.filter(item => classOf(item) === 4).map(capabilityText).join(', ')}`
      const lines = [head]
      if (reachable.length > 0) lines.push(`Through plugin.call it is connected to: ${[...new Set(reachable.map(capabilityText))].join(', ')}`)
      if (readers.length > 0) lines.push(`Plugins that read and are connected to it through plugin.call: ${readers.join(', ')}`)
      return lines
    },
  }
}
