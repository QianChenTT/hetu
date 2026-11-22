// The startup screen (D-672, D-679): four steps above the rest of the trusted window, from the list the core sends.
// hetu ships no plugin, so it shows until a plugin holding ui.layout is approved. The human may close it for now and
// show it again from the menu
import type { ListedPlugin, SecurityList } from '../../api/actions.ts'

// The release the install step fills in, only as a suggestion the human edits or replaces
export const SUGGESTED_LINK = 'https://github.com/QianChenTT/hetu-plugins'

// auto shows it until a layout is approved, shown and closed are the human's
export type StartupShown = 'auto' | 'shown' | 'closed'

// offers is the control the step draws: the folder dialog, the Install button's controls or none
export type StartupStep = { title: string, lines: string[], done: string | null, offers: 'folder' | 'install' | null }
export type Startup = { steps: StartupStep[], suggested: string }

// A plugin-folder plugin with an entry that hetu didn't refuse and that didn't fail: found and new is one waiting for
// its approval. Switched off still counts
const approvedNotRefused = (plugin: ListedPlugin) => plugin.from === 'folder' && !(plugin.state === 'found' && plugin.reason === 'new')
  && plugin.state !== 'refused' && plugin.state !== 'failed'

// Its items are what was granted, switched off or not
export function layoutApproved(list: SecurityList): boolean {
  return list.plugins.some(plugin => approvedNotRefused(plugin) && plugin.items.some(item => item.capability.type === 'ui.layout'))
}

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function startupScreen(list: SecurityList, shown: StartupShown): Startup | null {
  if (list.stopped !== null || shown === 'closed' || (shown === 'auto' && layoutApproved(list))) return null
  const inFolder = list.plugins.filter(plugin => plugin.from === 'folder').length
  const approvedCount = list.plugins.filter(approvedNotRefused).length
  return {
    suggested: SUGGESTED_LINK,
    steps: [
      {
        title: 'Pick the notes folder',
        lines: ['hetu works on the notes in one folder you pick, and hetu itself reaches nothing outside it'],
        done: list.luoshu === null ? null : `Notes folder: ${list.luoshu}`,
        offers: 'folder',
      },
      {
        title: 'Install the plugins you want',
        lines: [
          'hetu comes with no plugins. Install them from a zip, a folder or a GitHub link',
          'A layout plugin draws the editor window. Until one is approved the editor shows a plain note',
        ],
        done: inFolder === 0 ? null : `${counted(inFolder, 'plugin', 'plugins')} in the plugin folder`,
        offers: 'install',
      },
      {
        title: 'Approve them',
        lines: [
          'Each plugin’s Confirm lists what it may do. Install approves the ones you tick',
          'A plugin copied into the plugin folder by hand waits in the plugin list below for Approve',
        ],
        done: approvedCount === 0 ? null : `${approvedCount} approved`,
        offers: null,
      },
      {
        title: 'What a grant is',
        lines: [
          'A grant is one thing a plugin may do, such as read the notes in one folder. A plugin gets only the grants you approved and runs in a sandbox of its own',
          'Each grant has its own switch in the plugin list below. Switching one off applies at once',
        ],
        done: null,
        offers: null,
      },
    ],
  }
}
