import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecurityList, Staged } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import type { Fetch } from '../backend/plugins-manager/github.ts'
import { InstallStagings, MAX_STAGINGS } from '../backend/plugins-manager/stagings.ts'
import { cleanup, filesFor, harness, tempBase, tick, until, workerManifest, writeFolder, type Files } from './plugins-manager-fakes.ts'
import { makeZip } from './zip-maker.ts'

afterEach(cleanup)

const trusted: Caller = { kind: 'window', role: 'trusted', n: 1 }
const notes = { type: 'luoshu.read', paths: ['notes/**'] }
const plugin = (id: string, extra: object = {}) => filesFor(workerManifest(id, extra))
const zipOf = (files: Files, prefix = '') => makeZip(Object.entries(files).map(([name, data]) => ({ name: prefix + name, data })))
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
// Waits for a check that reads the disk
async function settled(check: () => Promise<boolean>): Promise<void> {
  for (let waited = 0; !(await check()); waited += 10) {
    if (waited > 3000) throw new Error('nothing settled in time')
    await tick(10)
  }
}
const code = (work: Promise<unknown>) => work.then(() => 'none', (err: { code?: string }) => err.code ?? String(err))

// A data folder of its own and the stagings over it, with a fetch that answers from the test
async function made(fetch?: Fetch) {
  const base = await tempBase()
  const dataDir = path.join(base, 'data')
  await mkdir(dataDir, { recursive: true })
  const stagings = new InstallStagings({ dataDir, ...(fetch === undefined ? {} : { fetch }) })
  const installs = path.join(dataDir, 'staging', 'installs')
  const left = async () => readdir(installs).catch((): string[] => [])
  return { base, dataDir, stagings, installs, left }
}

// A folder the human picked, outside the data folder
async function picked(base: string, files: Files, name = 'picked'): Promise<string> {
  const dir = path.join(base, name)
  await writeFolder(dir, files)
  return dir
}

const handleOf = (made: { handle: string } | { problem: string }) => {
  if (!('handle' in made)) throw new Error(`refused ${made.problem}`)
  return made.handle
}

