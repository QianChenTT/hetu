import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { lstat, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { replaceFile } from '../../lib/hashed-file.ts'
import { FetchRefused, getFromGitHub, type Fetch, type Wanted } from '../lib/github.ts'
import type { QuietProblem, Spawn, UpdateFile } from './header.ts'

// The installer a check found, downloaded on the human's click into the updates folder once its size and sha256
// match the signed file, then started detached once hetu has quit, hashed again right before

// The installer runs silent and starts hetu again once it has replaced the files, as electron-builder's NSIS installer
// reads /S and --force-run
export const INSTALLER_ARGS: readonly string[] = Object.freeze(['/S', '--force-run'])

// The last installers kept as the way back, run by hand, the one just written among them
const KEPT = 2

// Thirty minutes take a 200 MiB installer at about 1 Mbit/s
const DOWNLOAD_MS = 1_800_000
const INSTALLER_WANTED: Wanted = Object.freeze({ accept: 'application/octet-stream' })

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

// What a download came to: the installer's path, a refusal by the signed size or sha256 with nothing written, or a
// quiet problem
export type Downloaded = { file: string } | { refused: 'size' | 'hash' } | { problem: QuietProblem }

// Deletes every installer in the folder but the one just written and the newest other, by when each was last written.
// Anything not named .exe stays, and so does an installer that can't be deleted now
async function keepLast(dir: string, newest: string): Promise<void> {
  const others: { name: string, at: number }[] = []
  for (const name of await readdir(dir)) {
    if (name === newest || !name.toLowerCase().endsWith('.exe')) continue
    const found = await lstat(path.join(dir, name)).catch(() => null)
    if (found?.isFile() === true) others.push({ name, at: found.mtimeMs })
  }
  others.sort((a, b) => b.at - a.at)
  // An installer held open stays until the next download deletes it, which costs only its room on disk
  for (const { name } of others.slice(KEPT - 1)) await rm(path.join(dir, name), { force: true }).catch(() => undefined)
}

// Downloads the installer at url, capped at the signed size, and writes it as the signed name into dir once its bytes
// match the signed size and sha256
export async function downloadInstaller(update: UpdateFile, url: string, dir: string, options: { fetch?: Fetch, signal?: AbortSignal }): Promise<Downloaded> {
  let bytes: Buffer
  try {
    bytes = await getFromGitHub(url, INSTALLER_WANTED, { bytes: update.size, ms: DOWNLOAD_MS }, options)
  } catch (err) {
    if (!(err instanceof FetchRefused)) throw err
    return err.problem === 'too-big' ? { refused: 'size' } : { problem: err.problem }
  }
  if (bytes.length !== update.size) return { refused: 'size' }
  if (sha256(bytes) !== update.sha256) return { refused: 'hash' }
  const file = path.join(dir, update.file)
  try {
    await mkdir(dir, { recursive: true })
    await replaceFile(file, bytes)
    await keepLast(dir, update.file)
  } catch {
    return { problem: 'disk' }
  }
  return { file }
}

// What the start came to: started, changed (gone, or no longer the signed size and sha256, deleted when it can be) or
// failed (the start threw)
export type Started = 'started' | 'changed' | 'failed'

// Hashes the installer again and starts it. Synchronous, for the moment between Quit and the exit
export function startInstaller(file: string, update: UpdateFile, start: Spawn): Started {
  let bytes: Buffer
  try {
    bytes = readFileSync(file)
  } catch {
    return 'changed'
  }
  if (bytes.length !== update.size || sha256(bytes) !== update.sha256) {
    try {
      rmSync(file, { force: true })
    } catch {
      // A file held open stays, and the next download over its name replaces it
    }
    return 'changed'
  }
  try {
    start(file, INSTALLER_ARGS)
    return 'started'
  } catch {
    return 'failed'
  }
}

// A program started on its own, never through a shell, outliving hetu. A start that fails later is let go
export const spawnDetached: Spawn = (file, args) => {
  const child = spawn(file, [...args], { detached: true, stdio: 'ignore' })
  child.on('error', () => undefined)
  child.unref()
}
