import { definePlugin } from '@hetu/sdk'
import { createLuoshu } from './luoshu.ts'

// What each write and the watcher publish, once the plugin started and its context can publish
let publisher: ((topic: 'changed' | 'outside', path: string) => void) | null = null

const made = createLuoshu({ publish: (topic, path) => publisher?.(topic, path) })

// The provider role the carrier routes luoshu.* to, and the luoshu role the loader hands the folder to
export const provider = made.provider
export const luoshu = made.role

// The module stays loaded across incarnations, so a stop ends the watch and the next start's open begins a new one
export default definePlugin({
  start(ctx) {
    publisher = (topic, path) => {
      void ctx.events.publish(topic, path).catch(() => {})
    }
  },
  stop() {
    publisher = null
    made.close()
  },
})
