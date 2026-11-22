import { definePlugin, type Plugin } from '@hetu/sdk'
import { doorLimits, type TokenSeam } from './checks.ts'
import { clientsOf } from './clients.ts'
import { mcpServe } from './mcp.ts'
import { openPipe, type Pipe } from './pipe.ts'
import { rate } from './rate.ts'
import { refusalCounter } from './report.ts'
import { type Door, type DoorTimes, openDoor } from './server.ts'

// pipe is the local pipe's name, served beside the door when given
export type HttpOptions = { port: number, token: TokenSeam, pipe?: string, limits?: Partial<DoorTimes> }

// http's host half: the door and the pipe are open exactly while mcp is there, opened on start and on every change the
// core tells. A bind that fails tells the core why, port-taken when the port is held and bind-failed otherwise, the
// pipe's included. No other port or name is tried, since every URL a harness keeps names this one. The core then
// ends the half and http reads failed. Refusals at the door and the pipe go to the core counted by reason, at most one
// report a reason a second
export function httpPlugin(options: HttpOptions): Plugin {
  return definePlugin({
    start(ctx) {
      const counter = refusalCounter((reason, count) => ctx.call('core', 'refused', { reason, count }))
      const serve = mcpServe((args, call) => ctx.call('mcp', 'handle', args, call))
      const take = rate(doorLimits.perSecond, () => performance.now())
      const clients = clientsOf({ call: (name, args) => ctx.call('core', name, args) })
      let door: Door | null = null
      let pipe: Pipe | null = null
      let failed = false
      let stopping = false
      // One change at a time, so an open still under way when mcp goes is closed once it lands
      let turn: Promise<void> = Promise.resolve()

      const step = async () => {
        if (failed || stopping) return
        const wanted = ctx.has('mcp')
        if (wanted && door === null) {
          try {
            door = await openDoor({ port: options.port, token: options.token, serve, take, refused: reason => counter.hit(reason), ...(options.limits === undefined ? {} : { limits: options.limits }) })
            if (options.pipe !== undefined) pipe = await openPipe({ path: options.pipe, clients, serve, take, refused: reason => counter.hit(reason) })
          } catch (error) {
            failed = true
            const reason = door === null && (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE' ? 'port-taken' : 'bind-failed'
            // core.bindFailed, which the floor takes from this half in its utility process alone. A rejection is this
            // half's calls ending as the core ends it, or a reason the core never took, which leaves the half running
            // with no door until it is restarted
            void ctx.call('core', 'bindFailed', { reason }).catch(() => {})
          }
        } else if (!wanted && door !== null) {
          const open = [door, pipe]
          door = null
          pipe = null
          for (const one of open) await one?.close()
        }
      }
      const sync = () => {
        turn = turn.then(step, step)
        return turn
      }

      ctx.onDeps(() => sync())
      ctx.onStop(async () => {
        stopping = true
        // A step that failed has already let go of its door, so the stop goes on and the kill that ends this half takes
        // a door whose close failed with it
        await turn.catch(() => {})
        for (const one of [door, pipe]) await one?.close()
        door = null
        pipe = null
        clients.close()
        counter.close()
      })
      void sync()
    },
  })
}
