import { definePlugin } from '@hetu/sdk'
import { createGate } from './gate.ts'

// The gate makes no calls and has nothing to start: the plugins manager hands it its first grants snapshot before it counts as ready
export default definePlugin({ start() {} })

export const gate = createGate()
