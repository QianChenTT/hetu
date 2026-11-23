import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Fetch } from '../backend/lib/github.ts'
import { SIGNATURE_FILE_NAME, UPDATE_FILE_NAME } from '../backend/updater/check.ts'
import type { UpdateFile } from '../backend/updater/header.ts'
import { downloadInstaller, INSTALLER_ARGS, startInstaller } from '../backend/updater/install.ts'
import { createUpdater, type UpdaterOptions } from '../backend/updater/updater.ts'

const ours = generateKeyPairSync('ed25519')
const LATEST = 'https://api.github.com/repos/QianChenTT/hetu/releases/latest'
const download = (name: string) => `https://github.com/QianChenTT/hetu/releases/download/v0.6.1/${name}`
const INSTALLER = 'hetu-setup-0.6.1-x64.exe'
// The installer as the release holds it, made for the run and never run
const BYTES = Buffer.from('MZ a stand-in for the installer, never started by a test')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const signedFile = (over: Partial<UpdateFile> = {}): UpdateFile => ({
  version: '0.6.1', file: INSTALLER, size: BYTES.length, sha256: sha256(BYTES), built: '2026-11-23T20:00:00Z', ...over,
})

let dir: string
let updates: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hetu-updates-'))
  updates = path.join(dir, 'updates')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// GitHub answering the installer's download with these bytes, and the latest release when asked
function github(installer: Buffer = BYTES, file: UpdateFile = signedFile()): { fetch: Fetch, urls: string[] } {
  const update = Buffer.from(JSON.stringify(file))
  const signature = sign(null, update, ours.privateKey)
  const assets = [UPDATE_FILE_NAME, SIGNATURE_FILE_NAME, INSTALLER].map(name => ({ name, size: 1, state: 'uploaded', browser_download_url: download(name) }))
  const urls: string[] = []
  const fetch: Fetch = async url => {
    urls.push(url)
    if (url === LATEST) return Response.json({ tag_name: 'v0.6.1', assets })
    if (url === download(UPDATE_FILE_NAME)) return new Response(new Uint8Array(update))
    if (url === download(SIGNATURE_FILE_NAME)) return new Response(new Uint8Array(signature))
    if (url === download(INSTALLER)) return new Response(new Uint8Array(installer))
    return new Response('', { status: 404 })
  }
  return { fetch, urls }
}

const listed = async () => (await readdir(updates)).sort()

describe('the installer\'s download', () => {
  it('writes the installer into the updates folder once its size and sha256 match the signed file', async () => {
    const got = await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch })
    expect(got).toEqual({ file: path.join(updates, INSTALLER) })
    expect(await readFile(path.join(updates, INSTALLER))).toEqual(BYTES)
  })

  it('refuses a tampered installer, one byte flipped, and writes nothing', async () => {
    const tampered = Buffer.from(BYTES)
    tampered[3] ^= 1
    expect(await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github(tampered).fetch })).toEqual({ refused: 'hash' })
    expect(await readdir(updates).catch(() => [])).toEqual([])
  })

  it('refuses an installer shorter or longer than the signed size and writes nothing', async () => {
    for (const bytes of [BYTES.subarray(1), Buffer.concat([BYTES, Buffer.from('x')])]) {
      expect(await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github(bytes).fetch })).toEqual({ refused: 'size' })
    }
    expect(await readdir(updates).catch(() => [])).toEqual([])
  })

  it('stops reading at the signed size, however long the answer runs', async () => {
    let pulled = 0
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1024
        controller.enqueue(new Uint8Array(1024))
      },
    }))
    const fetch: Fetch = async () => endless()
    expect(await downloadInstaller(signedFile({ size: 4096 }), download(INSTALLER), updates, { fetch })).toEqual({ refused: 'size' })
    expect(pulled).toBeLessThan(16 * 1024)
  })

  it('is quiet on the network failing', async () => {
    const offline: Fetch = () => Promise.reject(new TypeError('fetch failed'))
    expect(await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: offline })).toEqual({ problem: 'offline' })
  })

  it('answers disk when the folder can\'t be written', async () => {
    await writeFile(updates, 'a file where the folder goes')
    expect(await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch })).toEqual({ problem: 'disk' })
  })

  it('keeps the last two installers and deletes older ones, leaving anything else', async () => {
    await mkdir(updates, { recursive: true })
    const old = ['hetu-setup-0.5.0-x64.exe', 'hetu-setup-0.5.1-x64.exe', 'hetu-setup-0.6.0-x64.exe']
    for (const [at, name] of old.entries()) {
      await writeFile(path.join(updates, name), name)
      const when = new Date(Date.UTC(2026, 10, 1 + at))
      await utimes(path.join(updates, name), when, when)
    }
    await writeFile(path.join(updates, 'notes.txt'), 'kept')
    await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch })
    expect(await listed()).toEqual(['hetu-setup-0.6.0-x64.exe', INSTALLER, 'notes.txt'].sort())
  })

  it('takes the newest as the one just written, whatever the clock says of the others', async () => {
    await mkdir(updates, { recursive: true })
    await writeFile(path.join(updates, 'a-written-last.exe'), 'later')
    const ahead = new Date(Date.now() + 86_400_000)
    await utimes(path.join(updates, 'a-written-last.exe'), ahead, ahead)
    await writeFile(path.join(updates, 'b-written-first.exe'), 'earlier')
    await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch })
    expect(await listed()).toEqual([INSTALLER, 'a-written-last.exe'].sort())
  })
})

