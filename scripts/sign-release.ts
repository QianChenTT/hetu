// Signs a draft release's update file with the publisher's key and publishes the draft as the latest full release, the
// one step that makes a release hetu's updater can see. Run by hand on the machine that holds the key:
// `npm run sign-release -- <version> [--key <file>]`. The passphrase is read from the terminal and never shown
import { spawn } from 'node:child_process'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type { Fetch } from '../core/backend/lib/github.ts'
import { checkLatest, OWNER, REPO, SIGNATURE_FILE_NAME, UPDATE_FILE_NAME, updateKey, versionParts } from '../core/backend/updater/check.ts'
import { updateFileFor } from '../core/build/update-file.ts'

const REPOSITORY = `${OWNER}/${REPO}`
// The workflow and branch that may have built what is signed, as gh attestation verify checks them
const RELEASE_WORKFLOW = `${REPOSITORY}/.github/workflows/release.yml`
const RELEASE_REF = 'refs/heads/main'

export type GhAnswer = { code: number, stdout: string, stderr: string }
export type Gh = (args: readonly string[]) => Promise<GhAnswer>

export type SignOptions = {
  version: string
  keyPath: string
  gh: Gh
  // Asks for the key's passphrase without showing it
  askPassphrase(prompt: string): Promise<string>
  // Asks for the version typed again before anything reaches GitHub
  confirm(prompt: string): Promise<string>
  // The key hetu checks the signature with, the one inside hetu unless a test hands its own
  publicKey?: KeyObject
  log?(line: string): void
}

// The key file under the home folder, where the publisher keeps it
export const defaultKeyPath = (): string => path.join(homedir(), 'keys', 'hetu-release', 'hetu-signing-1.key.pem')

const USAGE = 'usage: sign-release <version> [--key <file>]'

export function readArgs(argv: readonly string[]): { version: string, keyPath: string } {
  let version: string | undefined
  let keyPath = defaultKeyPath()
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!
    if (arg === '--key' && at + 1 < argv.length) keyPath = path.resolve(argv[++at]!)
    else if (!arg.startsWith('-') && version === undefined) version = arg
    else throw new Error(USAGE)
  }
  if (version === undefined) throw new Error(USAGE)
  return { version, keyPath }
}

// A gh call that must succeed, its stdout
async function run(gh: Gh, args: readonly string[]): Promise<string> {
  const answer = await gh(args)
  if (answer.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${answer.stderr.trim() || answer.stdout.trim()}`)
  return answer.stdout
}

// The update file against the setup it names, both as downloaded. A field that doesn't match is named
async function checkUpdateFile(bytes: Buffer, setup: string, version: string): Promise<void> {
  let written: Record<string, unknown>
  try {
    written = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error(`${UPDATE_FILE_NAME} isn't JSON`)
  }
  const released = typeof written.released === 'string' ? new Date(written.released) : null
  if (released === null || Number.isNaN(released.getTime()) || released.toISOString() !== written.released) {
    throw new Error(`${UPDATE_FILE_NAME}'s released isn't a time in UTC as toISOString writes it`)
  }
  const expected = await updateFileFor(setup, version, released)
  for (const field of ['version', 'file', 'size', 'sha256'] as const) {
    if (written[field] !== expected[field]) throw new Error(`${UPDATE_FILE_NAME}'s ${field} is ${String(written[field])}, the setup downloaded has ${expected[field]}`)
  }
}

// The check hetu itself makes, run on the local bytes: GitHub's latest release as holding the update file and this
// signature. Only a found update of this version passes
async function hetuAccepts(bytes: Buffer, signature: Buffer, version: string, key: KeyObject): Promise<boolean> {
  const download = (name: string) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`
  const files: Record<string, Buffer> = { [UPDATE_FILE_NAME]: bytes, [SIGNATURE_FILE_NAME]: signature }
  const fetch: Fetch = async url => {
    if (url === `https://api.github.com/repos/${REPOSITORY}/releases/latest`) {
      return Response.json({ tag_name: `v${version}`, assets: Object.keys(files).map(name => ({ name, size: files[name]!.length, state: 'uploaded', browser_download_url: download(name) })) })
    }
    const name = Object.keys(files).find(file => download(file) === url)
    return name === undefined ? new Response('', { status: 404 }) : new Response(new Uint8Array(files[name]!))
  }
  const checked = await checkLatest({ running: [0, 0, 0], key, fetch })
  return checked.outcome === 'found' && checked.update.version === version
}

