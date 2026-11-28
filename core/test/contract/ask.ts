import type { Caller } from '../../api/envelope.ts'
import type { Call, Provider } from '../../api/policy-jobs.ts'

export const pluginCaller = (id: string, half: 'worker' | 'host' = 'worker'): Caller => ({ kind: 'plugin', id, half, incarnation: 1 })
export const editorCaller: Caller = { kind: 'window', role: 'editor', n: 0 }

let n = 0
export type Asking = { caller?: Caller, root?: Caller, onBehalf?: string, canList?: (path: string) => boolean }

export const callOf = (action: string, args: unknown, as: Asking = {}): Call => {
  const caller = as.caller ?? pluginCaller('reader')
  return {
    callId: `k${++n}`, caller, root: as.root ?? caller, action, args, deadline: Date.now() + 30_000,
    ...(as.onBehalf === undefined ? {} : { onBehalf: as.onBehalf }),
    ...(as.canList === undefined ? {} : { canList: as.canList }),
  }
}

// prepare then perform, as the router makes a call. A refusal from either comes back as { refused }
export async function ask(provider: Provider, action: string, args: unknown, as: Asking = {}): Promise<unknown> {
  const call = callOf(action, args, as)
  const prepared = await provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}
