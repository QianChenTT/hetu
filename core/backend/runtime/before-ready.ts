import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { CustomScheme } from 'electron'
import { resolveDataDir } from '../lib/data-dir.ts'
import { shimArgv } from './shim.ts'

// No fuse turns these off. The two debugging switches open the DevTools handler once main has run, no-sandbox turns the
// renderers' sandbox off and ELECTRON_DISABLE_SANDBOX sets it with no argument at all, and the rest weaken what the
// renderers hold to or run something of the caller's. The proxy switches and host-resolver-rules would undo the
// sessions' proxy to nowhere or the rule that resolves no host name. A locked build refuses every argument besides, so
// these are a second line through Chromium's own parse, which finds a switch however it was spelled
// https://www.electronjs.org/docs/latest/api/command-line-switches
export const REFUSED_SWITCHES = Object.freeze([
  'remote-debugging-port', 'remote-debugging-pipe', 'no-sandbox', 'disable-web-security', 'js-flags', 'renderer-cmd-prefix', 'gpu-launcher',
  'no-proxy-server', 'proxy-server', 'proxy-pac-url', 'proxy-auto-detect', 'proxy-bypass-list', 'host-resolver-rules',
])

export const SCHEME = 'hetu'

// What before ready needs from Electron's app, faked in the tests. commandLine is Chromium's own parse of the
// arguments, so a switch spelled with another prefix or case is found as Chromium would find it
export type EarlyApp = {
  readonly commandLine: { hasSwitch(name: string): boolean, getSwitchValue(name: string): string, appendSwitch(name: string, value: string): void }
  setPath(name: 'userData', value: string): void
  requestSingleInstanceLock(): boolean
  enableSandbox(): void
  disableHardwareAcceleration(): void
  exit(code: number): void
}

export type EarlyProtocol = { registerSchemesAsPrivileged(schemes: CustomScheme[]): void }

// Runs before ready and before any await, since an ES module entry is sure to run only its synchronous part before
// ready. Null when this process exits: a locked build started with any argument or a refused switch, or a second hetu
// on the same data folder. hetu takes no argument but the shim's --mcp-stdio alone after its name, so a locked build
// refuses whatever else follows its own name rather than a list of bad ones, which would miss names. The
// single-instance lock lives in userData, so pointing userData into the data folder first makes the lock follow the
// folder: a second start with another folder runs
//
// The shim gets a profile of its own in the data folder, so it never shares Chromium's files with the hetu it reaches,
// and no GPU. It takes no lock, since a second start only shows the first one's window and opens no renderer, so it
// needs no sandbox or scheme
export function beforeReady(
  app: EarlyApp,
  protocol: EarlyProtocol,
  options: { env: Record<string, string | undefined>, platform: string, locked: boolean, argv: readonly string[] },
): { dataDir: string, dev: boolean, shim?: true } | null {
  const shim = shimArgv(options.argv, options.locked)
  if (options.locked && ((options.argv.length > 1 && !shim) || REFUSED_SWITCHES.some(name => app.commandLine.hasSwitch(name)))) {
    app.exit(1)
    return null
  }
  const found = resolveDataDir({ packaged: options.locked, env: options.env, platform: options.platform })
  // setPath throws on a folder that doesn't exist
  const userData = path.join(found.dataDir, shim ? 'shim' : 'electron')
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  if (shim) {
    app.disableHardwareAcceleration()
    return { ...found, shim }
  }
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return null
  }
  app.enableSandbox()
  // Chromium resolves no host name: hetu loads nothing by name, and a frame's STUN or TURN server named by host, or a
  // remote mDNS candidate, would otherwise be looked up outside the sessions' proxy, carrying whatever the frame put in
  // the name. Node's own lookups in main, fetch's among them, don't pass through Chromium's resolver. Appended here and
  // not on the command line, so app.relaunch, which starts the first argv again, doesn't hand it to a locked build
  // https://www.electronjs.org/docs/latest/api/command-line-switches#--host-resolver-rulesrules
  app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
  // With WebRTC's mDNS hiding on, a frame's peer connection has the network service answer mDNS on UDP 5353 on every
  // address and a remote candidate on <name>.local has it send a query onto every interface when the frame says. No
  // host candidate is gathered under disable_non_proxied_udp, so turning it off hides nothing. Chromium reads only the
  // last --disable-features, so this one carries any already there
  const disabled = app.commandLine.getSwitchValue('disable-features')
  app.commandLine.appendSwitch('disable-features', [disabled, 'WebRtcHideLocalIpsWithMdns'].filter(name => name !== '').join(','))
  // A second call replaces the first list rather than failing, so this is the only one
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true } }])
  return found
}

// Where hetu is installed and where the code built beside main.js is, the door's among it. A packaged build keeps that
// code inside app.asar, so ASAR integrity covers it. A run from the source uses the built main's folder for both.
// Either one not locked takes HETU_INSTALL_DIR in their place, so the tests can hand it a door of their own. A locked
// build never reads the environment
export function installDirFor(options: {
  packaged: boolean
  locked: boolean
  env: Record<string, string | undefined>
  here: string
  resourcesPath: string
  platform: string
}): { installDir: string, codeDir: string } {
  const paths = options.platform === 'win32' ? path.win32 : path.posix
  const override = options.locked ? undefined : options.env.HETU_INSTALL_DIR
  if (override !== undefined) {
    if (!paths.isAbsolute(override)) throw new Error('HETU_INSTALL_DIR is not an absolute path')
    return { installDir: override, codeDir: override }
  }
  if (options.packaged) return { installDir: options.resourcesPath, codeDir: paths.join(options.resourcesPath, 'app.asar') }
  return { installDir: options.here, codeDir: options.here }
}
