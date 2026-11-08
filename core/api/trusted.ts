import type { Capability } from './capabilities.ts'

// What the trusted window's page shares with the core, kept apart from zod so the page bundles none of it

// How long the trusted window takes no input after it shows or gains focus. A click or a key already on its way lands
// within a human reaction time of a few hundred ms. Firefox keeps the buttons of its security dialogs disabled for
// 1000 ms by default (security.dialog_enable_delay)
export const INPUT_DELAY_MS = 1000

const quoted = (value: string) => JSON.stringify(value)

// One capability as its type and each scope quoted, so a scope a plugin wrote reads as data and not as a sentence
export function capabilityText(granted: Capability): string {
  switch (granted.type) {
    case 'luoshu.read':
    case 'luoshu.write':
      return `${granted.type} on ${granted.paths.map(quoted).join(', ')}`
    case 'history':
      return `history ${granted.access} on ${granted.paths.map(quoted).join(', ')}`
    case 'net.fetch':
      return `net.fetch to ${granted.hosts.map(quoted).join(', ')}`
    case 'events.subscribe':
      return `events.subscribe to ${granted.topics.join(', ')}`
    case 'exec':
      return `exec of ${granted.commands.map(command => quoted(command.join(' '))).join(', ')}`
    case 'plugin.call':
      return `plugin.call to ${granted.targets.join(', ')}`
    default:
      return granted.type
  }
}
