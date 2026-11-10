import { definePlugin } from '@hetu/sdk'
import { createHistory } from './history.ts'

const made = createHistory()

// The provider role the carrier routes history.* to, and the history role the loader hands the notes folder to
export const provider = made.provider
export const history = made.role

// Starts on the data folder the loader hands an install host half and looks for git there and then. With no git to
// run, or no data folder, the start throws and history counts as failed, so calls answer unavailable and hetu runs on
export default definePlugin({
  async start(ctx) {
    if (ctx.dataDir === null) throw new Error('history starts only as an install host half, with the data folder')
    await made.start(ctx.dataDir)
  },
  stop() {
    made.close()
  },
})
