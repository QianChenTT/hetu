import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreStatus, SecurityList } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import type { Failure } from '../backend/loader/loader.ts'
import {
  allowAll, cleanup, coreInstall, filesFor, harness, hostManifest, reasonOf, stateOf, until, workerManifest, type Files,
} from './loader-fakes.ts'

afterEach(cleanup)

const editor: Caller = { kind: 'window', role: 'editor', n: 1 }
const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const worker = (id: string): Files => filesFor(workerManifest(id))
const call = (caller: Caller, action: string, args?: unknown) => ({ callId: 'c1', caller, action, args, deadline: Date.now() + 30_000 })
const exists = (file: string) => stat(file).then(() => true, () => false)
// The install with a gate that answers and a provider behind it, which a stopped start must never start
const install = () => ({ ...coreInstall(), luoshu: { files: filesFor(hostManifest('luoshu')) } })
const working = () => ({ exports: { gate: allowAll() } })

describe('a security control that fails at start', () => {
  it.each([
    ['a start that throws', { gate: { ...working(), throws: true } }, 'start-failed'],
    ['a start that never reaches ready', { gate: { ...working(), ready: false } }, 'start-timeout'],
    ['a module with no gate export', { gate: { exports: {} } }, 'no-role'],
  ])('stops hetu in the stopped mode on %s, starting nothing more', async (_name, behave, reason) => {
    const made = await harness({ install: install(), behave })
    await made.loader.start()
    expect(made.loader.stopped()).toEqual({ control: 'gate', why: 'failed', reason, again: false })
    expect(made.runtime.order()).not.toContain('luoshu')
    expect(stateOf(made.loader, 'luoshu')).toBe('stopped')
    expect(reasonOf(made.loader, 'luoshu')).toBe('control-failed')
    expect(made.link.events('core.ready')).toEqual([])
    expect(made.link.events('core.stopped')).toEqual([{ control: 'gate', why: 'failed', reason, again: false }])
  })

  it('stops hetu on a gate whose bytes fail their hash check', async () => {
    const made = await harness({ install: { ...install(), gate: { files: filesFor(hostManifest('gate')), hash: 'f'.repeat(64) } } })
    await made.loader.start()
    expect(made.loader.stopped()).toEqual({ control: 'gate', why: 'tampered', reason: 'tampered', again: false })
  })

  it('stops hetu on a gate the install list names whose files are gone', async () => {
    const made = await harness({ install: install(), behave: { gate: working() } })
    await import('node:fs/promises').then(fs => fs.rm(path.join(made.installDir, 'plugins', 'gate'), { recursive: true }))
    await made.loader.start()
    expect(made.loader.stopped()).toMatchObject({ control: 'gate', why: 'absent' })
  })

  it('stops hetu on a gate its start marker holds', async () => {
    const made = await harness({ install: install(), behave: { gate: working() }, markers: ['gate'] })
    await made.loader.start()
    expect(made.loader.stopped()).toMatchObject({ control: 'gate', why: 'failed', reason: 'marker' })
  })

  it('starts on with the gate the human switched off', async () => {
    const made = await harness({ install: install(), behave: { gate: { throws: true } }, switches: { off: ['gate'] } })
    await made.loader.start()
    expect(made.loader.stopped()).toBe(null)
    expect(stateOf(made.loader, 'luoshu')).toBe('ready')
  })

  it('starts on when the install list names no control', async () => {
    const made = await harness({ install: { luoshu: { files: filesFor(hostManifest('luoshu')) } } })
    await made.loader.start()
    expect(made.loader.stopped()).toBe(null)
    expect(stateOf(made.loader, 'luoshu')).toBe('ready')
  })

  it('never stops for a plugin-folder plugin that fails', async () => {
    const made = await harness({ behave: { gate: working(), alpha: { ready: false } }, folder: { alpha: worker('alpha') } })
    await made.loader.start()
    expect(made.loader.stopped()).toBe(null)
  })

  it('says again when the run before restarted for the same control', async () => {
    const made = await harness({
      install: install(),
      behave: { gate: { ...working(), throws: true } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'gate'),
    })
    await made.loader.start()
    expect(made.loader.stopped()).toMatchObject({ control: 'gate', again: true })
  })

  it('shows the stopped mode in core.status and the trusted window\'s list', async () => {
    const made = await harness({ install: install(), behave: { gate: { ...working(), throws: true } } })
    await made.loader.start()
    const mode = { control: 'gate', why: 'failed', reason: 'start-failed', again: false }
    expect(((await made.loader.serve(call(editor, 'core.status'))) as CoreStatus).stopped).toEqual(mode)
    expect(((await made.loader.serve(call(trusted, 'security.list'))) as SecurityList).stopped).toEqual(mode)
  })

  it('takes the human\'s switch-off in the stopped mode and clears the restart marker with it', async () => {
    const made = await harness({
      install: install(),
      behave: { gate: { ...working(), throws: true } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'gate'),
    })
    await made.loader.start()
    const { held } = await made.loader.request({ kind: 'plugin.off', plugin: 'gate' }, trusted) as { held: string }
    await made.loader.confirm(held, { typed: 'gate' })
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })
})

