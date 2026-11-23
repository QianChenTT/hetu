import type { KeyObject } from 'node:crypto'
import type { Fetch } from '../lib/github.ts'
import { checkLatest, releasePage, updateKey, versionParts, type Checked } from './check.ts'
import type { LastCheck, Updater, UpdaterRecording, UpdateState } from './header.ts'
import { CheckTimer, type Later } from './timer.ts'

export type UpdaterOptions = {
  // Only a locked build checks
  locked: boolean
  // The running version, app.getVersion(). One that isn't x.y.z turns the checks off
  running: string
  // Only Windows installs, every other platform links to the release page
  platform: string
  recording: UpdaterRecording
  // The switch as it stands at the start, on unless the human turned it off
  on?: boolean
  // A line for a check that failed quietly
  log?: (line: string) => void
  // The state changed, for the trusted window to read it again
  changed?: () => void
  key?: KeyObject
  // The key as PEM in place of the one inside hetu, for a test of a key that doesn't load
  pem?: string
  fetch?: Fetch
  later?: Later
  everyMs?: number
  now?: () => number
}

// The key a check verifies with, null with a line when it doesn't load, so hetu starts and nothing checks
function loaded(options: Pick<UpdaterOptions, 'key' | 'pem'>, log: (line: string) => void): KeyObject | null {
  try {
    return options.key ?? updateKey(options.pem)
  } catch {
    log('update: the key inside hetu does not load, so nothing checks')
    return null
  }
}

// The state of the last check, held for the trusted window, the checks the timer runs and a check on demand. A failed
// check is quiet, a line in the log and nothing more. A refused one is a core record, update.refused with its reason
export function createUpdater(options: UpdaterOptions): Updater {
  const log = options.log ?? (line => console.error(line))
  const running = versionParts(options.running)
  const key = options.locked && running !== null ? loaded(options, log) : null
  const canCheck = key !== null
  const now = options.now ?? Date.now
  let state: UpdateState = { canCheck, on: options.on ?? true, checked: null, last: { kind: 'none' } }
  let inFlight: Promise<UpdateState> | null = null
  let closed = false
  const stop = new AbortController()

  const set = (next: Partial<UpdateState>) => {
    state = { ...state, ...next }
    try {
      options.changed?.()
    } catch {
      log('update: the state change could not be told')
    }
  }

  const lastOf = (checked: Checked): LastCheck => {
    switch (checked.outcome) {
      case 'found': {
        const { version, built } = checked.update
        return { kind: 'found', version, built, page: releasePage(version), installable: options.platform === 'win32' && checked.installer !== null }
      }
      case 'current':
        return { kind: 'current', version: checked.update.version }
      case 'refused':
        return { kind: 'refused', reason: checked.reason, version: checked.version }
      case 'failed':
        return { kind: 'failed', problem: checked.problem }
    }
  }

  const runCheck = async (): Promise<UpdateState> => {
    set({ last: { kind: 'checking' } })
    let checked: Checked
    try {
      checked = await checkLatest({ running: running!, key: key!, signal: stop.signal, ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) })
    } catch {
      // A throw from a check is a fault of hetu's, kept as quiet as the network's. Its text stays out of the log
      checked = { outcome: 'failed', problem: 'fault' }
    }
    try {
      if (checked.outcome === 'failed') log(`update: no answer to act on (${checked.problem})`)
      if (checked.outcome === 'refused') options.recording.coreRecord('update.refused', { reason: checked.reason, version: checked.version })
    } finally {
      set({ checked: now(), last: lastOf(checked) })
    }
    return state
  }

  const check = (): Promise<UpdateState> => {
    if (!canCheck || closed) return Promise.resolve(state)
    inFlight ??= runCheck().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const timer = new CheckTimer({
    check,
    locked: canCheck,
    on: state.on,
    ...(options.later !== undefined ? { later: options.later } : {}),
    ...(options.everyMs !== undefined ? { everyMs: options.everyMs } : {}),
  })

  return {
    state: () => state,
    check,
    switchChecks(on) {
      if (on !== state.on) set({ on })
      timer.switched(on)
    },
    ready: () => timer.ready(),
    close() {
      closed = true
      timer.close()
      stop.abort()
    },
  }
}
