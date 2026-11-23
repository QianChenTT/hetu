import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { configFor, icoFromPng, INSTALL_GUID, packageHetu, SETUP_NAME, setupsIn } from '../build/package.ts'
import { FUSES } from '../build/fuses.ts'

// A release asset's name is changed where it holds a space, so a name with one wouldn't match its line in SHA256SUMS
describe('the setup\'s file name', () => {
  it('holds the version and the architecture and no space', () => {
    const name = SETUP_NAME.replace('${version}', '0.5.0').replace('${ext}', 'exe')
    expect(name).toBe('hetu-setup-0.5.0-x64.exe')
    expect(SETUP_NAME).not.toMatch(/\s/)
  })

  it('is the one file of a build SHA256SUMS covers', () => {
    const out = path.join('dist-package', 'installer')
    const made = ['hetu-setup-0.5.0-x64.exe', 'hetu-setup-0.5.0-x64.exe.blockmap', 'latest.yml', 'hetu-0.5.0-x64.msi', 'Uninstall hetu.exe']
    expect(setupsIn(made.map(name => path.join(out, name)))).toEqual([path.join(out, 'hetu-setup-0.5.0-x64.exe')])
  })
})

// The installer as configured for electron-builder. The include script locks it to the current user, see
// installer-script.test.ts
describe('the Windows installer', () => {
  const config = configFor('stage', { target: 'installer', locked: true, out: 'out' }, FUSES)
  const nsis = config.nsis!

  it('is NSIS alone, with no MSI left', () => {
    expect(config.win?.target).toEqual(['nsis'])
    expect(config).not.toHaveProperty('msi')
    expect(configFor('stage', { target: 'dir', locked: true, out: 'out' }, FUSES).win?.target).toEqual(['dir'])
  })

  it('installs per user with no page that can ask for administrator rights', () => {
    expect(nsis).not.toHaveProperty('perMachine')
    expect(nsis).not.toHaveProperty('selectPerMachineByDefault')
    expect(nsis.oneClick).toBe(false)
    expect(nsis.allowElevation).toBe(false)
    expect(nsis.packElevateHelper).toBe(false)
    expect(nsis.allowToChangeInstallationDirectory).toBe(false)
  })

  it('runs hetu at the finish, makes the Start menu shortcut and leaves the desktop one to the include script', () => {
    expect(nsis.runAfterFinish).toBe(true)
    expect(nsis.createStartMenuShortcut).toBe(true)
    expect(nsis.createDesktopShortcut).toBe(false)
    expect(nsis.include).toBe(path.join(import.meta.dirname, '..', 'build', 'installer.nsh'))
  })

  it('keeps one fixed id, so a newer setup replaces the install instead of adding a second hetu', () => {
    expect(nsis.guid).toBe(INSTALL_GUID)
    expect(INSTALL_GUID).toBe('3af4a7b2-eaef-54c1-8e70-b491bbebeebd')
  })

  // A misspelled option would otherwise be read as unset and the setup built without it
  it('passes electron-builder\'s own schema, which refuses an option it doesn\'t know', async () => {
    const require = createRequire(path.join(path.dirname(createRequire(import.meta.url).resolve('electron-builder/package.json')), 'package.json'))
    const lib = createRequire(require.resolve('app-builder-lib/package.json'))
    const { validateConfiguration } = lib('./out/util/config/config.js') as { validateConfiguration(config: unknown, logger: unknown): Promise<void> }
    const { DebugLogger } = lib('builder-util') as { DebugLogger: new (enabled: boolean) => unknown }
    await expect(validateConfiguration(config, new DebugLogger(false))).resolves.toBeUndefined()
    await expect(validateConfiguration({ ...config, nsis: { ...nsis, allowElevaton: false } }, new DebugLogger(false))).rejects.toThrow('configuration')
  })

  it('names the setup, writes no blockmap and keeps app data on uninstall', () => {
    expect(nsis.artifactName).toBe(SETUP_NAME)
    expect(nsis.differentialPackage).toBe(false)
    expect(nsis.deleteAppDataOnUninstall).toBe(false)
    expect(nsis.warningsAsErrors).toBe(true)
    expect(config.publish).toBeNull()
  })
})

