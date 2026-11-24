// The welcome guide (D-672, D-679): four steps, one drawn at a time, on the trusted window's first tab. hetu ships no
// plugin, so the window opens on it at start until a plugin holding ui.layout is approved. The human may close it for
// now and pick its tab again
import type { SecurityList } from '../../api/actions.ts'
import { approvedNotRefused } from '../../api/trusted.ts'

// The release the install step fills in, only as a suggestion the human edits or replaces
export const SUGGESTED_LINK = 'https://github.com/QianChenTT/hetu-plugins'

// offers is the control the step draws: the folder dialog, the Install button's controls, the plugins waiting for
// Approve or none
export type StartupStep = { title: string, lines: string[], done: string | null, offers: 'folder' | 'install' | 'approve' | null }
// at is the step drawn
export type Startup = { steps: StartupStep[], at: number, suggested: string }

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// at is the step the human went to or the guide was drawn at, else the first step not done
export function startupScreen(list: SecurityList, at: number | null): Startup | null {
  if (list.stopped !== null) return null
  const steps = stepsOf(list)
  const first = steps.findIndex(step => step.done === null)
  return { steps, at: at ?? (first === -1 ? 0 : first), suggested: SUGGESTED_LINK }
}

function stepsOf(list: SecurityList): StartupStep[] {
  const inFolder = list.plugins.filter(plugin => plugin.from === 'folder').length
  const approvedCount = list.plugins.filter(approvedNotRefused).length
  return [
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
          'A plugin copied into the plugin folder by hand waits here and in the plugin list for Approve',
        ],
        done: approvedCount === 0 ? null : `${approvedCount} approved`,
        offers: 'approve',
      },
      {
        title: 'What a grant is',
        lines: [
          'A grant is one thing a plugin may do, such as read the notes in one folder. A plugin gets only the grants you approved and runs in a sandbox of its own',
          'Each grant has its own switch in the plugin list. Switching one off applies at once',
        ],
        done: null,
        offers: null,
      },
  ]
}
