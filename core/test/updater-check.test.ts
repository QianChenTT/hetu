import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Fetch } from '../backend/lib/github.ts'
import { checkLatest, compareVersions, releasePage, SIGNATURE_FILE, UPDATE_FILE, updateKey, versionParts, type CheckOptions } from '../backend/updater/check.ts'
import { UPDATE_KEY } from '../backend/updater/key.ts'

// A key pair made for this run, so no test holds a private key and none touches the real one
const pair = () => generateKeyPairSync('ed25519')
const ours = pair()
const theirs = pair()

const LATEST = 'https://api.github.com/repos/QianChenTT/hetu/releases/latest'
const download = (name: string) => `https://github.com/QianChenTT/hetu/releases/download/v0.6.1/${name}`
const INSTALLER = 'hetu-setup-0.6.1-x64.exe'

const fields = (over: Record<string, unknown> = {}) => ({
  version: '0.6.1', file: INSTALLER, size: 123_456, sha256: 'ab'.repeat(32), released: '2026-11-23T20:00:00.000Z', ...over,
})
const bytesOf = (body: unknown) => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
const signed = (bytes: Buffer, key: KeyObject = ours.privateKey) => sign(null, bytes, key)

type Release = { file?: Buffer | null, signature?: Buffer | null, installer?: boolean, extra?: object[] }

const asset = (name: string) => ({ name, size: 1, state: 'uploaded', browser_download_url: download(name) })

// GitHub as a table of answers: the latest release with its assets and each asset's bytes. Every request is recorded,
// so no test reaches the network
function github(release: Release = {}, latest?: () => Response): { fetch: Fetch, urls: string[] } {
  const file = release.file === undefined ? bytesOf(fields()) : release.file
  const signature = release.signature === undefined && file !== null ? signed(file) : release.signature ?? null
  const assets = [
    ...(file !== null ? [asset(UPDATE_FILE)] : []),
    ...(signature !== null ? [asset(SIGNATURE_FILE)] : []),
    ...(release.installer !== false ? [asset(INSTALLER)] : []),
    ...(release.extra ?? []),
  ]
  const urls: string[] = []
  const fetch: Fetch = async url => {
    urls.push(url)
    if (url === LATEST) return latest?.() ?? Response.json({ tag_name: 'v0.6.1', assets })
    if (url === download(UPDATE_FILE) && file !== null) return new Response(new Uint8Array(file))
    if (url === download(SIGNATURE_FILE) && signature !== null) return new Response(new Uint8Array(signature))
    return new Response('', { status: 404 })
  }
  return { fetch, urls }
}

const options = (fetch: Fetch, over: Partial<CheckOptions> = {}): CheckOptions => ({ running: [0, 6, 0], key: ours.publicKey, fetch, ...over })

describe('the key inside hetu', () => {
  it('is the publisher\'s Ed25519 public key as published', () => {
    const spki = createPublicKey(UPDATE_KEY).export({ format: 'der', type: 'spki' }).toString('base64')
    expect(spki).toBe('MCowBQYDK2VwAyEAXT7tpaC+9QHdT83xtFvsCdZ65VOWHqUaFypE2lsWaPI=')
    expect(updateKey().asymmetricKeyType).toBe('ed25519')
  })

  it('refuses a key of another kind', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'pem', type: 'spki' }).toString()
    expect(() => updateKey(rsa)).toThrow(/not an Ed25519 key/)
  })
})

describe('a version', () => {
  it('is x.y.z only, as release.yml requires', () => {
    expect(versionParts('0.6.1')).toEqual([0, 6, 1])
    expect(versionParts('10.20.300')).toEqual([10, 20, 300])
    for (const version of ['0.6', '0.6.1.2', 'v0.6.1', '0.6.1-beta', '0.6.1+build', ' 0.6.1', '0.6.1 ', '0.-6.1', '1.2.3\n', '1234567890.0.0', '']) {
      expect(versionParts(version), version).toBeNull()
    }
  })

  it('compares part by part as numbers, not as text', () => {
    const order = (a: string, b: string) => Math.sign(compareVersions(versionParts(a)!, versionParts(b)!))
    expect(order('0.10.0', '0.9.9')).toBe(1)
    expect(order('1.0.0', '0.99.99')).toBe(1)
    expect(order('0.6.1', '0.6.1')).toBe(0)
    expect(order('0.6.0', '0.6.1')).toBe(-1)
    expect(order('0.5.10', '0.6.0')).toBe(-1)
  })
})

