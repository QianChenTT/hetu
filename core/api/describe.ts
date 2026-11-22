import type { Change, ClassRaised } from './changes.ts'
import { grantKeyOf } from './envelope.ts'
import { isSecurityControl } from './ids.ts'
import { classNames } from './policy-jobs.ts'
import { capabilityText } from './trusted.ts'

// The core's own words for a change, which the trusted window draws above Confirm and nothing else writes. The id of
// the plugin a change is for is shown as it is inside a fixed sentence. An id with hyphens can still read as words, such
// as hetu-needs-this-click-confirm, which the notices quote. Anything else a plugin or its client chose, a field, a
// scope, a plugin.call target, a topic, a variable name or a folder, goes in quotes as data
export type Described = { text: string, notes: string[] }

const quoted = (value: string) => JSON.stringify(value)

// What each security control stops doing while off
const whileOff: Readonly<Record<string, string>> = Object.freeze({
  gate: 'Calls with power then pass unchecked. The per-item switches lapse too, since allowing all means all. Exec still refuses a command whose item is off',
  'grant-risk-classifier': 'Plugins then go unclassified and nothing asks at its first use until it is on again',
  'flood-control': 'Nothing then limits how fast a plugin or a window sends or how many calls it keeps in flight and no plugin is cut off for a flood',
  recording: 'hetu then writes nothing to its event log, this switch last, so no security change made after it can be traced',
  'security-view': 'Security changes then apply with no Confirm, no security control can be switched off and the editor window can only switch it on again',
})

const RECOMMEND = 'hetu recommends keeping every security plugin on'
const HEARTBEAT_OFF = 'Nothing then pings a plugin or ends a utility process that hangs, so a call to a hung plugin waits its whole deadline'

