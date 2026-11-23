import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Fetch } from '../backend/lib/github.ts'
import { checkLatest, SIGNATURE_FILE_NAME, UPDATE_FILE_NAME } from '../backend/updater/check.ts'
import { updateFileFor, updateFileText, writeUpdateAndSums } from '../build/update-file.ts'

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})
const temp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-update-file-'))
  made.push(dir)
  return dir
}

// A stand-in for a built setup: bytes whose hash and size are known
const SETUP = 'hetu-setup-0.6.1-x64.exe'
const setupBytes = Buffer.from('MZ a stand-in for the setup, with no meaning of its own')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const BUILT = new Date('2026-11-23T20:00:00.000Z')

// GitHub's latest release holding the update file and its signature, for the check hetu itself makes
function github(file: Buffer, signature: Buffer): Fetch {
  const download = (name: string) => `https://github.com/QianChenTT/hetu/releases/download/v0.6.1/${name}`
  const asset = (name: string) => ({ name, size: 1, state: 'uploaded', browser_download_url: download(name) })
  return async url => {
    if (url === 'https://api.github.com/repos/QianChenTT/hetu/releases/latest') {
      return Response.json({ tag_name: 'v0.6.1', assets: [asset(UPDATE_FILE_NAME), asset(SIGNATURE_FILE_NAME), asset(SETUP)] })
    }
    if (url === download(UPDATE_FILE_NAME)) return new Response(new Uint8Array(file))
    if (url === download(SIGNATURE_FILE_NAME)) return new Response(new Uint8Array(signature))
    return new Response('', { status: 404 })
  }
}

describe('the update file made from a built setup', () => {
  it('names the setup, its size and sha256, the version and when it was made, in UTC', async () => {
    const setup = path.join(await temp(), SETUP)
    await writeFile(setup, setupBytes)
    expect(await updateFileFor(setup, '0.6.1', BUILT)).toEqual({
      version: '0.6.1', file: SETUP, size: setupBytes.length, sha256: sha256(setupBytes), built: '2026-11-23T20:00:00.000Z',
    })
  })

  it('refuses a version that isn\'t x.y.z', async () => {
    const setup = path.join(await temp(), SETUP)
    await writeFile(setup, setupBytes)
    await expect(updateFileFor(setup, '0.6.1-beta', BUILT)).rejects.toThrow('x.y.z')
  })

  // The bytes a release carries are the bytes the publisher signs and hetu checks, through hetu's own check
  it('is a file hetu accepts once the key signs its bytes', async () => {
    const setup = path.join(await temp(), SETUP)
    await writeFile(setup, setupBytes)
    const bytes = Buffer.from(updateFileText(await updateFileFor(setup, '0.6.1', BUILT)))
    const pair = generateKeyPairSync('ed25519')
    const signature = sign(null, bytes, pair.privateKey)
    expect(signature).toHaveLength(64)
    expect(await checkLatest({ running: [0, 6, 0], key: pair.publicKey, fetch: github(bytes, signature) })).toMatchObject({
      outcome: 'found', update: { version: '0.6.1', file: SETUP, size: setupBytes.length, sha256: sha256(setupBytes) },
    })
  })
})

describe('the files a release carries beside the setup', () => {
  it('writes the update file and SHA256SUMS over the setup and the update file', async () => {
    const out = await temp()
    const setup = path.join(out, SETUP)
    await writeFile(setup, setupBytes)
    await writeUpdateAndSums(out, [setup], '0.6.1', BUILT)
    expect((await readdir(out)).sort()).toEqual(['SHA256SUMS', SETUP, UPDATE_FILE_NAME].sort())
    const update = await readFile(path.join(out, UPDATE_FILE_NAME))
    expect(JSON.parse(update.toString('utf8'))).toEqual(await updateFileFor(setup, '0.6.1', BUILT))
    expect(await readFile(path.join(out, 'SHA256SUMS'), 'utf8')).toBe(`${sha256(setupBytes)}  ${SETUP}\n${sha256(update)}  ${UPDATE_FILE_NAME}\n`)
  })

  it('writes nothing for a build with no setup', async () => {
    const out = await temp()
    await writeUpdateAndSums(out, [], '0.6.1', BUILT)
    expect(await readdir(out)).toEqual([])
  })

  it('refuses two setups, since the update file names one', async () => {
    const out = await temp()
    const setups = [path.join(out, SETUP), path.join(out, 'hetu-setup-0.6.2-x64.exe')]
    for (const setup of setups) await writeFile(setup, setupBytes)
    await expect(writeUpdateAndSums(out, setups, '0.6.1', BUILT)).rejects.toThrow('one setup')
  })
})
