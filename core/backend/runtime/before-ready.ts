import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { CustomScheme } from 'electron'
import { resolveDataDir } from '../boot/boot.ts'

// No fuse turns these off, and Chromium opens the DevTools handler for them once main has run. A packaged build exits
// on either before anything else. A run from the source keeps them, since the end-to-end tests drive it through them
export const DEBUG_SWITCHES = Object.freeze(['remote-debugging-port', 'remote-debugging-pipe'])

export const SCHEME = 'hetu'

// What before ready needs from Electron's app, faked in the tests. commandLine is Chromium's own parse of the
// arguments, so a switch spelled with another prefix or case is found as Chromium would find it
export type EarlyApp = {
  readonly isPackaged: boolean
  readonly commandLine: { hasSwitch(name: string): boolean }
  setPath(name: 'userData', value: string): void
  requestSingleInstanceLock(): boolean
  enableSandbox(): void
  exit(code: number): void
}

export type EarlyProtocol = { registerSchemesAsPrivileged(schemes: CustomScheme[]): void }

// Runs before ready and before any await, since an ES module entry is sure to run only its synchronous part before
// ready. Null when this process exits: a packaged build started for debugging, or a second hetu on the same data
// folder. The single-instance lock lives in userData, so pointing userData into the data folder first makes the lock
// follow the folder: a second start with another folder runs
export function beforeReady(
  app: EarlyApp,
  protocol: EarlyProtocol,
  options: { env: Record<string, string | undefined>, platform: string },
): { dataDir: string, dev: boolean } | null {
  if (app.isPackaged && DEBUG_SWITCHES.some(name => app.commandLine.hasSwitch(name))) {
    app.exit(1)
    return null
  }
  const found = resolveDataDir({ packaged: app.isPackaged, env: options.env, platform: options.platform })
  // setPath throws on a folder that doesn't exist
  const userData = path.join(found.dataDir, 'electron')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return null
  }
  app.enableSandbox()
  // A second call replaces the first list rather than failing, so this is the only one
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }])
  return found
}

// Where the install list and the install plugins are. A packaged build keeps them beside app.asar and ignores the
// environment, as it does for the data folder. A run from the source uses the built main's folder, or HETU_INSTALL_DIR
// so the tests can hand it an install of their own
export function installDirFor(options: {
  packaged: boolean
  env: Record<string, string | undefined>
  here: string
  resourcesPath: string
  platform: string
}): string {
  if (options.packaged) return options.resourcesPath
  const override = options.env.HETU_INSTALL_DIR
  if (override === undefined) return options.here
  const paths = options.platform === 'win32' ? path.win32 : path.posix
  if (!paths.isAbsolute(override)) throw new Error('HETU_INSTALL_DIR is not an absolute path')
  return override
}
