import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { configFor, icoFromPng, MSI_NAME, packageHetu } from '../build/package.ts'
import { FUSES } from '../build/fuses.ts'

// A release asset's name is changed where it holds a space, so a name with one wouldn't match its line in SHA256SUMS
describe('the MSI\'s file name', () => {
  it('holds the version and the architecture and no space', () => {
    const name = MSI_NAME.replace('${version}', '0.5.0').replace('${ext}', 'msi')
    expect(name).toBe('hetu-0.5.0-x64.msi')
    expect(MSI_NAME).not.toMatch(/\s/)
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
  // Electron's own default app, a real archive, stands in for app.asar as well
  const electronAsar = path.join(path.dirname(require.resolve('electron/package.json')), 'dist', 'resources', 'default_app.asar')

  for (const [platform, inside] of [['win32', ['resources']], ['linux', ['resources']], ['darwin', ['Electron.app', 'Contents', 'Resources']]] as const) {
    it(`names app.asar alone once Electron is extracted, on ${platform}`, async () => {
      const appOutDir = await mkdtemp(path.join(tmpdir(), 'hetu-pack-'))
      try {
        const resources = path.join(appOutDir, ...inside)
        await mkdir(resources, { recursive: true })
        await copyFile(electronAsar, path.join(resources, 'default_app.asar'))
        const config = configFor(appOutDir, { target: 'dir', locked: true, out: appOutDir }, FUSES)
        const afterExtract = config.afterExtract as ((context: { appOutDir: string, electronPlatformName: string }) => Promise<void>) | undefined
        await afterExtract?.({ appOutDir, electronPlatformName: platform })
        await copyFile(electronAsar, path.join(resources, 'app.asar'))
        const relative = platform === 'darwin' ? 'Resources' : 'resources'
        const list = await computeData({ resourcesPath: resources, resourcesRelativePath: relative, resourcesDestinationPath: resources })
        expect(Object.keys(list)).toEqual([path.join(relative, 'app.asar')])
      } finally {
        await rm(appOutDir, { recursive: true, force: true })
      }
    })
  }
})
