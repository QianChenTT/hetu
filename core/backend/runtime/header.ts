import type { StoppedMode } from '../../api/actions.ts'
import type { PluginFile } from '../../lib/hash-files.ts'
import type { Port } from '../router/header.ts'

// What the runtime provides, the only part that touches Electron. The plugins manager starts and ends plugins through it
// and its tests fake it

// What the runtime does about the log failing while hetu ran: quit and start again, or show the stopped mode, in the
// native box with quit only where box says so, since the security view that would hold its choices is off
export type Failure =
  | { action: 'relaunch', control: string, reason: string }
  | { action: 'stopped', mode: StoppedMode, box: boolean }

// drawer says the plugin holds a ui item, so the runtime gives its worker a port to each editor page as well
// files and frames come only with drawer: the bytes the plugins manager checked, which serve the plugin's frames and icons
export type WorkerStart = {
  id: string
  incarnation: number
  code: Buffer
  port: unknown
  drawer: boolean
  files?: readonly PluginFile[]
  frames?: Readonly<Record<string, string>>
}

// A host entry that runs in a utility process: its verified bytes and the plugin's end of a new channel. exited is how
// the runtime tells the plugins manager the process ended, with killed true when the runtime itself ended it. The exit code is
// never passed on: a kill exits 0 on Windows, so it can't tell a kill from a clean exit
export type UtilityStart = { id: string, incarnation: number, code: Buffer, port: unknown, exited: (how: { killed: boolean }) => void }

// What the plugins manager needs from the runtime, the only part that touches Electron, faked in the plugins manager's tests
export type Runtime = {
  // Both ends of a new channel for plugin id: core for the router and plugin for the half's code. MessageChannelMain in
  // Electron, whose core end reads only text within the plugin's cap. counted has main weigh each message against the
  // plugin's bytesPerSecond as well, for a port with no relay page in front of it
  channel(id: string, counted?: boolean): { core: Port, plugin: unknown }
  // Starts a worker from the verified bytes. The worker host page gets { id, incarnation, code } and the port. A throw
  // means it couldn't start
  startWorker(start: WorkerStart): void
  // Ends a worker with terminate(). Ending one already dead decides nothing
  terminate(id: string, incarnation: number): void
  // Forks a utility process that imports the verified bytes and runs the plugin on the port. A throw means it couldn't
  // start
  startUtility(start: UtilityStart): void
  // Ends a utility process. Ending one already dead decides nothing
  kill(id: string, incarnation: number): void
}
