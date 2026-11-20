import { definePlugin, type Plugin } from '@hetu/sdk'
import type { TokenSeam } from './checks.ts'
import { mcpServe } from './mcp.ts'
import { refusalCounter } from './report.ts'
import { type Door, type DoorTimes, openDoor } from './server.ts'

export type HttpOptions = { port: number, token: TokenSeam, limits?: Partial<DoorTimes> }

// http's host half: the door is open exactly while mcp is there, opened on start and on every change the core tells.
// A bind that fails tells the core why, port-taken when the port is held and bind-failed otherwise, and no other port is
// tried, since every URL a harness keeps names this one. The core then ends the half and http reads failed. Refusals
// at the door go to the core counted by reason, at most one report a reason a second
export function httpPlugin(options: HttpOptions): Plugin {
  return definePlugin({
    start(ctx) {
      const counter = refusalCounter((reason, count) => ctx.call('core', 'refused', { reason, count }))
      const serve = mcpServe((args, call) => ctx.call('mcp', 'handle', args, call))
      let door: Door | null = null
      let failed = false
      let stopping = false
      // One change at a time, so an open still under way when mcp goes is closed once it lands
      let turn: Promise<void> = Promise.resolve()

      const step = async () => {
        if (failed || stopping) return
        const wanted = ctx.has('mcp')
        if (wanted && door === null) {
          try {
            door = await openDoor({ port: options.port, token: options.token, serve, refused: reason => counter.hit(reason), ...(options.limits === undefined ? {} : { limits: options.limits }) })
          } catch (error) {
            failed = true
            const reason = (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE' ? 'port-taken' : 'bind-failed'
            // The core ends this half before it answers, so the call never settles
            void ctx.bindFailed(reason).catch(() => {})
          }
        } else if (!wanted && door !== null) {
          const open = door
          door = null
          await open.close()
        }
      }
      const sync = () => {
        turn = turn.then(step, step)
        return turn
      }

      ctx.onDeps(() => sync())
      ctx.onStop(async () => {
        stopping = true
        await turn.catch(() => {})
        if (door !== null) await door.close()
        door = null
        counter.close()
      })
      void sync()
    },
  })
}
