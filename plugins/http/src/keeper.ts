import { definePlugin, type Plugin } from '@hetu/sdk'
import type { TokenSeam } from './checks.ts'
import { mcpServe } from './mcp.ts'
import { refusalCounter } from './report.ts'
import { type Door, type DoorTimes, openDoor } from './server.ts'

export type HttpOptions = { token: TokenSeam, limits?: Partial<DoorTimes> }

// http's host half: the door binds once on start, on the port the core names in init and no other. It holds the port
// until stop whatever mcp does, so no other program takes it while mcp is away. While mcp is not ready the door answers
// 503, read from the state the core tells at each request, so a request meets no wait while mcp starts. A bind that
// fails tells the core why, port-taken when the port is held and bind-failed otherwise, bind-failed too with no port
// named. It is never tried again, since every URL a harness keeps names this port. The core then ends the half and
// http reads failed. Refusals at the door go to the core counted by reason, at most one report a reason a second
export function httpPlugin(options: HttpOptions): Plugin {
  return definePlugin({
    async start(ctx) {
      const counter = refusalCounter((reason, count) => ctx.call('core', 'agentRefused', { reason, count }))
      const serve = mcpServe((args, call) => ctx.call('mcp', 'handle', args, call))
      let door: Door | null = null
      let stopping = false

      const bind = async () => {
        try {
          if (ctx.port === null) throw new Error('no port named')
          const opened = await openDoor({
            port: ctx.port, token: options.token, serve, refused: reason => counter.hit(reason), ready: () => ctx.state('mcp') === 'ready',
            ...(options.limits === undefined ? {} : { limits: options.limits }),
          })
          if (stopping) await opened.close()
          else door = opened
        } catch (error) {
          const reason = (error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE' ? 'port-taken' : 'bind-failed'
          // The core ends this half before it answers, so the call never settles
          void ctx.bindFailed(reason).catch(() => {})
        }
      }
      const bound = bind()

      ctx.onStop(async () => {
        stopping = true
        await bound
        if (door !== null) await door.close()
        door = null
        counter.close()
      })
      await bound
    },
  })
}