export async function signRelease(options: SignOptions): Promise<void> {
  const { version, gh } = options
  const log = options.log ?? (line => console.log(line))
  if (versionParts(version) === null) throw new Error(`the version ${version} isn't x.y.z`)
  const tag = `v${version}`
  const setupName = `hetu-setup-${version}-x64.exe`
  const release = JSON.parse(await run(gh, ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'tagName,isDraft,assets'])) as { isDraft: boolean, assets: { name: string }[] }
  if (!release.isDraft) throw new Error(`${tag} is not a draft, so it is published already or was never made by the Release workflow`)
  for (const name of [setupName, UPDATE_FILE_NAME]) {
    if (!release.assets.some(asset => asset.name === name)) throw new Error(`the draft ${tag} holds no ${name}`)
  }
  const work = await mkdtemp(path.join(tmpdir(), 'hetu-sign-release-'))
  try {
    await run(gh, ['release', 'download', tag, '--repo', REPOSITORY, '--dir', work, '--pattern', setupName, '--pattern', UPDATE_FILE_NAME])
    const setup = path.join(work, setupName)
    const updateFile = path.join(work, UPDATE_FILE_NAME)
    // Built by the Release workflow on main, each file as downloaded
    for (const file of [setup, updateFile]) {
      await run(gh, ['attestation', 'verify', file, '--repo', REPOSITORY, '--signer-workflow', RELEASE_WORKFLOW, '--source-ref', RELEASE_REF, '--deny-self-hosted-runners'])
      log(`${path.basename(file)}: built by ${RELEASE_WORKFLOW} on ${RELEASE_REF}`)
    }
    const bytes = await readFile(updateFile)
    await checkUpdateFile(bytes, setup, version)
    log(`${UPDATE_FILE_NAME} matches ${setupName}`)
    const pem = await readFile(options.keyPath)
    let key: KeyObject
    try {
      key = createPrivateKey({ key: pem, format: 'pem', passphrase: await options.askPassphrase(`Passphrase for ${options.keyPath}: `) })
    } catch (err) {
      throw new Error(`the passphrase doesn't open ${options.keyPath} or the file isn't a key: ${(err as Error).message}`)
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${options.keyPath} isn't an Ed25519 key`)
    const signature = sign(null, bytes, key)
    if (!(await hetuAccepts(bytes, signature, version, options.publicKey ?? updateKey()))) {
      throw new Error('the signature doesn\'t check against the key inside hetu, so this key isn\'t the one hetu trusts')
    }
    log(`${UPDATE_FILE_NAME} signed and hetu's own check accepts it`)
    if ((await options.confirm(`Publish hetu ${version} as the latest release? Type ${version} to publish: `)).trim() !== version) {
      throw new Error('not confirmed, nothing was uploaded or published')
    }
    const signatureFile = path.join(work, SIGNATURE_FILE_NAME)
    await writeFile(signatureFile, signature)
    await run(gh, ['release', 'upload', tag, signatureFile, '--repo', REPOSITORY, '--clobber'])
    await run(gh, ['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--prerelease=false', '--latest'])
    const latest = (await run(gh, ['api', `repos/${REPOSITORY}/releases/latest`, '--jq', '.tag_name'])).trim()
    if (latest !== tag) throw new Error(`${tag} is published, but GitHub's latest release is ${latest}`)
    log(`${tag} is published as the latest release`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// One line read from a terminal in raw mode, nothing of it shown. Enter ends it, Backspace takes a character off and
// Ctrl+C stops
export function askHidden(
  prompt: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?(on: boolean): unknown } = process.stdin,
  output: { write(text: string): unknown } = process.stdout,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    return Promise.reject(new Error('the passphrase is read from a terminal only, where it isn\'t shown'))
  }
  return new Promise((resolve, reject) => {
    let typed = ''
    const end = (err?: Error) => {
      input.off('data', onData)
      input.setRawMode!(false)
      input.pause()
      output.write('\n')
      if (err === undefined) resolve(typed)
      else reject(err)
    }
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString()) {
        if (char === '\r' || char === '\n') return end()
        if (char === '\u0003') return end(new Error('stopped'))
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
        else typed += char
      }
    }
    output.write(prompt)
    input.setRawMode!(true)
    input.on('data', onData)
    input.resume()
  })
}

// A line read from the terminal as typed
function askLine(prompt: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(prompt)
    process.stdin.once('data', chunk => {
      process.stdin.pause()
      resolve(chunk.toString())
    })
    process.stdin.resume()
  })
}

// gh as installed, its output kept whole
const gh: Gh = args => new Promise((resolve, reject) => {
  const child = spawn('gh', [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (piece: Buffer) => { stdout += piece.toString('utf8') })
  child.stderr.on('data', (piece: Buffer) => { stderr += piece.toString('utf8') })
  child.on('error', reject)
  child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
})

if (import.meta.main) {
  try {
    const { version, keyPath } = readArgs(process.argv.slice(2))
    await signRelease({ version, keyPath, gh, askPassphrase: prompt => askHidden(prompt), confirm: askLine })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
