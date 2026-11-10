import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { CustomScheme } from 'electron'
import { resolveDataDir } from '../boot/boot.ts'

// No fuse turns these off. The two debugging switches open the DevTools handler once main has run, no-sandbox turns the
// renderers' sandbox off and ELECTRON_DISABLE_SANDBOX sets it with no argument at all, and the rest weaken what the
// renderers hold to or run something of the caller's. A locked build refuses every argument besides, so these are a
// second line through Chromium's own parse, which finds a switch however it was spelled
export const REFUSED_SWITCHES = Object.freeze([
  'remote-debugging-port', 'remote-debugging-pipe', 'no-sandbox', 'disable-web-security', 'js-flags', 'renderer-cmd-prefix', 'gpu-launcher',
])

export const SCHEME = 'hetu'

// What before ready needs from Electron's app, faked in the tests. commandLine is Chromium's own parse of the
// arguments, so a switch spelled with another prefix or case is found as Chromium would find it
export type EarlyApp = {
  readonly commandLine: { hasSwitch(name: string): boolean }
  setPath(name: 'userData', value: string): void
  requestSingleInstanceLock(): boolean
  enableSandbox(): void
  exit(code: number): void
}

export type EarlyProtocol = { registerSchemesAsPrivileged(schemes: CustomScheme[]): void }

// Runs before ready and before any await, since an ES module entry is sure to run only its synchronous part before
// ready. Null when this process exits: a locked build started with any argument or a refused switch, or a second hetu
// on the same data folder. hetu takes no argument, so a locked build refuses whatever follows its own name rather than
// a list of bad ones, which would miss names. The single-instance lock lives in userData, so pointing userData into
// the data folder first makes the lock follow the folder: a second start with another folder runs
export function beforeReady(
  app: EarlyApp,
  protocol: EarlyProtocol,
  options: { env: Record<string, string | undefined>, platform: string, locked: boolean, argv: readonly string[] },
): { dataDir: string, dev: boolean } | null {
  if (options.locked && (options.argv.length > 1 || REFUSED_SWITCHES.some(name => app.commandLine.hasSwitch(name)))) {
    app.exit(1)
    return null
  }
  const found = resolveDataDir({ packaged: options.locked, env: options.env, platform: options.platform })
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

// Where the install plugins are and where the install list is. A packaged build keeps the plugins beside app.asar and
// the list inside it, so ASAR integrity covers the list. A run from the source uses the built main's folder for both.
// Either one not locked takes HETU_INSTALL_DIR in their place, so the tests can hand it an install of their own. A
// locked build never reads the environment
export function installDirFor(options: {
  packaged: boolean
  locked: boolean
  env: Record<string, string | undefined>
  here: string
  resourcesPath: string
  platform: string
}): { installDir: string, listDir: string } {
  const paths = options.platform === 'win32' ? path.win32 : path.posix
  const override = options.locked ? undefined : options.env.HETU_INSTALL_DIR
  if (override !== undefined) {
    if (!paths.isAbsolute(override)) throw new Error('HETU_INSTALL_DIR is not an absolute path')
    return { installDir: override, listDir: override }
  }
  if (options.packaged) return { installDir: options.resourcesPath, listDir: paths.join(options.resourcesPath, 'app.asar') }
  return { installDir: options.here, listDir: options.here }
}
