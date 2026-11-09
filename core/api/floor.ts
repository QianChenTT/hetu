import { frozen, table } from './frozen.ts'

const MiB = 1024 * 1024

// Fixed constants that protect main, starting values until they are measured in Electron. The watchdog may lower one
// per plugin and only the human may raise one, per plugin or for all. A higher value is always the wider one
export const floorConstants = table({
  messagesPerSecond: 1000, // per port
  bytesPerSecond: 4 * MiB, // per port, what a worker's messages may weigh in a second, see weigh in rate.ts
  callsInFlight: 64, // per caller
  bytesInFlight: 32 * MiB, // per caller
  argumentBytes: MiB, // per call
  resultBytes: 16 * MiB, // per call, past this the call answers failed with too-large
  callDeadlineMs: 30000, // shrinking along parent
  guardAnswerMs: 2000, // timed once the answer returns, a late one counts as guard-down
  parentDepth: 4,
  readyMs: 10000,
  stopGraceMs: 3000,
  heartbeatMs: 5000,
  heartbeatMisses: 3, // then unresponsive
  eventCredits: 256, // per subscriber
  topicsPerHalf: 64,
  filterMsPerSecond: 100, // per plugin, the gate's time its core.filterReadable calls may take in a second
  auditQueue: 10000, // records
  // How long the oldest record the audit queue holds may wait for the log plugin's ack before the log counts as stalled
  // and is marked failed: six of the event log's 5 s retries after a failed write, so a disk locked for a moment doesn't
  // fail the log for the run
  auditStallMs: 30000,
  floorBacklog: 1000, // records
  floodFactor: 10, // the flood cap: this many times the message rate
  floodMs: 5000, // for this long
  firstUseAsks: 1, // open at once per plugin
} as const)

export type FloorConstant = keyof typeof floorConstants

export const floorConstantNames = frozen(Object.keys(floorConstants) as FloorConstant[])

// The longest delay a timer takes, about 24.8 days. Node fires a longer one at once, so a raised deadline would time
// every call out
export const MAX_TIMER_MS = 2 ** 31 - 1

// The constants that are times in ms, none of which the human may raise past MAX_TIMER_MS
export const timeConstants = frozen(floorConstantNames.filter(name => name.endsWith('Ms')))
