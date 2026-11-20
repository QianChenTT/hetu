import type { Capability } from './capabilities.ts'

// What the trusted window's page shares with the core, kept apart from zod so the page bundles none of it

// How long the trusted window takes no input after it shows or gains focus. A click or a key already on its way lands
// within a human reaction time of a few hundred ms. Firefox keeps the buttons of its security dialogs disabled for
// 1000 ms by default (security.dialog_enable_delay)
export const INPUT_DELAY_MS = 1000

const quoted = (value: string) => JSON.stringify(value)

// One capability as its type and each scope quoted, a target, a topic and a variable name too, so nothing a plugin or
// its client chose reads as a sentence of the screen
export function capabilityText(granted: Capability): string {
  switch (granted.type) {
    case 'luoshu.read':
    case 'luoshu.write':
    case 'luoshu.list':
    case 'ui.edit':
    case 'ui.read':
      return `${granted.type} on ${granted.paths.map(quoted).join(', ')}`
    case 'history':
      return `history ${granted.access} on ${granted.paths.map(quoted).join(', ')}`
    case 'net.fetch':
      return `net.fetch to ${granted.hosts.map(quoted).join(', ')}`
    case 'events.subscribe':
      return `events.subscribe to ${granted.topics.map(quoted).join(', ')}`
    case 'exec':
      // Each command as its argument array, so two that run differently never read alike, then the variables it gets
      return `exec of ${granted.commands.map(command => JSON.stringify(command)).join(', ')}${granted.env.length > 0 ? ` with ${granted.env.map(quoted).join(', ')} from your environment` : ''}`
    case 'plugin.call':
      return `plugin.call to ${granted.targets.map(quoted).join(', ')}`
    default:
      return granted.type
  }
}
