import type { InstallProblem, ListedPlugin, SecurityList, StagedSource } from './actions.ts'
import type { Capability } from './capabilities.ts'

// What the trusted window's page shares with the core, kept apart from zod so the page bundles none of it

// How long the trusted window takes no input after it shows or gains focus. A click or a key already on its way lands
// within a human reaction time of a few hundred ms. Firefox keeps the buttons of its security dialogs disabled for
// 1000 ms by default (security.dialog_enable_delay)
export const INPUT_DELAY_MS = 1000

const quoted = (value: string) => JSON.stringify(value)

// Characters that draw nothing or reorder the text around them
const HIDDEN = /[\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g

// A folder or file path in quotes. A path that holds no quote, no control or hidden character, no lone surrogate and
// no backslash at its end, as an ordinary Windows path, shows as it is, each backslash once. Any other is escaped as
// data with each hidden character as its code, so it can't end its quotes early or reorder what follows them
export function quotedPath(path: string): string {
  const plain = path.isWellFormed() && !/["\u0000-\u001f]/.test(path) && path.search(HIDDEN) === -1 && !path.endsWith('\\')
  if (plain) return `"${path}"`
  return quoted(path).replace(HIDDEN, hidden => `\\u${hidden.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

// A plugin-folder plugin the human approved: found and new is one waiting for its approval
const approved = (plugin: ListedPlugin) => plugin.from === 'folder' && !(plugin.state === 'found' && plugin.reason === 'new')

// Its items are what was granted, switched off or not
const holdsLayout = (plugin: ListedPlugin) => plugin.items.some(item => item.capability.type === 'ui.layout')

// An approved plugin that hetu didn't refuse and that didn't fail. Switched off still counts
export const approvedNotRefused = (plugin: ListedPlugin) => approved(plugin) && plugin.state !== 'refused' && plugin.state !== 'failed'

export function layoutApproved(list: SecurityList): boolean {
  return list.plugins.some(plugin => approvedNotRefused(plugin) && holdsLayout(plugin))
}

// The welcome guide is due while hetu runs and the human never approved a plugin holding ui.layout: main opens the
// trusted window on it at start and the window opens on its tab. An approved layout that fails or is refused still
// counts, so a set-up hetu whose layout broke isn't greeted with the first steps again
export function welcomeDue(list: SecurityList): boolean {
  return list.stopped === null && !list.plugins.some(plugin => approved(plugin) && holdsLayout(plugin))
}

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
    case 'door.handle':
      return 'door.handle, answering every request MCP clients send through hetu\'s door'
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
  'ui.keystream': () => 'See each key you press in an open note',
  'events.subscribe': ({ topics }) => (topics.length === 0 ? 'Hear no events' : `Hear the events ${list(topics)}`),
  storage: () => 'Keep data of its own',
  // A command runs as a program of the human's, not in the plugin's sandbox
  exec: ({ commands, env }) => `Run the command${commands.length === 1 ? '' : 's'} ${commands.map(command => JSON.stringify(command)).join(', ')} outside the sandbox with your rights on this computer${env.length > 0 ? `, with ${list(env)} from your environment` : ''}`,
  'plugin.call': ({ targets }) => (targets.length === 0 ? 'Call no other plugin' : `Call the plugin${targets.length === 1 ? '' : 's'} ${list(targets)}`),
  'guard.hook': () => 'Check each change to a note before it is written',
  'log.read': () => 'Read hetu’s event log',
  // The door hands this plugin every request an outside program makes to hetu's local connection
  'door.handle': () => 'Answer the requests other programs on this computer send to hetu',
}

// A type no row names, which a parsed manifest never holds, shows as its name in quotes
export function grantSentence(granted: Capability): string {
  const sentence = sentences[granted.type] as ((granted: Capability) => string) | undefined
  return sentence === undefined ? `Use ${quoted(granted.type)}` : sentence(granted)
}

// The sentence to follow a plugin's name or "it can": its first letter lower case, as in "Let search read all your notes"
export function grantClause(granted: Capability): string {
  const sentence = grantSentence(granted)
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

// Why a link or a source gave nothing to install, as the trusted window says it. main's fetch from GitHub answers its
// problems with these words too
export const installProblemWords: Readonly<Record<InstallProblem, string>> = Object.freeze({
  'not-github': 'That is not a link to a GitHub repo or release. Paste one like https://github.com/owner/repo',
  'off-github': "The download pointed away from the hosts hetu fetches from, so nothing was fetched. An older release may still use GitHub's old download host, which hetu no longer fetches from",
  'no-release': "GitHub has no published release there. The repo may be private or missing or the tag may have no release. A repo link finds only the latest full release, so paste a prerelease's own tag link to install it",
  'not-found': 'GitHub no longer has that file. Paste the link again to see what the release holds now',
  'no-zip': 'That release holds no .zip file to install from',
  'digest-mismatch': 'The downloaded zip does not match the checksum GitHub lists for it, so it was not kept. Try again',
  'rate-limited': 'GitHub is limiting requests from this network for now. Try again in an hour or install from a downloaded zip',
  offline: 'GitHub could not be reached. Check the connection and try again',
  'timed-out': 'GitHub took too long to answer. Try again',
  cancelled: 'The download was stopped',
  'bad-answer': 'GitHub answered in a way hetu does not read. Try again later or install from a downloaded zip',
  invalid: 'That doesn’t read as a zip or a plugin folder',
  name: 'It holds a file name that could land outside its folder, so nothing was taken',
  duplicate: 'It holds two files under one name, so nothing was taken',
  special: 'It holds a link or another special file, so nothing was taken',
  encrypted: 'It holds an encrypted file, so nothing was taken',
  'too-many': 'It holds more files than one install takes, so nothing was taken',
  'too-big': 'It is bigger than one install takes, so nothing was taken',
  'not-a-folder': 'That isn’t a folder',
  'same-id': 'It holds two plugins with one id, so nothing was taken',
  none: 'No plugin in it. A plugin’s folder holds hetu-plugin.json',
})

// What an install says of the plugins it takes, which no signature proves yet
export const UNSIGNED = 'Unsigned: nothing proves who made these plugins. Install only what comes from a source you trust'

// The source as the core staged it, a link's with the release it took the zip from and whether its bytes matched the
// checksum GitHub lists, which says they arrived as GitHub holds them and never who made them
export function sourceLine(source: StagedSource): string {
  if (source.kind !== 'link') return `From the ${source.kind} ${quotedPath(source.path)}`
  const checked = source.verified ? 'matching the checksum GitHub lists for it' : 'with no checksum from GitHub to check it against'
  return `From ${quoted(source.asset)} in the release ${quoted(source.tag)} of ${quoted(source.link)}, ${checked}`
}
