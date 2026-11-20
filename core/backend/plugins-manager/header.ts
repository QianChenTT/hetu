import type { Field } from '../../lib/event-log.ts'
import type { Landing, Recording } from '../recording/header.ts'

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