describe('the installer\'s start', () => {
  it('hashes the file again and starts it detached, silent and starting hetu again after', async () => {
    const { file } = await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch }) as { file: string }
    const started: { file: string, args: readonly string[] }[] = []
    expect(startInstaller(file, signedFile(), (at, args) => started.push({ file: at, args }))).toBe('started')
    expect(started).toEqual([{ file, args: ['/S', '--force-run'] }])
    expect(INSTALLER_ARGS).toEqual(['/S', '--force-run'])
  })

  it('refuses a file swapped after the download, starts nothing and deletes it', async () => {
    const { file } = await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch }) as { file: string }
    const swapped = Buffer.from(BYTES)
    swapped[0] ^= 1
    await writeFile(file, swapped)
    const started: string[] = []
    expect(startInstaller(file, signedFile(), at => started.push(at))).toBe('changed')
    expect(started).toEqual([])
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a file gone or grown, starting nothing', async () => {
    const started: string[] = []
    expect(startInstaller(path.join(updates, INSTALLER), signedFile(), at => started.push(at))).toBe('changed')
    const { file } = await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch }) as { file: string }
    await writeFile(file, Buffer.concat([BYTES, Buffer.from('more')]))
    expect(startInstaller(file, signedFile(), at => started.push(at))).toBe('changed')
    expect(started).toEqual([])
  })

  it('answers failed when the start throws, keeping the file', async () => {
    const { file } = await downloadInstaller(signedFile(), download(INSTALLER), updates, { fetch: github().fetch }) as { file: string }
    expect(startInstaller(file, signedFile(), () => {
      throw new Error('no start')
    })).toBe('failed')
    expect(await readFile(file)).toEqual(BYTES)
  })

  it('logs a start that throws and has hetu start again', async () => {
    const { updater, quits, lines } = made({ fetch: github().fetch, spawn: () => { throw new Error('no start') } })
    await updater.check()
    await updater.install()
    expect(quits[0]()).toBe(false)
    expect(lines).toContain('update: the installer did not start')
  })
})

function made(over: Partial<UpdaterOptions> = {}) {
  const records: { event: string, fields: unknown }[] = []
  const lines: string[] = []
  const quits: (() => boolean)[] = []
  const started: { file: string, args: readonly string[] }[] = []
  const updater = createUpdater({
    locked: true, running: '0.6.0', platform: 'win32', key: ours.publicKey, dataDir: dir,
    recording: { coreRecord: (event, fields) => records.push({ event, fields }) },
    log: line => lines.push(line), later: () => () => undefined,
    quit: start => (quits.push(start), true), spawn: (file, args) => started.push({ file, args }),
    ...over,
  })
  return { updater, records, lines, quits, started }
}

