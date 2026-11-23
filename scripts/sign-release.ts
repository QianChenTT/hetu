// Signs a draft release's update file with the publisher's key and publishes the draft as the latest full release, the
// one step that makes a release hetu's updater can see. Run by hand on the machine that holds the key:
// `npm run sign-release -- <version> [--key <file>]`. The passphrase is read from the terminal and never shown
import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Fetch } from '../core/backend/lib/github.ts'
import { checkLatest, compareVersions, OWNER, REPO, SIGNATURE_FILE_NAME, UPDATE_FILE_NAME, updateKey, versionParts, type Checked } from '../core/backend/updater/check.ts'
import { updateFileFor } from '../core/build/update-file.ts'

const REPOSITORY = `${OWNER}/${REPO}`
// The workflow and the ref that may have built what is signed, as gh attestation verify checks them
const RELEASE_WORKFLOW = `${REPOSITORY}/.github/workflows/release.yml`
const RELEASE_SOURCE_REF = 'refs/heads/main'
const SUMS = 'SHA256SUMS'

export type GhAnswer = { code: number, stdout: string, stderr: string }
export type Gh = (args: readonly string[]) => Promise<GhAnswer>

export type SignOptions = {
  version: string
  keyPath: string
  gh: Gh
  // Asks for the key's passphrase without showing it
  askPassphrase(prompt: string): Promise<string>
  // Asks for the version typed again, the go-ahead before anything reaches GitHub
  askTyped(prompt: string): Promise<string>
  // The key hetu checks the signature with, the one inside hetu unless a test hands its own
  publicKey?: KeyObject
  log?(line: string): void
  // Waits between two reads of GitHub's latest release after publishing
  wait?(ms: number): Promise<void>
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
async function ghOrThrow(gh: Gh, args: readonly string[]): Promise<string> {
  const answer = await gh(args)
  if (answer.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${answer.stderr.trim() || answer.stdout.trim()}`)
  return answer.stdout
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

type Draft = { isDraft: boolean, targetCommitish: string, assets: { name: string, digest?: string | null }[] }

const viewDraft = async (gh: Gh, tag: string): Promise<Draft> =>
  JSON.parse(await ghOrThrow(gh, ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'isDraft,targetCommitish,assets'])) as Draft

// The draft holds exactly these files, each with the sha256 GitHub records for it. Anything added, missing or changed
// since the files were checked refuses
function checkAssets(draft: Draft, tag: string, expected: Readonly<Record<string, string>>): void {
  if (!draft.isDraft) throw new Error(`${tag} is not a draft, so it is published already or was never made by the Release workflow`)
  const names = draft.assets.map(asset => asset.name).sort()
  if (names.join('\n') !== Object.keys(expected).sort().join('\n')) {
    throw new Error(`the draft ${tag} holds ${names.join(', ')}, not ${Object.keys(expected).sort().join(', ')}`)
  }
  for (const asset of draft.assets) {
    if (asset.digest !== `sha256:${expected[asset.name]}`) throw new Error(`the draft's ${asset.name} has sha256 ${asset.digest ?? 'none'}, not the ${expected[asset.name]} checked`)
  }
}

// GitHub's latest full release, null before the first. Any answer but a found one or a 404 throws
async function latestTag(gh: Gh): Promise<string | null> {
  const answer = await gh(['api', `repos/${REPOSITORY}/releases/latest`, '--jq', '.tag_name'])
  if (answer.code === 0) return answer.stdout.trim()
  if (/HTTP 404/.test(answer.stderr)) return null
  throw new Error(`gh api failed: ${answer.stderr.trim()}`)
}

// The update file against the setup it names, both as downloaded. A field that doesn't match is named
async function checkUpdateFile(bytes: Buffer, setup: string, version: string): Promise<void> {
  let written: Record<string, unknown>
  try {
    written = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error(`${UPDATE_FILE_NAME} isn't JSON`)
  }
  const built = typeof written.built === 'string' ? new Date(written.built) : null
  if (built === null || Number.isNaN(built.getTime()) || built.toISOString() !== written.built) {
    throw new Error(`${UPDATE_FILE_NAME}'s built isn't a time in UTC as toISOString writes it`)
  }
  const expected = await updateFileFor(setup, version, built)
  for (const field of ['version', 'file', 'size', 'sha256'] as const) {
    if (written[field] !== expected[field]) throw new Error(`${UPDATE_FILE_NAME}'s ${field} is ${String(written[field])}, the setup downloaded has ${expected[field]}`)
  }
}

// The check hetu's updater makes, run on the local bytes: GitHub's latest release as holding the update file and this
// signature
async function updaterCheck(bytes: Buffer, signature: Buffer, version: string, key: KeyObject): Promise<Checked> {
  const download = (name: string) => `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`
  const files: Record<string, Buffer> = { [UPDATE_FILE_NAME]: bytes, [SIGNATURE_FILE_NAME]: signature }
  const fetch: Fetch = async url => {
    if (url === `https://api.github.com/repos/${REPOSITORY}/releases/latest`) {
      return Response.json({ tag_name: `v${version}`, assets: Object.keys(files).map(name => ({ name, size: files[name]!.length, state: 'uploaded', browser_download_url: download(name) })) })
    }
    const name = Object.keys(files).find(file => download(file) === url)
    return name === undefined ? new Response('', { status: 404 }) : new Response(new Uint8Array(files[name]!))
  }
  return checkLatest({ running: [0, 0, 0], key, fetch })
}

// Why the updater wouldn't offer this version, null when it would
function notOffered(checked: Checked, version: string): string | null {
  if (checked.outcome === 'found') return checked.update.version === version ? null : `it would offer ${checked.update.version}, not ${version}`
  if (checked.outcome === 'refused' && checked.reason === 'signature') return 'the signature doesn\'t check against the key inside hetu, so this key isn\'t the one hetu trusts'
  if (checked.outcome === 'refused') return `it refuses the update file: ${checked.reason}`
  if (checked.outcome === 'failed') return `its check failed: ${checked.problem}`
  return `it sees ${checked.update.version} as current`
}

export async function signRelease(options: SignOptions): Promise<void> {
  const { version, gh } = options
  const log = options.log ?? (line => console.log(line))
  const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const parts = versionParts(version)
  if (parts === null) throw new Error(`the version ${version} isn't x.y.z`)
  const pem = await readFile(options.keyPath)
  const tag = `v${version}`
  const setupName = `hetu-setup-${version}-x64.exe`
  const draft = await viewDraft(gh, tag)
  if (!draft.isDraft) throw new Error(`${tag} is not a draft, so it is published already or was never made by the Release workflow`)
  for (const name of [setupName, UPDATE_FILE_NAME, SUMS]) {
    if (!draft.assets.some(asset => asset.name === name)) throw new Error(`the draft ${tag} holds no ${name}`)
  }
  // Published only above the latest full release, so no install already on it is offered less
  const latest = await latestTag(gh)
  const latestParts = latest === null ? null : versionParts(latest.replace(/^v/, ''))
  if (latest !== null && (latestParts === null || compareVersions(parts, latestParts) <= 0)) {
    throw new Error(`${tag} isn't higher than the latest release ${latest}`)
  }
  const work = await mkdtemp(path.join(tmpdir(), 'hetu-sign-release-'))
  try {
    await ghOrThrow(gh, ['release', 'download', tag, '--repo', REPOSITORY, '--dir', work, '--pattern', setupName, '--pattern', UPDATE_FILE_NAME, '--pattern', SUMS])
    const setup = path.join(work, setupName)
    const updateFile = path.join(work, UPDATE_FILE_NAME)
    const bytes = await readFile(updateFile)
    const hashes: Record<string, string> = { [setupName]: sha256(await readFile(setup)), [UPDATE_FILE_NAME]: sha256(bytes), [SUMS]: sha256(await readFile(path.join(work, SUMS))) }
    // A signature an earlier run uploaded is replaced below
    checkAssets({ ...draft, assets: draft.assets.filter(asset => asset.name !== SIGNATURE_FILE_NAME) }, tag, hashes)
    // Built by the Release workflow on main, each file as downloaded
    for (const file of [setup, updateFile]) {
      await ghOrThrow(gh, ['attestation', 'verify', file, '--repo', REPOSITORY, '--signer-workflow', RELEASE_WORKFLOW, '--source-ref', RELEASE_SOURCE_REF, '--deny-self-hosted-runners'])
      log(`${path.basename(file)}: built by ${RELEASE_WORKFLOW} on ${RELEASE_SOURCE_REF}`)
    }
    await checkUpdateFile(bytes, setup, version)
    const sums = await readFile(path.join(work, SUMS), 'utf8')
    if (sums !== `${hashes[setupName]}  ${setupName}\n${hashes[UPDATE_FILE_NAME]}  ${UPDATE_FILE_NAME}\n`) throw new Error(`${SUMS} doesn't hold exactly the two files checked`)
    log(`${UPDATE_FILE_NAME} and ${SUMS} match ${setupName}`)
    const passphrase = await options.askPassphrase(`Passphrase for ${options.keyPath}: `)
    let key: KeyObject
    try {
      key = createPrivateKey({ key: pem, format: 'pem', passphrase })
    } catch (err) {
      throw new Error(`the passphrase doesn't open ${options.keyPath} or the file isn't a key: ${(err as Error).message}`)
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${options.keyPath} isn't an Ed25519 key`)
    const signature = sign(null, bytes, key)
    const refusal = notOffered(await updaterCheck(bytes, signature, version, options.publicKey ?? updateKey()), version)
    if (refusal !== null) throw new Error(`hetu's updater wouldn't offer ${tag}: ${refusal}`)
    log(`${UPDATE_FILE_NAME} signed and hetu's updater would offer ${tag}`)
    const typed = await options.askTyped(`Publish hetu ${version}, built from ${draft.targetCommitish}, as the latest release after ${latest ?? 'none'}? Type ${version} to publish: `)
    if (typed.trim() !== version) throw new Error('not confirmed, nothing was uploaded or published')
    const signatureFile = path.join(work, SIGNATURE_FILE_NAME)
    await writeFile(signatureFile, signature)
    await ghOrThrow(gh, ['release', 'upload', tag, signatureFile, '--repo', REPOSITORY, '--clobber'])
    // The draft once more, right before it goes out: the files checked and the signature made, nothing else
    checkAssets(await viewDraft(gh, tag), tag, { ...hashes, [SIGNATURE_FILE_NAME]: sha256(signature) })
    await ghOrThrow(gh, ['release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--prerelease=false', '--latest'])
    // GitHub can take a moment to name a newly published release its latest
    let now = await latestTag(gh)
    for (let tries = 1; now !== tag && tries < 5; tries++) {
      await wait(2000)
      now = await latestTag(gh)
    }
    if (now !== tag) throw new Error(`${tag} is published, but GitHub's latest release is ${now ?? 'none'}`)
    log(`${tag} is published as the latest release`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// One line read from a terminal in raw mode, nothing of it shown. Enter ends it, Backspace takes a character off,
// Ctrl+C stops and a key that sends an escape sequence, such as an arrow, is dropped
export function askHidden(
  prompt: string,
  input: NodeJS.ReadableStream & { isTTY?: boolean, setRawMode?(on: boolean): unknown } = process.stdin,
  output: { write(text: string): unknown } = process.stdout,
): Promise<string> {
  if (input.isTTY !== true || input.setRawMode === undefined) {
    return Promise.reject(new Error('the passphrase is read from a terminal only, where it isn\'t shown. Run it from Windows Terminal or PowerShell, or as winpty node scripts/sign-release.ts <version> in a Git Bash mintty window'))
  }
  return new Promise((resolve, reject) => {
    let typed = ''
    const decoder = new StringDecoder('utf8')
    const end = (err?: Error) => {
      input.off('data', onData)
      input.setRawMode!(false)
      input.pause()
      output.write('\n')
      if (err === undefined) resolve(typed)
      else reject(err)
    }
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (text.startsWith('\u001b')) return
      for (const char of text) {
        if (char === '\r' || char === '\n') return end()
        if (char === '\u0003') return end(new Error('stopped'))
        if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1)
        else if (char >= ' ') typed += char
      }
    }
    output.write(prompt)
    input.setRawMode!(true)
    input.on('data', onData)
    input.resume()
  })
}

// A line read from the terminal as typed, shown
function askVisible(prompt: string): Promise<string> {
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
    await signRelease({ version, keyPath, gh, askPassphrase: prompt => askHidden(prompt), askTyped: askVisible })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
