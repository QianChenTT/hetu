import { definePlugin } from '@hetu/sdk'
import { createStorage } from './store.ts'

// The provider role the loader reads once storage is ready
export const provider = createStorage()

// The storage role, through which the loader clears a space in its turn
export const storage = { clear: provider.clear }

// Opens on the data folder the loader hands an install host half. Without one the start throws and storage counts as
// failed, so calls answer unavailable
export default definePlugin({
  start(ctx) {
    if (ctx.dataDir === null) throw new Error('storage starts only as an install host half, with the data folder')
    provider.open(ctx.dataDir)
  },
})
