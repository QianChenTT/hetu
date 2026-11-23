import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Fetch } from '../backend/lib/github.ts'
import { SIGNATURE_FILE_NAME, UPDATE_FILE_NAME } from '../backend/updater/check.ts'
import { CHECK_EVERY_MS } from '../backend/updater/header.ts'
import { CheckTimer, type Later } from '../backend/updater/timer.ts'
import { createUpdater, type UpdaterOptions } from '../backend/updater/updater.ts'

const ours = generateKeyPairSync('ed25519')
const LATEST = 'https://api.github.com/repos/QianChenTT/hetu/releases/latest'
const download = (name: string) => `https://github.com/QianChenTT/hetu/releases/download/v0.6.1/${name}`
const INSTALLER = 'hetu-setup-0.6.1-x64.exe'
const asset = (name: string) => ({ name, size: 1, state: 'uploaded', browser_download_url: download(name) })

// GitHub answering one release with the update file for version, signed by the run's key unless forged
function github(version = '0.6.1', forged = false): { fetch: Fetch, urls: string[], down: () => void } {
  const file = Buffer.from(JSON.stringify({ version, file: INSTALLER, size: 10, sha256: 'ab'.repeat(32), built: '2026-11-23T20:00:00Z' }))
  const signature = sign(null, forged ? Buffer.concat([file, Buffer.from(' ')]) : file, ours.privateKey)
  const urls: string[] = []
  let offline = false
  const fetch: Fetch = async url => {
    urls.push(url)
    if (offline) throw new TypeError('fetch failed')
    if (url === LATEST) return Response.json({ tag_name: `v${version}`, assets: [asset(UPDATE_FILE_NAME), asset(SIGNATURE_FILE_NAME), asset(INSTALLER)] })
    if (url === download(UPDATE_FILE_NAME)) return new Response(file)
    if (url === download(SIGNATURE_FILE_NAME)) return new Response(signature)
    return new Response('', { status: 404 })
  }
  return { fetch, urls, down: () => (offline = true) }
}

