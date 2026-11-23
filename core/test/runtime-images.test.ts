import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { providerActions } from '../api/actions.ts'
import type { Caller } from '../api/envelope.ts'
import { readBytes } from '../backend/providers/luoshu/bytes.ts'
import { createLuoshu, type Luoshu } from '../backend/providers/luoshu/luoshu.ts'
import { sniffed, ViewImages } from '../backend/runtime/images.ts'
import { serve } from '../backend/runtime/sessions.ts'
import { frameCsp, IMAGE_CSP } from '../backend/runtime/views.ts'
import { cleanup, code, editor, harness, trusted, worker } from './router-fakes.ts'

// A real 1x1 png, then the first bytes of each other type
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ab4f5e0b0000000049454e44ae426082', 'hex')
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
const SVG = '<?xml version="1.0"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>'
const bmp = () => {
  const bytes = Buffer.alloc(58)
  bytes.write('BM', 0, 'latin1')
  bytes.writeUInt32LE(40, 14)
  return bytes
}

let base: string
let folder: string
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-images-')))
  folder = path.join(base, 'notes')
  for (const dir of ['notes/pics', 'notes/.obsidian', 'notes/Secret', 'outside', 'data', 'install']) await mkdir(path.join(base, dir), { recursive: true })
  await writeFile(path.join(folder, 'pics', 'dot.png'), PNG)
  await writeFile(path.join(folder, 'pics', 'photo.jpg'), JPEG)
  await writeFile(path.join(folder, 'pics', 'drawn.svg'), SVG)
  await writeFile(path.join(folder, 'pics', 'old.bmp'), bmp())
  // A png renamed to look like a jpeg, a note renamed to look like a png and a png named as text
  await writeFile(path.join(folder, 'pics', 'wrong.jpg'), PNG)
  await writeFile(path.join(folder, 'pics', 'note.png'), 'just a note, no image')
  await writeFile(path.join(folder, 'pics', 'dot.txt'), PNG)
  await writeFile(path.join(folder, '.obsidian', 'hidden.png'), PNG)
  await writeFile(path.join(folder, 'Secret', 'a.png'), PNG)
  await writeFile(path.join(base, 'outside', 'far.png'), PNG)
  // Junctions with no dot in their names, into a dot folder and out of the notes folder
  await symlink(path.join(folder, '.obsidian'), path.join(folder, 'cfg'), 'junction')
  await symlink(path.join(base, 'outside'), path.join(folder, 'out'), 'junction')
})

afterEach(async () => {
  for (const made of live.splice(0)) made.close()
  cleanup()
  await rm(base, { recursive: true, force: true })
})

