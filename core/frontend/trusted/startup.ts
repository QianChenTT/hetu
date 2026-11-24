// The startup flow (D-672, D-679, D-744, D-750): four steps, one drawn at a time, on the trusted window's first tab.
// hetu ships no plugin, so every install goes through it: the notes folder, the first plugin installed with the Install
// button's controls, one line saying where the plugin installed is approved, then what a grant is. Approving itself is
// no step of the flow. While it is due it has no way out. Once a plugin is installed it ends and stays on its tab
import type { SecurityList } from '../../api/actions.ts'
import { pluginsInFolder, startupDue } from '../../api/trusted.ts'

// The release the install step fills in, only as a suggestion the human edits or replaces
export const SUGGESTED_LINK = 'https://github.com/QianChenTT/hetu-plugins'

// Where the human approves the plugin installed: the install's own Confirm, or Approve in the plugin list for a plugin
// copied into the plugin folder by hand
export const APPROVE_LINE = 'Approve what you installed in its Confirm at the top of this window, or with Approve in the Plugins tab for a plugin copied in by hand'

// offers is the control the step draws: the folder dialog, the Install button's controls or none
export type StartupStep = { title: string, lines: string[], done: string | null, offers: 'folder' | 'install' | null }
// at is the step drawn. due says the flow has not ended, so the guide draws no way out
export type Startup = { steps: StartupStep[], at: number, suggested: string, due: boolean }

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// at is the step the human went to or the guide was drawn at, else the first step not done
export function startupScreen(list: SecurityList, at: number | null): Startup | null {
  if (list.stopped !== null) return null
  const steps = stepsOf(list)
  const first = steps.findIndex(step => step.done === null)
  return { steps, at: at ?? (first === -1 ? 0 : first), suggested: SUGGESTED_LINK, due: startupDue(list) }
}

function stepsOf(list: SecurityList): StartupStep[] {
  const inFolder = pluginsInFolder(list)
  return [
      {
        title: 'Pick the notes folder',
        lines: ['hetu works on the notes in one folder you pick, and hetu itself reaches nothing outside it'],
        done: list.luoshu === null ? null : `Notes folder: ${list.luoshu}`,
        offers: 'folder',
      },
      {
        title: 'Install your first plugin',
        lines: ['hetu comes with no plugins. Install one from a zip, a folder or a GitHub link'],
        done: inFolder === 0 ? null : `${counted(inFolder, 'plugin', 'plugins')} in the plugin folder`,
        offers: 'install',
      },
      {
        title: 'Approve it',
        lines: [APPROVE_LINE],
        done: null,
        offers: null,
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
