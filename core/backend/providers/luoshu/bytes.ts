import type { Caller } from '../../../api/envelope.ts'
import { defaultLimits } from '../../../api/limits.ts'
import type { Call, Provider } from '../../../api/policy-jobs.ts'

// The action this file alone hands the provider: a read under the same path rules that answers the note's bytes and
// the path it read. No plugin can name it, since the router routes only the actions core/api lists
export const BYTES_READ = 'luoshu.bytes'

export type ReadBytes = (caller: Caller, path: string, reads: (path: string) => boolean) => Promise<{ bytes: Uint8Array, path: string } | null>

// A note's bytes for main's image host, read by the luoshu's provider while it is on, under the path rules every read
// takes: the caller's spelling made canonical, dot names, links out and hetu's own folders refused, the folder and the
// name looked at again once open and the latch held. reads is asked about the path as spelled, the canonical path and
// any path a look resolves it to again, so the plugin's luoshu.read has to reach each. null for anything refused, a
// note past the read cap among them
export function bytesReader(provider: () => Provider | null): ReadBytes {
  // Names this reader's calls apart from the router's, whose ids are hex tokens
  let made = 0
  return async (caller, path, reads) => {
    const luoshu = provider()
    if (luoshu === null || !reads(path)) return null
    const call: Call = {
      callId: `image-${++made}`, caller, root: caller, action: BYTES_READ, args: { path },
      deadline: Date.now() + defaultLimits.callDeadlineMs,
      judge: paths => (paths.every(reads) ? null : { code: 'not-granted' }),
    }
    let performed = false
    let prepared: Awaited<ReturnType<Provider['prepare']>> | null = null
    try {
      prepared = await luoshu.prepare(call)
      if ('code' in prepared) return null
      const paths = prepared.scope.paths ?? []
      if (paths.length === 0 || !paths.every(reads)) return null
      performed = true
      return await luoshu.perform(call, prepared) as { bytes: Uint8Array, path: string }
    } catch {
      return null
    } finally {
      // perform lets go of the latch itself, a call stopped before it has it let go here
      if (!performed && prepared !== null && !('code' in prepared)) luoshu.release?.(call, prepared)
    }
  }
}
