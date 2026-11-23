import type { Field } from '../../lib/event-log.ts'
import type { FetchProblem } from '../lib/github.ts'

// What the updater provides: the state of the last look at hetu's latest full release on GitHub, a check on demand
// and the switch for the checks at start and every 7 days. Definitions only, updater.ts implements them and main.ts
// makes the one hetu runs

// How long between two checks while hetu runs: 7 days, fixed
export const CHECK_EVERY_MS = 604_800_000

// Why an update was refused. signature: the update file's signature doesn't check against the key inside hetu, or the
// release holds the file with no signature. format: a signed file that isn't an update file. version: a signed version
// lower than the running one
export const refusedReasons = Object.freeze(['signature', 'format', 'version'] as const)
export type RefusedReason = typeof refusedReasons[number]

// Why a check got no answer to act on, which is quiet: the network, no full release, a release holding no update file
// or a fault of hetu's own
export type QuietProblem = FetchProblem | 'no-update-file' | 'fault'

// The signed update file's fields, read only once its signature checked: the version, the installer's asset name in the
// release, its size in bytes and sha256 as lower case hex and when the release build made the installer, as ISO 8601
// in UTC
export type UpdateFile = { version: string, file: string, size: number, sha256: string, built: string }

// What the last check came to. current: the latest release is the running version. found: a higher signed version,
// with the release page and whether this machine can install it (Windows with the installer in the release) or only
// links to the page
export type LastCheck =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'current', version: string }
  | { kind: 'failed', problem: QuietProblem }
  | { kind: 'found', version: string, built: string, page: string, installable: boolean }
  | { kind: 'refused', reason: RefusedReason, version: string | null }

// canCheck: whether this build checks at all, a locked build with an x.y.z version and the key loaded. on: the switch
// for the checks at start and every 7 days. checked: when the last check ended, ms since the epoch, null before the first
export type UpdateState = { canCheck: boolean, on: boolean, checked: number | null, last: LastCheck }

export type Updater = {
  state(): UpdateState
  // Checks now whatever the switch, joining a check under way. A build that doesn't check answers its state
  check(): Promise<UpdateState>
  // The switch: off stops the checks at start and every 7 days, on checks at once once the core is ready
  switchChecks(on: boolean): void
  // The core is ready: the first check and the 7 days from it
  ready(): void
  // Stops the timer and any check or download under way
  close(): void
}

// What the updater needs from recording: the core record of a refused update
export type UpdaterRecording = { coreRecord(event: string, fields?: Record<string, Field>): void }
