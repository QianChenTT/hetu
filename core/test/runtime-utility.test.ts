import { EventEmitter } from 'node:events'
import { readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayLimits } from '../api/rate.ts'
import type { UtilityStart } from '../backend/loader/seams.ts'
import { type ForkOptions, utilityRuntime, type UtilityChild } from '../backend/runtime/utility.ts'
import { baseEnv } from '../lib/clean-env.ts'

// Electron's UtilityProcess as the runtime sees it. exit hands over the exit code, which a kill sets to 0 on Windows
class FakeChild extends EventEmitter implements UtilityChild {
  posted: { message: unknown, transfer: unknown[] }[] = []
  kills = 0

  postMessage(message: unknown, transfer: unknown[] = []): void {
    this.posted.push({ message, transfer })
  }

  kill(): boolean {
    this.kills++
    return true
  }

  exits(code: number): void {
    this.emit('exit', code)
  }
}

const limits: RelayLimits = { messagesPerSecond: 200, floodFactor: 10, floodMs: 5000, bytesPerSecond: 4096, resultBytes: 1024 }
const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

function fake(options: { locked?: boolean } = {}) {
  const forks: { modulePath: string, args: string[], options: ForkOptions, child: FakeChild }[] = []
  const runtime = utilityRuntime({
    fork: (modulePath, args, forkOptions) => {
      const child = new FakeChild()
      forks.push({ modulePath, args, options: forkOptions, child })
      if (forkOptions.cwd !== undefined) made.push(forkOptions.cwd)
      return child
    },
    bootstrap: path.join('dist', 'utility.js'),
    locked: options.locked ?? true,
    limits: () => limits,
  })
  const exits: { id: string, killed: boolean }[] = []
  const start = (id = 'http', incarnation = 1): UtilityStart => ({
    id, incarnation, code: Buffer.from('export default 1'), port: { the: 'port' }, exited: how => exits.push({ id, ...how }),
  })
  return { runtime, forks, exits, start }
}

