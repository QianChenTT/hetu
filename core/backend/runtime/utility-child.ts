import { relayLimitsOf } from '../../api/rate.ts'
import { runInUtility, type UtilityPort } from '../../sdk/utility.ts'
import { isPlugin } from './hosts.ts'

// The bootstrap a utility process runs, built beside main.js. Its first message from main holds the bytes the loader
// hashed, the plugin's limits and its one port. It imports the bytes as one data: module, as main does for a host half,
// and runs the module's plugin on that port. Anything else in the first message, a module that throws as it loads or one
// with no plugin ends the process, which the loader reads as crashed

export type StartEvent = { data: unknown, ports: readonly unknown[] }
export type ChildParts = { importer: (url: string) => Promise<unknown>, exit: (code: number) => void }

export async function startChild(event: StartEvent, parts: ChildParts): Promise<void> {
  const data = event.data as { v?: unknown, kind?: unknown, code?: unknown, limits?: unknown } | null
  const limits = relayLimitsOf(data?.limits)
  const [port] = event.ports
  if (data?.v !== 1 || data.kind !== 'start' || typeof data.code !== 'string' || limits === null || event.ports.length !== 1) {
    return parts.exit(1)
  }
  let module: { default?: unknown } | null
  try {
    module = await parts.importer(`data:text/javascript;base64,${data.code}`) as { default?: unknown } | null
  } catch {
    return parts.exit(1)
  }
  const plugin = module?.default
  if (!isPlugin(plugin)) return parts.exit(1)
  runInUtility(plugin, port as UtilityPort, limits)
}

// Only main's first message counts. In a test, where there is no parent port, nothing listens
const parent = (process as { parentPort?: { once(event: 'message', listener: (event: StartEvent) => void): unknown } }).parentPort
parent?.once('message', event => void startChild(event, { importer: url => import(url), exit: code => process.exit(code) }))
