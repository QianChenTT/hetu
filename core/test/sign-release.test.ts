import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import type { Fetch } from '../backend/lib/github.ts'
import { checkLatest, SIGNATURE_FILE_NAME, UPDATE_FILE_NAME } from '../backend/updater/check.ts'
import { updateFileFor, updateFileText } from '../build/update-file.ts'
import { askHidden, defaultKeyPath, readArgs, signRelease, type Gh, type SignOptions } from '../../scripts/sign-release.ts'

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})
const temp = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-sign-'))
  made.push(dir)
  return dir
}

const VERSION = '0.6.1'
const TAG = `v${VERSION}`
const SETUP = `hetu-setup-${VERSION}-x64.exe`
const REPO = 'QianChenTT/hetu'
const PASSPHRASE = 'a passphrase made for this run'
const COMMIT = 'c0ffee0000000000000000000000000000000000'

// A key pair made for this run, the private half written as the publisher's is: encrypted PKCS#8 in PEM with AES-256-CBC
// under a passphrase. Nothing here reads the publisher's key
async function keyPair(): Promise<{ keyPath: string, publicKey: KeyObject }> {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  expect(pair.privateKey).toContain('ENCRYPTED PRIVATE KEY')
  const keyPath = path.join(await temp(), 'signing.key.pem')
  await writeFile(keyPath, pair.privateKey)
  return { keyPath, publicKey: createPublicKey(pair.publicKey) }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

type Draft = {
  isDraft?: boolean
  setup?: Buffer
  // Files that replace the ones the Release workflow would have made, or null for one missing
  files?: Record<string, Buffer | null>
  attested?: Record<string, boolean>
  // GitHub's latest release before publishing (null for none) and the tags it answers after, one a read
  latest?: string | null
  latestAfter?: string[]
  // What the draft holds once the signature is uploaded, when someone changed it meanwhile (null for a file removed),
  // and whether it was published meanwhile
  changed?: Record<string, Buffer | null>
  publishedMeanwhile?: boolean
}

// gh as a table: the draft's files with the digests GitHub records, each call recorded. A download writes the named
// files into --dir, an upload reads the file it names, so the bytes that would reach GitHub are kept
async function fakeGh(draft: Draft = {}) {
  const setupBytes = draft.setup ?? Buffer.from('MZ a stand-in for the setup')
  const dir = await temp()
  await writeFile(path.join(dir, SETUP), setupBytes)
  const updateFile = Buffer.from(updateFileText(await updateFileFor(path.join(dir, SETUP), VERSION, new Date('2026-11-23T20:00:00.000Z'))))
  const sums = Buffer.from(`${sha256(setupBytes)}  ${SETUP}\n${sha256(updateFile)}  ${UPDATE_FILE_NAME}\n`)
  const files: Record<string, Buffer> = { [SETUP]: setupBytes, [UPDATE_FILE_NAME]: updateFile, SHA256SUMS: sums }
  for (const [name, bytes] of Object.entries(draft.files ?? {})) {
    if (bytes === null) delete files[name]
    else files[name] = bytes
  }
  const calls: string[][] = []
  const uploads: Record<string, Buffer> = {}
  const after = [...(draft.latestAfter ?? [TAG])]
  let published = false
  const flag = (args: readonly string[], name: string) => args.flatMap((arg, at) => (arg === name ? [args[at + 1]!] : []))
  const gh: Gh = async args => {
    calls.push([...args])
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    const [group, command] = args
    if (group === 'release' && command === 'view') {
      const uploaded = Object.keys(uploads).length > 0
      const now: Record<string, Buffer | null> = { ...files, ...uploads, ...(uploaded ? draft.changed : {}) }
      const assets = Object.entries(now).flatMap(([name, bytes]) => (bytes === null ? [] : [{ name, digest: `sha256:${sha256(bytes)}` }]))
      const isDraft = uploaded && draft.publishedMeanwhile === true ? false : draft.isDraft ?? true
      return ok(JSON.stringify({ isDraft, targetCommitish: COMMIT, assets }))
    }
    if (group === 'release' && command === 'download') {
      const into = flag(args, '--dir')[0]!
      for (const name of flag(args, '--pattern')) if (files[name] !== undefined) await writeFile(path.join(into, name), files[name])
      return ok()
    }
    if (group === 'attestation' && command === 'verify') {
      const name = path.basename(args[2]!)
      return (draft.attested ?? {})[name] === false ? { code: 1, stdout: '', stderr: `no attestation for ${name}` } : ok()
    }
    if (group === 'release' && command === 'upload') {
      uploads[path.basename(args[3]!)] = await readFile(args[3]!)
      return ok()
    }
    if (group === 'release' && command === 'edit') {
      published = true
      return ok()
    }
    if (group === 'api') {
      const tag = published ? (after.length > 1 ? after.shift()! : after[0]!) : draft.latest === undefined ? 'v0.6.0' : draft.latest
      return tag === null ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : ok(`${tag}\n`)
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
  }
  return { gh, calls, uploads, updateFile, setupBytes, published: () => published }
}

async function options(gh: Gh, over: Partial<SignOptions> = {}): Promise<SignOptions & { asked: string[], waited: number[] }> {
  const { keyPath, publicKey } = await keyPair()
  const asked: string[] = []
  const waited: number[] = []
  return {
    version: VERSION,
    keyPath,
    gh,
    publicKey,
    askPassphrase: async prompt => {
      asked.push(prompt)
      return PASSPHRASE
    },
    askTyped: async prompt => {
      asked.push(prompt)
      return VERSION
    },
    log: () => {},
    wait: async ms => { waited.push(ms) },
    asked,
    waited,
    ...over,
  }
}

// GitHub's latest release holding the update file and the signature uploaded, for the check hetu itself makes
function latestHolding(file: Buffer, signature: Buffer): Fetch {
  const download = (name: string) => `https://github.com/QianChenTT/hetu/releases/download/${TAG}/${name}`
  const asset = (name: string) => ({ name, size: 1, state: 'uploaded', browser_download_url: download(name) })
  return async url => {
    if (url === 'https://api.github.com/repos/QianChenTT/hetu/releases/latest') {
      return Response.json({ tag_name: TAG, assets: [asset(UPDATE_FILE_NAME), asset(SIGNATURE_FILE_NAME), asset(SETUP)] })
    }
    if (url === download(UPDATE_FILE_NAME)) return new Response(new Uint8Array(file))
    if (url === download(SIGNATURE_FILE_NAME)) return new Response(new Uint8Array(signature))
    return new Response('', { status: 404 })
  }
}

const commands = (calls: string[][]) => calls.map(call => `${call[0]} ${call[1]}`)
const nothingChanged = (fake: Awaited<ReturnType<typeof fakeGh>>) => {
  expect(fake.uploads).toEqual({})
  expect(fake.published()).toBe(false)
}

describe('signing and publishing a draft release', () => {
  it('signs the update file, uploads the signature and publishes the draft as the latest full release once confirmed', async () => {
    const fake = await fakeGh()
    const run = await options(fake.gh)
    await signRelease(run)
    expect(commands(fake.calls)).toEqual([
      'release view', 'api repos/QianChenTT/hetu/releases/latest', 'release download', 'attestation verify', 'attestation verify',
      'release upload', 'release view', 'release edit', 'api repos/QianChenTT/hetu/releases/latest',
    ])
    expect(run.asked).toHaveLength(2)
    expect(run.asked[1]).toContain(COMMIT)
    expect(run.asked[1]).toContain('after v0.6.0')
    expect(fake.calls[7]).toEqual(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--prerelease=false', '--latest'])
    const signature = fake.uploads[SIGNATURE_FILE_NAME]!
    expect(signature).toHaveLength(64)
    // The uploaded signature over the release's own update file, through the check hetu makes
    expect(await checkLatest({ running: [0, 6, 0], key: run.publicKey!, fetch: latestHolding(fake.updateFile, signature) })).toMatchObject({
      outcome: 'found', update: { version: VERSION, file: SETUP, sha256: sha256(fake.setupBytes) },
    })
  })

  it('passes gh each file to verify against the Release workflow on main', async () => {
    const fake = await fakeGh()
    await signRelease(await options(fake.gh))
    const verified = fake.calls.filter(call => call[0] === 'attestation')
    expect(verified.map(call => path.basename(call[2]!))).toEqual([SETUP, UPDATE_FILE_NAME])
    for (const call of verified) {
      expect(call.slice(3)).toEqual(['--repo', REPO, '--signer-workflow', `${REPO}/.github/workflows/release.yml`, '--source-ref', 'refs/heads/main', '--deny-self-hosted-runners'])
    }
  })

  it('downloads into a folder of its own and removes it afterwards', async () => {
    const fake = await fakeGh()
    await signRelease(await options(fake.gh))
    const download = fake.calls.find(call => call[1] === 'download')!
    const dir = download[download.indexOf('--dir') + 1]!
    expect(path.basename(dir)).toMatch(/^hetu-sign-release-/)
    expect(existsSync(dir)).toBe(false)
  })

  it('publishes the first release when there is no latest one yet', async () => {
    const fake = await fakeGh({ latest: null })
    const run = await options(fake.gh)
    await signRelease(run)
    expect(run.asked[1]).toContain('after none')
    expect(fake.published()).toBe(true)
  })

  it('replaces a signature an earlier run uploaded to the draft', async () => {
    const fake = await fakeGh({ files: { [SIGNATURE_FILE_NAME]: Buffer.alloc(64) } })
    await signRelease(await options(fake.gh))
    expect(fake.published()).toBe(true)
  })

  it('refuses a version that isn\'t x.y.z before asking GitHub anything', async () => {
    const fake = await fakeGh()
    await expect(signRelease(await options(fake.gh, { version: 'v0.6.1' }))).rejects.toThrow('the version v0.6.1 isn\'t x.y.z')
    expect(fake.calls).toEqual([])
  })

  it('refuses a key file it can\'t read before asking GitHub anything', async () => {
    const fake = await fakeGh()
    await expect(signRelease(await options(fake.gh, { keyPath: path.join(await temp(), 'missing.pem') }))).rejects.toThrow('ENOENT')
    expect(fake.calls).toEqual([])
  })

  it('refuses a release that isn\'t a draft', async () => {
    const fake = await fakeGh({ isDraft: false })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(`${TAG} is not a draft`)
    expect(commands(fake.calls)).toEqual(['release view'])
  })

  for (const name of [SETUP, UPDATE_FILE_NAME, 'SHA256SUMS']) {
    it(`refuses a draft missing ${name}`, async () => {
      const fake = await fakeGh({ files: { [name]: null } })
      await expect(signRelease(await options(fake.gh))).rejects.toThrow(`the draft ${TAG} holds no ${name}`)
      expect(commands(fake.calls)).toEqual(['release view'])
    })
  }

  it('refuses a draft holding a file the Release workflow didn\'t make', async () => {
    const fake = await fakeGh({ files: { 'extra.exe': Buffer.from('x') } })
    const run = await options(fake.gh)
    await expect(signRelease(run)).rejects.toThrow('extra.exe')
    expect(run.asked).toEqual([])
    nothingChanged(fake)
  })

  for (const latest of [TAG, 'v0.7.0', 'v0.10.0']) {
    it(`refuses to publish ${TAG} over the latest release ${latest}, which isn't lower`, async () => {
      const fake = await fakeGh({ latest })
      const run = await options(fake.gh)
      await expect(signRelease(run)).rejects.toThrow(`${TAG} isn't higher than the latest release ${latest}`)
      expect(commands(fake.calls)).toEqual(['release view', 'api repos/QianChenTT/hetu/releases/latest'])
    })
  }

  for (const name of [SETUP, UPDATE_FILE_NAME]) {
    it(`refuses when ${name}'s attestation doesn't verify, before the passphrase is asked`, async () => {
      const fake = await fakeGh({ attested: { [name]: false } })
      const run = await options(fake.gh)
      await expect(signRelease(run)).rejects.toThrow(`no attestation for ${name}`)
      expect(run.asked).toEqual([])
      nothingChanged(fake)
    })
  }

  const mismatched: [string, Record<string, unknown>, string][] = [
    ['sha256', { sha256: 'ab'.repeat(32) }, `${UPDATE_FILE_NAME}'s sha256 is ${'ab'.repeat(32)}`],
    ['size', { size: 1 }, `${UPDATE_FILE_NAME}'s size is 1`],
    ['file', { file: 'hetu-setup-0.6.2-x64.exe' }, `${UPDATE_FILE_NAME}'s file is hetu-setup-0.6.2-x64.exe`],
    ['version', { version: '0.6.2' }, `${UPDATE_FILE_NAME}'s version is 0.6.2`],
  ]
  for (const [field, over, message] of mismatched) {
    it(`refuses an update file whose ${field} doesn't match the setup downloaded, before the passphrase is asked`, async () => {
      const original = JSON.parse((await fakeGh()).updateFile.toString('utf8')) as Record<string, unknown>
      const changed = Buffer.from(JSON.stringify({ ...original, ...over }))
      const fake = await fakeGh({ files: { [UPDATE_FILE_NAME]: changed } })
      const run = await options(fake.gh)
      await expect(signRelease(run)).rejects.toThrow(message)
      expect(run.asked).toEqual([])
      nothingChanged(fake)
    })
  }

  it('refuses an update file whose released isn\'t UTC as toISOString writes it', async () => {
    const original = JSON.parse((await fakeGh()).updateFile.toString('utf8')) as Record<string, unknown>
    const fake = await fakeGh({ files: { [UPDATE_FILE_NAME]: Buffer.from(JSON.stringify({ ...original, released: '2026-11-23 20:00' })) } })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(`${UPDATE_FILE_NAME}'s released isn't a time in UTC`)
  })

  it('refuses an update file that isn\'t JSON', async () => {
    const fake = await fakeGh({ files: { [UPDATE_FILE_NAME]: Buffer.from('not json') } })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(`${UPDATE_FILE_NAME} isn't JSON`)
  })

  it('refuses a SHA256SUMS that doesn\'t hold exactly the two files checked', async () => {
    const fake = await fakeGh({ files: { SHA256SUMS: Buffer.from(`${'00'.repeat(32)}  ${SETUP}\n`) } })
    const run = await options(fake.gh)
    await expect(signRelease(run)).rejects.toThrow('SHA256SUMS doesn\'t hold exactly the two files checked')
    expect(run.asked).toEqual([])
  })

  it('refuses a download that isn\'t what GitHub records for the draft', async () => {
    const fake = await fakeGh()
    const real = fake.gh
    const gh: Gh = async args => {
      const answer = await real(args)
      if (args[1] !== 'download') return answer
      const dir = args[args.indexOf('--dir') + 1]!
      await writeFile(path.join(dir, SETUP), Buffer.from('MZ another setup'))
      return answer
    }
    const run = await options(gh)
    await expect(signRelease(run)).rejects.toThrow(`the draft's ${SETUP} has sha256`)
    expect(run.asked).toEqual([])
  })

  it('refuses a passphrase that doesn\'t open the key, uploading nothing', async () => {
    const fake = await fakeGh()
    await expect(signRelease(await options(fake.gh, { askPassphrase: async () => 'not the passphrase' }))).rejects.toThrow('the passphrase doesn\'t open')
    nothingChanged(fake)
  })

  it('stops as the prompt says when the passphrase isn\'t given', async () => {
    const fake = await fakeGh()
    await expect(signRelease(await options(fake.gh, { askPassphrase: async () => { throw new Error('stopped') } }))).rejects.toThrow(/^stopped$/)
    nothingChanged(fake)
  })

  it('refuses a key whose signature hetu\'s key doesn\'t check, uploading nothing', async () => {
    const fake = await fakeGh()
    const run = await options(fake.gh, { publicKey: generateKeyPairSync('ed25519').publicKey })
    await expect(signRelease(run)).rejects.toThrow('this key isn\'t the one hetu trusts')
    nothingChanged(fake)
  })

  it('names the updater\'s reason when it would refuse the update file itself', async () => {
    const fake = await fakeGh({ setup: Buffer.alloc(0) })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow('it refuses the update file: format')
    nothingChanged(fake)
  })

  it('uploads and publishes nothing unless the version is typed to confirm', async () => {
    const fake = await fakeGh()
    await expect(signRelease(await options(fake.gh, { askTyped: async () => 'yes' }))).rejects.toThrow('not confirmed')
    nothingChanged(fake)
  })

  it('publishes nothing when the draft changed between the checks and the publish', async () => {
    const fake = await fakeGh({ changed: { [SETUP]: Buffer.from('MZ swapped') } })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(`the draft's ${SETUP} has sha256`)
    expect(fake.published()).toBe(false)
  })

  it('publishes nothing when a file was added to the draft meanwhile', async () => {
    const fake = await fakeGh({ changed: { 'extra.exe': Buffer.from('x') } })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow('extra.exe')
    expect(fake.published()).toBe(false)
  })

  it('publishes nothing when a file was removed from the draft meanwhile', async () => {
    const fake = await fakeGh({ changed: { [SETUP]: null } })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(`the draft ${TAG} holds`)
    expect(fake.published()).toBe(false)
  })

  it('edits nothing when the draft was published meanwhile', async () => {
    const fake = await fakeGh({ publishedMeanwhile: true })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(`${TAG} is not a draft`)
    expect(fake.published()).toBe(false)
  })

  it('waits for GitHub to name the release its latest', async () => {
    const fake = await fakeGh({ latestAfter: ['v0.6.0', 'v0.6.0', TAG] })
    const run = await options(fake.gh)
    await signRelease(run)
    expect(run.waited).toEqual([2000, 2000])
  })

  it('says so when GitHub\'s latest release is still another one after five reads', async () => {
    const fake = await fakeGh({ latestAfter: ['v0.7.0'] })
    const run = await options(fake.gh)
    await expect(signRelease(run)).rejects.toThrow(`${TAG} is published, but GitHub's latest release is v0.7.0`)
    expect(run.waited).toHaveLength(4)
  })

  it('says what gh said when a call fails', async () => {
    const gh: Gh = async () => ({ code: 1, stdout: '', stderr: 'release not found' })
    await expect(signRelease(await options(gh))).rejects.toThrow('gh release view failed: release not found')
  })
})

describe('the command line', () => {
  it('takes the version and the key file, the key defaulting to the one under the home folder', () => {
    expect(readArgs(['0.6.1'])).toEqual({ version: '0.6.1', keyPath: defaultKeyPath() })
    expect(readArgs(['0.6.1', '--key', 'other.pem'])).toEqual({ version: '0.6.1', keyPath: path.resolve('other.pem') })
    expect(defaultKeyPath()).toBe(path.join(homedir(), 'keys', 'hetu-release', 'hetu-signing-1.key.pem'))
  })

  it('refuses no version, a second one or an option it doesn\'t know', () => {
    expect(() => readArgs([])).toThrow('usage')
    expect(() => readArgs(['0.6.1', '0.6.2'])).toThrow('usage')
    expect(() => readArgs(['0.6.1', '--keys', 'a'])).toThrow('usage')
    expect(() => readArgs(['0.6.1', '--key'])).toThrow('usage')
  })
})

// A terminal as a stream: raw mode recorded, keys typed as data
function terminal() {
  const input = Object.assign(new PassThrough({ encoding: 'utf8' }), { isTTY: true, raw: [] as boolean[], setRawMode(on: boolean) { this.raw.push(on); return this } })
  let shown = ''
  const output = { write: (text: string) => { shown += text; return true } }
  return { input, output, shown: () => shown }
}

describe('the passphrase prompt', () => {
  it('reads to Enter in raw mode and shows nothing typed', async () => {
    const tty = terminal()
    const asked = askHidden('Passphrase: ', tty.input, tty.output)
    tty.input.write('secret')
    tty.input.write('\r')
    expect(await asked).toBe('secret')
    expect(tty.shown()).toBe('Passphrase: \n')
    expect(tty.input.raw).toEqual([true, false])
  })

  it('takes Backspace off the last character', async () => {
    const tty = terminal()
    const asked = askHidden('Passphrase: ', tty.input, tty.output)
    tty.input.write('secrex\u007ft\b\bet\n')
    expect(await asked).toBe('secret')
  })

  it('drops a key that sends an escape sequence and keeps a character split across two reads', async () => {
    const raw: boolean[] = []
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode(on: boolean) { raw.push(on); return this } })
    const asked = askHidden('Passphrase: ', input, { write: () => true })
    const accented = Buffer.from('é')
    input.write(Buffer.from('\u001b[A'))
    input.write(Buffer.concat([Buffer.from('caf'), accented.subarray(0, 1)]))
    input.write(Buffer.concat([accented.subarray(1), Buffer.from('\r')]))
    expect(await asked).toBe('café')
  })

  it('stops on Ctrl+C', async () => {
    const tty = terminal()
    const asked = askHidden('Passphrase: ', tty.input, tty.output)
    tty.input.write('sec\u0003')
    await expect(asked).rejects.toThrow('stopped')
    expect(tty.input.raw).toEqual([true, false])
  })

  it('refuses input that isn\'t a terminal, where raw mode can\'t hide it', async () => {
    const input = new PassThrough()
    await expect(askHidden('Passphrase: ', input, { write: () => true })).rejects.toThrow('terminal')
  })
})
