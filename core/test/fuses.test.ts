import { FuseV1Options } from '@electron/fuses'
import { describe, expect, it } from 'vitest'
import { FUSES, fuseConfig } from '../build/fuses.ts'

// The names @electron/fuses knows, so an Electron that adds a fuse fails here until hetu decides it
const known = Object.keys(FuseV1Options).filter(name => Number.isNaN(Number(name)))

describe('the fuses', () => {
  it('decides every fuse the Electron in use has, and no other', () => {
    expect(Object.keys(FUSES).sort()).toEqual([...known].sort())
  })

  it('turns off every way to run code in main besides app.asar and turns on its integrity check', () => {
    expect(FUSES).toEqual({
      RunAsNode: false,
      EnableCookieEncryption: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
      WasmTrapHandlers: true,
    })
  })

  it('hands @electron/fuses every fuse by its index with all of them required', () => {
    const config = fuseConfig('win32', FUSES) as unknown as Record<string, unknown>
    expect(config.strictlyRequireAllFuses).toBe(true)
    for (const name of known) expect(config[FuseV1Options[name as keyof typeof FuseV1Options]], name).toBe(FUSES[name as keyof typeof FUSES])
    expect(config.resetAdHocDarwinSignature).toBe(false)
    expect((fuseConfig('darwin', FUSES) as { resetAdHocDarwinSignature?: boolean }).resetAdHocDarwinSignature).toBe(true)
  })

  // The driven build, which the end-to-end tests reach through the inspector, is the only one with it on
  it('leaves the inspector on only when asked, for the build the end-to-end tests drive', () => {
    const driven = fuseConfig('win32', { ...FUSES, EnableNodeCliInspectArguments: true }) as unknown as Record<number, boolean>
    expect(driven[FuseV1Options.EnableNodeCliInspectArguments]).toBe(true)
    expect(driven[FuseV1Options.RunAsNode]).toBe(false)
  })
})
