import { appendFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses'
import { afterEach, describe, expect, it } from 'vitest'
import { executableIn } from '../../build/package.ts'
import { FUSES, type FuseName } from '../../build/fuses.ts'
import { hashFiles, readFiles } from '../../lib/hash-files.ts'
import { appDir, cleanup, electronCopyIn, exitText, homeEnv, linkedCopy, repo, resourcesOf, start, temp } from './helpers.ts'

// The packed build as it ships, started as a plain process: what Playwright can't drive, since a locked build refuses
// the switches Playwright starts it with

afterEach(cleanup)

const exists = (file: string) => readFile(file).then(() => true, () => false)
// A copy whose fuses changed is signed again on macOS, where an executable with a broken ad hoc signature won't run
const darwin = process.platform === 'darwin'

describe('the packed folder', () => {
  it('has every fuse as the table sets it', async () => {
    const wire = await getCurrentFuseWire(executableIn(appDir)) as unknown as Record<number, number>
    for (const [name, on] of Object.entries(FUSES)) {
      expect(String.fromCharCode(wire[FuseV1Options[name as FuseName]]), name).toBe(on ? '1' : '0')
    }
  })

  // macOS keeps the app's icon there too, which Info.plist names
  it('holds app.asar and the install plugins in resources and nothing else', async () => {
    const icon = process.platform === 'darwin' ? ['electron.icns'] : []
    expect((await readdir(resourcesOf(appDir))).sort()).toEqual(['app.asar', ...icon, 'plugins'].sort())
  })
})

describe('a start', () => {
  it('reaches core.ready with the gate and its plugins, its pages and preloads read out of app.asar, and reads no folder the environment names', async () => {
    const decoy = await temp()
    const decoyData = path.join(decoy, 'data')
    const decoyInstall = path.join(decoy, 'install')
    const { env, dataDir } = await homeEnv({ HETU_DATA_DIR: decoyData, HETU_INSTALL_DIR: decoyInstall })
    const started = await start({ env, until: all => all.some(record => record.event === 'plugin.started' && record.plugin === 'layout') && all.some(record => record.event === 'core.ready') })
    expect(started.ready).toBe(true)
    expect(started.dataDir).toBe(dataDir)
    const events = started.records.map(record => `${record.event}${typeof record.plugin === 'string' ? ` ${record.plugin}` : ''}`)
    expect(events).toEqual(expect.arrayContaining(['install.checked', 'plugin.started gate', 'plugin.started capabilities', 'plugin.started search', 'plugin.started layout']))
    expect(started.records.find(record => record.event === 'install.checked')).toMatchObject({ result: 'ok' })
    expect(started.records.find(record => record.event === 'core.ready')).toMatchObject({ gate: 'on' })
    expect([await exists(decoyData), await exists(decoyInstall)]).toEqual([false, false])
    expect(await readdir(decoy)).toEqual([])
  })
})

// A locked build exits 1 before ready, so it writes no event and opens no DevTools port
async function refused(args: string[], extra: Record<string, string> = {}, executable?: string) {
  const { env } = await homeEnv(extra)
  const started = await start({ env, args, ms: 20_000, ...(executable === undefined ? {} : { executable }) })
  expect(started.code, `${args.join(' ')}: ${exitText(started)}`).toBe(1)
  expect(started.stderr).not.toMatch(/DevTools listening|Debugger listening/)
  expect(started.records).toEqual([])
}

describe('switches and arguments', () => {
  it.each([
    ['--remote-debugging-port=0'], ['--remote-debugging-pipe'], ['--REMOTE-DEBUGGING-PORT=0'], ['--no-sandbox'], ['--js-flags=--expose-gc'],
    ['--inspect=0'], ['--disable-web-security'], ['notes.md'],
  ])('refuses %s', async arg => {
    await refused([arg])
  })

  it.runIf(process.platform === 'win32')('refuses a switch spelled the Windows way', async () => {
    await refused(['/remote-debugging-port=0'])
  })

  // Electron turns it into --no-sandbox with nothing on the command line
  it('refuses ELECTRON_DISABLE_SANDBOX with no argument at all', async () => {
    await refused([], { ELECTRON_DISABLE_SANDBOX: '1' })
  })

  // app.isPackaged reads the executable's name. The build's own constant doesn't
  it('refuses a debugging switch to a copy of hetu named electron', async () => {
    const copy = await linkedCopy()
    const named = electronCopyIn(copy)
    await link(executableIn(copy), named)
    await refused(['--remote-debugging-port=0'], {}, named)
  })
})

// Each control is shown to fire on a copy with that fuse on, so the test can tell the fuse from anything else. Each
// start gets a data folder of its own, since a start ends once its log holds core.ready and a log shared with the start
// before already does, which ended a control before Node had read its options on a slower machine
describe('the fuses hold', () => {
  async function withFuse(fuse: FuseName, on: boolean, name?: string): Promise<string> {
    const executable = path.relative(appDir, executableIn(appDir)).split(path.sep).join('/')
    const copy = await linkedCopy([executable])
    await flipFuses(executableIn(copy), { version: FuseVersion.V1, resetAdHocDarwinSignature: darwin, [FuseV1Options[fuse]]: on })
    if (name === undefined) return executableIn(copy)
    const named = path.join(path.dirname(executableIn(copy)), name)
    await rename(executableIn(copy), named)
    return named
  }

  async function markerScript(): Promise<{ script: string, marker: string }> {
    const dir = await temp()
    const marker = path.join(dir, 'ran.txt')
    const script = path.join(dir, 'plant.cjs')
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(0)\n`)
    return { script, marker }
  }

  it('runs no script as plain Node through ELECTRON_RUN_AS_NODE', async () => {
    const { script, marker } = await markerScript()
    const env = async () => (await homeEnv({ ELECTRON_RUN_AS_NODE: '1' })).env
    await start({ env: await env(), args: [script], ms: 15_000 })
    expect(await exists(marker)).toBe(false)
    await start({ env: await env(), args: [script], ms: 15_000, executable: await withFuse('RunAsNode', true) })
    expect(await exists(marker)).toBe(true)
  })

  it('loads no code through NODE_OPTIONS, even in a copy named electron, which Electron itself takes for a run from the source', async () => {
    const { script, marker } = await markerScript()
    const env = async () => (await homeEnv({ NODE_OPTIONS: `--require=${script}` })).env
    const name = process.platform === 'win32' ? 'electron.exe' : 'electron'
    await start({ env: await env(), ms: 20_000, executable: await withFuse('EnableNodeOptionsEnvironmentVariable', false, name) })
    expect(await exists(marker)).toBe(false)
    const control = await start({ env: await env(), ms: 20_000, executable: await withFuse('EnableNodeOptionsEnvironmentVariable', true, name) })
    expect(await exists(marker), control.stderr).toBe(true)
  })

  it('opens no debugger for --inspect', async () => {
    expect((await start({ args: ['--inspect=0'], ms: 15_000 })).stderr).not.toContain('Debugger listening')
    expect((await start({ args: ['--inspect=0'], ms: 15_000, executable: await withFuse('EnableNodeCliInspectArguments', true) })).stderr).toContain('Debugger listening')
  })

  it('never loads an app folder put where app.asar was', async () => {
    const { script, marker } = await markerScript()
    const plant = async (executable: string) => {
      const resources = resourcesOf(path.dirname(executable).endsWith('MacOS') ? path.join(executable, '..', '..', '..', '..') : path.dirname(executable))
      await rm(path.join(resources, 'app.asar'))
      await mkdir(path.join(resources, 'app'))
      await writeFile(path.join(resources, 'app', 'package.json'), '{"main":"main.cjs"}\n')
      await writeFile(path.join(resources, 'app', 'main.cjs'), `require(${JSON.stringify(script)})\n`)
      return executable
    }
    await start({ ms: 10_000, executable: await plant(await withFuse('OnlyLoadAppFromAsar', true)) })
    expect(await exists(marker)).toBe(false)
    await start({ ms: 10_000, executable: await plant(await withFuse('OnlyLoadAppFromAsar', false)) })
    expect(await exists(marker)).toBe(true)
  })
})

// Linux has no ASAR integrity, so a changed app.asar is refused on Windows and macOS only
describe.runIf(process.platform !== 'linux')('a changed app.asar', () => {
  const asar = path.relative(appDir, path.join(resourcesOf(appDir), 'app.asar')).split(path.sep).join('/')
  const executable = path.relative(appDir, executableIn(appDir)).split(path.sep).join('/')

  // One byte of a file's content, or of the header, changed on a copy. With the integrity fuse off the same copy starts
  async function changed(where: 'content' | 'header', fuseOn: boolean): Promise<string> {
    const copy = await linkedCopy([asar, executable])
    const file = path.join(copy, asar)
    const bytes = await readFile(file)
    const at = where === 'content' ? bytes.indexOf('hetu could not start') : bytes.indexOf('"hash":"') + 8
    expect(at).toBeGreaterThan(8)
    bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61
    await writeFile(file, bytes)
    if (!fuseOn) await flipFuses(executableIn(copy), { version: FuseVersion.V1, resetAdHocDarwinSignature: darwin, [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false })
    return copy
  }

  it.each(['content', 'header'] as const)('ends the app when its %s changed, and the same copy starts with the check off', async where => {
    const refusedStart = await start({ dir: await changed(where, true), ms: 20_000 })
    expect(refusedStart.ready).toBe(false)
    expect(refusedStart.code).not.toBeNull()
    expect((await start({ dir: await changed(where, false) })).ready).toBe(true)
  })
})

describe('a changed install plugin', () => {
  const list = async () => JSON.parse(await readFile(path.join(repo, 'dist-package', 'dir', 'stage', 'app', 'hetu-install.json'), 'utf8')) as { plugins: Record<string, { hash: string }> }

  async function tampered(id: string): Promise<string> {
    const file = path.relative(appDir, path.join(resourcesOf(appDir), 'plugins', id, 'dist', 'host.js')).split(path.sep).join('/')
    const copy = await linkedCopy([file])
    await appendFile(path.join(copy, file), '\n// changed\n')
    return copy
  }

  it('fails alone as tampered and hetu runs', async () => {
    const started = await start({ dir: await tampered('storage') })
    expect(started.records.find(record => record.event === 'plugin.checked' && record.plugin === 'storage')).toMatchObject({ result: 'tampered' })
    expect(started.ready).toBe(true)
  })

  it('stops hetu when it is the gate', async () => {
    const started = await start({ dir: await tampered('gate'), until: all => all.some(record => record.event === 'core.stopped') })
    expect(started.records.find(record => record.event === 'core.stopped')).toMatchObject({ control: 'gate' })
    expect(started.ready).toBe(false)
  })

  it('stays tampered with a list planted beside app.asar that names its new hash', async () => {
    const copy = await tampered('storage')
    const planted = await list()
    planted.plugins.storage.hash = hashFiles(await readFiles(path.join(resourcesOf(copy), 'plugins', 'storage')))
    await writeFile(path.join(resourcesOf(copy), 'hetu-install.json'), JSON.stringify(planted))
    const started = await start({ dir: copy })
    expect(started.records.find(record => record.event === 'plugin.checked' && record.plugin === 'storage')).toMatchObject({ result: 'tampered' })
  })

  it('never reads a plugin folder the list doesn\'t name', async () => {
    const copy = await linkedCopy()
    const stray = path.join(resourcesOf(copy), 'plugins', 'stray')
    await mkdir(path.join(stray, 'dist'), { recursive: true })
    await writeFile(path.join(stray, 'hetu-plugin.json'), '{"id":"stray","name":"Stray","version":"1.0.0","api":"^2","entries":{"host":"dist/host.js"}}')
    await writeFile(path.join(stray, 'dist', 'host.js'), 'throw new Error("read")')
    const started = await start({ dir: copy })
    expect(started.ready).toBe(true)
    expect(JSON.stringify(started.records)).not.toContain('stray')
  })
})
