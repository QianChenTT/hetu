import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultSwitches, StateStore, type Switches } from '../../backend/boot/state.ts'
import { cleanup, editorPage, launch, records, temp, until } from './helpers.ts'
import { ask, type Reply } from '../drive.ts'

afterEach(cleanup)

// An empty install folder, so no door runs and the door reads as missing. The gate and the other core modules ship
// inside the core
const install = temp

async function data(switches: Partial<Switches> = {}): Promise<string> {
  const dataDir = await temp()
  await new StateStore(dataDir).writeSwitches({ ...defaultSwitches(), ...switches })
  return dataDir
}

async function started(options: { switches?: Partial<Switches> } = {}) {
  const dataDir = await data(options.switches)
  const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
  const page = await editorPage(app)
  await until(async () => (await records(dataDir)).some(record => record.event === 'core.ready'))
  return { dataDir, app, page }
}

const codeOf = (reply: Reply) => (reply.ok ? 'ok' : reply.refusal?.code)
// No notes folder is picked, so a read the gate lets through answers unavailable at the luoshu's prepare
const read = async (page: Page, file = 'notes/a.md') => codeOf(await ask(page, 'luoshu.read', { path: file }))

const banner = async (page: Page, line: string) => {
  await until(async () => (await page.locator('#banner li').allTextContents()).includes(line))
}

describe('the gate on and the core\'s log', () => {
  it('decides a window\'s call on its grants, and the core writes its record and serves the log to the window', async () => {
    const { dataDir, page } = await started()
    expect(await read(page)).toBe('unavailable')
    // A dot file is no note: the contract's path schema refuses it before the editor's grant is asked
    expect(await read(page, '.scratch.md')).toBe('invalid')
    await until(async () => (await records(dataDir)).some(record =>
      record.event === 'audit.call' && record.action === 'luoshu.read' && record.code === 'unavailable' && record.gate === 'on'
      && String(record.caller).startsWith('window/editor#')))
    const history = await ask(page, 'log.segments')
    expect(history.ok).toBe(true)
    expect((history.result as { segment: number }[])[0]).toMatchObject({ segment: 1 })
    expect(await ask(page, 'log.verify')).toMatchObject({ ok: true, result: { ok: true } })
    const lines = await page.locator('#banner li').allTextContents()
    expect(lines).not.toContain('gate: on')
    expect(lines.some(line => line.startsWith('log:'))).toBe(false)
  })
})

describe('the gate off by the human', () => {
  it('lets calls with power through, still recorded while the log runs', async () => {
    const { dataDir, page } = await started({ switches: { off: ['gate'] } })
    expect(await read(page)).toBe('unavailable')
    await until(async () => (await records(dataDir)).some(record => record.event === 'audit.call' && record.action === 'luoshu.read' && record.gate === 'off'))
    await banner(page, 'gate: off')
  })

  // Recording off writes no core.ready, so the banner says when the start is over
  it('lets them through unrecorded once the human turned recording off too', async () => {
    const dataDir = await data({ off: ['gate', 'recording'] })
    const app = await launch(dataDir, { HETU_INSTALL_DIR: await install() })
    const page = await editorPage(app)
    await banner(page, 'gate: off')
    await banner(page, 'recording off')
    expect(await read(page)).toBe('unavailable')
    expect((await records(dataDir)).some(record => record.event === 'audit.call')).toBe(false)
  })
})
