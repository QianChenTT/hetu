import { definePlugin } from '@hetu/sdk'
import { createLog } from './log.ts'

const audit = createLog()

// Pulls the audit records from start to stop. The loader lends it the handle before it counts as ready
export default definePlugin({
  start() {
    audit.start()
  },
  async stop() {
    await audit.stop()
  },
})

// The log slot's role and the provider of log.history and log.verify
export const log = audit.role
export const provider = audit.provider
