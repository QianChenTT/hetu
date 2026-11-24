import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { parseStrict } from '../../lib/hashed-file.ts'
import { FetchRefused, getFromGitHub, onGitHub, readRelease, releaseLimits, type Fetch, type FetchLimits, type ReleaseAnswer, type Wanted } from '../lib/github.ts'
import type { QuietProblem, RefusedReason, UpdateFile } from './header.ts'
import { UPDATE_KEY } from './key.ts'

// One look at hetu's latest full release: its update file and that file's signature fetched, the signature checked
// against the key inside hetu before a byte of the file is read, then the file's form and its version against the
// running one. Nothing here downloads the installer or shows anything

export const OWNER = 'QianChenTT'
export const REPO = 'hetu'
export const UPDATE_FILE_NAME = 'hetu-update.json'
export const SIGNATURE_FILE_NAME = 'hetu-update.json.sig'

// The page of the release a version names, built from the signed version and never from the API's answer
export const releasePage = (version: string) => `https://github.com/${OWNER}/${REPO}/releases/tag/v${version}`

// An update file is a few hundred bytes. An Ed25519 signature is 64 bytes, the bytes crypto.sign gives, unencoded. One
// of another length is let through to be refused as a bad signature, not dropped as a failed fetch
const KiB = 1024
export const updateFileLimits: FetchLimits = Object.freeze({ bytes: 64 * KiB, ms: 20_000 })
export const signatureLimits: FetchLimits = Object.freeze({ bytes: KiB, ms: 20_000 })

const ASSET_WANTED: Wanted = Object.freeze({ accept: 'application/octet-stream' })

// x.y.z, the form release.yml requires of package.json's version, each part kept within a safe integer
const VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/

// A version's three numbers, null for anything but x.y.z
export function versionParts(version: string): readonly [number, number, number] | null {
  const parts = VERSION.exec(version)
  return parts === null ? null : [Number(parts[1]), Number(parts[2]), Number(parts[3])]
}

// Below zero when a is lower than b, zero when equal and above zero when higher, part by part as numbers
export function compareVersions(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let at = 0; at < 3; at++) if (a[at] !== b[at]) return a[at] - b[at]
  return 0
}

const MiB = 1024 * KiB

// The file the publisher signs. A field it doesn't name is ignored, so a later field never strands an older hetu.
// The installer's name is one name with no folder in it, since it becomes a file in the updates folder
const updateFileSchema = z.object({
  version: z.string().regex(VERSION),
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.exe$/),
  size: z.number().int().positive().max(1024 * MiB),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  built: z.iso.datetime(),
})

// The key a check verifies with, made from the PEM inside hetu unless a test hands its own. Anything but an Ed25519
// public key throws
export function updateKey(pem: string = UPDATE_KEY): KeyObject {
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the update key is not an Ed25519 key')
  return key
}

// What a check came to. found carries the signed file and the installer's download link, null when the release holds
// no installer by the signed name or points it off GitHub's hosts. current: the signed version is the running one
export type Checked =
  | { outcome: 'found', update: UpdateFile, installer: string | null }
  | { outcome: 'current', update: UpdateFile }
  | { outcome: 'refused', reason: RefusedReason, version: string | null }
  | { outcome: 'failed', problem: QuietProblem }

export type CheckOptions = { running: readonly [number, number, number], key: KeyObject, fetch?: Fetch, signal?: AbortSignal }

// An asset uploaded whole under exactly this name, null for none
const assetNamed = (release: ReleaseAnswer, name: string) => release.assets.find(asset => asset.state === 'uploaded' && asset.name === name) ?? null

// Whether the signature is the key's over exactly these bytes. A signature of any other length never checks
const signedBy = (key: KeyObject, bytes: Buffer, signature: Buffer) => verify(null, bytes, key, signature)

async function look(options: CheckOptions): Promise<Checked> {
  const release = await readRelease(OWNER, REPO, null, releaseLimits, options)
  const file = assetNamed(release, UPDATE_FILE_NAME)
  if (file === null) return { outcome: 'failed', problem: 'no-update-file' }
  const signature = assetNamed(release, SIGNATURE_FILE_NAME)
  if (signature === null) return { outcome: 'refused', reason: 'signature', version: null }
  const bytes = await getFromGitHub(file.browser_download_url, ASSET_WANTED, updateFileLimits, options)
  const signed = await getFromGitHub(signature.browser_download_url, ASSET_WANTED, signatureLimits, options)
  if (!signedBy(options.key, bytes, signed)) return { outcome: 'refused', reason: 'signature', version: null }
  // Read only now, so nothing an unsigned file holds is ever parsed
  let update: UpdateFile
  try {
    update = parseStrict(bytes, updateFileSchema)
  } catch {
    return { outcome: 'refused', reason: 'format', version: null }
  }
  const order = compareVersions(versionParts(update.version)!, options.running)
  if (order < 0) return { outcome: 'refused', reason: 'version', version: update.version }
  if (order === 0) return { outcome: 'current', update }
  const installer = assetNamed(release, update.file)?.browser_download_url ?? null
  return { outcome: 'found', update, installer: installer !== null && onGitHub(installer) ? installer : null }
}

// Looks at the latest full release. A refusal from the network is quiet, anything else throws
export async function checkLatest(options: CheckOptions): Promise<Checked> {
  try {
    return await look(options)
  } catch (err) {
    if (err instanceof FetchRefused) return { outcome: 'failed', problem: err.problem }
    throw err
  }
}
