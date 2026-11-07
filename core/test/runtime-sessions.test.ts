import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allowed, partition, ROLES, serve } from '../backend/runtime/sessions.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hetu-pages-'))
  await mkdir(path.join(root, 'mount', 'parts'), { recursive: true })
  await mkdir(path.join(root, 'trusted'), { recursive: true })
  await writeFile(path.join(root, 'mount', 'index.html'), '<!doctype html><title>hetu</title>')
  await writeFile(path.join(root, 'mount', 'parts', 'shell.css'), 'body {}')
  await writeFile(path.join(root, 'mount', 'README.md'), 'notes')
  await writeFile(path.join(root, 'trusted', 'index.html'), '<!doctype html><title>trusted</title>')
  await writeFile(path.join(root, 'secret.html'), 'outside')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const get = (url: string, method = 'GET') => ({ url, method })

describe('the sessions', () => {
  it('keeps each role in its own partition that never reaches the disk', () => {
    expect(Object.keys(ROLES).map(role => partition(role as keyof typeof ROLES))).toEqual(['hetu-editor', 'hetu-trusted'])
    for (const role of Object.keys(ROLES)) expect(partition(role as keyof typeof ROLES)).not.toMatch(/^persist:/)
  })

  it('lets a request through only to the role\'s own hetu hosts', () => {
    expect(allowed('editor', 'hetu://editor/')).toBe(true)
    expect(allowed('editor', 'hetu://views/x.html')).toBe(true)
    expect(allowed('editor', 'hetu://content/x')).toBe(true)
    expect(allowed('trusted', 'hetu://trusted/index.html')).toBe(true)
    for (const url of [
      'hetu://trusted/', 'https://example.com/', 'http://127.0.0.1:4747/', 'file:///C:/Windows/win.ini', 'ws://127.0.0.1/',
      'data:text/html,hi', 'blob:hetu://editor/1', 'devtools://devtools/bundled/inspector.html', 'chrome://gpu',
      'hetu://user@editor/', 'hetu://editor:1/', 'not a url',
    ]) {
      expect(allowed('editor', url), url).toBe(false)
    }
    expect(allowed('trusted', 'hetu://editor/')).toBe(false)
  })

  it('serves the role\'s page from the app with its CSP and type, never sniffed', async () => {
    const page = await serve('editor', get('hetu://editor/'), root)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>hetu</title>')
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    const style = await serve('editor', get('hetu://editor/parts/shell.css'), root)
    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
  })

  it('serves no other role\'s page, no host without pages yet and nothing outside its folder', async () => {
    for (const [role, url] of [
      ['editor', 'hetu://trusted/'], ['trusted', 'hetu://editor/'], ['editor', 'hetu://views/index.html'],
      ['editor', 'hetu://editor/../secret.html'], ['editor', 'hetu://editor/%2e%2e/secret.html'],
      ['editor', 'hetu://editor/..%2fsecret.html'], ['editor', 'hetu://editor/parts%5c..%5c..%5csecret.html'],
      ['editor', 'hetu://editor/README.md'], ['editor', 'hetu://editor/missing.html'], ['editor', 'hetu://editor/parts'],
      ['editor', 'hetu://editor/index.html:stream'], ['editor', 'hetu://editor/INDEX.HTML'],
    ] as const) {
      expect((await serve(role, get(url), root)).status, url).toBe(404)
    }
    expect((await serve('trusted', get('hetu://trusted/'), root)).status).toBe(200)
  })

  it('answers only GET and HEAD', async () => {
    expect((await serve('editor', get('hetu://editor/', 'POST'), root)).status).toBe(405)
    const head = await serve('editor', get('hetu://editor/', 'HEAD'), root)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
})
