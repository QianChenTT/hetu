import { definePlugin } from '@hetu/sdk'
import { createCapabilities } from './capabilities.ts'

// Answers from what it is handed and makes no calls, so it has nothing to start
export default definePlugin({ start() {} })

// The capabilities slot's role the loader reads once the plugin is ready
export const capabilities = createCapabilities()
