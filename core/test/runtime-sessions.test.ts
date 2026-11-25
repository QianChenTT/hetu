import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import { allowed, lockDown, NONCE_MARK, partition, ROLES, serve } from '../backend/runtime/sessions.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hetu-pages-'))
  await mkdir(path.join(root, 'editor', 'parts'), { recursive: true })
  await mkdir(path.join(root, 'trusted'), { recursive: true })
  await writeFile(path.join(root, 'editor', 'index.html'), `<!doctype html><title>hetu</title><script src="page.js" nonce="${NONCE_MARK}" defer></script>`)
  await writeFile(path.join(root, 'editor', 'parts', 'shell.css'), 'body {}')
  await writeFile(path.join(root, 'editor', 'README.md'), 'notes')
  await writeFile(path.join(root, 'trusted', 'index.html'), '<!doctype html><title>trusted</title>')
  await mkdir(path.join(root, 'workers'), { recursive: true })
  await writeFile(path.join(root, 'workers', 'index.html'), '<!doctype html><title>workers</title>')
  await writeFile(path.join(root, 'secret.html'), 'outside')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const get = (url: string, method = 'GET') => ({ url, method })

describe('the sessions', () => {
  it('keeps each role in its own partition that never reaches the disk', () => {
    expect(Object.keys(ROLES).map(role => partition(role as keyof typeof ROLES))).toEqual(['hetu-editor', 'hetu-trusted', 'hetu-workers'])
    for (const role of Object.keys(ROLES)) expect(partition(role as keyof typeof ROLES)).not.toMatch(/^persist:/)
  })

  it('lets a request through only to the role\'s own hetu hosts', () => {
    expect(allowed('editor', 'hetu://editor/')).toBe(true)
    expect(allowed('editor', 'hetu://kanban.views/x.html')).toBe(true)
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
    expect(allowed('workers', 'hetu://workers/page.js')).toBe(true)
    expect(allowed('workers', 'hetu://editor/')).toBe(false)
    expect(allowed('editor', 'hetu://workers/')).toBe(false)
  })

  it('lets the editor page reach a host of its own for each plugin id\'s frames, and no other frames host', () => {
    const longest = `p${'a'.repeat(62)}z`
    for (const url of [
      'hetu://kanban.views/', 'hetu://my--plugin.views/t/a.html', 'hetu://a-b.views/icon/x.svg', `hetu://${longest}.views/`,
      `hetu://${'ab--'.repeat(21)}c.views/`, 'hetu://xn--board.views/',
    ]) {
      expect(allowed('editor', url), url).toBe(true)
    }
    for (const url of [
      'hetu://views/x.html', 'hetu://.views/', 'hetu://x.kanban.views/', 'hetu://kanban.views.views/', `hetu://${longest}a.views/`,
      'hetu://-kanban.views/', 'hetu://kanban_.views/', 'hetu://con.views/', 'hetu://kanban.view/', 'hetu://kanbanviews/',
      'hetu://user@kanban.views/', 'hetu://kanban.views:1/', 'https://kanban.views/', 'hetu://my_plugin.views/',
      'hetu://my---plugin.views/', 'hetu://my--.views/', 'hetu://--my.views/', 'hetu://my--_plugin.views/', `hetu://${'ab--'.repeat(21)}cd.views/`,
    ]) {
      expect(allowed('editor', url), url).toBe(false)
    }
    expect(allowed('trusted', 'hetu://kanban.views/')).toBe(false)
    expect(allowed('workers', 'hetu://kanban.views/')).toBe(false)
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
      ['editor', 'hetu://trusted/'], ['trusted', 'hetu://editor/'], ['editor', 'hetu://views/index.html'], ['editor', 'hetu://kanban.views/index.html'],
      ['editor', 'hetu://editor/../secret.html'], ['editor', 'hetu://editor/%2e%2e/secret.html'],
      ['editor', 'hetu://editor/..%2fsecret.html'], ['editor', 'hetu://editor/parts%5c..%5c..%5csecret.html'],
      ['editor', 'hetu://editor/README.md'], ['editor', 'hetu://editor/missing.html'], ['editor', 'hetu://editor/parts'],
      ['editor', 'hetu://editor/index.html:stream'], ['editor', 'hetu://editor/INDEX.HTML'],
    ] as const) {
      expect((await serve(role, get(url), root)).status, url).toBe(404)
    }
    expect((await serve('trusted', get('hetu://trusted/'), root)).status).toBe(200)
  })

  it('gives the worker host page a CSP of its own: scripts from itself and WebAssembly, workers only from data:', async () => {
    const page = await serve('workers', get('hetu://workers/'), root)
    expect(page.status).toBe(200)
    const csp = page.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).toContain('worker-src data:')
    const editor = await serve('editor', get('hetu://editor/'), root)
    expect(editor.headers.get('content-security-policy')).not.toContain('worker-src')
  })

  it('lets the editor page frame and show images from the plugins\' frames hosts and show the images host, and no other page', async () => {
    const editor = (await serve('editor', get('hetu://editor/'), root)).headers.get('content-security-policy') ?? ''
    expect(editor).toContain('frame-src hetu://*.views;')
    expect(editor).toContain("img-src 'self' hetu://*.views hetu://images;")
    expect(editor).toContain("frame-ancestors 'none'")
    const trusted = (await serve('trusted', get('hetu://trusted/'), root)).headers.get('content-security-policy') ?? ''
    expect(trusted).not.toContain('.views')
    expect(trusted).not.toContain('hetu://images')
  })

  it('serves a plugin\'s frames from what main holds for it, with the frame\'s own CSP and its focus without activation denied', async () => {
    const views = {
      serve: (url: string) => (url === 'hetu://kanban.views/t/a.html' ? { bytes: new Uint8Array(Buffer.from('<p>a</p>')), type: 'text/html; charset=utf-8', csp: "default-src 'none'; frame-ancestors hetu://editor" } : null),
    }
    const page = await serve('editor', get('hetu://kanban.views/t/a.html'), root, views)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<p>a</p>')
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors hetu://editor")
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    // Its own focus does nothing without the human's activation in it and nothing it nests can be let do more
    expect(page.headers.get('permissions-policy')).toBe('focus-without-user-activation=()')
    expect((await serve('editor', get('hetu://kanban.views/t/b.html'), root, views)).status).toBe(404)
    expect((await serve('editor', get('hetu://kanban.views/t/a.html', 'HEAD'), root, views)).status).toBe(200)
    // The bare views host and a deeper one hold no plugin's frames, whatever main would answer for them
    const any = { serve: () => ({ bytes: new Uint8Array(1), type: 'text/html; charset=utf-8', csp: "default-src 'none'" }) }
    for (const url of ['hetu://views/t/a.html', 'hetu://x.kanban.views/t/a.html']) expect((await serve('editor', get(url), root, any)).status, url).toBe(404)
  })

  it('names a nonce in the editor page\'s style-src and on its script, made fresh for each load with 128 random bits', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const page = await serve('editor', get(i === 0 ? 'hetu://editor/?nonce=chosen' : 'hetu://editor/'), root)
      const csp = page.headers.get('content-security-policy') ?? ''
      const nonce = /^style-src 'self' 'nonce-([A-Za-z0-9+/]+={0,2})'$/.exec(csp.split('; ').find(part => part.startsWith('style-src')) ?? '')?.[1]
      expect(nonce, csp).toBeDefined()
      expect(Buffer.from(nonce!, 'base64')).toHaveLength(16)
      const body = await page.text()
      expect(body).toContain(`<script src="page.js" nonce="${nonce}" defer>`)
      expect(body).not.toContain(NONCE_MARK)
      seen.add(nonce!)
    }
    expect(seen.size).toBe(200)
    expect(seen.has('chosen')).toBe(false)
  })

  it('never allows inline style or script by keyword and gives no page but the editor\'s a nonce', async () => {
    const policies = await Promise.all([
      ['editor', 'hetu://editor/'], ['editor', 'hetu://editor/parts/shell.css'], ['trusted', 'hetu://trusted/'], ['workers', 'hetu://workers/'],
    ].map(async ([role, url]) => (await serve(role as keyof typeof ROLES, get(url!), root)).headers.get('content-security-policy') ?? ''))
    for (const policy of policies) {
      expect(policy).not.toContain('unsafe-inline')
      expect(policy).not.toContain('unsafe-hashes')
      expect(policy).not.toContain('sha256-')
    }
    expect(policies[0]).toContain("'nonce-")
    for (const policy of policies.slice(1)) expect(policy).not.toContain("'nonce-")
    // A nonce names no script: scripts still come only from the page's own files
    expect(policies[0].split('; ').find(part => part.startsWith('script-src'))).toBe("script-src 'self'")
  })

  it('refuses to serve an editor page that doesn\'t hold the nonce\'s mark exactly once', async () => {
    await writeFile(path.join(root, 'editor', 'index.html'), '<!doctype html><title>hetu</title>')
    expect((await serve('editor', get('hetu://editor/'), root)).status).toBe(500)
    await writeFile(path.join(root, 'editor', 'index.html'), `<p nonce="${NONCE_MARK}"></p><p nonce="${NONCE_MARK}"></p>`)
    expect((await serve('editor', get('hetu://editor/'), root)).status).toBe(500)
  })

  it('serves a frame\'s page as main holds it, the nonce\'s mark left as text and no nonce in its policy', async () => {
    const html = `<style nonce="${NONCE_MARK}">p {}</style>`
    const views = { serve: () => ({ bytes: new Uint8Array(Buffer.from(html)), type: 'text/html; charset=utf-8', csp: "default-src 'none'; style-src hetu://kanban.views/t/" }) }
    const page = await serve('editor', get('hetu://kanban.views/t/a.html'), root, views)
    expect(await page.text()).toBe(html)
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; style-src hetu://kanban.views/t/")
  })

  it('has the editor page\'s own markup carry the nonce\'s mark on its script, where the page reads it', async () => {
    const markup = await readFile(path.join(import.meta.dirname, '..', 'frontend', 'editor', 'index.html'), 'utf8')
    expect(markup.split(NONCE_MARK)).toHaveLength(2)
    expect(markup).toContain(`<script src="page.js" nonce="${NONCE_MARK}" defer></script>`)
  })

  it('answers only GET and HEAD', async () => {
    expect((await serve('editor', get('hetu://editor/', 'POST'), root)).status).toBe(405)
    const head = await serve('editor', get('hetu://editor/', 'HEAD'), root)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
})

