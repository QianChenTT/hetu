// Where a tier 0 run's build and plugins came from, read from what made them rather than from the tree at test time
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { unpackZip } from '../../backend/plugins-manager/unpack.ts'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 2 ** 20 })
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

// A tree's commit, whether it differs from it and a hash of how: the diff, the untracked files and their contents
export function treeState(dir: string): { commit: string, dirty: boolean, state: string } {
  const status = git(dir, 'status', '--porcelain')
  const untracked = git(dir, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(name => name !== '')
  const hash = createHash('sha256').update(git(dir, 'diff', 'HEAD', '--binary'))
  for (const name of untracked.sort()) hash.update(name).update(execFileSync('git', ['-C', dir, 'hash-object', '--', name], { encoding: 'utf8' }))
  return { commit: git(dir, 'rev-parse', 'HEAD').trim(), dirty: status !== '', state: hash.digest('hex') }
}

export type BuildStamp = { commit: string, dirty: boolean, state: string, locked: boolean, packedAt: string }
const STAMP = 'tier0-build.json'

// Written beside the packed folders right after packing, from the tree the pack read
export async function stampBuild(out: string, repo: string, locked = false): Promise<BuildStamp> {
  const stamp = { ...treeState(repo), locked, packedAt: new Date().toISOString() }
  await writeFile(path.join(out, STAMP), `${JSON.stringify(stamp, null, 2)}\n`)
  return stamp
}

export async function readBuildStamp(out: string): Promise<BuildStamp> {
  const text = await readFile(path.join(out, STAMP), 'utf8').catch(() => null)
  if (text === null) throw new Error(`${out} has no ${STAMP}, so what it was packed from is unknown: pack it with npm run tier0`)
  return JSON.parse(text) as BuildStamp
}

// A packed build is reused only for the tree it was packed from
export function checkReuse(stamp: BuildStamp, now: { commit: string, state: string }): void {
  if (stamp.commit !== now.commit || stamp.state !== now.state) {
    throw new Error(`the tree changed since it was packed (${stamp.commit.slice(0, 7)} to ${now.commit.slice(0, 7)}${stamp.state === now.state ? '' : ', its changes too'}): run npm run tier0 without --reuse`)
  }
}

// The folder electron-builder packed into, found as packageHetu finds it
export function drivenOutDir(out: string): string {
  const found = readdirSync(out).find(name => /-unpacked$|^mac/.test(name))
  if (found === undefined) throw new Error(`nothing packed in ${out}: run npm run tier0`)
  return path.join(out, found)
}

// The zip carries no commit of its own. It is tied to the checkout by three facts: its hash is the one pack wrote in
// SHA256SUMS beside it, every file in it is the checkout's built file of that name, and it is newer than every file
// the checkout tracks. A zip unlike its own sums is refused, the other two are recorded, consistent when all hold and
// the checkout is clean
export async function pluginsProvenance(dir: string, zip: string) {
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`${dir} is a link, and a plugin build through a link writes its source path into the zip: use a real checkout`)
  const bytes = await readFile(zip)
  const hash = sha256(bytes)
  const listed = await readFile(path.join(path.dirname(zip), 'SHA256SUMS'), 'utf8').catch(() => null)
  const line = listed?.split('\n').find(entry => entry.endsWith(`  ${path.basename(zip)}`))
  const sums = line === undefined ? 'missing' as const : 'matches' as const
  if (line !== undefined && !line.startsWith(`${hash}  `)) throw new Error(`${zip} is not the zip its SHA256SUMS names, so it was changed after it was packed`)

  const unpacked = await mkdtemp(path.join(os.tmpdir(), 'hetu-tier0-zip-'))
  let builtFiles: 'match' | 'differ' = 'match'
  try {
    const staged = await unpackZip(bytes, unpacked)
    if (staged.problem !== null) throw new Error(`${zip} didn't unpack: ${staged.problem}`)
    for (const name of await filesUnder(unpacked)) {
      const built = await readFile(path.join(dir, name)).catch(() => null)
      if (built === null || !built.equals(await readFile(path.join(unpacked, name)))) builtFiles = 'differ'
    }
  } finally {
    await rm(unpacked, { recursive: true, force: true })
  }
  const zipTime = (await stat(zip)).mtimeMs
  let newerThanTree = true
  for (const name of git(dir, 'ls-files', '-z').split('\0').filter(entry => entry !== '')) {
    const found = await stat(path.join(dir, name)).catch(() => null)
    if (found !== null && found.mtimeMs > zipTime) newerThanTree = false
  }
  const dirty = git(dir, 'status', '--porcelain') !== ''
  return {
    commit: git(dir, 'rev-parse', 'HEAD').trim(), dirty, zip, sha256: hash, sums, builtFiles, newerThanTree,
    consistent: sums === 'matches' && builtFiles === 'match' && newerThanTree && !dirty,
  }
}
export type PluginsProvenance = Awaited<ReturnType<typeof pluginsProvenance>>

export async function filesUnder(dir: string, under = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(path.join(dir, under), { withFileTypes: true })) {
    const name = under === '' ? entry.name : `${under}/${entry.name}`
    if (entry.isDirectory()) found.push(...await filesUnder(dir, name))
    else found.push(name)
  }
  return found.sort()
}

export const sha256Of = async (file: string) => sha256(await readFile(file))