describe('a check of the latest release', () => {
  it('finds a higher version whose file the key signed, with the installer\'s link and the release page', async () => {
    const { fetch, urls } = github()
    expect(await checkLatest(options(fetch))).toEqual({ outcome: 'found', update: fields(), installer: download(INSTALLER) })
    expect(urls).toEqual([LATEST, download(UPDATE_FILE), download(SIGNATURE_FILE)])
    expect(releasePage('0.6.1')).toBe('https://github.com/QianChenTT/hetu/releases/tag/v0.6.1')
  })

  it('refuses a file with one byte flipped, the signature unchanged', async () => {
    const file = bytesOf(fields())
    const signature = signed(file)
    const flipped = Buffer.from(file)
    flipped[10] ^= 1
    expect(await checkLatest(options(github({ file: flipped, signature }).fetch))).toEqual({ outcome: 'refused', reason: 'signature', version: null })
  })

  it('refuses a signature with one byte flipped', async () => {
    const file = bytesOf(fields())
    const signature = signed(file)
    signature[0] ^= 1
    expect(await checkLatest(options(github({ file, signature }).fetch))).toEqual({ outcome: 'refused', reason: 'signature', version: null })
  })

  it('refuses a file signed by another key', async () => {
    const file = bytesOf(fields())
    expect(await checkLatest(options(github({ file, signature: signed(file, theirs.privateKey) }).fetch)))
      .toEqual({ outcome: 'refused', reason: 'signature', version: null })
  })

  it('refuses a signature of the wrong length, cut short or padded', async () => {
    const file = bytesOf(fields())
    for (const signature of [signed(file).subarray(0, 63), Buffer.concat([signed(file), Buffer.alloc(1)]), Buffer.alloc(0)]) {
      expect(await checkLatest(options(github({ file, signature }).fetch))).toEqual({ outcome: 'refused', reason: 'signature', version: null })
    }
  })

  it('refuses a release holding the update file with no signature', async () => {
    const { fetch, urls } = github({ signature: null })
    expect(await checkLatest(options(fetch))).toEqual({ outcome: 'refused', reason: 'signature', version: null })
    expect(urls).toEqual([LATEST])
  })

  it('answers the running version as current', async () => {
    const file = bytesOf(fields({ version: '0.6.0' }))
    expect(await checkLatest(options(github({ file }).fetch))).toEqual({ outcome: 'current', update: fields({ version: '0.6.0' }) })
  })

  it('refuses a lower version, an old signed file replayed', async () => {
    const old = bytesOf(fields({ version: '0.5.0', file: 'hetu-setup-0.5.0-x64.exe' }))
    expect(await checkLatest(options(github({ file: old }).fetch))).toEqual({ outcome: 'refused', reason: 'version', version: '0.5.0' })
    expect(await checkLatest(options(github({ file: bytesOf(fields({ version: '0.5.99' })) }).fetch))).toEqual({ outcome: 'refused', reason: 'version', version: '0.5.99' })
  })

  it('refuses a signed file that isn\'t an update file, read only after the signature checked', async () => {
    for (const body of [
      'not json', '[]', fields({ version: '0.7' }), fields({ version: 'v0.7.0' }), fields({ size: 0 }), fields({ size: -1 }), fields({ size: 1.5 }),
      fields({ size: 2 * 1024 * 1024 * 1024 }), fields({ sha256: 'AB'.repeat(32) }), fields({ sha256: 'ab' }), fields({ file: '..\\hetu.exe' }),
      fields({ file: 'updates/hetu.exe' }), fields({ file: '.hetu.exe' }), fields({ file: 'hetu.msi' }), fields({ released: 'yesterday' }),
      { version: '0.7.0', file: INSTALLER, size: 1, sha256: 'ab'.repeat(32) },
      '{"version":"0.5.0","version":"0.7.0","file":"a.exe","size":1,"sha256":"' + 'ab'.repeat(32) + '","released":"2026-11-23T20:00:00Z"}',
    ]) {
      expect(await checkLatest(options(github({ file: bytesOf(body) }).fetch)), JSON.stringify(body)).toEqual({ outcome: 'refused', reason: 'format', version: null })
    }
  })

  it('ignores a field the file adds later', async () => {
    const file = bytesOf(fields({ notes: 'more later', version: '0.7.0' }))
    expect(await checkLatest(options(github({ file }).fetch))).toMatchObject({ outcome: 'found', update: fields({ version: '0.7.0' }) })
  })

  it('finds a higher version with no installer link when the release holds none by the signed name', async () => {
    expect(await checkLatest(options(github({ installer: false, extra: [asset('hetu-setup-0.6.0-x64.exe')] }).fetch)))
      .toEqual({ outcome: 'found', update: fields(), installer: null })
  })

  it('reads only assets uploaded whole', async () => {
    const half = { ...asset(SIGNATURE_FILE), state: 'starter' }
    const { fetch } = github({ signature: null, extra: [half] })
    expect(await checkLatest(options(fetch))).toEqual({ outcome: 'refused', reason: 'signature', version: null })
  })

  it('is quiet when the release holds no update file', async () => {
    const { fetch, urls } = github({ file: null })
    expect(await checkLatest(options(fetch))).toEqual({ outcome: 'failed', problem: 'no-update-file' })
    expect(urls).toEqual([LATEST])
  })

  it('is quiet when there is no full release', async () => {
    const { fetch } = github({}, () => new Response('{"message":"Not Found"}', { status: 404 }))
    expect(await checkLatest(options(fetch))).toEqual({ outcome: 'failed', problem: 'no-release' })
  })

  it('is quiet on the network failing or the rate limit', async () => {
    const offline: Fetch = () => Promise.reject(new TypeError('fetch failed'))
    expect(await checkLatest(options(offline))).toEqual({ outcome: 'failed', problem: 'offline' })
    const limited = github({}, () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
    expect(await checkLatest(options(limited.fetch))).toEqual({ outcome: 'failed', problem: 'rate-limited' })
  })

  it('refuses an oversized update file or release answer by the fetch limits', async () => {
    const big = Buffer.concat([bytesOf(fields()), Buffer.alloc(64 * 1024, 0x20)])
    expect(await checkLatest(options(github({ file: big, signature: signed(big) }).fetch))).toEqual({ outcome: 'failed', problem: 'too-big' })
    const huge = github({}, () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)))
    expect(await checkLatest(options(huge.fetch))).toEqual({ outcome: 'failed', problem: 'too-big' })
  })

  it('refuses a download link off GitHub\'s hosts before any request to it', async () => {
    const away = { name: UPDATE_FILE, size: 1, state: 'uploaded', browser_download_url: 'https://example.com/hetu-update.json' }
    const { fetch, urls } = github({ file: null, extra: [away, asset(SIGNATURE_FILE)] })
    expect(await checkLatest(options(fetch))).toEqual({ outcome: 'failed', problem: 'off-github' })
    expect(urls).toEqual([LATEST])
  })

  it('gives up on a stalled answer at the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stalled = github({}, () => new Response(new ReadableStream({ start: controller => controller.enqueue(new Uint8Array(1)) })))
      let settled = false
      const waiting = checkLatest(options(stalled.fetch)).finally(() => (settled = true))
      await vi.advanceTimersByTimeAsync(19_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await waiting).toEqual({ outcome: 'failed', problem: 'timed-out' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops on the caller\'s signal', async () => {
    const stalled = github({}, () => new Response(new ReadableStream({ start: controller => controller.enqueue(new Uint8Array(1)) })))
    const stop = new AbortController()
    const waiting = checkLatest(options(stalled.fetch, { signal: stop.signal }))
    stop.abort()
    expect(await waiting).toEqual({ outcome: 'failed', problem: 'cancelled' })
  })
})