describe('a staging from a picked folder or zip', () => {
  it('copies a picked folder, reads each plugin with the digest of its manifest and keeps the bytes it read', async () => {
    const { base, stagings, left } = await made()
    const files = plugin('search', { capabilities: [notes] })
    const handle = handleOf(await stagings.stagePicked('folder', await picked(base, files)))
    const staging = stagings.held(handle)!
    expect(staging.source).toEqual({ kind: 'folder', path: path.join(base, 'picked') })
    expect(staging.plugins).toMatchObject([{ id: 'search', digest: sha256(files['hetu-plugin.json']), problem: null, manifest: { id: 'search', capabilities: [notes] } }])
    expect((await stagings.read(handle, 'search'))?.files.map(file => file.path)).toEqual(['hetu-plugin.json', 'worker.js'])
    expect(await left()).toEqual([handle])
  })

  it('unpacks a picked zip of several plugins, one folder each', async () => {
    const { base, stagings } = await made()
    const zip = path.join(base, 'plugins.zip')
    await writeFile(zip, makeZip([...Object.entries(plugin('alpha')).map(([name, data]) => ({ name: `alpha/${name}`, data })),
      ...Object.entries(plugin('tags')).map(([name, data]) => ({ name: `tags/${name}`, data }))]))
    const handle = handleOf(await stagings.stagePicked('zip', zip))
    expect(stagings.held(handle)!.plugins.map(one => [one.id, one.problem])).toEqual([['alpha', null], ['tags', null]])
    expect(stagings.held(handle)!.source).toEqual({ kind: 'zip', path: zip })
  })

  it('reads a plugin again only while its bytes hash to what was staged', async () => {
    const { base, stagings, installs } = await made()
    const handle = handleOf(await stagings.stagePicked('folder', await picked(base, plugin('search'))))
    await writeFile(path.join(installs, handle, 'worker.js'), 'changed after it was shown')
    expect(await stagings.read(handle, 'search')).toBeNull()
    expect(await stagings.read(handle, 'other')).toBeNull()
    expect(await stagings.read('gone', 'search')).toBeNull()
  })

  it('marks a plugin that can\'t install with why and refuses two plugins under one name', async () => {
    const { base, stagings } = await made()
    const handle = handleOf(await stagings.stagePicked('folder', await picked(base, {
      ...Object.fromEntries(Object.entries(plugin('hetu-own')).map(([name, data]) => [`a/${name}`, data])),
      'c/hetu-plugin.json': '{ not json',
    })))
    expect(stagings.held(handle)!.plugins.map(one => [one.id, one.problem, one.manifest === null])).toEqual([
      ['hetu-own', 'reserved', false], ['c', 'invalid', true],
    ])
    expect(await stagings.read(handle, 'hetu-own')).toBeNull()
    const clash = await stagings.stagePicked('folder', await picked(base, {
      ...Object.fromEntries(Object.entries(plugin('d')).map(([name, data]) => [`x/${name}`, data])),
      'd/hetu-plugin.json': '{ not json',
    }, 'clash'))
    expect(clash).toEqual({ problem: 'same-id' })
  })

  it('clears the staging on every refusal, leaving nothing on disk', async () => {
    const { base, stagings, left } = await made()
    expect(await stagings.stagePicked('folder', await picked(base, { 'readme.md': 'no plugin' }, 'empty'))).toEqual({ problem: 'none' })
    const device = path.join(base, 'device.zip')
    await writeFile(device, makeZip([{ name: 'a/hetu-plugin.json', data: '{}' }, { name: 'a/con', data: 'x' }]))
    expect(await stagings.stagePicked('zip', device)).toEqual({ problem: 'name' })
    const climbing = path.join(base, 'climbing.zip')
    await writeFile(climbing, makeZip([{ name: '../hetu-plugin.json', data: '{}' }]))
    expect(await stagings.stagePicked('zip', climbing)).toEqual({ problem: 'invalid' })
    expect(await stagings.stagePicked('zip', path.join(base, 'missing.zip'))).toEqual({ problem: 'invalid' })
    expect(await stagings.stagePicked('folder', path.join(base, 'missing'))).toEqual({ problem: 'not-a-folder' })
    expect(await left()).toEqual([])
  })

  it('drops the oldest staging past the cap and clears a staging unstaged', async () => {
    const { base, stagings, left } = await made()
    const source = await picked(base, plugin('search'))
    const handles: string[] = []
    for (let i = 0; i <= MAX_STAGINGS; i++) handles.push(handleOf(await stagings.stagePicked('folder', source)))
    expect(stagings.held(handles[0])).toBeNull()
    await settled(async () => !(await left()).includes(handles[0]))
    stagings.unstage(handles[1])
    expect(stagings.held(handles[1])).toBeNull()
    await settled(async () => (await left()).length === MAX_STAGINGS - 1)
  })

  it('sweeps what a run before left and clears every staging at close, staging nothing after', async () => {
    const { base, dataDir, installs, left } = await made()
    await mkdir(path.join(installs, 'left-by-a-crash'), { recursive: true })
    const stagings = new InstallStagings({ dataDir })
    const handle = handleOf(await stagings.stagePicked('folder', await picked(base, plugin('search'))))
    expect(await left()).toEqual([handle])
    await stagings.close()
    expect(await left()).toEqual([])
    expect(stagings.held(handle)).toBeNull()
    expect(await code(stagings.stagePicked('folder', await picked(base, plugin('search'), 'again')))).toBe('stopped')
  })
})