export function describeChange(change: Change): Described {
  switch (change.kind) {
    case 'plugin.approve':
      return { text: `Approve ${change.plugin} with the grants its manifest asks for`, notes: [] }
    case 'plugin.update':
      return { text: `Update ${change.plugin} to the version staged beside it`, notes: ['It stops with the plugins that need it and starts again on the new version'] }
    case 'plugin.on':
      return { text: `Switch ${change.plugin} on`, notes: [] }
    case 'plugin.off':
      if (change.plugin === 'heartbeat') return { text: 'Switch heartbeat off', notes: [HEARTBEAT_OFF] }
      if (!isSecurityControl(change.plugin)) return { text: `Switch ${change.plugin} off`, notes: ['The plugins that need it stop with it'] }
      return { text: `Switch ${change.plugin} off`, notes: [whileOff[change.plugin] ?? `Writes then pass without ${change.plugin}'s check`, RECOMMEND] }
    case 'plugin.remove':
      return { text: `Remove ${change.plugin} with its code, storage and cache`, notes: ['This can\'t be undone'] }
    case 'plugin.restore':
      return { text: `Restore ${change.plugin} from the copy hetu ships`, notes: [] }
    case 'plugin.clearStorage':
      return { text: `Delete everything ${change.plugin} keeps in its storage`, notes: ['This can\'t be undone'] }
    case 'plugin.reset':
      return {
        text: `Reset ${change.plugin}: its storage and cache are cleared`,
        notes: ['A plugin from the plugin folder then waits for approval again', 'This can\'t be undone'],
      }
    case 'grant.widen':
      return { text: `Give ${change.plugin} ${capabilityText(change.capability)}`, notes: [] }
    case 'grant.narrow':
      return { text: `Take ${capabilityText(change.capability)} from ${change.plugin}`, notes: [] }
    case 'item.on':
      return { text: `Let ${change.plugin} use ${capabilityText(change.capability)}`, notes: [] }
    case 'item.off':
      return { text: `Stop ${change.plugin} using ${capabilityText(change.capability)}`, notes: [] }
    case 'luoshu.pick':
      return { text: `Use ${quoted(change.folder)} as the notes folder`, notes: [] }
    case 'devMode':
      return change.on
        ? { text: `Load ${change.plugin} in dev mode`, notes: ['Its files then load without their hash check'] }
        : { text: `Load ${change.plugin} with its hash check again`, notes: [] }
    case 'exec.anyCommand':
      return change.on
        ? { text: `Let exec run any command for ${change.plugin}`, notes: [`${change.plugin} can then run anything you can run`] }
        : { text: `Hold exec to ${change.plugin}'s own command list again`, notes: [] }
    case 'skipVerification':
      return change.on
        ? { text: 'Skip the hash checks at every start', notes: ['A plugin or setting edited on disk then loads unchecked', RECOMMEND] }
        : { text: 'Check the hashes at every start again', notes: [] }
    case 'confirmOff':
      return change.on
        ? { text: 'Apply changes made in this window without a Confirm', notes: ['A request from any other window still opens this window'] }
        : { text: 'Ask for a Confirm in this window again', notes: [] }
    case 'allowUnsigned':
      return change.on
        ? { text: `Trust the unsigned build ${change.hash}`, notes: [] }
        : { text: `Stop trusting the unsigned build ${change.hash}`, notes: [] }
    case 'limit.set':
      return { text: `Set ${change.constant} to ${change.value} for ${change.plugin ?? 'every plugin'}`, notes: [] }
    case 'class.raised':
      return {
        text: `${quoted(change.plugin)} moved from ${className(change.from)} to ${className(change.to)} with no Confirm on screen`,
        notes: [`Why: ${why(change)}`, 'Its new class and the items that ask at first use are in place already. Confirm only says you saw it'],
      }
    // The field is what the root plugin set on its calls, in quotes as data. A revoke names the client it revokes, the
    // field up to its first #
    case 'identity.revoke':
      return { text: `Revoke ${quoted(grantKeyOf(change.field))} under ${change.root}`, notes: ['It loses every item at once and asks for nothing again until hetu quits'] }
    case 'identity.ask':
      return {
        text: `Give ${quoted(change.field)} under ${change.root} what it asks for through ${change.plugin}`,
        notes: [
          ...change.capabilities.map(capability => `It asks for: ${capabilityText(capability)}`),
          'Each call made for it reaches only what the calling plugin holds as well', `${change.root} may pass on to it what a plugin it called found that it may read, without holding that itself`, 'It holds the items until hetu quits',
          'Cancel and revoke turns it away until hetu quits, as Revoke in the identities list does once it holds an item',
        ],
      }
    // Where the client comes from first, then what it calls itself, where it gets its answer or that it runs on this
    // computer and the field it gets last, each in quotes as data. The field's place last is where the trusted window
    // finds it to draw apart
    case 'consent.ask': {
      const from = change.clientHost === null ? `the client ${quoted(change.client)}` : `the client from ${quoted(change.clientHost)}`
      const named = change.name === null ? 'with no name' : `named ${quoted(change.name)}`
      const reached = change.redirectHost === null ? 'a program on this computer reaching hetu over the local pipe' : `which returns to ${quoted(change.redirectHost)}`
      return {
        text: `Connect ${from} ${named}, ${reached}, through ${change.plugin} as ${quoted(change.field)}`,
        notes: [
          'Any program on this computer can connect under that client id and that name, so confirm only a connect you started just now',
          'It reaches no note yet. It asks for items later and each ask waits for your Confirm',
        ],
      }
    }
  }
}

const className = (n: number | null) => (n === null ? 'a class not known' : `class ${n}, ${classNames[n]}`)

// What moved the class, the plugin whose change it was in quotes
function why(change: ClassRaised): string {
  const by = quoted(change.by ?? change.plugin)
  switch (change.cause) {
    case 'approve':
      return `the approval of ${by} without a Confirm`
    case 'copy':
      return `the copy of ${by} hetu ships, made at start`
    case 'update':
      return `the update of ${by} without a Confirm`
    case 'widen':
      return `a grant given to ${by} without a Confirm`
    case 'narrow':
      return `a grant taken from ${by}`
    case 'restore':
      return `the restore of ${by} without a Confirm`
    case 'remove':
      return `the removal of ${by}`
    case 'reset':
      return `the reset of ${by}`
    case 'start':
      return 'the classing at start, which found what changed while hetu was not running'
    case 'slot-on':
      return 'the grant risk classifier switched on again'
  }
}