describe('Install, on the human\'s click', () => {
  it('downloads the installer found, quits and starts it once quit has run', async () => {
    const { updater, quits, started, records } = made({ fetch: github().fetch })
    await updater.check()
    expect(await updater.install()).toEqual({ outcome: 'quitting' })
    expect(updater.state().last).toEqual({ kind: 'installing', version: '0.6.1' })
    expect(started).toEqual([])
    expect(quits).toHaveLength(1)
    expect(quits[0]()).toBe(true)
    expect(started).toEqual([{ file: path.join(dir, 'updates', INSTALLER), args: ['/S', '--force-run'] }])
    expect(records).toEqual([])
  })

  it('records a tampered installer as update.refused with hash, shows it and quits nothing', async () => {
    const tampered = Buffer.from(BYTES)
    tampered[0] ^= 1
    const { updater, quits, records } = made({ fetch: github(tampered).fetch })
    await updater.check()
    expect(await updater.install()).toEqual({ outcome: 'refused', reason: 'hash' })
    expect(records).toEqual([{ event: 'update.refused', fields: { reason: 'hash', version: '0.6.1' } }])
    expect(updater.state().last).toEqual({ kind: 'refused', reason: 'hash', version: '0.6.1' })
    expect(quits).toEqual([])
  })

  it('records a size that doesn\'t match as update.refused with size', async () => {
    const { updater, records } = made({ fetch: github(BYTES.subarray(2)).fetch })
    await updater.check()
    expect(await updater.install()).toEqual({ outcome: 'refused', reason: 'size' })
    expect(records).toEqual([{ event: 'update.refused', fields: { reason: 'size', version: '0.6.1' } }])
  })

  it('logs a swapped file at the start, starts nothing and has hetu start again', async () => {
    const { updater, quits, started, lines } = made({ fetch: github().fetch })
    await updater.check()
    await updater.install()
    await writeFile(path.join(dir, 'updates', INSTALLER), 'swapped')
    expect(quits[0]()).toBe(false)
    expect(started).toEqual([])
    expect(lines).toContain('update: the installer changed on disk after its download and was not started')
  })

  it('is quiet on a download that fails, keeping the update found for another click', async () => {
    const { fetch } = github()
    let down = false
    const flaky: Fetch = (url, init) => (down && url === download(INSTALLER) ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init))
    const { updater, quits, records, lines } = made({ fetch: flaky })
    const found = (await updater.check()).last
    down = true
    expect(await updater.install()).toEqual({ outcome: 'failed', problem: 'offline' })
    expect(updater.state().last).toEqual(found)
    expect(records).toEqual([])
    expect(quits).toEqual([])
    expect(lines).toContain('update: the installer did not download (offline)')
    down = false
    expect(await updater.install()).toEqual({ outcome: 'quitting' })
  })

  it('is unavailable with nothing found, on macOS, in a build that doesn\'t check and while one is under way', async () => {
    const before = made({ fetch: github().fetch })
    expect(await before.updater.install()).toEqual({ outcome: 'unavailable' })
    const mac = made({ fetch: github().fetch, platform: 'darwin' })
    await mac.updater.check()
    expect(await mac.updater.install()).toEqual({ outcome: 'unavailable' })
    const unlocked = made({ fetch: github().fetch, locked: false })
    expect(await unlocked.updater.install()).toEqual({ outcome: 'unavailable' })
    const twice = made({ fetch: github().fetch })
    await twice.updater.check()
    const [a, b] = [twice.updater.install(), twice.updater.install()]
    expect(await b).toEqual({ outcome: 'unavailable' })
    expect(await a).toEqual({ outcome: 'quitting' })
    expect(await twice.updater.install()).toEqual({ outcome: 'unavailable' })
    expect(twice.quits).toHaveLength(1)
  })

  it('starts nothing when a quit is already under way', async () => {
    const { updater, started } = made({ fetch: github().fetch, quit: () => false })
    await updater.check()
    expect(await updater.install()).toEqual({ outcome: 'unavailable' })
    expect(started).toEqual([])
  })

  it('stops the download on close and quits nothing', async () => {
    const { fetch } = github()
    let close = () => undefined as void
    const closing: Fetch = async (url, init) => {
      const answer = await fetch(url, init)
      if (url === download(INSTALLER)) close()
      return answer
    }
    const { updater, quits } = made({ fetch: closing })
    close = () => updater.close()
    await updater.check()
    expect(await updater.install()).toEqual({ outcome: 'failed', problem: 'cancelled' })
    expect(quits).toEqual([])
  })

  it('checks nothing more once installing', async () => {
    const { fetch, urls } = github()
    const { updater } = made({ fetch })
    await updater.check()
    await updater.install()
    const asked = urls.length
    expect((await updater.check()).last).toEqual({ kind: 'installing', version: '0.6.1' })
    expect(urls).toHaveLength(asked)
  })
})
