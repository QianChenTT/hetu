import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
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

// The executable inside a packed folder
export function executableIn(appOutDir: string, platform: string = process.platform): string {
  if (platform === 'win32') return path.join(appOutDir, 'hetu.exe')
  if (platform === 'darwin') return path.join(appOutDir, 'hetu.app', 'Contents', 'MacOS', 'hetu')
  return path.join(appOutDir, 'hetu')
}

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
    win: { target: kind.target === 'installer' ? ['msi'] : ['dir'] },
    // Per machine into Program Files with one UAC prompt, no folder to pick, never started by the installer, so hetu
    // never runs elevated
    msi: {
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
  const stage = path.join(kind.out, 'stage')
  await rm(kind.out, { recursive: true, force: true })
  await stageInstall(stage, { locked: kind.locked })
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
