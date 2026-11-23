import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto'
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
  const { createPublicKey } = await import('node:crypto')
  return { keyPath, publicKey: createPublicKey(pair.publicKey) }
}

const setupBytes = Buffer.from('MZ a stand-in for the setup')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

type Draft = {
  isDraft?: boolean
  files?: Record<string, Buffer>
  attested?: Record<string, boolean>
  latest?: string
}

// gh as a table: the draft's state and files, each call recorded. A download writes the named files into --dir, an
// upload reads the file it names, so the bytes that would reach GitHub are kept
async function fakeGh(draft: Draft = {}) {
  const updateFile = await (async () => {
    const dir = await temp()
    await writeFile(path.join(dir, SETUP), setupBytes)
    return Buffer.from(updateFileText(await updateFileFor(path.join(dir, SETUP), VERSION, new Date('2026-11-23T20:00:00.000Z'))))
  })()
  const files: Record<string, Buffer> = { [SETUP]: setupBytes, [UPDATE_FILE_NAME]: updateFile, SHA256SUMS: Buffer.from('sums\n'), ...draft.files }
  const calls: string[][] = []
  const uploads: Record<string, Buffer> = {}
  let published = false
  const flag = (args: readonly string[], name: string) => args.flatMap((arg, at) => (arg === name ? [args[at + 1]!] : []))
  const gh: Gh = async args => {
    calls.push([...args])
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
    const [group, command] = args
    if (group === 'release' && command === 'view') {
      return ok(JSON.stringify({ tagName: TAG, isDraft: draft.isDraft ?? true, assets: Object.keys(files).map(name => ({ name })) }))
    }
    if (group === 'release' && command === 'download') {
      const dir = flag(args, '--dir')[0]!
      for (const name of flag(args, '--pattern')) if (files[name] !== undefined) await writeFile(path.join(dir, name), files[name])
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
    if (group === 'api') return ok(`${published ? draft.latest ?? TAG : 'v0.6.0'}\n`)
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` }
  }
  return { gh, calls, uploads, updateFile, published: () => published }
}

async function options(gh: Gh, over: Partial<SignOptions> = {}): Promise<SignOptions & { asked: string[] }> {
  const { keyPath, publicKey } = await keyPair()
  const asked: string[] = []
  return {
    version: VERSION,
    keyPath,
    gh,
    publicKey,
    askPassphrase: async prompt => {
      asked.push(prompt)
      return PASSPHRASE
    },
    confirm: async prompt => {
      asked.push(prompt)
      return VERSION
    },
    log: () => {},
    asked,
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

describe('signing and publishing a draft release', () => {
  it('signs the update file, uploads the signature and publishes the draft as the latest full release once confirmed', async () => {
    const fake = await fakeGh()
    const run = await options(fake.gh)
    await signRelease(run)
    expect(commands(fake.calls)).toEqual(['release view', 'release download', 'attestation verify', 'attestation verify', 'release upload', 'release edit', 'api repos/QianChenTT/hetu/releases/latest'])
    expect(run.asked).toHaveLength(2)
    expect(fake.calls[5]).toEqual(['release', 'edit', TAG, '--repo', REPO, '--draft=false', '--prerelease=false', '--latest'])
    const signature = fake.uploads[SIGNATURE_FILE_NAME]!
    expect(signature).toHaveLength(64)
    // The uploaded signature over the release's own update file, through the check hetu makes
    expect(await checkLatest({ running: [0, 6, 0], key: run.publicKey!, fetch: latestHolding(fake.updateFile, signature) })).toMatchObject({
      outcome: 'found', update: { version: VERSION, file: SETUP, sha256: sha256(setupBytes) },
    })
  })

  it('checks each file\'s attestation against the Release workflow on main', async () => {
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
    const dir = fake.calls.find(call => call[1] === 'download')![fake.calls.find(call => call[1] === 'download')!.indexOf('--dir') + 1]!
    expect(path.dirname(dir)).toBe(path.resolve(tmpdir()))
    expect(existsSync(dir)).toBe(false)
  })

  it('refuses a version that isn\'t x.y.z before asking GitHub anything', async () => {
    const fake = await fakeGh()
    await expect(signRelease(await options(fake.gh, { version: 'v0.6.1' }))).rejects.toThrow('x.y.z')
    expect(fake.calls).toEqual([])
  })

  it('refuses a release that isn\'t a draft', async () => {
    const fake = await fakeGh({ isDraft: false })
    const run = await options(fake.gh)
    await expect(signRelease(run)).rejects.toThrow('not a draft')
    expect(commands(fake.calls)).toEqual(['release view'])
  })

  it('refuses a draft missing the setup or the update file', async () => {
    for (const name of [SETUP, UPDATE_FILE_NAME]) {
      const fake = await fakeGh()
      const view = fake.gh
      const gh: Gh = async args => {
        const answer = await view(args)
        if (args[1] !== 'view') return answer
        const release = JSON.parse(answer.stdout) as { assets: { name: string }[] }
        return { ...answer, stdout: JSON.stringify({ ...release, assets: release.assets.filter(asset => asset.name !== name) }) }
      }
      await expect(signRelease(await options(gh)), name).rejects.toThrow(name)
      expect(commands(fake.calls)).toEqual(['release view'])
    }
  })

  for (const name of [SETUP, UPDATE_FILE_NAME]) {
    it(`refuses when ${name}'s attestation doesn't verify, before the passphrase is asked`, async () => {
      const fake = await fakeGh({ attested: { [name]: false } })
      const run = await options(fake.gh)
      await expect(signRelease(run)).rejects.toThrow(`no attestation for ${name}`)
      expect(run.asked).toEqual([])
      expect(fake.uploads).toEqual({})
      expect(fake.published()).toBe(false)
    })
  }

  const mismatched: [string, Record<string, unknown>][] = [
    ['sha256', { sha256: 'ab'.repeat(32) }],
    ['size', { size: setupBytes.length + 1 }],
    ['file', { file: 'hetu-setup-0.6.2-x64.exe' }],
    ['version', { version: '0.6.2' }],
    ['released', { released: '2026-11-23 20:00' }],
  ]
  for (const [field, over] of mismatched) {
    it(`refuses an update file whose ${field} doesn't match the setup downloaded, before the passphrase is asked`, async () => {
      const original = JSON.parse((await fakeGh()).updateFile.toString('utf8')) as Record<string, unknown>
      const fake = await fakeGh({ files: { [UPDATE_FILE_NAME]: Buffer.from(JSON.stringify({ ...original, ...over })) } })
      const run = await options(fake.gh)
      await expect(signRelease(run)).rejects.toThrow(field)
      expect(run.asked).toEqual([])
      expect(fake.uploads).toEqual({})
    })
  }

  it('refuses an update file that isn\'t JSON', async () => {
    const fake = await fakeGh({ files: { [UPDATE_FILE_NAME]: Buffer.from('not json') } })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow(UPDATE_FILE_NAME)
  })

  it('refuses a passphrase that doesn\'t open the key, uploading nothing', async () => {
    const fake = await fakeGh()
    const run = await options(fake.gh, { askPassphrase: async () => 'not the passphrase' })
    await expect(signRelease(run)).rejects.toThrow('passphrase')
    expect(fake.uploads).toEqual({})
    expect(fake.published()).toBe(false)
  })

  it('refuses a key whose signature hetu\'s key doesn\'t check, uploading nothing', async () => {
    const fake = await fakeGh()
    const run = await options(fake.gh, { publicKey: generateKeyPairSync('ed25519').publicKey })
    await expect(signRelease(run)).rejects.toThrow('key inside hetu')
    expect(fake.uploads).toEqual({})
    expect(fake.published()).toBe(false)
  })

  it('uploads and publishes nothing unless the version is typed to confirm', async () => {
    const fake = await fakeGh()
    const run = await options(fake.gh, { confirm: async () => 'yes' })
    await expect(signRelease(run)).rejects.toThrow('not confirmed')
    expect(fake.uploads).toEqual({})
    expect(fake.published()).toBe(false)
  })

  it('says so when GitHub\'s latest release isn\'t the one published', async () => {
    const fake = await fakeGh({ latest: 'v0.7.0' })
    await expect(signRelease(await options(fake.gh))).rejects.toThrow('v0.7.0')
  })

  it('says what gh said when a call fails', async () => {
    const gh: Gh = async () => ({ code: 1, stdout: '', stderr: 'release not found' })
    await expect(signRelease(await options(gh))).rejects.toThrow('release not found')
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
