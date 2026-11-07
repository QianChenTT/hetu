import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beforeReady, DEBUG_SWITCHES, type EarlyApp, type EarlyProtocol } from '../backend/runtime/before-ready.ts'

const made: string[] = []

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-early-'))
  made.push(dir)
  return dir
}

// Electron's app and protocol as before ready sees them, writing down each call in order
function fakes(options: { packaged?: boolean, switches?: string[], lock?: boolean } = {}) {
  const calls: string[] = []
  const seen: { userData?: string, userDataExisted?: boolean, schemes?: unknown } = {}
  const app: EarlyApp = {
    isPackaged: options.packaged ?? false,
    commandLine: { hasSwitch: name => (options.switches ?? []).includes(name) },
    setPath(name, value) {
      calls.push(`setPath ${name}`)
      seen.userData = value
      seen.userDataExisted = existsSync(value)
    },
    requestSingleInstanceLock() {
      calls.push('requestSingleInstanceLock')
      return options.lock ?? true
    },
    enableSandbox() {
      calls.push('enableSandbox')
    },
    exit(code) {
      calls.push(`exit ${code}`)
    },
  }
  const protocol: EarlyProtocol = {
    registerSchemesAsPrivileged(schemes) {
      calls.push('registerSchemesAsPrivileged')
      seen.schemes = schemes
    },
  }
  return { app, protocol, calls, seen }
}

describe('before ready', () => {
  it.each(DEBUG_SWITCHES)('exits a packaged build started with --%s before anything else', async name => {
    const base = await temp()
    const { app, protocol, calls } = fakes({ packaged: true, switches: [name] })
    const early = beforeReady(app, protocol, { env: { LOCALAPPDATA: base, HOME: base }, platform: process.platform })
    expect(early).toBeNull()
    expect(calls).toEqual(['exit 1'])
    expect(existsSync(path.join(base, 'hetu'))).toBe(false)
    expect(existsSync(path.join(base, 'Library'))).toBe(false)
    expect(existsSync(path.join(base, '.local'))).toBe(false)
  })

  it('lets a run from the source keep its debugging switches, which the tests drive it through', async () => {
    const dataDir = await temp()
    const { app, protocol, calls } = fakes({ switches: [...DEBUG_SWITCHES] })
    const early = beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    expect(early).toEqual({ dataDir, dev: true })
    expect(calls).not.toContain('exit 1')
  })

  it('makes <dataDir>/electron, points userData at it, then takes the lock, turns the sandbox on and registers hetu', async () => {
    const dataDir = await temp()
    const { app, protocol, calls, seen } = fakes()
    beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    expect(calls).toEqual(['setPath userData', 'requestSingleInstanceLock', 'enableSandbox', 'registerSchemesAsPrivileged'])
    expect(seen.userData).toBe(path.join(dataDir, 'electron'))
    expect(seen.userDataExisted).toBe(true)
  })

  it('places a packaged build\'s userData under the state folder, never where HETU_DATA_DIR points', async () => {
    const base = await temp()
    const elsewhere = await temp()
    const { app, protocol, seen } = fakes({ packaged: true })
    const env = { LOCALAPPDATA: base, HOME: base, XDG_STATE_HOME: base, HETU_DATA_DIR: elsewhere }
    const early = beforeReady(app, protocol, { env, platform: process.platform })
    expect(early?.dev).toBe(false)
    expect(seen.userData?.startsWith(base)).toBe(true)
    expect(seen.userData?.endsWith(path.join('hetu', 'electron'))).toBe(true)
  })

  it('quits a second instance on the same data folder before it turns anything on', async () => {
    const dataDir = await temp()
    const { app, protocol, calls } = fakes({ lock: false })
    const early = beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    expect(early).toBeNull()
    expect(calls).toEqual(['setPath userData', 'requestSingleInstanceLock', 'exit 0'])
  })

  it('registers hetu once, as a standard and secure scheme', async () => {
    const dataDir = await temp()
    const { app, protocol, seen } = fakes()
    beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
    expect(seen.schemes).toEqual([{ scheme: 'hetu', privileges: { standard: true, secure: true } }])
  })

  it('throws on a HETU_DATA_DIR that isn\'t absolute before it touches Electron', () => {
    const { app, protocol, calls } = fakes()
    expect(() => beforeReady(app, protocol, { env: { HETU_DATA_DIR: 'relative' }, platform: process.platform })).toThrow('absolute')
    expect(calls).toEqual([])
  })
})