// GitHub answered from the test: the release's JSON from the API and each zip's bytes from its download link
function github(zips: Record<string, Buffer>, digests: Record<string, string | null> = {}) {
  const asked: string[] = []
  const download = (name: string) => `https://github.com/o/r/releases/download/v1/${name}`
  const fetch: Fetch = async url => {
    asked.push(url)
    if (url.startsWith('https://api.github.com/')) {
      const assets = Object.entries(zips).map(([name, bytes]) => ({
        name, size: bytes.length, state: 'uploaded', browser_download_url: download(name), digest: digests[name] === undefined ? `sha256:${sha256(bytes)}` : digests[name],
      }))
      return new Response(JSON.stringify({ tag_name: 'v1', assets }), { status: 200 })
    }
    const name = Object.keys(zips).find(one => url === download(one))
    return name === undefined ? new Response('', { status: 404 }) : new Response(new Uint8Array(zips[name]), { status: 200 })
  }
  return { fetch, asked }
}

describe('a staging from a release', () => {
  it('keeps the release\'s zips under a handle and stages one by its place, saying whether its checksum matched', async () => {
    const { fetch, asked } = github({ 'a.zip': zipOf(plugin('alpha')), 'b.zip': zipOf(plugin('tags')) }, { 'b.zip': null })
    const { stagings } = await made(fetch)
    const found = await stagings.findRelease('https://github.com/o/r')
    if (!('release' in found)) throw new Error('no release')
    expect(found).toMatchObject({ tag: 'v1', assets: [{ name: 'a.zip' }, { name: 'b.zip' }] })
    const a = handleOf(await stagings.stageRelease(found.release, 0))
    expect(stagings.held(a)!.source).toEqual({ kind: 'link', link: 'https://github.com/o/r', asset: 'a.zip', tag: 'v1', verified: true })
    const b = handleOf(await stagings.stageRelease(found.release, 1))
    expect(stagings.held(b)!.source).toMatchObject({ asset: 'b.zip', verified: false })
    expect(stagings.held(b)!.plugins.map(one => one.id)).toEqual(['tags'])
    expect(asked.filter(url => url.includes('/download/'))).toHaveLength(2)
  })

  it('refuses a place past the list, a handle it doesn\'t keep and one a newer release replaced, fetching nothing', async () => {
    const { fetch, asked } = github({ 'a.zip': zipOf(plugin('alpha')) })
    const { stagings } = await made(fetch)
    const first = await stagings.findRelease('https://github.com/o/r') as { release: string }
    expect(await code(stagings.stageRelease(first.release, 1))).toBe('invalid')
    expect(await code(stagings.stageRelease(first.release, -1))).toBe('invalid')
    expect(await code(stagings.stageRelease('made-up', 0))).toBe('not-found')
    const second = await stagings.findRelease('https://github.com/o/r') as { release: string }
    expect(await code(stagings.stageRelease(first.release, 0))).toBe('not-found')
    expect(asked.filter(url => url.includes('/download/'))).toEqual([])
    handleOf(await stagings.stageRelease(second.release, 0))
  })

  it('answers the download\'s problem and stages nothing when the bytes don\'t match the checksum', async () => {
    const { fetch } = github({ 'a.zip': zipOf(plugin('alpha')) }, { 'a.zip': `sha256:${'0'.repeat(64)}` })
    const { stagings, left } = await made(fetch)
    const found = await stagings.findRelease('https://github.com/o/r') as { release: string }
    expect(await stagings.stageRelease(found.release, 0)).toEqual({ problem: 'digest-mismatch' })
    expect(await stagings.findRelease('https://example.com/o/r')).toEqual({ problem: 'not-github' })
    expect(await left()).toEqual([])
  })

  it('stops a download under way when the stagings close', async () => {
    let started = false
    const fetch: Fetch = async (url, init) => {
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ tag_name: 'v1', assets: [{ name: 'a.zip', size: 10, state: 'uploaded', browser_download_url: 'https://github.com/o/r/releases/download/v1/a.zip' }] }), { status: 200 })
      }
      started = true
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    }
    const { stagings } = await made(fetch)
    const found = await stagings.findRelease('https://github.com/o/r') as { release: string }
    const staging = stagings.stageRelease(found.release, 0)
    await until(() => started)
    await stagings.close()
    expect(await staging).toEqual({ problem: 'cancelled' })
  })
})

