import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { UPDATE_FILE_NAME, versionParts } from '../backend/updater/check.ts'
import type { UpdateFile } from '../backend/updater/header.ts'

// The update file a release carries beside its setup, unsigned. The publisher signs these exact bytes later and hetu
// checks that signature before it reads a field

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// The fields for one built setup: its version, name, size and sha256 and when the file was made, in UTC
export async function updateFileFor(setup: string, version: string, released: Date): Promise<UpdateFile> {
  if (versionParts(version) === null) throw new Error(`the version ${version} isn't x.y.z`)
  const bytes = await readFile(setup)
  return { version, file: path.basename(setup), size: bytes.length, sha256: sha256(bytes), released: released.toISOString() }
}

export const updateFileText = (update: UpdateFile): string => `${JSON.stringify(update, null, 2)}\n`

// Beside a build's setup: the update file naming it and SHA256SUMS over both. Nothing for a build with no setup
export async function writeReleaseFiles(out: string, setups: readonly string[], version: string, released: Date): Promise<void> {
  if (setups.length === 0) return
  if (setups.length > 1) throw new Error(`expected one setup in ${out}, found ${setups.length}`)
  const update = path.join(out, UPDATE_FILE_NAME)
  await writeFile(update, updateFileText(await updateFileFor(setups[0]!, version, released)))
  const lines = await Promise.all([setups[0]!, update].map(async file => `${sha256(await readFile(file))}  ${path.basename(file)}`))
  await writeFile(path.join(out, 'SHA256SUMS'), `${lines.join('\n')}\n`)
}
