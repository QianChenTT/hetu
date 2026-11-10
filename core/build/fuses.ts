import { type FuseConfig, FuseV1Options, FuseVersion } from '@electron/fuses'

export type FuseName = keyof typeof FuseV1Options

// Each fuse Electron 45 has, set at packaging and read by Electron before main.js runs. Off: every way to run code in
// main besides app.asar. On: app.asar's integrity check and loading the app from app.asar alone
export const FUSES: Readonly<Record<FuseName, boolean>> = Object.freeze({
  // ELECTRON_RUN_AS_NODE would make hetu.exe a plain Node. hetu never forks itself
  RunAsNode: false,
  // Every session is in memory and offline, so no cookie reaches the disk. The fuse can't be turned back off and on
  // macOS it wants a signed app for the Keychain
  EnableCookieEncryption: false,
  // NODE_OPTIONS would load code into main before main.js
  EnableNodeOptionsEnvironmentVariable: false,
  // --inspect would open main to a debugger
  EnableNodeCliInspectArguments: false,
  // A changed app.asar ends the app on Windows and macOS
  EnableEmbeddedAsarIntegrityValidation: true,
  // An app folder beside app.asar is never loaded in its place
  OnlyLoadAppFromAsar: true,
  // hetu ships no V8 snapshot of its own
  LoadBrowserProcessSpecificV8Snapshot: false,
  // No page loads from file:, every page is on hetu:
  GrantFileProtocolExtraPrivileges: false,
  // A speed feature. Off, V8 checks bounds in code, so memory safety is the same
  WasmTrapHandlers: true,
})

// The config @electron/fuses flips: each fuse by its index, all of them required, so an Electron that adds a fuse fails
// the build until it is decided here. On macOS the ad-hoc signature is made again after the bytes change
export function fuseConfig(platform: string, fuses: Readonly<Record<FuseName, boolean>>): FuseConfig {
  const config: Record<string | number, unknown> = { version: FuseVersion.V1, strictlyRequireAllFuses: true, resetAdHocDarwinSignature: platform === 'darwin' }
  for (const [name, on] of Object.entries(fuses)) config[FuseV1Options[name as FuseName]] = on
  return config as unknown as FuseConfig
}
