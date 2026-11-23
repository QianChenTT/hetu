import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { FoundRelease, InstallProblem, StagedProblem, StagedSource } from '../../api/actions.ts'
import { MAX_STAGED_PLUGINS } from '../../api/changes.ts'
import { isReservedId } from '../../api/ids.ts'
import type { FolderManifest } from '../../api/manifest.ts'
import { clear, folders } from './folders.ts'
import { findPlugins, type Found } from './find.ts'
import type { Made, StagedRead, Staging, Stagings } from './header.ts'
import { downloadZip, releaseZips, zipLimits, type FetchOptions, type ReleaseZip } from './release.ts'
import { stageFolder, unpackLimits, unpackZip, type UnpackLimits, type UnpackProblem } from './unpack.ts'
import { MANIFEST_FILE, readPlugin, type Read } from './verify.ts'

// The Install button's stagings in main: each in a folder of its own under the data folder's staging, filled from a
// zip or a folder main's own dialog picked or from a release zip main downloaded, then read as the plugins manager
// reads a plugin folder. Nothing a window sends names a path or a download link

// The most stagings held at once, the one being made among them, the oldest dropped for a new one. Each holds up to the
// unpack cap on disk
export const MAX_STAGINGS = 4

// A staging as main keeps it: its folder, what the window is shown and each plugin's folder with the hash of the bytes
// read when it was staged
type Kept = { dir: string, staging: Staging, plugins: ReadonlyMap<string, { folder: string, hash: string }> }

// The latest release found: its handle, the link as pasted, its tag and its zips in the order the window was answered
type Release = { handle: string, link: string, tag: string, zips: readonly ReleaseZip[] }

export type StagingsOptions = { dataDir: string, fetch?: FetchOptions['fetch'], limits?: UnpackLimits }

// Why one plugin found can't be installed, from the read: a manifest that doesn't parse, files gone or a manifest
// changed between find's two reads read as invalid. A plugin that can be read but takes an id hetu keeps is reserved
function problemOf(read: Read, id: string): StagedProblem | null {
  if (read.problem === 'install-only' || read.problem === 'api') return read.problem
  if (read.problem !== null) return 'invalid'
  return isReservedId(id) ? 'reserved' : null
}

// The SHA-256 of the manifest's bytes as staged, of no bytes when there is none
function digestOf(read: Read): string {
  const manifest = read.files.find(file => file.path === MANIFEST_FILE)
  return createHash('sha256').update(manifest?.bytes ?? Buffer.alloc(0)).digest('hex')
}

// O_NOFOLLOW where the platform has one, so a zip swapped for a link after the dialog isn't read through the link
const READ_ONLY = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

// A picked zip's bytes, read once up to the cap a release zip has. One that isn't a plain file, a link among them, can't
// be read or is past the cap is refused
async function zipBytes(file: string, cap: number): Promise<Buffer | UnpackProblem> {
  let handle
  try {
    // A link is refused before it is opened, where the platform has no O_NOFOLLOW
    if (!(await lstat(file)).isFile()) return 'invalid'
    handle = await open(file, READ_ONLY)
  } catch {
    return 'invalid'
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return 'invalid'
    if (stat.size > cap) return 'too-big'
    const bytes = await handle.readFile()
    return bytes.length > cap ? 'too-big' : bytes
  } catch {
    return 'invalid'
  } finally {
    await handle.close()
  }
}

