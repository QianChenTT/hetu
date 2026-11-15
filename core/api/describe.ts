import type { Change, ClassRaised } from './changes.ts'
import { isSecurityControl } from './ids.ts'
import { classNames } from './slots.ts'
import { capabilityText } from './trusted.ts'

// The core's own words for a change, which the trusted window draws above Confirm and nothing else writes. Ids are
// shown as they are inside a fixed sentence. An id with hyphens can still read as words, such as
// hetu-needs-this-click-confirm, which the notices quote. Anything else a plugin wrote, a scope or a folder, goes in
// quotes as data
export type Described = { text: string, notes: string[] }

const quoted = (value: string) => JSON.stringify(value)

// What each security control stops doing while off
const whileOff: Readonly<Record<string, string>> = Object.freeze({
  gate: 'Calls with power then pass unchecked. The per-item switches lapse too, since allowing all means all. Exec still refuses a command whose item is off',
  capabilities: 'Plugins then go unclassified and nothing asks at its first use until it is on again',
  watchdog: 'Nothing then stops or slows a plugin that misbehaves',
})

const RECOMMEND = 'hetu recommends keeping every security plugin on'

export function describeChange(change: Change): Described {
  switch (change.kind) {
    case 'plugin.approve':
      return { text: `Approve ${change.plugin} with the grants its manifest asks for`, notes: [] }
    case 'plugin.update':
      return { text: `Update ${change.plugin} to the version staged beside it`, notes: ['It stops with the plugins that need it and starts again on the new version'] }
    case 'plugin.on':
      return { text: `Switch ${change.plugin} on`, notes: [] }
    case 'plugin.off':
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
        text: `Reset ${change.plugin}: its storage, cache and start marker are cleared`,
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
    case 'luoshu.set':
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
    case 'recordNothing':
      return change.on
        ? { text: 'Stop recording', notes: ['hetu writes nothing to its event log from here, this switch last', 'No security change made after it can be traced'] }
        : { text: 'Record again', notes: [] }
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
      return 'the capabilities plugin switched on again'
  }
}
