import path from 'node:path'
import { parseArgs } from 'node:util'
import { startDaemon } from './daemon.ts'
import { DEFAULT_LOG_DIR, EventLog } from './log.ts'
import { loadToken } from './token.ts'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const { values } = parseArgs({
  options: {
    vault: { type: 'string', default: path.join(repoRoot, 'playground_vault') },
    port: { type: 'string', default: process.env.HETU_PORT ?? '4747' },
    debounce: { type: 'string', default: '2000' },
    'log-dir': { type: 'string', default: DEFAULT_LOG_DIR },
  },
})

const daemon = await startDaemon({
  vault: values.vault,
  port: Number(values.port),
  humanDebounceMs: Number(values.debounce),
  token: await loadToken(true),
  events: new EventLog({ dir: values['log-dir'], console: true }),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await daemon.close()
    process.exit(0)
  })
}
