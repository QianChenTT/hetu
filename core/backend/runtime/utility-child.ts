import { type RelayLimits, relayLimitsOf } from '../../api/rate.ts'
import { runInUtility, type UtilityPort } from '../../sdk/utility.ts'
import { isPlugin } from './hosts.ts'

// The bootstrap a utility process runs, built beside main.js. Its first message from main holds the bytes the plugins manager
// hashed, the plugin's limits and its one port. It imports the bytes as one data: module and runs the module's plugin on
// that port. Anything else in the first message, a module that throws as it loads or one
// with no plugin ends the process, which the plugins manager reads as crashed. Main's later messages on the same parent port carry
// the plugin's limits as they are each time one changes

export type StartEvent = { data: unknown, ports: readonly unknown[] }
export type ChildParts = { importer: (url: string) => Promise<unknown>, exit: (code: number) => void }

// What a running plugin's transport takes new limits through
export type Limit = (limits: RelayLimits) => void

export async function startChild(event: StartEvent, parts: ChildParts): Promise<Limit | undefined> {
  const data = event.data as { v?: unknown, kind?: unknown, code?: unknown, limits?: unknown } | null
  const limits = relayLimitsOf(data?.limits)
  const [port] = event.ports
  if (data?.v !== 1 || data.kind !== 'start' || typeof data.code !== 'string' || limits === null || event.ports.length !== 1) {
    parts.exit(1)
    return undefined
  }
  let module: { default?: unknown } | null
  try {
    module = await parts.importer(`data:text/javascript;base64,${data.code}`) as { default?: unknown } | null
  } catch {
    parts.exit(1)
    return undefined
  }
  const plugin = module?.default
  if (!isPlugin(plugin)) {
    parts.exit(1)
    return undefined
  }
  return runInUtility(plugin, port as UtilityPort, limits)
}

export type ParentPort = { on(event: 'message', listener: (event: StartEvent) => void): unknown }

// The child's side of its parent port, which only main writes to. The first message starts the plugin and every later
// one counts only as { v: 1, kind: 'limits', limits } with no port, handed to the running transport. Limits that come
// while the module still loads wait for it, the newest only. The channel to the carrier carries none
export function listenToMain(
  parent: ParentPort,
  parts: ChildParts,
  start: (event: StartEvent, parts: ChildParts) => Promise<Limit | undefined> = startChild,
): void {
  let started = false
  let limit: Limit | null = null
  let waiting: RelayLimits | null = null
  parent.on('message', event => {
    if (!started) {
      started = true
      void start(event, parts).then(set => {
        if (set === undefined) return
        limit = set
        if (waiting !== null) set(waiting)
        waiting = null
      })
      return
    }
    const data = event.data as { v?: unknown, kind?: unknown, limits?: unknown } | null
    const limits = relayLimitsOf(data?.limits)
    if (data?.v !== 1 || data.kind !== 'limits' || limits === null || (event.ports ?? []).length !== 0) return
    if (limit === null) waiting = limits
    else limit(limits)
  })
}

// In a test, where there is no parent port, nothing listens
const parent = (process as { parentPort?: ParentPort }).parentPort
if (parent !== undefined) listenToMain(parent, { importer: url => import(url), exit: code => process.exit(code) })
