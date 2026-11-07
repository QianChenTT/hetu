import type { Capability } from './capabilities.ts'
import type { WindowRole } from './envelope.ts'
import { table } from './plain.ts'

// What each window holds, fixed here and never read from the state. The editor reads and writes the luoshu, reads
// history and the log, hears luoshu events, gets the ui verbs and keeps the editor's own storage space. ** leaves out
// every dot file and dot folder at any depth, so the editor's luoshu and history grants reach no .scratch.md,
// notes/.todo.md or .trash/. Never exec or net.*. The trusted window holds no capability, only core actions, which the
// floor decides
export const windowGrants: Readonly<Record<WindowRole, readonly Capability[]>> = table({
  editor: [
    { type: 'luoshu.read', paths: ['**'] },
    { type: 'luoshu.write', paths: ['**'] },
    { type: 'history', access: 'read', paths: ['**'] },
    { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] },
    { type: 'log.read' },
    { type: 'ui.panel' },
    { type: 'ui.decoration' },
    { type: 'ui.command' },
    { type: 'ui.statusBar' },
    { type: 'ui.keys' },
    { type: 'storage' },
  ],
  trusted: [],
})
