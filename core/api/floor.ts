import { frozen, table } from './plain.ts'

const MiB = 1024 * 1024

// Fixed constants that protect main, starting values step 10 measures. The watchdog may lower one per plugin and only
// the human may raise one, per plugin or for all. A higher value is always the wider one
export const floorConstants = table({
  messagesPerSecond: 1000, // per port
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
  auditQueue: 10000, // records
  floorBacklog: 1000, // records
  floodFactor: 10, // the flood cap: this many times the message rate
  floodMs: 5000, // for this long
  firstUseAsks: 1, // open at once per plugin
} as const)

export type FloorConstant = keyof typeof floorConstants

export const floorConstantNames = frozen(Object.keys(floorConstants) as FloorConstant[])