describe('a security control that fails while hetu runs', () => {
  const failing = async () => {
    const failures: Failure[] = []
    const gate = allowAll()
    const made = await harness({ install: install(), behave: { gate: { exports: { gate } } }, loader: { onFailure: failure => { failures.push(failure) } } })
    await made.loader.start()
    expect(made.loader.stopped()).toBe(null)
    return { made, gate, failures }
  }

  it('asks the runtime to quit and start again, with the restart marker written first', async () => {
    const { made, gate, failures } = await failing()
    gate.throws = true
    await made.loader.apply({ kind: 'confirmOff', on: true })
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'relaunch', control: 'gate', reason: 'state-changed' }])
    expect(await readFile(path.join(made.dataDir, 'failed-once'), 'utf8')).toBe('gate')
    expect(made.link.events('core.failed')).toEqual([{ control: 'gate', reason: 'state-changed' }])
  })

  it('stops in the stopped mode instead when the run before restarted for the same control', async () => {
    const failures: Failure[] = []
    const gate = allowAll()
    const made = await harness({
      install: install(),
      behave: { gate: { exports: { gate } } },
      loader: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'gate'),
    })
    await made.loader.start()
    gate.throws = true
    await made.loader.apply({ kind: 'confirmOff', on: true })
    await until(() => failures.length > 0)
    const mode = { control: 'gate', why: 'failed', reason: 'state-changed', again: true }
    expect(failures).toEqual([{ action: 'stopped', mode }])
    expect(made.loader.stopped()).toEqual(mode)
    await made.loader.settled()
    expect(stateOf(made.loader, 'luoshu')).not.toBe('ready')
  })

  it('takes the core\'s log failing the same way', async () => {
    const { made, failures } = await failing()
    made.loader.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'relaunch', control: 'log', reason: 'log-failing' }])
    expect(await readFile(path.join(made.dataDir, 'failed-once'), 'utf8')).toBe('log')
  })

  it('reports one failure however many follow', async () => {
    const { made, failures } = await failing()
    made.loader.controlFailed('log', 'log-failing')
    made.loader.controlFailed('gate', 'state-changed')
    await until(() => failures.length > 0)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failures).toHaveLength(1)
  })

  it('reports nothing during shutdown', async () => {
    const { made, failures } = await failing()
    await made.loader.shutdown()
    made.loader.controlFailed('log', 'log-failing')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(failures).toEqual([])
  })
})
describe('the restart marker, after the review', () => {
  it('stops hetu on a failure of any control once the run before restarted, so two controls can\u2019t take turns', async () => {
    const failures: Failure[] = []
    const gate = allowAll()
    const made = await harness({
      install: install(),
      behave: { gate: { exports: { gate } } },
      loader: { onFailure: failure => { failures.push(failure) } },
      before: async ({ dataDir }) => writeFile(path.join(dataDir, 'failed-once'), 'log'),
    })
    await made.loader.start()
    gate.throws = true
    await made.loader.apply({ kind: 'confirmOff', on: true })
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'stopped', mode: { control: 'gate', why: 'failed', reason: 'state-changed', again: true } }])
  })

  it('stops hetu instead of starting it again when the marker can\u2019t be written', async () => {
    const failures: Failure[] = []
    const made = await harness({ install: install(), behave: { gate: working() }, loader: { onFailure: failure => { failures.push(failure) } } })
    await made.loader.start()
    // A folder where the marker goes makes its write fail
    await mkdir(path.join(made.dataDir, 'failed-once'), { recursive: true })
    await writeFile(path.join(made.dataDir, 'failed-once', 'x'), '')
    made.loader.controlFailed('log', 'log-failing')
    await until(() => failures.length > 0)
    expect(failures).toEqual([{ action: 'stopped', mode: { control: 'log', why: 'failed', reason: 'log-failing', again: false } }])
  })

  it('makes shutdown wait for its write', async () => {
    const { made } = await (async () => {
      const made = await harness({ install: install(), behave: { gate: working() }, loader: { onFailure: () => {} } })
      await made.loader.start()
      return { made }
    })()
    made.loader.controlFailed('log', 'log-failing')
    await made.loader.shutdown()
    expect(await readFile(path.join(made.dataDir, 'failed-once'), 'utf8')).toBe('log')
  })

  it('is cleared by a clean Quit only once a write under way has landed', async () => {
    const made = await harness({ install: install(), behave: { gate: working() }, loader: { onFailure: () => {} } })
    await made.loader.start()
    made.loader.controlFailed('log', 'log-failing')
    await made.loader.cleanQuit()
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })

  it('ignores a failure told before the start finished, so the carrier can tell it again later', async () => {
    const failures: Failure[] = []
    const made = await harness({ install: install(), behave: { gate: working() }, loader: { onFailure: failure => { failures.push(failure) } } })
    expect(made.loader.controlFailed('log', 'log-failing')).toBe(false)
    await made.loader.start()
    expect(made.loader.controlFailed('log', 'log-failing')).toBe(true)
    expect(made.loader.controlFailed('log', 'log-failing')).toBe(false)
  })
})

describe('the restart marker', () => {
  it('is cleared by a clean Quit', async () => {
    const made = await harness({ install: install(), behave: { gate: working() } })
    await mkdir(made.dataDir, { recursive: true })
    await writeFile(path.join(made.dataDir, 'failed-once'), 'gate')
    await made.loader.start()
    await made.loader.cleanQuit()
    expect(await exists(path.join(made.dataDir, 'failed-once'))).toBe(false)
  })
})
