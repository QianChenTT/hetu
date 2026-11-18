import { definePlugin } from '@hetu/sdk'
import { createExec } from './exec.ts'

const made = createExec()

// The provider role the carrier routes exec.* to, and the exec role the loader hands each view of the grants to
export const provider = made.provider
export const exec = made.role

// Starts on the data folder the loader hands an install host half. Without one the start throws and exec counts as
// failed, so calls answer unavailable
export default definePlugin({
  async start(ctx) {
    if (ctx.dataDir === null) throw new Error('exec starts only as an install host half, with the data folder')
    await made.start(ctx.dataDir)
  },
  stop() {
    made.close()
  },
})
