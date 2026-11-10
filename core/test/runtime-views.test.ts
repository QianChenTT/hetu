import { describe, expect, it } from 'vitest'
import type { PluginFile } from '../lib/hash-files.ts'
import { frameCsp, ViewFiles } from '../backend/runtime/views.ts'

const file = (path: string, text: string): PluginFile => ({ path, bytes: Buffer.from(text) } as PluginFile)
const files = [
  file('hetu-plugin.json', '{}'),
  file('worker.js', 'w'),
  file('dist/board.html', '<script src="board.js"></script>'),
  file('dist/board.js', 'console.log(1)'),
  file('dist/board.css', 'p {}'),
  file('dist/other.html', '<p>other</p>'),
  file('dist/icon.svg', '<svg/>'),
  file('dist/icon.png', 'png'),
]

function made(): ViewFiles {
  let n = 0
  const views = new ViewFiles({ token: () => (++n).toString(16).padStart(32, '0') })
  views.started('kanban', 1, files, { board: 'dist/board.html' })
  return views
}

const text = (served: ReturnType<ViewFiles['serve']>) => (served === null ? null : Buffer.from(served.bytes).toString())

describe('the views host', () => {
  it('mints a single-use URL for a running plugin\'s frame and serves its entry page once', () => {
    const views = made()
    const url = views.mint('kanban', 'board')
    expect(url).toBe(`hetu://views/${'1'.padStart(32, '0')}/dist/board.html`)
    const page = views.serve(url!)
    expect(text(page)).toBe('<script src="board.js"></script>')
    expect(page?.type).toBe('text/html; charset=utf-8')
    expect(views.serve(url!)).toBe(null)
  })

  it('serves the plugin\'s other files under the token many times, never another html', () => {
    const views = made()
    const base = views.mint('kanban', 'board')!.replace(/dist\/board\.html$/, '')
    expect(text(views.serve(`${base}dist/board.js`))).toBe('console.log(1)')
    expect(text(views.serve(`${base}dist/board.js`))).toBe('console.log(1)')
    expect(views.serve(`${base}dist/board.css`)?.type).toBe('text/css; charset=utf-8')
    expect(views.serve(`${base}dist/other.html`)).toBe(null)
    expect(views.serve(`${base}dist/missing.js`)).toBe(null)
    expect(views.serve(`${base}../worker.js`)).toBe(null)
    expect(views.serve(`${base}dist%2fboard.js`)).toBe(null)
  })

  it('serves the bytes the plugin started with, whatever the disk holds now', () => {
    const views = made()
    const url = views.mint('kanban', 'board')!
    expect(text(views.serve(url))).toContain('board.js')
  })

  it('gives the frame a CSP naming only its token\'s path, no network, no frames and no forms, embedded only by the editor', () => {
    const views = made()
    const url = views.mint('kanban', 'board')!
    const token = url.split('/')[3]
    const csp = views.serve(url)!.csp
    expect(csp).toBe(frameCsp(token!))
    for (const part of [
      "default-src 'none'", `script-src hetu://views/${token}/`, `style-src hetu://views/${token}/`, `img-src hetu://views/${token}/`,
      `font-src hetu://views/${token}/`, "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
      'frame-ancestors hetu://editor',
    ]) expect(csp).toContain(part)
  })

  it('mints nothing for a frame the plugin lacks or a plugin not running', () => {
    const views = made()
    expect(views.mint('kanban', 'list')).toBe(null)
    expect(views.mint('other', 'board')).toBe(null)
  })

  it('stops serving every token of an incarnation that ended, and keeps a newer one', () => {
    const views = made()
    const url = views.mint('kanban', 'board')!
    views.ended('kanban', 1)
    expect(views.serve(url)).toBe(null)
    expect(views.mint('kanban', 'board')).toBe(null)
    views.started('kanban', 2, files, { board: 'dist/board.html' })
    views.ended('kanban', 1)
    expect(views.mint('kanban', 'board')).not.toBe(null)
  })

  it('revokes a token that is gone and every token when the editor page unloads', () => {
    const views = made()
    const one = views.mint('kanban', 'board')!
    expect(views.gone(one)).toEqual({ plugin: 'kanban' })
    expect(views.serve(one)).toBe(null)
    expect(views.gone(one)).toBe(null)
    const two = views.mint('kanban', 'board')!
    views.unloaded()
    expect(views.serve(two)).toBe(null)
  })

  it('serves a running plugin\'s icons as svg or png only', () => {
    const views = made()
    expect(views.serve('hetu://views/icon/kanban/dist/icon.svg')?.type).toBe('image/svg+xml')
    expect(views.serve('hetu://views/icon/kanban/dist/icon.png')?.type).toBe('image/png')
    expect(views.serve('hetu://views/icon/kanban/dist/board.js')).toBe(null)
    expect(views.serve('hetu://views/icon/kanban/dist/board.html')).toBe(null)
    expect(views.serve('hetu://views/icon/other/dist/icon.svg')).toBe(null)
    views.ended('kanban', 1)
    expect(views.serve('hetu://views/icon/kanban/dist/icon.svg')).toBe(null)
  })

  it('refuses a URL off the views host or with a user, a port or a query', () => {
    const views = made()
    const url = views.mint('kanban', 'board')!
    for (const other of [url.replace('views', 'editor'), url.replace('hetu://', 'hetu://u@'), url.replace('views/', 'views:1/'), `${url}?x=1`]) {
      expect(views.serve(other), other).toBe(null)
    }
  })
})