describe('what may become an installer', () => {
  it('refuses an installer around a build that isn\'t locked, before anything is staged', async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'hetu-package-'))
    try {
      await expect(packageHetu({ target: 'installer', locked: false, out })).rejects.toThrow('locked')
      expect(await readdir(out)).toEqual([])
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

// The start of a PNG, enough for the header to be read
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])

describe('the installer\'s icon', () => {
  it('is one 256 pixel PNG image in an ICO file, which Windows reads since Vista', () => {
    const ico = icoFromPng(png)
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 1])
    // 0 stands for 256 in an ICO entry's width and height
    expect([ico[6], ico[7], ico.readUInt16LE(10), ico.readUInt16LE(12)]).toEqual([0, 0, 1, 32])
    expect([ico.readUInt32LE(14), ico.readUInt32LE(18)]).toEqual([png.length, 22])
    expect(ico.subarray(22).equals(png)).toBe(true)
  })

  it('refuses bytes that aren\'t a PNG', () => {
    expect(() => icoFromPng(Buffer.from('not a png'))).toThrow('PNG')
  })
})

// electron-builder lists the archives in resources and writes that list into the executable after afterExtract and
// before afterPack (platformPackager.js in app-builder-lib 26.18.0), so a file deleted later stays named in it
describe('the integrity list in the executable', () => {
  const require = createRequire(import.meta.url)
  const builder = path.dirname(require.resolve('electron-builder/package.json'))
  const { computeData } = createRequire(path.join(builder, 'package.json'))('app-builder-lib/out/asar/integrity') as {
    computeData(options: { resourcesPath: string, resourcesRelativePath: string, resourcesDestinationPath: string }): Promise<Record<string, unknown>>
  }
  // A small archive in asar's layout stands in for Electron's default app and for app.asar, so the test needs no
  // Electron binary, which the unit tests' install never fetches: a pickled size, then a pickled JSON header
  const archive = (file: string) => {
    const json = Buffer.from(JSON.stringify({ files: { 'index.js': { size: 0, offset: '0' } } }))
    const padded = Math.ceil(json.length / 4) * 4
    const head = Buffer.alloc(16 + padded)
    head.writeUInt32LE(4, 0)
    head.writeUInt32LE(8 + padded, 4)
    head.writeUInt32LE(4 + padded, 8)
    head.writeUInt32LE(json.length, 12)
    json.copy(head, 16)
    return writeFile(file, head)
  }

  for (const [platform, inside] of [['win32', ['resources']], ['linux', ['resources']], ['darwin', ['Electron.app', 'Contents', 'Resources']]] as const) {
    it(`names app.asar alone once Electron is extracted, on ${platform}`, async () => {
      const appOutDir = await mkdtemp(path.join(tmpdir(), 'hetu-pack-'))
      try {
        const resources = path.join(appOutDir, ...inside)
        await mkdir(resources, { recursive: true })
        await archive(path.join(resources, 'default_app.asar'))
        const config = configFor(appOutDir, { target: 'dir', locked: true, out: appOutDir }, FUSES)
        const afterExtract = config.afterExtract as ((context: { appOutDir: string, electronPlatformName: string }) => Promise<void>) | undefined
        await afterExtract?.({ appOutDir, electronPlatformName: platform })
        await archive(path.join(resources, 'app.asar'))
        const relative = platform === 'darwin' ? 'Resources' : 'resources'
        const list = await computeData({ resourcesPath: resources, resourcesRelativePath: relative, resourcesDestinationPath: resources })
        expect(Object.keys(list)).toEqual([path.join(relative, 'app.asar')])
      } finally {
        await rm(appOutDir, { recursive: true, force: true })
      }
    })
  }
})
