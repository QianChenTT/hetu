import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot } from '../backend/boot/boot.ts'
import type { CarrierLink } from '../backend/loader/seams.ts'
import { LinkToCarrier, wireCore } from '../backend/wire.ts'
import { worker } from './carrier-fakes.ts'
import { coreInstall, FakeRuntime, tempBase, writeInstall, type Listing } from './loader-fakes.ts'

const open: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of open.splice(0)) await close()
})

// The joined core over a real boot: a temp data folder, an install written from fixtures and the fake runtime
async function joined(install: Record<string, Listing> = coreInstall()) {
  const base = await tempBase()
  const installDir = path.join(base, 'install')
  const dataDir = path.join(base, 'data')
  await mkdir(installDir, { recursive: true })
  await writeInstall(installDir, install)
  const booted = await boot({ packaged: false, installDir, env: { HETU_DATA_DIR: dataDir }, platform: process.platform })
  const runtime = new FakeRuntime()
  const { loader, carrier } = wireCore({ booted, installDir, runtime })
  open.push(async () => {
    await loader.shutdown().catch(() => {})
    // Shutdown's own records are still draining into the log, and Windows won't remove a folder a write is filling
    await carrier.flushFloor()
    carrier.close()
    for (const port of runtime.ports) port.close()
    await booted.release()
    await rm(base, { recursive: true, force: true })
  })
  return { loader, carrier, runtime, booted, dataDir, installDir }
}

// The events the floor lane wrote to the boot's event log, in order
async function floorEvents(dataDir: string): Promise<string[]> {
  const text = await readFile(path.join(dataDir, 'events', 'events-1.jsonl'), 'utf8')
  return text.trim().split('\n').map(line => (JSON.parse(line) as { event: string }).event)
}

describe('wiring the core', () => {
  it('builds link, loader and carrier so the loader reaches the real carrier', async () => {
    const { carrier, loader, dataDir } = await joined()
    await loader.start()
    await carrier.flushFloor()
    const events = await floorEvents(dataDir)
    expect(events).toContain('install.checked')
    expect(events).toContain('plugin.started')
    expect(carrier.limit('gate', 'readyMs')).toBe(10000)
    // The carrier keeps no import of the loader, so the typecheck proves here that it gives the loader all it needs
    const asLink: CarrierLink = carrier
    expect(asLink).toBe(carrier)
  })

  it('refuses a link call made before the carrier exists', () => {
    const link = new LinkToCarrier()
    expect(() => link.send(worker('search'), { v: 1, kind: 'ping' })).toThrow('carrier')
  })
})