describe('the utility runtime', () => {
  it('forks the bootstrap with an environment built from empty, never main\'s', () => {
    const { runtime, forks, start } = fake()
    const was = process.env.HETU_SECRET_FOR_TEST
    process.env.HETU_SECRET_FOR_TEST = 'main only'
    try {
      runtime.startUtility(start())
    } finally {
      if (was === undefined) delete process.env.HETU_SECRET_FOR_TEST
      else process.env.HETU_SECRET_FOR_TEST = was
    }
    const [{ modulePath, args, options }] = forks
    expect(modulePath).toBe(path.join('dist', 'utility.js'))
    expect(args).toEqual([])
    expect({ ...options.env }).toEqual({ ...baseEnv() })
    expect(Object.values(options.env).join('\n')).not.toContain('main only')
    expect(options.serviceName).toBe('hetu http')
  })

  it('runs it in a new empty working folder outside the data folder, one per incarnation', async () => {
    const { runtime, forks, start } = fake()
    runtime.startUtility(start('http', 1))
    runtime.startUtility(start('http', 2))
    const [first, second] = forks.map(entry => entry.options.cwd!)
    expect(first).not.toBe(second)
    expect(await readdir(first)).toEqual([])
    expect((await stat(first)).isDirectory()).toBe(true)
    expect(path.dirname(first)).toBe(path.resolve(tmpdir()))
  })

  it('ignores its stdio in a locked build and lets it through from the source', () => {
    const locked = fake({ locked: true })
    locked.runtime.startUtility(locked.start())
    expect(locked.forks[0].options.stdio).toBe('ignore')
    const source = fake({ locked: false })
    source.runtime.startUtility(source.start())
    expect(source.forks[0].options.stdio).toBe('inherit')
  })

  it('sends the verified bytes, the limits and the plugin\'s end of its channel as the first message, nothing else', () => {
    const { runtime, forks, start } = fake()
    const given = start()
    runtime.startUtility(given)
    expect(forks[0].child.posted).toEqual([{
      message: { v: 1, kind: 'start', code: Buffer.from('export default 1').toString('base64'), limits },
      transfer: [given.port],
    }])
  })

  it('tells the loader an exit it caused as killed, even when the exit code reads 0', () => {
    const { runtime, forks, exits, start } = fake()
    runtime.startUtility(start())
    runtime.kill('http', 1)
    expect(forks[0].child.kills).toBe(1)
    forks[0].child.exits(0)
    expect(exits).toEqual([{ id: 'http', killed: true }])
  })

  it('tells the loader an exit it didn\'t cause as not killed, whatever the exit code', () => {
    for (const code of [0, 1, -1073741819]) {
      const { runtime, forks, exits, start } = fake()
      runtime.startUtility(start())
      forks[0].child.exits(code)
      expect(exits).toEqual([{ id: 'http', killed: false }])
    }
  })

  it('kills only the incarnation named, decides nothing for one already ended and tells each exit once', () => {
    const { runtime, forks, exits, start } = fake()
    runtime.startUtility(start('http', 1))
    runtime.startUtility(start('http', 2))
    runtime.kill('http', 1)
    expect(forks.map(entry => entry.child.kills)).toEqual([1, 0])
    forks[0].child.exits(0)
    forks[0].child.exits(0)
    runtime.kill('http', 1)
    runtime.kill('nobody', 1)
    expect(forks.map(entry => entry.child.kills)).toEqual([1, 0])
    expect(exits).toEqual([{ id: 'http', killed: true }])
  })

  it('removes its working folder once it exited when the folder is still empty, and leaves one it wrote into', async () => {
    const { runtime, forks, start } = fake()
    runtime.startUtility(start('http', 1))
    runtime.startUtility(start('http', 2))
    const [empty, written] = forks.map(entry => entry.options.cwd!)
    await writeFile(path.join(written, 'left.txt'), 'x')
    forks[0].child.exits(0)
    forks[1].child.exits(0)
    expect(await stat(empty).then(() => true, () => false)).toBe(false)
    expect(await readdir(written)).toEqual(['left.txt'])
  })

  it('sends each running child of the plugin its limits as they are when limited is called, on its parent port', () => {
    let current: RelayLimits = limits
    const forks: FakeChild[] = []
    const runtime = utilityRuntime({
      fork: (_modulePath, _args, forkOptions) => {
        made.push(forkOptions.cwd)
        const child = new FakeChild()
        forks.push(child)
        return child
      },
      bootstrap: 'utility.js',
      locked: true,
      limits: () => current,
    })
    const start = (id: string, incarnation: number): UtilityStart => ({ id, incarnation, code: Buffer.from(''), port: {}, exited: () => {} })
    runtime.startUtility(start('http', 1))
    runtime.startUtility(start('other', 1))
    current = { ...limits, messagesPerSecond: 20 }
    runtime.limited('http')
    expect(forks[0].posted.slice(1)).toEqual([{ message: { v: 1, kind: 'limits', limits: current }, transfer: [] }])
    expect(forks[1].posted).toHaveLength(1)
    // A raise goes out the same way
    current = { ...limits, messagesPerSecond: 400 }
    runtime.limited('http')
    expect(forks[0].posted.at(-1)).toEqual({ message: { v: 1, kind: 'limits', limits: current }, transfer: [] })
  })

  it('sends nothing to a child that exited, to a plugin with none running and survives a post that throws', () => {
    const { runtime, forks, start } = fake()
    runtime.startUtility(start('http', 1))
    forks[0].child.exits(1)
    runtime.limited('http')
    runtime.limited('nobody')
    expect(forks[0].child.posted).toHaveLength(1)
    runtime.startUtility(start('http', 2))
    forks[1].child.postMessage = () => {
      throw new Error('gone')
    }
    expect(() => runtime.limited('http')).not.toThrow()
  })

  it('throws when the fork throws, so the loader reads start-failed', () => {
    const runtime = utilityRuntime({ fork: () => { throw new Error('no fork') }, bootstrap: 'utility.js', locked: true, limits: () => limits })
    expect(() => runtime.startUtility({ id: 'http', incarnation: 1, code: Buffer.from(''), port: null, exited: () => {} })).toThrow('no fork')
  })
})

