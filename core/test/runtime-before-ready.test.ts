import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { beforeReady, type EarlyApp, type EarlyProtocol, installDirFor, REFUSED_SWITCHES } from '../backend/runtime/before-ready.ts'

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
function fakes(options: { switches?: string[], lock?: boolean } = {}) {
  const calls: string[] = []
  const seen: { userData?: string, userDataExisted?: boolean, schemes?: unknown } = {}
  const app: EarlyApp = {
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
  it('refuses the debugging switches, the sandbox off and the switches that weaken the renderers', () => {
    expect([...REFUSED_SWITCHES].sort()).toEqual([
      'disable-web-security', 'gpu-launcher', 'js-flags', 'no-sandbox', 'remote-debugging-pipe', 'remote-debugging-port', 'renderer-cmd-prefix',
    ])
  })

  // Chromium's own parse finds a switch however it was spelled, and ELECTRON_DISABLE_SANDBOX sets no-sandbox with no
  // argument at all, so this holds where the argument rule below sees nothing
  it.each(REFUSED_SWITCHES)('exits a locked build Chromium reads --%s for before anything else, with no argument on its command line', async name => {
    const base = await temp()
    const { app, protocol, calls } = fakes({ switches: [name] })
    const early = beforeReady(app, protocol, { env: { LOCALAPPDATA: base, HOME: base }, platform: process.platform, locked: true, argv: ['hetu.exe'] })
    expect(early).toBeNull()
    expect(calls).toEqual(['exit 1'])
    expect(existsSync(path.join(base, 'hetu'))).toBe(false)
    expect(existsSync(path.join(base, 'Library'))).toBe(false)
    expect(existsSync(path.join(base, '.local'))).toBe(false)
  })

  // hetu takes no argument, so a locked build refuses anything after its own name: a list of bad switches misses names
  it.each([
    ['a debugging switch', '--remote-debugging-port=0'], ['one spelled the Windows way', '/remote-debugging-port=0'], ['inspect', '--inspect'],
    ['a plain word', 'notes.md'], ['an empty argument', ''], ['a switch Chromium hasn\'t named yet', '--some-future-switch'],
  ])('exits a locked build started with %s', async (_name, arg) => {
    const base = await temp()
    const { app, protocol, calls } = fakes()
    expect(beforeReady(app, protocol, { env: { LOCALAPPDATA: base, HOME: base }, platform: process.platform, locked: true, argv: ['hetu.exe', arg] })).toBeNull()
    expect(calls).toEqual(['exit 1'])
  })

  it('starts a locked build with nothing after its name', async () => {
    const base = await temp()
    const { app, protocol, calls } = fakes()
    expect(beforeReady(app, protocol, { env: { LOCALAPPDATA: base, HOME: base, XDG_STATE_HOME: base }, platform: process.platform, locked: true, argv: ['hetu.exe'] })).not.toBeNull()
    expect(calls).not.toContain('exit 1')
  })

  it('lets a run from the source keep its debugging switches and arguments, which the tests drive it through', async () => {
    const dataDir = await temp()
    const { app, protocol, calls } = fakes({ switches: [...REFUSED_SWITCHES] })
    const early = beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform, locked: false, argv: ['electron', '.', '--remote-debugging-port=0'] })
    expect(early).toEqual({ dataDir, dev: true })
    expect(calls).not.toContain('exit 1')
  })

  it('makes <dataDir>/electron, points userData at it, then takes the lock, turns the sandbox on and registers hetu', async () => {
    const dataDir = await temp()
    const { app, protocol, calls, seen } = fakes()
    beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform, locked: false, argv: ['electron'] })
    expect(calls).toEqual(['setPath userData', 'requestSingleInstanceLock', 'enableSandbox', 'registerSchemesAsPrivileged'])
    expect(seen.userData).toBe(path.join(dataDir, 'electron'))
    expect(seen.userDataExisted).toBe(true)
  })

  it('places a locked build\'s userData under the state folder, never where HETU_DATA_DIR points', async () => {
    const base = await temp()
    const elsewhere = await temp()
    const { app, protocol, seen } = fakes()
    const env = { LOCALAPPDATA: base, HOME: base, XDG_STATE_HOME: base, HETU_DATA_DIR: elsewhere }
    const early = beforeReady(app, protocol, { env, platform: process.platform, locked: true, argv: ['hetu.exe'] })
    expect(early?.dev).toBe(false)
    expect(seen.userData?.startsWith(base)).toBe(true)
    expect(seen.userData?.endsWith(path.join('hetu', 'electron'))).toBe(true)
  })

  it('quits a second instance on the same data folder before it turns anything on', async () => {
    const dataDir = await temp()
    const { app, protocol, calls } = fakes({ lock: false })
    const early = beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform, locked: false, argv: ['electron'] })
    expect(early).toBeNull()
    expect(calls).toEqual(['setPath userData', 'requestSingleInstanceLock', 'exit 0'])
  })

  it('registers hetu once, as a standard and secure scheme', async () => {
    const dataDir = await temp()
    const { app, protocol, seen } = fakes()
    beforeReady(app, protocol, { env: { HETU_DATA_DIR: dataDir }, platform: process.platform, locked: false, argv: ['electron'] })
    expect(seen.schemes).toEqual([{ scheme: 'hetu', privileges: { standard: true, secure: true } }])
  })

  it('throws on a HETU_DATA_DIR that isn\'t absolute before it touches Electron', () => {
    const { app, protocol, calls } = fakes()
    expect(() => beforeReady(app, protocol, { env: { HETU_DATA_DIR: 'relative' }, platform: process.platform, locked: false, argv: ['electron'] })).toThrow('absolute')
    expect(calls).toEqual([])
  })
})

describe('the install folder', () => {
  const where = { here: '/app/core/dist', resourcesPath: '/app/resources', platform: 'linux' }

  // The plugins beside app.asar and the list inside it, so ASAR integrity covers the list
  it('is beside app.asar in a locked build with the list inside app.asar, whatever HETU_INSTALL_DIR says', () => {
    expect(installDirFor({ ...where, packaged: true, locked: true, env: { HETU_INSTALL_DIR: '/elsewhere' } })).toEqual({ installDir: '/app/resources', listDir: '/app/resources/app.asar' })
    expect(installDirFor({ ...where, packaged: true, locked: false, env: {} })).toEqual({ installDir: '/app/resources', listDir: '/app/resources/app.asar' })
  })

  // The packed build the end-to-end tests drive reads the environment as a run from the source does, so a test can
  // hand it an install of its own. The locked build never does
  it('is HETU_INSTALL_DIR in a packaged build that isn\'t locked, when that is set', () => {
    expect(installDirFor({ ...where, packaged: true, locked: false, env: { HETU_INSTALL_DIR: '/tmp/install' } })).toEqual({ installDir: '/tmp/install', listDir: '/tmp/install' })
  })

  it('is the built main\'s folder in a run from the source, or HETU_INSTALL_DIR when that is set, for the tests, with the list in it', () => {
    expect(installDirFor({ ...where, packaged: false, locked: false, env: {} })).toEqual({ installDir: '/app/core/dist', listDir: '/app/core/dist' })
    expect(installDirFor({ ...where, packaged: false, locked: false, env: { HETU_INSTALL_DIR: '/tmp/install' } })).toEqual({ installDir: '/tmp/install', listDir: '/tmp/install' })
  })

  it('refuses a HETU_INSTALL_DIR that isn\'t absolute', () => {
    expect(() => installDirFor({ ...where, packaged: false, locked: false, env: { HETU_INSTALL_DIR: 'relative' } })).toThrow('absolute')
  })
})