function luoshu(readCap?: number): Luoshu {
  const made = createLuoshu(readCap === undefined ? {} : { readCap })
  live.push(made)
  made.role.open({ folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install'), trash: async () => {} })
  return made
}

// The images host on the real luoshu and the real router, whose fake gate holds the grants a test names. board runs
// as incarnation 1 until a test says otherwise
function host(options: { readCap?: number, now?: () => number } = {}) {
  const made = luoshu(options.readCap)
  const routed = harness()
  routed.gate.grants.board = [{ type: 'luoshu.read', paths: ['pics/**', 'cfg/**', 'out/**', 'SECRET/**'] }]
  const running = new Map([['board', 1]])
  let n = 0
  const images = new ViewImages({
    running: plugin => running.get(plugin) ?? null,
    reads: (caller, at) => routed.router.reads(caller, at),
    read: async (caller, at, reads) => (await readBytes(made.provider, caller, at, reads))?.bytes ?? null,
    token: () => (++n).toString(16).padStart(32, '0'),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
  return { images, running, routed, made }
}

const bytesOf = (served: Awaited<ReturnType<ViewImages['serve']>>) => (served === null ? null : Buffer.from(served.bytes))

describe('the images host', () => {
  it('mints a single-use URL and serves the png once with its type and the image policy', async () => {
    const { images } = host()
    const url = images.mint(editor, 'board', 'pics/dot.png')
    expect(url).toBe(`hetu://images/${'1'.padStart(32, '0')}`)
    const served = await images.serve(url!)
    expect(bytesOf(served)).toEqual(PNG)
    expect(served).toMatchObject({ type: 'image/png', csp: IMAGE_CSP })
    expect(await images.serve(url!)).toBe(null)
  })

  it('serves each type as its first bytes say, only where the extension names that type', async () => {
    const { images } = host()
    const typeOf = async (at: string) => (await images.serve(images.mint(editor, 'board', at)!))?.type ?? null
    expect(await typeOf('pics/photo.jpg')).toBe('image/jpeg')
    expect(await typeOf('pics/drawn.svg')).toBe('image/svg+xml')
    expect(await typeOf('pics/old.bmp')).toBe('image/bmp')
    // A note renamed .png and a png renamed .jpg are refused by the sniff
    expect(await typeOf('pics/note.png')).toBe(null)
    expect(await typeOf('pics/wrong.jpg')).toBe(null)
    // A png named as text never gets a URL
    expect(images.mint(editor, 'board', 'pics/dot.txt')).toBe(null)
  })

  it('mints nothing for another window, a plugin not running, a path outside its read scope, a dot path or a note', () => {
    const { images } = host()
    expect(images.mint(trusted, 'board', 'pics/dot.png')).toBe(null)
    expect(images.mint(worker('board'), 'board', 'pics/dot.png')).toBe(null)
    expect(images.mint(editor, 'other', 'pics/dot.png')).toBe(null)
    expect(images.mint(editor, 'board', 'dot.png')).toBe(null)
    expect(images.mint(editor, 'board', '.obsidian/hidden.png')).toBe(null)
    expect(images.mint(editor, 'board', 'pics/../dot.png')).toBe(null)
    expect(images.mint(editor, 'board', 'pics/a.md')).toBe(null)
  })

  it('serves nothing once the grant is revoked after the draw', async () => {
    const { images, routed } = host()
    const url = images.mint(editor, 'board', 'pics/dot.png')!
    routed.gate.grants.board = [{ type: 'luoshu.read', paths: ['notes/**'] }]
    expect(await images.serve(url)).toBe(null)
  })

  it('serves nothing once the plugin stopped, started again or was removed', async () => {
    const { images, running } = host()
    const stopped = images.mint(editor, 'board', 'pics/dot.png')!
    running.delete('board')
    expect(await images.serve(stopped)).toBe(null)
    running.set('board', 1)
    const again = images.mint(editor, 'board', 'pics/dot.png')!
    running.set('board', 2)
    expect(await images.serve(again)).toBe(null)
  })

  it('serves nothing when the plugin stops while its note is read', async () => {
    const made = luoshu()
    const running = new Map([['board', 1]])
    const images = new ViewImages({
      running: plugin => running.get(plugin) ?? null,
      reads: () => true,
      read: async (caller, at, reads) => {
        const got = await readBytes(made.provider, caller, at, reads)
        running.delete('board')
        return got?.bytes ?? null
      },
    })
    expect(await images.serve(images.mint(editor, 'board', 'pics/dot.png')!)).toBe(null)
  })

  it('serves nothing after the editor page unloads or past ten seconds', async () => {
    let now = 1000
    const { images } = host({ now: () => now })
    const unloaded = images.mint(editor, 'board', 'pics/dot.png')!
    images.unloaded()
    expect(await images.serve(unloaded)).toBe(null)
    const late = images.mint(editor, 'board', 'pics/dot.png')!
    now += 10_001
    expect(await images.serve(late)).toBe(null)
    const onTime = images.mint(editor, 'board', 'pics/dot.png')!
    now += 10_000
    expect(bytesOf(await images.serve(onTime))).toEqual(PNG)
  })

  it('refuses a junction into a dot folder or out of the notes folder as the luoshu refuses it, whatever the grant', async () => {
    const { images } = host()
    expect(await images.serve(images.mint(editor, 'board', 'cfg/hidden.png')!)).toBe(null)
    expect(await images.serve(images.mint(editor, 'board', 'out/far.png')!)).toBe(null)
  })

  it.runIf(process.platform !== 'linux')('judges the path the disk spells, so another case of a folder outside the grant is refused', async () => {
    const { images, routed } = host()
    // SECRET/** is granted and the disk spells the folder Secret, which no grant names
    expect(await images.serve(images.mint(editor, 'board', 'SECRET/a.png')!)).toBe(null)
    routed.gate.grants.board = [{ type: 'luoshu.read', paths: ['SECRET/**', 'Secret/**'] }]
    expect(bytesOf(await images.serve(images.mint(editor, 'board', 'SECRET/a.png')!))).toEqual(PNG)
  })

  it('refuses an image past the luoshu\'s read cap', async () => {
    const capped = host({ readCap: PNG.length - 1 })
    expect(await capped.images.serve(capped.images.mint(editor, 'board', 'pics/dot.png')!)).toBe(null)
    const fits = host({ readCap: PNG.length })
    expect(bytesOf(await fits.images.serve(fits.images.mint(editor, 'board', 'pics/dot.png')!))).toEqual(PNG)
  })

  it('takes no URL but its own host and token, with nothing after it', async () => {
    const { images } = host()
    const url = images.mint(editor, 'board', 'pics/dot.png')!
    const token = url.slice('hetu://images/'.length)
    for (const other of [`${url}?x=1`, `${url}#x`, `${url}/x`, `hetu://views/${token}`, `hetu://user@images/${token}`, `hetu://images:8080/${token}`]) {
      expect(await images.serve(other)).toBe(null)
    }
    expect(bytesOf(await images.serve(url))).toEqual(PNG)
  })

  it('leaves no latch held, so a read after a refused one goes on', async () => {
    const { images, made } = host()
    expect(await images.serve(images.mint(editor, 'board', 'pics/note.png')!)).toBe(null)
    expect(await images.serve(images.mint(editor, 'board', 'out/far.png')!)).toBe(null)
    expect(made.calls()).toBe(0)
  })
})

describe('the image bytes read', () => {
  const plugin: Caller = { kind: 'plugin', id: 'board', half: 'worker', incarnation: 1 }

  it('asks reads about the path as spelled and the canonical one, and reads nothing when either is refused', async () => {
    const made = luoshu()
    const asked: string[] = []
    const got = await readBytes(made.provider, plugin, 'pics/dot.png', at => (asked.push(at), true))
    expect(got).toEqual({ bytes: PNG, path: 'pics/dot.png' })
    expect(asked).toEqual(['pics/dot.png', 'pics/dot.png'])
    expect(await readBytes(made.provider, plugin, 'pics/dot.png', () => false)).toBe(null)
    let first = true
    expect(await readBytes(made.provider, plugin, 'pics/dot.png', () => (first ? (first = false, true) : false))).toBe(null)
    expect(made.calls()).toBe(0)
  })

  it('reads nothing with the luoshu off', async () => {
    expect(await readBytes(null, plugin, 'pics/dot.png', () => true)).toBe(null)
  })

  it('is an action no plugin can call, since the router routes none core/api leaves out', async () => {
    expect(Object.hasOwn(providerActions, 'luoshu.bytes')).toBe(false)
    const { connect, gate, luoshu: fake } = harness()
    gate.grants.board = [{ type: 'luoshu.read', paths: ['**'] }]
    const board = connect(worker('board'))
    expect(code(await board.ask('luoshu.bytes', { path: 'pics/dot.png' }))).not.toBe(null)
    expect(fake.prepared).toEqual([])
  })
})

describe('the router\'s reads', () => {
  const board = worker('board')

  it('answers the gate\'s canRead while it is on, yes with it off by the human and no when it is down or shutting down', () => {
    const { router, gate, pluginsManager } = harness()
    gate.grants.board = [{ type: 'luoshu.read', paths: ['pics/**'] }]
    expect(router.reads(board, 'pics/a.png')).toBe(true)
    expect(router.reads(board, 'b.png')).toBe(false)
    pluginsManager.policyJobs.gate = 'off'
    expect(router.reads(board, 'b.png')).toBe(true)
    pluginsManager.policyJobs.gate = 'failed'
    expect(router.reads(board, 'pics/a.png')).toBe(false)
    pluginsManager.policyJobs.gate = 'on'
    gate.readable = () => {
      throw new Error('down')
    }
    expect(router.reads(board, 'pics/a.png')).toBe(false)
    gate.readable = null
    router.stopping()
    expect(router.reads(board, 'pics/a.png')).toBe(false)
  })
})

describe('the sniff', () => {
  it.each([
    ['png', PNG, 'image/png'],
    ['jpeg', JPEG, 'image/jpeg'],
    ['gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/gif'],
    ['webp', Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1'), 'image/webp'],
    ['avif', Buffer.from('\x00\x00\x00\x1cftypavif\x00\x00\x00\x00', 'latin1'), 'image/avif'],
    ['bmp', bmp(), 'image/bmp'],
    ['svg', Buffer.from(SVG), 'image/svg+xml'],
    ['svg with a byte order mark and a doctype', Buffer.from('﻿<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>'), 'image/svg+xml'],
    ['text', Buffer.from('hello'), null],
    ['text that starts BM', Buffer.from('BMW notes from the garage, nothing more than that here'), null],
    ['html', Buffer.from('<html><svg></svg></html>'), null],
    ['an svg past its first 4 KiB', Buffer.from(`<!--${'x'.repeat(5000)}-->\n<svg/>`), null],
    ['nothing', Buffer.alloc(0), null],
  ])('reads %s', (_name, bytes, type) => {
    expect(sniffed(bytes)).toBe(type)
  })
})

describe('the images host on the editor session', () => {
  const root = path.join(tmpdir(), 'hetu-no-pages')
  const get = (url: string) => ({ url, method: 'GET' })

  it('answers an svg with its type, nosniff, no-store and a policy under which it runs and loads nothing', async () => {
    const { images } = host()
    const answered = await serve('editor', get(images.mint(editor, 'board', 'pics/drawn.svg')!), root, undefined, images)
    expect(answered.status).toBe(200)
    expect(answered.headers.get('content-type')).toBe('image/svg+xml')
    expect(answered.headers.get('x-content-type-options')).toBe('nosniff')
    expect(answered.headers.get('cache-control')).toBe('no-store')
    expect(answered.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    expect(Buffer.from(await answered.arrayBuffer()).toString()).toBe(SVG)
  })

  it('answers 404 for a token refused and never serves the host to the trusted window or the workers', async () => {
    const { images } = host()
    const url = images.mint(editor, 'board', 'pics/dot.png')!
    expect((await serve('trusted', get(url), root, undefined, images)).status).toBe(404)
    expect((await serve('workers', get(url), root, undefined, images)).status).toBe(404)
    // Neither took the token, which the editor page still loads once
    expect((await serve('editor', get(url), root, undefined, images)).status).toBe(200)
    expect((await serve('editor', get(url), root, undefined, images)).status).toBe(404)
  })

  it('gives a view frame a policy that names no images host, so a frame loads no image from it', () => {
    const policy = frameCsp('0'.repeat(32))
    expect(policy).not.toContain('hetu://images')
    expect(policy).toContain(`img-src hetu://views/${'0'.repeat(32)}/;`)
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("default-src 'none'")
  })
})
