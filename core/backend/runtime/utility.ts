import { mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RelayLimits } from '../../api/rate.ts'
import { VERSION } from '../../api/version.ts'
import { baseEnv } from '../../lib/clean-env.ts'
import type { Runtime, UtilityStart } from '../plugins-manager/seams.ts'

// What the runtime gives utilityProcess.fork. env replaces the child's whole environment
export type ForkOptions = { env: Record<string, string>, cwd: string, stdio: 'ignore' | 'inherit', serviceName: string }

// Electron's UtilityProcess as the runtime uses it. exit hands over an exit code, which this runtime never reads
export type UtilityChild = {
  postMessage(message: unknown, transfer?: unknown[]): void
  kill(): boolean
  once(event: 'exit', listener: (code: number) => void): unknown
}

export type UtilityOptions = {
  fork: (modulePath: string, args: string[], options: ForkOptions) => UtilityChild
  // The bootstrap built beside main.js
  bootstrap: string
  // A locked build ignores the child's stdio. A run from the source lets it through to main's
  locked: boolean
  // What the child's transport paces itself to, the limits main holds the plugin to
  limits: (id: string) => RelayLimits
}

type Child = { id: string, child: UtilityChild, cwd: string, killed: boolean, over: boolean }

// The environment a utility half is forked with: the base and NODE_OPTIONS with no value. Electron forks with main's
// whole environment when env holds no name, as the base on macOS and Linux holds none. Chromium leaves a name whose
// value is empty out of the child's, so the half gets the base alone, and a NODE_OPTIONS that reached it empty would
// set nothing
export function utilityEnv(ambient: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return { ...baseEnv(ambient, platform), NODE_OPTIONS: '' }
}

// The utility halves' runtime: each a utilityProcess forked from the core's bootstrap, with an environment built from
// empty, a new empty working folder in the system's temp folder and its first message the verified bytes, its limits and
// the plugin's end of its channel. It records each kill it makes, so an exit reads killed from that record and never from
// the exit code, which a kill sets to 0 on Windows. limited sends each running child of a plugin its limits as they are
// now, on the child's parent port, which only main writes to
export function utilityRuntime(options: UtilityOptions): Pick<Runtime, 'startUtility' | 'kill'> & { limited(id: string): void } {
  const running = new Map<string, Child>()
  const key = (id: string, incarnation: number) => `${id}#${incarnation}`
  return {
    startUtility(start: UtilityStart) {
      const cwd = mkdtempSync(path.join(tmpdir(), 'hetu-utility-'))
      let child: UtilityChild
      try {
        child = options.fork(options.bootstrap, [], {
          env: utilityEnv(),
          cwd,
          stdio: options.locked ? 'ignore' : 'inherit',
          serviceName: `hetu ${start.id}`,
        })
      } catch (err) {
        rmdirSync(cwd)
        throw err
      }
      const own: Child = { id: start.id, child, cwd, killed: false, over: false }
      running.set(key(start.id, start.incarnation), own)
      child.once('exit', () => {
        if (own.over) return
        own.over = true
        running.delete(key(start.id, start.incarnation))
        // Only an empty folder goes. One the child wrote into stays in the temp folder, so nothing it left there, a link
        // among it, is ever followed by a recursive delete
        try {
          rmdirSync(cwd)
        } catch {}
        start.exited({ killed: own.killed })
      })
      child.postMessage({ v: VERSION, kind: 'start', code: start.code.toString('base64'), limits: options.limits(start.id) }, [start.port])
    },
    limited(id) {
      for (const own of running.values()) {
        if (own.id !== id || own.over) continue
        try {
          own.child.postMessage({ v: VERSION, kind: 'limits', limits: options.limits(id) })
        } catch {}
      }
    },
    kill(id, incarnation) {
      const own = running.get(key(id, incarnation))
      if (own === undefined || own.over) return
      own.killed = true
      own.child.kill()
    },
  }
}
