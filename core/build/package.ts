import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { flipFuses } from '@electron/fuses'
import { Arch, build, Platform, type Configuration } from 'electron-builder'
import { FUSES, fuseConfig, type FuseName } from './fuses.ts'
import { stageInstall } from './stage.ts'

const repo = path.join(import.meta.dirname, '..', '..')
const require = createRequire(import.meta.url)
const electronVersion = (require('electron/package.json') as { version: string }).version
// The Electron the lock file fetched and checksummed and the tests ran, so packaging downloads no second one
const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist')

// Fixed for good: a new one would install a second hetu beside the first
const UPGRADE_CODE = '6f3d2a8e-4b1c-4e7a-9d55-2c8b0e1f7a43'

export type PackageKind = {
  // dir builds the unpacked folder alone, installer the folder and the MSI (Windows) around it
  target: 'dir' | 'installer'
  // false only for the build the end-to-end tests drive, which also keeps the inspector fuse on for Playwright and is
  // never made into an installer
  locked: boolean
  out: string
}

// electron-builder's own 256 pixel Electron icon, the one the executable shows until hetu has an icon of its own
const ICON_PNG = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'icons', 'electron-linux', '256x256.png')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// An ICO file holding one 256 pixel PNG, as Windows reads them since Vista. The MSI's Start menu shortcut names an icon
// whether or not one is set, so the installer needs one
export function icoFromPng(png: Buffer): Buffer {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG')
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  // Width and height 0 stand for 256, then no palette, the reserved byte, one plane and 32 bits a pixel
  header.writeUInt8(0, 6)
  header.writeUInt8(0, 7)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}

// The executable inside a packed folder
export function executableIn(appOutDir: string, platform: string = process.platform): string {
  if (platform === 'win32') return path.join(appOutDir, 'hetu.exe')
  if (platform === 'darwin') return path.join(appOutDir, 'hetu.app', 'Contents', 'MacOS', 'hetu')
  return path.join(appOutDir, 'hetu')
}

// The MSI's file name as electron-builder's template. No space, since a GitHub release changes one in an asset's name
// and the name would no longer match its line in SHA256SUMS
export const MSI_NAME = 'hetu-${version}-x64.${ext}'

function configFor(stage: string, kind: PackageKind, fuses: Readonly<Record<FuseName, boolean>>): Configuration {
  return {
    appId: 'app.hetu',
    productName: 'hetu',
    executableName: 'hetu',
    copyright: 'hetu',
    electronVersion,
    electronDist,
    directories: { output: kind.out, buildResources: path.join(stage, 'resources') },
    files: ['**/*'],
    asar: true,
    asarUnpack: [],
    // Each install plugin beside app.asar, which the loader checks against the list inside it
    extraResources: [{ from: path.join(stage, 'plugins'), to: 'plugins', filter: ['**/*'] }],
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    includePdb: false,
    publish: null,
    // Electron's own default app goes, so resources holds app.asar and the plugins alone. Then one place flips the fuses,
    // after the integrity of app.asar is in the executable
    afterPack: async context => {
      const resources = context.electronPlatformName === 'darwin' ? path.join(context.appOutDir, 'hetu.app', 'Contents', 'Resources') : path.join(context.appOutDir, 'resources')
      await rm(path.join(resources, 'default_app.asar'), { force: true })
      await flipFuses(executableIn(context.appOutDir, context.electronPlatformName), fuseConfig(context.electronPlatformName, fuses))
    },
    win: { target: kind.target === 'installer' ? ['msi'] : ['dir'], icon: path.join(stage, 'resources', 'icon.ico') },
    // Per machine into Program Files with one UAC prompt, no folder to pick, never started by the installer, so hetu
    // never runs elevated
    msi: {
      artifactName: MSI_NAME,
      perMachine: true,
      oneClick: true,
      runAfterFinish: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      shortcutName: 'hetu',
      upgradeCode: UPGRADE_CODE,
      warningsAsErrors: true,
    },
    mac: { target: [{ target: 'dir', arch: ['arm64'] }], identity: null, hardenedRuntime: false },
    linux: { target: ['dir'], executableName: 'hetu', category: 'Office' },
  }
}

// The stage, the package around it and a SHA256SUMS file over what was made. The tool sits behind this one function,
// and every proof tests what it made
export async function packageHetu(kind: PackageKind): Promise<{ appOutDir: string, made: string[] }> {
  // The driven build takes the inspector and the environment's folders, so it never ships
  if (kind.target === 'installer' && !kind.locked) throw new Error('an installer is built only around a locked build')
  const stage = path.join(kind.out, 'stage')
  await rm(kind.out, { recursive: true, force: true })
  await stageInstall(stage, { locked: kind.locked })
  await mkdir(path.join(stage, 'resources'), { recursive: true })
  await writeFile(path.join(stage, 'resources', 'icon.ico'), icoFromPng(await readFile(ICON_PNG)))
  const fuses = kind.locked ? FUSES : { ...FUSES, EnableNodeCliInspectArguments: true }
  const platform = process.platform === 'win32' ? Platform.WINDOWS : process.platform === 'darwin' ? Platform.MAC : Platform.LINUX
  const arch = process.platform === 'darwin' ? Arch.arm64 : Arch.x64
  const made = await build({
    targets: platform.createTarget(kind.target === 'installer' && process.platform === 'win32' ? ['msi'] : ['dir'], arch),
    config: configFor(stage, kind, fuses),
    // The staged app with its own package.json and no dependencies, so nothing from the repo is collected
    projectDir: path.join(stage, 'app'),
  })
  const unpacked = (await readdir(kind.out)).find(name => /-unpacked$|^mac/.test(name))
  if (unpacked === undefined) throw new Error('no unpacked folder was made')
  const appOutDir = path.join(kind.out, unpacked)
  const installers = made.filter(file => file.endsWith('.msi'))
  const sums = await Promise.all(installers.map(async file => `${createHash('sha256').update(await readFile(file)).digest('hex')}  ${path.basename(file)}`))
  if (sums.length > 0) await writeFile(path.join(kind.out, 'SHA256SUMS'), `${sums.join('\n')}\n`)
  return { appOutDir, made }
}

if (import.meta.main) {
  const target = process.argv.includes('installer') ? 'installer' : 'dir'
  const driven = process.argv.includes('driven')
  const out = path.join(repo, 'dist-package', driven ? 'driven' : target)
  const { appOutDir, made } = await packageHetu({ target, locked: !driven, out })
  console.log(appOutDir)
  for (const file of made) console.log(file)
}
