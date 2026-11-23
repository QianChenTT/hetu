import type { StagedProblem, StagedSource } from '../../api/actions.ts'
import type { FolderManifest } from '../../api/manifest.ts'
import type { Field } from '../../lib/event-log.ts'
import type { Landing, Recording } from '../recording/header.ts'
import type { Read } from './verify.ts'

// Recording says what became of a core record, so the type lives with it
export type { Landing }

// What the plugins manager needs from recording, a small interface the plugins manager's tests fake. record settles
// with landed once that one record is on disk, muted while the human has recording off and lost when the backlog
// dropped it, the log refused it, the lane closed with it still waiting or recording threw. It never rejects. A copy,
// an update or a restore applies only on landed or muted, so a record the log can't write yet holds the change back
// until it lands or the plugins manager gives up. A plugins manager that gives up aborts signal, which takes a record
// still waiting out of the backlog and settles it lost. drain writes what waits within ms and gives back how many
// records still wait, so switching recording off writes its own record last. resume lets the writer go on
export type PluginsRecording = Pick<Recording, 'drain' | 'resume' | 'coalesced'> & {
  record(event: string, fields: Record<string, Field>, signal?: AbortSignal): Promise<Landing>
}

// One plugin of a staging as the core read it when it staged it: its id, the SHA-256 of its manifest's bytes, the
// manifest when it parsed as a plugin folder's and why it can't be installed, null when it can
export type StagedRead = { id: string, digest: string, manifest: FolderManifest | null, problem: StagedProblem | null }
export type Staging = { source: StagedSource, plugins: readonly StagedRead[] }

// The Install button's stagings, which the plugins manager reads to word a plugin.install and to check it and installs
// from once the Confirm counts. held is what the core staged under a handle, from memory, null for one it doesn't hold.
// read is one plugin's bytes read again from the staging, null when they no longer hash to what was staged and shown.
// unstage drops a staging, once installed, failed or cancelled
export type Stagings = {
  held(handle: string): Staging | null
  read(handle: string, id: string): Promise<Read | null>
  unstage(handle: string): void
}
