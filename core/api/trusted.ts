import type { StagedSource } from './actions.ts'
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
    case 'lock.set':
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

const list = (values: readonly string[]) => values.map(quoted).join(', ')

// Notes by their scopes: ** and **/* reach every note, any other scope is quoted as data
function notes(paths: readonly string[]): string {
  if (paths.includes('**') || paths.includes('**/*')) return 'all your notes'
  return paths.length === 0 ? 'no notes' : `the notes at ${list(paths)}`
}

type Sentences = { readonly [T in Capability['type']]: (granted: Extract<Capability, { type: T }>) => string }

// What each capability type lets a plugin do, as a plain sentence for a Confirm, one row a type. Each scope, host,
// topic, command, variable and plugin a plugin named is quoted as data
const sentences: Sentences = {
  'luoshu.read': ({ paths }) => `Read ${notes(paths)}`,
  'luoshu.write': ({ paths }) => `Create, change, move and delete ${notes(paths)}`,
  'luoshu.list': ({ paths }) => `See the names of ${notes(paths)}`,
  'ui.read': ({ paths }) => `Read ${notes(paths)} while you have them open`,
  'ui.edit': ({ paths }) => `Edit ${notes(paths)} while you have them open, for you to save`,
  'lock.set': ({ paths }) => `Lock ${notes(paths)} so nothing else changes them for a while`,
  history: ({ access, paths }) => (access === 'read' ? `Read the earlier versions of ${notes(paths)}` : `Save versions of ${notes(paths)} into hetu’s history`),
  'net.fetch': ({ hosts }) => (hosts.length === 0
    ? 'Send data to and get data from no site'
    : `Send data to and get data from ${hosts.includes('*') ? 'any site' : list(hosts)} over the network`),
  'ui.view': () => 'Show panes and items of its own in the editor window',
  'ui.layout': () => 'Lay out the whole editor window once you pick it as the layout',
  'ui.decoration': () => 'Mark up how the text of an open note looks',
  'ui.command': () => 'Add commands and keyboard shortcuts',
  'ui.keys': () => 'See each key you press in an open note',
  'events.subscribe': ({ topics }) => (topics.length === 0 ? 'Hear no events' : `Hear the events ${list(topics)}`),
  storage: () => 'Keep data of its own',
  // A command runs as a program of the human's, not in the plugin's sandbox
  exec: ({ commands, env }) => `Run the command${commands.length === 1 ? '' : 's'} ${commands.map(command => JSON.stringify(command)).join(', ')} outside the sandbox with your rights on this computer${env.length > 0 ? `, with ${list(env)} from your environment` : ''}`,
  'plugin.call': ({ targets }) => (targets.length === 0 ? 'Call no other plugin' : `Call the plugin${targets.length === 1 ? '' : 's'} ${list(targets)}`),
  'guard.hook': () => 'Check each change to a note before it is written',
  'log.read': () => 'Read hetu’s event log',
}

export function grantSentence(granted: Capability): string {
  return (sentences[granted.type] as (granted: Capability) => string)(granted)
}

// What an install says of the plugins it takes, which no signature proves yet
export const UNSIGNED = 'Unsigned: nothing proves who made these plugins. Install only what comes from a source you trust'

// The source as the core staged it, a link's with the release it took the zip from
export function sourceLine(source: StagedSource): string {
  if (source.kind === 'link') return `From ${quoted(source.asset)} in the release ${quoted(source.tag)} of ${quoted(source.link)}`
  return `From the ${source.kind} ${quoted(source.path)}`
}
