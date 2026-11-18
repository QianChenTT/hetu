import { definePlugin } from '@hetu/sdk'
import { createGate } from './gate.ts'

// The gate makes no calls and has nothing to start: the loader hands it its first StateView before it counts as ready
export default definePlugin({ start() {} })

export const gate = createGate()