// The stagings joined to the plugins manager as main joins them
async function joined(fetch?: Fetch) {
  const base = await tempBase()
  const stagings = new InstallStagings({ dataDir: path.join(base, 'data'), ...(fetch === undefined ? {} : { fetch }) })
  const pm = await harness({ base, pluginsManager: { stagings } })
  const serve = (action: string, args?: unknown) => pm.pluginsManager.serve({ callId: 'c1', caller: trusted, root: trusted, action, args, deadline: Date.now() + 30_000 })
  return { ...pm, stagings, serve }
}

describe('the install actions main serves', () => {
  it('answers a picked staging with each plugin\'s class as if installed alone, then installs it on the Confirm and starts it', async () => {
    const made = await joined()
    await made.pluginsManager.start()
    const staged = made.pluginsManager.stagedAnswer(await made.stagings.stagePicked('folder', await picked(made.base, plugin('search', { capabilities: [notes] }))))
    if (!('staged' in staged)) throw new Error('nothing staged')
    expect(staged.plugins).toMatchObject([{ id: 'search', name: 'search', version: '1.0.0', capabilities: [notes], class: 1, replaces: null, problem: null }])
    const answer = await made.pluginsManager.request({ kind: 'plugin.install', staged: staged.staged, plugins: [{ id: 'search', digest: staged.plugins[0].digest }] }, trusted)
    if (!('held' in answer)) throw new Error('applied at once')
    const [request] = (await made.serve('security.list') as SecurityList).requests
    expect(request.notes).toContain('search: Class 1, Reader')
    await made.pluginsManager.confirm(answer.held, {})
    expect((await made.store.load()).state.plugins.search).toMatchObject({ class: 1, granted: [notes] })
    await until(() => made.runtime.order().includes('search'))
    expect(made.stagings.held(staged.staged)).toBeNull()
  })

  it('serves a release by its handle and a zip by its place, refusing a place past the list', async () => {
    const { fetch } = github({ 'a.zip': zipOf(plugin('alpha')) })
    const made = await joined(fetch)
    await made.pluginsManager.start()
    const found = await made.serve('core.findRelease', { link: 'https://github.com/o/r' }) as { release: string }
    const staged = await made.serve('core.stage', { release: found.release, zip: 0 }) as Staged
    expect(staged).toMatchObject({ source: { kind: 'link', asset: 'a.zip', verified: true }, plugins: [{ id: 'alpha', class: 0 }] })
    expect(await code(made.serve('core.stage', { release: found.release, zip: 1 }))).toBe('invalid')
    if (!('staged' in staged)) throw new Error('nothing staged')
    await made.serve('core.unstage', { staged: staged.staged })
    expect(made.stagings.held(staged.staged)).toBeNull()
  })

  it('stages nothing until every plugin may start and closes the stagings at shutdown', async () => {
    const made = await joined()
    expect(await code(made.serve('core.findRelease', { link: 'https://github.com/o/r' }))).toBe('unavailable')
    await made.pluginsManager.start()
    const handle = handleOf(await made.stagings.stagePicked('folder', await picked(made.base, plugin('search'))))
    await made.pluginsManager.shutdown()
    expect(made.stagings.held(handle)).toBeNull()
    expect(await readdir(path.join(made.dataDir, 'staging', 'installs')).catch(() => [])).toEqual([])
  })

  it('answers unavailable with no stagings wired', async () => {
    const made = await harness()
    await made.pluginsManager.start()
    const serve = (action: string, args?: unknown) => made.pluginsManager.serve({ callId: 'c1', caller: trusted, root: trusted, action, args, deadline: Date.now() + 30_000 })
    expect(await code(serve('core.stage', { release: 'g1', zip: 0 }))).toBe('unavailable')
    expect(await code(serve('core.unstage', { staged: 'g1' }))).toBe('unavailable')
  })
})