export class InstallStagings implements Stagings {
  readonly #root: string
  readonly #fetch: FetchOptions['fetch']
  readonly #limits: UnpackLimits
  readonly #kept = new Map<string, Kept>()
  readonly #downloads = new Set<AbortController>()
  // A run before may have left stagings behind, which go before the first is made
  readonly #swept: Promise<void>
  #release: Release | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(options: StagingsOptions) {
    this.#root = folders.installs(options.dataDir)
    this.#fetch = options.fetch
    this.#limits = options.limits ?? unpackLimits
    // A folder that can't be cleared now holds stagings no handle names, which nothing reads
    this.#swept = clear(this.#root).catch(() => {})
  }

  held(handle: string): Staging | null {
    return this.#kept.get(handle)?.staging ?? null
  }

  async read(handle: string, id: string): Promise<Read | null> {
    const kept = this.#kept.get(handle)?.plugins.get(id)
    if (kept === undefined) return null
    const read = await readPlugin(kept.folder, id)
    return read.problem === null && read.hash === kept.hash ? read : null
  }

  // A zip or a folder main's dialog picked
  stagePicked(kind: 'zip' | 'folder', picked: string): Promise<Made> {
    return this.#inTurn(() => this.#picked(kind, picked))
  }

  async #picked(kind: 'zip' | 'folder', picked: string): Promise<Made> {
    const source: StagedSource = { kind, path: picked }
    if (kind === 'folder') return this.#make(source, async dir => (await stageFolder(picked, dir, this.#limits)).problem)
    const bytes = await zipBytes(picked, zipLimits.bytes)
    if (typeof bytes === 'string') return { problem: bytes }
    return this.#make(source, async dir => (await unpackZip(bytes, dir, this.#limits)).problem)
  }

  async findRelease(link: string): Promise<FoundRelease> {
    const release = await this.#fetching(signal => releaseZips(link, { fetch: this.#fetch, signal }))
    if (release.problem !== null) return { problem: release.problem }
    const handle = randomUUID()
    this.#release = { handle, link, tag: release.tag, zips: release.zips }
    return { release: handle, tag: release.tag, assets: release.zips.map(zip => ({ name: zip.name, bytes: zip.size })) }
  }

  stageRelease(handle: string, place: number): Promise<Made> {
    return this.#inTurn(() => this.#released(handle, place))
  }

  async #released(handle: string, place: number): Promise<Made> {
    const release = this.#release
    if (release === null || release.handle !== handle) throw { code: 'not-found' }
    if (!Number.isInteger(place) || place < 0 || place >= release.zips.length) throw { code: 'invalid' }
    const zip = release.zips[place]
    const downloaded = await this.#fetching(signal => downloadZip(zip, { fetch: this.#fetch, signal }))
    if (downloaded.problem !== null) return { problem: downloaded.problem }
    const source: StagedSource = { kind: 'link', link: release.link, asset: zip.name, tag: release.tag, verified: downloaded.verified }
    return this.#make(source, async dir => (await unpackZip(downloaded.bytes, dir, this.#limits)).problem)
  }

  unstage(handle: string): void {
    const kept = this.#kept.get(handle)
    if (kept === undefined) return
    this.#kept.delete(handle)
    // A folder that can't be cleared now goes at the next start's sweep. Nothing reads it meanwhile
    void clear(kept.dir).catch(() => {})
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#release = null
    for (const download of this.#downloads) download.abort()
    this.#kept.clear()
    await this.#swept
    // What can't be cleared now goes at the next start's sweep
    await clear(this.#root).catch(() => {})
  }

  // One staging made at a time, its download included, so no two hold the disk or the memory a staging takes at once
  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    // The caller gets run and its error, the turn only waits for it so one failed staging never blocks the next
    this.#queue = run.catch(() => {})
    return run
  }

  // A download stopped when the stagings close
  async #fetching<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw { code: 'stopped' }
    const controller = new AbortController()
    this.#downloads.add(controller)
    try {
      return await work(controller.signal)
    } finally {
      this.#downloads.delete(controller)
    }
  }

  // A new folder filled by fill, then the plugins in it found and read. Any refusal, failure or close on the way clears
  // the folder, so only a staging kept leaves anything on disk
  async #make(source: StagedSource, fill: (dir: string) => Promise<UnpackProblem | null>): Promise<Made> {
    await this.#swept
    if (this.#closed) throw { code: 'stopped' }
    const handle = randomUUID()
    const dir = path.join(this.#root, handle)
    // The staging being made counts toward the cap, so the oldest goes before it is written
    for (const old of [...this.#kept.keys()].slice(0, Math.max(0, this.#kept.size - MAX_STAGINGS + 1))) this.unstage(old)
    let kept = false
    try {
      await mkdir(dir, { recursive: true })
      const problem = await fill(dir)
      if (problem !== null) return { problem }
      const found = this.#found(dir, source, await findPlugins(dir))
      if ('problem' in found) return found
      if (this.#closed) throw { code: 'stopped' }
      this.#kept.set(handle, found)
      kept = true
      return { handle }
    } finally {
      // A folder no handle names is never read. The next start's sweep takes it
      if (!kept) await clear(dir).catch(() => {})
    }
  }

  // What was found as the window is answered. An unread manifest's plugin goes by its folder's name, or by the source's
  // when the folder is the staging itself. A name that meets another plugin's id is refused as same-id so no tick could
  // name two plugins
  #found(dir: string, source: StagedSource, finding: { problem: InstallProblem | null, plugins: Found[] }): Kept | { problem: InstallProblem } {
    if (finding.problem !== null) return { problem: finding.problem }
    if (finding.plugins.length === 0) return { problem: 'none' }
    if (finding.plugins.length > MAX_STAGED_PLUGINS) return { problem: 'too-many' }
    const named = source.kind === 'link' ? source.asset : path.basename(source.path)
    const plugins: StagedRead[] = []
    const places = new Map<string, { folder: string, hash: string }>()
    for (const { folder, read, id: readId } of finding.plugins) {
      const id = readId ?? (folder === dir ? named : path.basename(folder))
      const problem = problemOf(read, id)
      // A manifest only the install's schema takes is kept out, as is one that didn't parse
      const manifest = read.problem === 'install-only' ? null : read.manifest as FolderManifest | null
      plugins.push({ id, digest: digestOf(read), manifest, problem })
      if (problem === null && read.hash !== null) places.set(id, { folder, hash: read.hash })
    }
    if (new Set(plugins.map(plugin => plugin.id)).size < plugins.length) return { problem: 'same-id' }
    return { dir, staging: { source, plugins }, plugins: places }
  }
}
