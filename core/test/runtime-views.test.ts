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

describe('the frames\' hosts', () => {
  it('mints a single-use URL for a running plugin\'s frame and serves its entry page once', () => {
    const views = made()
    const url = views.mint('kanban', 'board')
    expect(url).toBe(`hetu://kanban.views/${'1'.padStart(32, '0')}/dist/board.html`)
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
    expect(csp).toBe(frameCsp('kanban', token!))
    const own = `hetu://kanban.views/${token}/`
    for (const part of [
      "default-src 'none'", `script-src ${own}`, `style-src ${own}`, `img-src ${own}`, `font-src ${own}`, "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'",
      'frame-ancestors hetu://editor',
    ]) expect(csp).toContain(part)
  })

  it('serves a token only on its own plugin\'s host, never another plugin\'s or the bare views host', () => {
    const views = made()
    views.started('other', 1, files, { board: 'dist/board.html' })
    const url = views.mint('kanban', 'board')!
    const base = url.replace(/dist\/board\.html$/, '')
    for (const host of ['other.views', 'views', 'x.kanban.views']) {
      expect(views.serve(url.replace('kanban.views', host)), host).toBe(null)
      expect(views.serve(`${base.replace('kanban.views', host)}dist/board.js`), host).toBe(null)
      expect(views.gone(url.replace('kanban.views', host)), host).toBe(null)
    }
    // None of those took the token, which still loads once on its own host
    expect(text(views.serve(url))).toBe('<script src="board.js"></script>')
    expect(text(views.serve(`${base}dist/board.js`))).toBe('console.log(1)')
    expect(views.gone(url)).toEqual({ plugin: 'kanban' })
  })

  it('mints and serves on the host of a plugin id with an underscore, written --, or of 64 characters', () => {
    const views = made()
    for (const [id, label] of [['my_board', 'my--board'], [`p${'a'.repeat(62)}z`, `p${'a'.repeat(62)}z`], [`${'ab_'.repeat(21)}c`, `${'ab--'.repeat(21)}c`]]) {
      views.started(id!, 1, files, { board: 'dist/board.html' })
      const url = views.mint(id!, 'board')!
      expect(url.startsWith(`hetu://${label}.views/`), url).toBe(true)
      const token = url.split('/')[3]
      // A CSP host-source takes only letters, digits and dashes, so the frame's own policy names the same host
      expect(frameCsp(id!, token!)).toContain(`script-src hetu://${label}.views/${token}/;`)
      if (label !== id) expect(views.serve(url.replace(label!, id!))).toBe(null)
      expect(text(views.serve(url))).toBe('<script src="board.js"></script>')
    }
    // The id as it is, underscore and all, names no host
    const url = views.mint('my_board', 'board')!
    expect(views.serve(url.replace('my--board', 'my_board'))).toBe(null)
    expect(views.gone(url.replace('my--board', 'my_board'))).toBe(null)
    expect(views.gone(url)).toEqual({ plugin: 'my_board' })
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

  it('serves hetu-theme.css beside a frame\'s page from the theme it holds, under the frame\'s CSP, in place of a plugin\'s file of that name', () => {
    const views = new ViewFiles({ token: () => '1'.padStart(32, '0') })
    views.started('kanban', 1, [...files, file('hetu-theme.css', 'p { color: red }')], { board: 'dist/board.html' })
    const base = views.mint('kanban', 'board')!.replace(/dist\/board\.html$/, '')
    const sheet = views.serve(`${base}hetu-theme.css`)
    expect(text(sheet)).toBe(':root {}\n')
    expect(sheet?.type).toBe('text/css; charset=utf-8')
    expect(sheet?.csp).toBe(frameCsp('kanban', '1'.padStart(32, '0')))
    views.theme({ '--hetu-color-bg': '#202020', '--hetu-font-ui': 'Inter, sans-serif' })
    expect(text(views.serve(`${base}hetu-theme.css`))).toBe(':root {\n  --hetu-color-bg: #202020;\n  --hetu-font-ui: Inter, sans-serif;\n}\n')
    expect(views.serve(`${base}dist/hetu-theme.css`)).toBe(null)
    expect(views.serve(`${base.replace('kanban.views', 'other.views')}hetu-theme.css`)).toBe(null)
    expect(views.gone(`${base}dist/board.html`)).toEqual({ plugin: 'kanban' })
    expect(views.serve(`${base}hetu-theme.css`)).toBe(null)
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

  it('serves a running plugin\'s icons as svg or png only, on its own host', () => {
    const views = made()
    expect(views.serve('hetu://kanban.views/icon/dist/icon.svg')?.type).toBe('image/svg+xml')
    expect(views.serve('hetu://kanban.views/icon/dist/icon.png')?.type).toBe('image/png')
    expect(views.serve('hetu://kanban.views/icon/dist/board.js')).toBe(null)
    expect(views.serve('hetu://kanban.views/icon/dist/board.html')).toBe(null)
    expect(views.serve('hetu://other.views/icon/dist/icon.svg')).toBe(null)
    views.ended('kanban', 1)
    expect(views.serve('hetu://kanban.views/icon/dist/icon.svg')).toBe(null)
  })

  it('refuses an icon asked on another plugin\'s host or the bare views host', () => {
    const views = made()
    views.started('other', 1, [file('dist/mine.svg', '<svg/>')], {})
    expect(views.serve('hetu://other.views/icon/dist/mine.svg')?.type).toBe('image/svg+xml')
    for (const url of [
      'hetu://other.views/icon/dist/icon.svg', 'hetu://other.views/icon/kanban/dist/icon.svg', 'hetu://kanban.views/icon/dist/mine.svg',
      'hetu://kanban.views/icon/other/dist/mine.svg', 'hetu://views/icon/kanban/dist/icon.svg', 'hetu://x.kanban.views/icon/dist/icon.svg',
    ]) {
      expect(views.serve(url), url).toBe(null)
    }
  })

  it('serves the icons of a plugin whose id has an underscore', () => {
    const views = made()
    views.started('my_board', 1, files, {})
    expect(views.serve('hetu://my--board.views/icon/dist/icon.svg')?.type).toBe('image/svg+xml')
    expect(views.serve('hetu://my_board.views/icon/dist/icon.svg')).toBe(null)
  })

  it('refuses a URL off a plugin\'s frames host or with a user, a port or a query', () => {
    const views = made()
    const url = views.mint('kanban', 'board')!
    for (const other of [url.replace('kanban.views', 'editor'), url.replace('hetu://', 'hetu://u@'), url.replace('views/', 'views:1/'), `${url}?x=1`, `${url}#x`]) {
      expect(views.serve(other), other).toBe(null)
    }
  })
})
