import type { Beating, HeartbeatCore, HeartbeatModule } from './header.ts'

type Beat = { timer: ReturnType<typeof setInterval>, misses: number, waiting: boolean }

// The heartbeat: a ping down each running plugin's half every heartbeatMs. heartbeatMisses unanswered in a row ask the
// core to mark a worker unresponsive, again at each ping until it answers, or to kill a utility half, which still holds
// whatever it opened while hung. Anything heard from the plugin starts the count again. A check that throws is skipped
// with a fault and the next ping counts
export function createHeartbeat(): HeartbeatModule {
  let core: HeartbeatCore | null = null
  let fault: (step: string) => void = () => {}
  const beats = new Map<Beating, Beat>()

  const check = (plugin: Beating, beat: Beat, misses: number) => {
    if (core === null || beats.get(plugin) !== beat) return
    try {
      if (beat.waiting) beat.misses++
      if (beat.misses >= misses) {
        if (plugin.utility) core.kill(plugin)
        else core.unresponsive(plugin)
        // A kill ends the plugin and its beat with it
        if (beats.get(plugin) !== beat) return
      }
      beat.waiting = true
      core.ping(plugin)
    } catch {
      fault('check')
    }
  }

  return {
    open(given, faulted) {
      core = given
      fault = faulted
    },

    close() {
      for (const beat of beats.values()) clearInterval(beat.timer)
      beats.clear()
      core = null
    },

    started(plugin) {
      if (core === null || beats.has(plugin)) return
      const misses = core.limit(plugin.plugin, 'heartbeatMisses')
      const beat: Beat = { timer: setInterval(() => check(plugin, beat, misses), core.limit(plugin.plugin, 'heartbeatMs')), misses: 0, waiting: false }
      beat.timer.unref?.()
      beats.set(plugin, beat)
    },

    heard(plugin) {
      const beat = beats.get(plugin)
      if (beat === undefined) return
      beat.misses = 0
      beat.waiting = false
    },

    stopped(plugin) {
      const beat = beats.get(plugin)
      if (beat === undefined) return
      clearInterval(beat.timer)
      beats.delete(plugin)
    },
  }
}
