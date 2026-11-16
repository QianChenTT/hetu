import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, launch, temp } from './helpers.ts'

// Diagnostic: what a utility child forked from main sees for each env it is given

afterEach(cleanup)

describe('diagnostic: a utility child\'s environment', () => {
  it('prints the names a child sees for each env', async () => {
    const dir = await temp()
    const script = path.join(dir, 'child.js')
    await writeFile(script, 'process.parentPort.postMessage(Object.keys(process.env).sort())\n')
    const app = await launch(await temp())
    const envs = [null, {}, { NODE_OPTIONS: '' }, { HETU_X: '1' }]
    const seen = await app.evaluate(async ({ utilityProcess }, { script, envs }) => {
      const out: unknown[] = []
      for (const env of envs) {
        const child = utilityProcess.fork(script, [], env === null ? { stdio: 'ignore' } : { env, stdio: 'ignore' })
        out.push(await Promise.race([
          new Promise(resolve => child.once('message', resolve)),
          new Promise(resolve => setTimeout(() => resolve('no answer in 10 s'), 10_000)),
        ]))
        child.kill()
      }
      return out
    }, { script, envs })
    for (const [i, names] of seen.entries()) {
      console.log(`DIAG env=${JSON.stringify(envs[i])} platform=${process.platform} count=${Array.isArray(names) ? names.length : '-'} names=${JSON.stringify(names)}`)
    }
    expect(seen.length).toBe(4)
  })
})