// A clock that runs a timer only when the test says, with every timer still pending listed with its ms
function fakeLater(): { later: Later, pending: { ms: number, run: () => void }[], fire: () => void } {
  const pending: { ms: number, run: () => void }[] = []
  const later: Later = (run, ms) => {
    const timer = { ms, run }
    pending.push(timer)
    return () => {
      const at = pending.indexOf(timer)
      if (at !== -1) pending.splice(at, 1)
    }
  }
  const fire = () => pending.shift()?.run()
  return { later, pending, fire }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function made(over: Partial<UpdaterOptions> = {}) {
  const records: { event: string, fields: unknown }[] = []
  const lines: string[] = []
  let told = 0
  const clock = fakeLater()
  const updater = createUpdater({
    locked: true, running: '0.6.0', platform: 'win32', key: ours.publicKey, now: () => 1_000,
    recording: { coreRecord: (event, fields) => records.push({ event, fields }) },
    log: line => lines.push(line), changed: () => told++, later: clock.later, ...over,
  })
  return { updater, records, lines, clock, told: () => told }
}

describe('the updater\'s state', () => {
  it('holds a higher signed version found, with its page and Install on Windows', async () => {
    const { fetch } = github()
    const { updater, records, told } = made({ fetch })
    expect(updater.state()).toEqual({ canCheck: true, on: true, checked: null, last: { kind: 'none' } })
    const state = await updater.check()
    expect(state).toEqual({
      canCheck: true, on: true, checked: 1_000,
      last: { kind: 'found', version: '0.6.1', built: '2026-11-23T20:00:00Z', page: 'https://github.com/QianChenTT/hetu/releases/tag/v0.6.1', installable: true },
    })
    expect(updater.state()).toBe(state)
    expect(records).toEqual([])
    expect(told()).toBe(2)
  })

  it('only links to the page on macOS and Linux', async () => {
    for (const platform of ['darwin', 'linux']) {
      const { updater } = made({ fetch: github().fetch, platform })
      expect((await updater.check()).last).toMatchObject({ kind: 'found', installable: false, page: 'https://github.com/QianChenTT/hetu/releases/tag/v0.6.1' })
    }
  })

  it('is current on the running version, with no record', async () => {
    const { updater, records } = made({ fetch: github('0.6.0').fetch })
    expect((await updater.check()).last).toEqual({ kind: 'current', version: '0.6.0' })
    expect(records).toEqual([])
  })

  it('records a refused update with its reason and version and holds it for the trusted window', async () => {
    const forged = made({ fetch: github('0.9.0', true).fetch })
    expect((await forged.updater.check()).last).toEqual({ kind: 'refused', reason: 'signature', version: null })
    expect(forged.records).toEqual([{ event: 'update.refused', fields: { reason: 'signature', version: null } }])
    const older = made({ fetch: github('0.5.0').fetch })
    expect((await older.updater.check()).last).toEqual({ kind: 'refused', reason: 'version', version: '0.5.0' })
    expect(older.records).toEqual([{ event: 'update.refused', fields: { reason: 'version', version: '0.5.0' } }])
  })

  it('is quiet on the network failing: a line in the log and no record', async () => {
    const offline: Fetch = () => Promise.reject(new TypeError('fetch failed'))
    const { updater, records, lines } = made({ fetch: offline })
    expect((await updater.check()).last).toEqual({ kind: 'failed', problem: 'offline' })
    expect(records).toEqual([])
    expect(lines).toEqual(['update: no answer to act on (offline)'])
  })

  it('keeps a fault of its own as quiet as the network', async () => {
    const faulty = { status: 200, headers: new Headers(), get body(): never { throw new RangeError('a fault') } }
    const throwing: Fetch = async () => faulty as unknown as Response
    const { updater, records, lines } = made({ fetch: throwing })
    expect((await updater.check()).last).toEqual({ kind: 'failed', problem: 'fault' })
    expect(records).toEqual([])
    expect(lines).toEqual(['update: no answer to act on (fault)'])
  })

  it('goes on when telling a change throws', async () => {
    const { updater, lines } = made({ fetch: github().fetch, changed: () => { throw new Error('gone') } })
    expect((await updater.check()).last).toMatchObject({ kind: 'found' })
    expect(lines).toEqual(['update: the state change could not be told', 'update: the state change could not be told'])
  })

  it('joins a check under way', async () => {
    const { fetch, urls } = github()
    const { updater } = made({ fetch })
    const [a, b] = [updater.check(), updater.check()]
    expect(updater.state().last).toEqual({ kind: 'checking' })
    expect(await a).toBe(await b)
    expect(urls.filter(url => url === LATEST)).toHaveLength(1)
  })

  it('never checks in a build that isn\'t locked, the timer and a check on demand alike', async () => {
    const { fetch, urls } = github()
    const { updater, clock } = made({ fetch, locked: false })
    updater.ready()
    expect(await updater.check()).toEqual({ canCheck: false, on: true, checked: null, last: { kind: 'none' } })
    updater.switchChecks(false)
    updater.switchChecks(true)
    await settle()
    expect(urls).toEqual([])
    expect(clock.pending).toEqual([])
  })

  it('never checks with a key that doesn\'t load, and still starts', async () => {
    const { fetch, urls } = github()
    const { updater, lines } = made({ fetch, key: undefined, pem: 'not a key' })
    updater.ready()
    expect((await updater.check()).canCheck).toBe(false)
    expect(urls).toEqual([])
    expect(lines).toEqual(['update: the key inside hetu does not load, so nothing checks'])
  })

  it('never checks with a running version that isn\'t x.y.z', async () => {
    const { fetch, urls } = github()
    const { updater } = made({ fetch, running: '0.6.0-dev' })
    updater.ready()
    expect((await updater.check()).canCheck).toBe(false)
    expect(urls).toEqual([])
  })

  it('checks on demand with the switch off, a click being the human asking', async () => {
    const { fetch, urls } = github()
    const { updater } = made({ fetch, on: false })
    expect((await updater.check()).last).toMatchObject({ kind: 'found' })
    expect(urls).toContain(LATEST)
  })

  it('stops a check under way on close and checks nothing after', async () => {
    const hanging: Fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
    const { updater } = made({ fetch: hanging })
    const waiting = updater.check()
    updater.close()
    expect((await waiting).last).toEqual({ kind: 'failed', problem: 'cancelled' })
    const after = updater.state()
    expect(await updater.check()).toBe(after)
  })
})

describe('the checks at start and every 7 days', () => {
  it('checks once the core is ready and again 7 days after each check ends', async () => {
    const { fetch, urls } = github()
    const { updater, clock } = made({ fetch })
    await settle()
    expect(urls).toEqual([])
    updater.ready()
    await settle()
    expect(urls.filter(url => url === LATEST)).toHaveLength(1)
    expect(clock.pending.map(timer => timer.ms)).toEqual([CHECK_EVERY_MS])
    expect(CHECK_EVERY_MS).toBe(7 * 24 * 60 * 60 * 1000)
    clock.fire()
    await settle()
    expect(urls.filter(url => url === LATEST)).toHaveLength(2)
    expect(clock.pending.map(timer => timer.ms)).toEqual([CHECK_EVERY_MS])
    updater.ready()
    await settle()
    expect(urls.filter(url => url === LATEST)).toHaveLength(2)
  })

  it('goes on after a failed check', async () => {
    const { fetch, urls, down } = github()
    down()
    const { updater, clock } = made({ fetch })
    updater.ready()
    await settle()
    expect(updater.state().last).toEqual({ kind: 'failed', problem: 'offline' })
    expect(clock.pending.map(timer => timer.ms)).toEqual([CHECK_EVERY_MS])
    expect(urls).toHaveLength(1)
  })

  it('checks nothing at start with the switch off and stops the timer when it is turned off', async () => {
    const { fetch, urls } = github()
    const off = made({ fetch, on: false })
    off.updater.ready()
    await settle()
    expect(urls).toEqual([])
    expect(off.clock.pending).toEqual([])
    const on = made({ fetch })
    on.updater.ready()
    await settle()
    expect(on.clock.pending).toHaveLength(1)
    on.updater.switchChecks(false)
    expect(on.updater.state().on).toBe(false)
    expect(on.clock.pending).toEqual([])
  })

  it('checks at once when switched on again once ready, and not before ready', async () => {
    const { fetch, urls } = github()
    const { updater, clock } = made({ fetch, on: false })
    updater.switchChecks(true)
    await settle()
    expect(urls).toEqual([])
    updater.switchChecks(false)
    updater.ready()
    updater.switchChecks(true)
    await settle()
    expect(urls.filter(url => url === LATEST)).toHaveLength(1)
    expect(clock.pending).toHaveLength(1)
  })

  it('schedules nothing from a check that ends after the switch went off or the updater closed', async () => {
    let answer: (() => void) | null = null
    const check = () => new Promise<void>(resolve => (answer = resolve))
    const clock = fakeLater()
    const timer = new CheckTimer({ check, locked: true, on: true, later: clock.later })
    timer.ready()
    timer.switched(false)
    answer!()
    await settle()
    expect(clock.pending).toEqual([])
    const closing = new CheckTimer({ check, locked: true, on: true, later: clock.later })
    closing.ready()
    closing.close()
    answer!()
    await settle()
    expect(clock.pending).toEqual([])
  })

  it('goes on after a check that rejects', async () => {
    let checks = 0
    const clock = fakeLater()
    const timer = new CheckTimer({ check: () => (checks++, Promise.reject(new Error('a fault'))), locked: true, on: true, later: clock.later })
    timer.ready()
    await settle()
    expect(clock.pending).toHaveLength(1)
    clock.fire()
    await settle()
    expect(checks).toBe(2)
    expect(clock.pending).toHaveLength(1)
  })

  it('never runs in a build that isn\'t locked', async () => {
    let checks = 0
    const clock = fakeLater()
    const timer = new CheckTimer({ check: async () => checks++, locked: false, on: true, later: clock.later })
    timer.ready()
    timer.switched(false)
    timer.switched(true)
    await settle()
    expect(checks).toBe(0)
    expect(clock.pending).toEqual([])
  })
})
