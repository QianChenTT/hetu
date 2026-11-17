import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Capability } from '../api/capabilities.ts'
import { boot } from '../backend/boot/boot.ts'
import { defaultSwitches, StateStore, type Plugin } from '../backend/boot/state.ts'
import { wireCore } from '../backend/wire.ts'
import { createGate } from '../../plugins/gate/src/gate.ts'
import { createLuoshu } from '../../plugins/luoshu/src/luoshu.ts'
import { cleanup, harness, worker } from './carrier-fakes.ts'
import { coreInstall, entryFor, FakeRuntime, filesFor, hostManifest, tempBase, until, workerManifest, writeFolder, writeInstall } from './loader-fakes.ts'

// What another plugin's write does once a write's temp file is open, after its version check and before its note lands
const hook = { onTemp: null as null | (() => Promise<void>) }

vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args)
      if (args[1] === 'wx' && String(args[0]).endsWith('.hetu-tmp') && hook.onTemp !== null) {
        const act = hook.onTemp
        hook.onTemp = null
        await act()
      }
      return handle
    }) as typeof real.open,
  }
})

const run = promisify(execFile)
const open: (() => Promise<void>)[] = []

afterEach(async () => {
  hook.onTemp = null
  cleanup()
  for (const close of open.splice(0).reverse()) await close()
})

type Reply = { ok?: boolean, refusal?: { code: string } }

// The joined core over a real boot with the gate and the luoshu as they ship and a folder plugin for each grant list
async function world(folders: Record<string, Capability[]>) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  const folder = path.join(base, 'notes')
  await mkdir(installDir, { recursive: true })
  await mkdir(folder, { recursive: true })
  await writeInstall(installDir, { ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } })
  const store = new StateStore(dataDir)
  await store.writeSwitches(defaultSwitches())
  await store.writeLuoshu({ folder })
  for (const [id, granted] of Object.entries(folders)) {
    const root = path.join(dataDir, 'plugins', id)
    await writeFolder(root, filesFor(workerManifest(id, { capabilities: granted }) as never))
    await store.writePlugin(id, await entryFor(root, { granted, class: 4 } as Partial<Plugin>))
  }
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const luoshu = createLuoshu({ settleMs: 50 })
  const runtime = new FakeRuntime()
  runtime.behave = {
    gate: { exports: { gate: createGate() } },
    luoshu: { exports: { provider: luoshu.provider, luoshu: luoshu.role } },
  }
  const { loader, carrier } = wireCore({ booted, installDir, runtime, confirmDelayMs: 0, debug: () => {} } as never)
  open.push(async () => {
    luoshu.close()
    await loader.shutdown().catch(() => {})
    carrier.close()
    await carrier.flush()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await loader.start()
  await loader.settled()
  for (const id of Object.keys(folders)) await until(() => loader.plugin(id)?.state === 'ready')
  const ask = async (id: string, action: string, args: unknown) => (await runtime.half(id).ask(action, args, 15_000)) as Reply | null
  return { folder, ask }
}

// Whether this volume gives secretnote.md the short name SECRET~1.MD in an empty folder, as dir /x shows it
async function shortNames(): Promise<boolean> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-short-')))
  try {
    await writeFile(path.join(dir, 'secretnote.md'), '')
    const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: dir })
    return stdout.split(/\r?\n/).some(line => /\sSECRET~1\.MD\s+secretnote\.md$/.test(line.trimEnd()))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const noShortNames = async (skip: (note: string) => void) => {
  if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the landing through one unproven')
  skip('this volume makes no 8.3 short names')
}

// beta may write only r*/SECRET~1.MD. alpha writes a new note r<i>/secretnote.md, whose 8.3 short name NTFS makes
// SECRET~1.MD, while beta's write of r<i>/SECRET~1.MD runs, sent 0 to 5 ms after it
describe.runIf(process.platform === 'win32')('a write spelled as the 8.3 short name another plugin\'s new note gets', () => {
  it('never lands on that note, whose write answered ok', async ({ skip }) => {
    if (!(await shortNames())) return noShortNames(skip)
    const { folder, ask } = await world({
      alpha: [{ type: 'luoshu.write', paths: ['r*/**'] }, { type: 'luoshu.read', paths: ['r*/**'] }] as Capability[],
      beta: [{ type: 'luoshu.write', paths: ['r*/SECRET~1.MD'] }] as Capability[],
    })
    const lost: string[] = []
    const answers = new Set<string>()
    for (const [size, rounds] of [[256 * 1024, 60], [4, 30]] as const) {
      for (let i = 0; i < rounds; i++) {
        const dir = `r${size}-${i}`
        await ask('alpha', 'luoshu.write', { path: `${dir}/seed.md`, text: 'seed' })
        const [b, a] = await Promise.all([
          ask('beta', 'luoshu.write', { path: `${dir}/SECRET~1.MD`, text: 'B'.repeat(size) }),
          new Promise(resolve => setTimeout(resolve, i % 6)).then(() => ask('alpha', 'luoshu.write', { path: `${dir}/secretnote.md`, text: `ALPHA ${i}` })),
        ])
        answers.add(b?.ok ? 'ok' : `${b?.refusal?.code}`)
        const held = await readFile(path.join(folder, dir, 'secretnote.md'), 'utf8').catch(() => null)
        if (a?.ok && held !== `ALPHA ${i}`) lost.push(`${dir} holds [${(await readdir(path.join(folder, dir))).join(', ')}]`)
      }
    }
    expect(lost).toEqual([])
    // beta's write either lands under its own name beside alpha's note or finds the name taken
    expect([...answers].every(answer => answer === 'ok' || answer === 'stale' || answer === 'not-granted')).toBe(true)
  }, 120_000)
})

describe.runIf(process.platform === 'win32')('the write that finds the name taken through an 8.3 short name', () => {
  it('answers stale and is recorded with the path its caller wrote and that code', async ({ skip }) => {
    if (!(await shortNames())) return noShortNames(skip)
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-short-record-')))
    open.push(() => rm(base, { recursive: true, force: true }))
    const folder = path.join(base, 'notes')
    await mkdir(path.join(folder, 'box'), { recursive: true })
    for (const dir of ['data', 'install']) await mkdir(path.join(base, dir))
    const luoshu = createLuoshu({ settleMs: 50 })
    open.push(async () => luoshu.close())
    luoshu.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install') })
    const parts = harness()
    parts.gate.grants.beta = [{ type: 'luoshu.write', paths: ['box/SECRET~1.MD'] }] as never
    parts.providers.luoshu = luoshu.provider
    // Another plugin's new note lands once beta's version check found none, as a write under another key can
    hook.onTemp = () => writeFile(path.join(folder, 'box', 'secretnote.md'), 'ALPHA')
    const reply = await parts.connect(worker('beta')).ask('luoshu.write', { path: 'box/SECRET~1.MD', text: 'BETA' })
    await parts.carrier.flush()
    expect(reply).toMatchObject({ ok: false, refusal: { code: 'stale' } })
    expect(await readFile(path.join(folder, 'box', 'secretnote.md'), 'utf8')).toBe('ALPHA')
    expect(await readdir(path.join(folder, 'box'))).toEqual(['secretnote.md'])
    expect(parts.log.events('audit.call').map(record => record.fields)).toMatchObject([{ action: 'luoshu.write', paths: '["box/SECRET~1.MD"]', code: 'stale' }])
  }, 60_000)
})