// A session as lockDown sets it up, keeping the proxies it is given and answering each with the promise in answer
class FakeSession {
  proxies: object[] = []
  answer: Promise<void> = Promise.resolve()
  readonly webRequest = { onBeforeRequest() {} }
  readonly protocol = { handle() {} }
  setPermissionRequestHandler() {}
  setPermissionCheckHandler() {}
  setDevicePermissionHandler() {}
  setSpellCheckerEnabled() {}
  on() {}
  setProxy(config: object): Promise<void> {
    this.proxies.push(config)
    return this.answer
  }
}

const locked = (fake: FakeSession, role: keyof typeof ROLES | null) => lockDown(fake as unknown as Session, role, root)

describe('the sessions\' proxy', () => {
  it('puts every session behind one proxy on loopback port 1, with no direct way and loopback not bypassed', async () => {
    for (const role of [null, ...Object.keys(ROLES)] as (keyof typeof ROLES | null)[]) {
      const fake = new FakeSession()
      await locked(fake, role)
      expect(fake.proxies, String(role)).toEqual([{ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1', proxyBypassRules: '<-loopback>' }])
    }
  })

  it('is done only once the proxy is set, and fails when it can\'t be set', async () => {
    const fake = new FakeSession()
    let set = () => {}
    fake.answer = new Promise(resolve => {
      set = resolve
    })
    let done = false
    const locking = locked(fake, 'editor').then(() => {
      done = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(done).toBe(false)
    set()
    await locking
    expect(done).toBe(true)
    const refused = new FakeSession()
    refused.answer = Promise.reject(new Error('no proxy'))
    await expect(locked(refused, 'workers')).rejects.toThrow('no proxy')
  })
})

// Every .ts file under a folder, by its path from there
async function sources(dir: string, from = dir): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await sources(full, from))
    else if (entry.name.endsWith('.ts')) found.push(path.relative(from, full).split(path.sep).join('/'))
  }
  return found
}

describe('where sessions are made', () => {
  // A session made anywhere else would get no proxy, no permission handlers and no request filter. Electron makes one
  // for session.fromPartition, session.fromPath and a partition in a page's web preferences
  it('makes them only in main\'s loop over the roles, each locked down there', async () => {
    const backend = path.join(import.meta.dirname, '..', 'backend')
    const made: string[] = []
    for (const file of await sources(backend)) {
      const lines = (await readFile(path.join(backend, file), 'utf8')).split('\n')
      lines.forEach((line, at) => {
        if (/\bfromPartition\s*\(|\bfromPath\s*\(|\bpartition\s*:/.test(line)) made.push(`${file}: ${line.trim()} / ${lines[at + 1]?.trim()}`)
      })
    }
    expect(made).toEqual(['main.ts: sessions[role] = session.fromPartition(partition(role)) / await lockDown(sessions[role], role, pages, views, images)'])
  })
})
