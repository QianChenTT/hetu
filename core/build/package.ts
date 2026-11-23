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

// The setup's id, which names its registry keys. Fixed for good: a new one would install a second hetu beside the first.
// The value electron-builder derives from the app id, so it stays the same if the app id is ever changed
export const INSTALL_GUID = '3af4a7b2-eaef-54c1-8e70-b491bbebeebd'

export type PackageKind = {
  // dir builds the unpacked folder alone, installer the folder and the setup (Windows) around it
  target: 'dir' | 'installer'
  // false only for the build the end-to-end tests drive, which also keeps the inspector fuse on for Playwright and is
  // never made into an installer
  locked: boolean
  out: string
}

// electron-builder's own 256 pixel Electron icon, the one the executable shows until hetu has an icon of its own
const ICON_PNG = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'icons', 'electron-linux', '256x256.png')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// An ICO file holding one 256 pixel PNG, as Windows reads them since Vista. The setup's and its uninstaller's icon and
// the shortcuts' icon come from it
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

// Where an extracted Electron keeps its resources. On macOS the bundle still has Electron's own name then, which
// electron-builder renames to hetu.app later
async function resourcesIn(appOutDir: string, platform: string): Promise<string> {
  if (platform !== 'darwin') return path.join(appOutDir, 'resources')
  const bundles = (await readdir(appOutDir)).filter(name => name.endsWith('.app'))
  if (bundles.length !== 1) throw new Error(`expected one app bundle in ${appOutDir}, found ${bundles.length}`)
  return path.join(appOutDir, bundles[0]!, 'Contents', 'Resources')
}

// The setup's file name as electron-builder's template. No space, since a GitHub release changes one in an asset's name
// and the name would no longer match its line in SHA256SUMS
export const SETUP_NAME_TEMPLATE = 'hetu-setup-${version}-x64.${ext}'

// The setups among the files a build made, the files SHA256SUMS covers
export function setupsIn(made: readonly string[]): string[] {
  return made.filter(file => /^hetu-setup-.+-x64\.exe$/.test(path.basename(file)))
}

export function configFor(stage: string, kind: PackageKind, fuses: Readonly<Record<FuseName, boolean>>): Configuration {
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
    npmRebuild: false,
    nodeGypRebuild: false,
    buildDependenciesFromSource: false,
    includePdb: false,
    publish: null,
    // Electron's own default app goes once Electron is extracted, so resources holds app.asar alone. It
    // goes before electron-builder lists the archives in resources for the integrity it writes into the executable,
    // which comes after afterExtract and before afterPack, so the list names no file the package doesn't hold
    afterExtract: async context => {
      await rm(path.join(await resourcesIn(context.appOutDir, context.electronPlatformName), 'default_app.asar'), { force: true })
    },
    // One place flips the fuses, after the integrity of app.asar is in the executable
    afterPack: async context => {
      await flipFuses(executableIn(context.appOutDir, context.electronPlatformName), fuseConfig(context.electronPlatformName, fuses))
    },
    win: { target: kind.target === 'installer' ? ['nsis'] : ['dir'], icon: path.join(stage, 'resources', 'icon.ico') },
    // For the current Windows account into %LOCALAPPDATA%\Programs\hetu with no UAC prompt: Welcome, the desktop shortcut
    // box, progress and Finish with Run hetu. No folder to pick. The include script skips the page that asks just me or
    // all users and makes every way to elevation a refusal
    nsis: {
      artifactName: SETUP_NAME_TEMPLATE,
      oneClick: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      packElevateHelper: false,
      runAfterFinish: true,
      createStartMenuShortcut: true,
      // Made by the include script from its checkbox, which electron-builder doesn't offer
      createDesktopShortcut: false,
      shortcutName: 'hetu',
      guid: INSTALL_GUID,
      include: path.join(import.meta.dirname, 'installer.nsh'),
      // The blockmap serves electron-updater's partial downloads, which hetu doesn't use
      differentialPackage: false,
      deleteAppDataOnUninstall: false,
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
    targets: platform.createTarget(kind.target === 'installer' && process.platform === 'win32' ? ['nsis'] : ['dir'], arch),
    config: configFor(stage, kind, fuses),
    // The staged app with its own package.json and no dependencies, so nothing from the repo is collected
    projectDir: path.join(stage, 'app'),
  })
  const unpacked = (await readdir(kind.out)).find(name => /-unpacked$|^mac/.test(name))
  if (unpacked === undefined) throw new Error('no unpacked folder was made')
  const appOutDir = path.join(kind.out, unpacked)
  const sums = await Promise.all(setupsIn(made).map(async file => `${createHash('sha256').update(await readFile(file)).digest('hex')}  ${path.basename(file)}`))
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
