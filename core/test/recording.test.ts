import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultLimits } from '../api/limits.ts'
import type { Recording } from '../backend/recording/header.ts'
import { createRecording } from '../backend/recording/recording.ts'
import { FakeLog, tick, worker } from './router-fakes.ts'

// Recording on its own over a fake log: what it takes in, what it writes and when the log counts as failed
const made: Recording[] = []
afterEach(() => {
  for (const recording of made.splice(0)) recording.close()
})

function recording(over: { off?: () => boolean, logFailMs?: number, failed?: () => boolean | void } = {}) {
  const log = new FakeLog()
  let clock = 1_000_000
  const one = createRecording({
    log,
    off: over.off ?? (() => false),
    limit: name => (name === 'logFailMs' ? over.logFailMs ?? defaultLimits.logFailMs : defaultLimits[name]),
    hash: text => createHash('sha256').update(text).digest('hex'),
    clock: () => clock,
    everyMs: 3_600_000,
    ...(over.failed !== undefined ? { failed: over.failed } : {}),
  })
  made.push(one)
  return { recording: one, log, at: (ms: number) => { clock = ms } }
}

const call = (action = 'luoshu.read') => ({ at: 0, caller: worker('search'), root: worker('search'), action, code: null, ms: 1, gate: 'on' as const })

describe('recording', () => {
  it('writes core records, call records and coalesced records through the one log', async () => {
    const { recording: one, log } = recording()
    one.coreRecord('plugin.found', { plugin: 'search' })
    one.call(call(), false)
    one.coalesced('fault', { plugin: 'gate', step: 'decide' })
    expect(await one.record('plugin.copied', { plugin: 'git' })).toBe('landed')
    await one.flush()
    expect(log.records.map(record => record.event)).toEqual(['plugin.found', 'fault', 'plugin.copied', 'audit.call'])
  })

  it('takes in nothing while the human has it off and answers every wait muted', async () => {
    let off = true
    const { recording: one, log } = recording({ off: () => off })
    one.coreRecord('plugin.found', { plugin: 'search' })
    one.call(call(), false)
    one.coalesced('fault', { plugin: 'gate', step: 'decide' })
    expect(await one.record('plugin.copied', { plugin: 'git' })).toBe('muted')
    await one.flush()
    expect(log.records).toEqual([])
    off = false
    expect(await one.record('plugin.copied', { plugin: 'git' })).toBe('landed')
  })

  it('reads the log for log.segments and log.verify whatever its switch', async () => {
    const { recording: one, log } = recording({ off: () => true })
    const asked = (action: string) => one.serve({ callId: 'c', caller: worker('search'), action, args: undefined, deadline: 0 })
    expect(await asked('log.segments')).toEqual(log.segments)
    expect(await asked('log.verify')).toEqual({ ok: true })
  })

  it('counts the log failed once the oldest queued record waited logFailMs and tells it once taken, never while off', async () => {
    let told = 0
    let off = false
    const { recording: one, log, at } = recording({ logFailMs: 1000, failed: () => { told++ }, off: () => off })
    log.failing = true
    one.call(call(), false)
    expect(one.failing()).toBe(false)
    at(1_001_000)
    expect(one.failing()).toBe(true)
    one.call(call('luoshu.list'), false)
    one.call(call('luoshu.list'), false)
    expect(told).toBe(1)
    off = true
    expect(one.failing()).toBe(false)
  })

  it('tells the failure again while the plugins manager doesn\'t take it', async () => {
    const answers = [false, true]
    let told = 0
    const { recording: one, log, at } = recording({ logFailMs: 1000, failed: () => { told++; return answers.shift() } })
    log.failing = true
    one.call(call(), false)
    at(1_001_000)
    one.call(call(), false)
    one.call(call(), false)
    one.call(call(), false)
    expect(told).toBe(2)
  })

  it('writes nothing more after a drain until it resumes', async () => {
    const { recording: one, log } = recording()
    one.call(call(), false)
    expect(await one.drain(1000)).toBe(0)
    one.call(call('luoshu.list'), false)
    await one.flush()
    expect(log.events('audit.call')).toHaveLength(1)
    one.resume()
    await one.flush()
    expect(log.events('audit.call')).toHaveLength(2)
  })

  it('hashes an exec command with the hash it is handed', async () => {
    const { recording: one, log } = recording()
    one.call({ ...call('exec.run'), scope: { command: ['git', 'status'] } }, false)
    await one.flush()
    expect(log.events('audit.call')[0].fields).toMatchObject({ commandHash: createHash('sha256').update('["git","status"]').digest('hex') })
  })

  it('takes nothing in once closed', async () => {
    const { recording: one, log } = recording()
    one.close()
    expect(await one.record('plugin.copied', { plugin: 'git' })).toBe('lost')
    await tick()
    expect(log.records).toEqual([])
  })
})
