import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startDaemon, type Daemon } from '../src/daemon.ts'
import { EventLog, type Event } from '../src/log.ts'

const TOKEN = 'test-token'
const DEBOUNCE = 300

let vault: string
let daemon: Daemon
let logged: Event[]

// Events go to memory only, no log file during tests
const events = () => new EventLog({ dir: null, onEvent: e => logged.push(e) })
const find = (name: string) => logged.filter(e => e.event === name)

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: vault, encoding: 'utf8' }).trim()
}

async function connect(label: string, token = TOKEN): Promise<Client> {
  const client = new Client({ name: label, version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(daemon.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { type: string; text: string }[])[0].text
  return { ok: !result.isError, body: JSON.parse(text) }
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 50))
  }
}

beforeEach(async () => {
  logged = []
  vault = await mkdtemp(path.join(tmpdir(), 'hetu-vault-'))
  await mkdir(path.join(vault, 'notes'))
  await writeFile(path.join(vault, 'notes', 'a.md'), '# A\n\nThe quick brown fox\n')
  await writeFile(path.join(vault, 'notes', 'b.md'), '# B\n\nSecond note\n')
  await writeFile(path.join(vault, 'notes', 'c.md'), '# C\n\nThird note\n')
  daemon = await startDaemon({ vault, token: TOKEN, humanDebounceMs: DEBOUNCE, events: events() })
})

afterEach(async () => {
  await daemon.close()
  // Windows keeps handles open for a moment after git and the watcher exit
  await rm(vault, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('vault daemon over MCP', () => {
  it('starts a git repo for a new vault', () => {
    expect(git('log', '--format=%s')).toBe('init: vault')
  })

  it('rejects requests without the bearer token', async () => {
    await expect(connect('intruder', 'wrong')).rejects.toThrow()
    const res = await fetch(daemon.url, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('rejects a browser origin and a rebinding host', async () => {
    const origin = await fetch(daemon.url, { method: 'POST', headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` } })
    expect(origin.status).toBe(403)
    // DNS rebinding: a page on evil.example resolves its own name to 127.0.0.1, so the Host header still names evil.example
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(daemon.url, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } }, res => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
  })

  it('lists the agent tools', async () => {
    const client = await connect('agent')
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(
      ['acquire_lease', 'edit_note', 'list_notes', 'note_history', 'read_note', 'release_lease', 'write_note'].sort(),
    )
  })

  it('commits one lease as one commit holding exactly the leased files', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md', 'notes/new.md'], label: 'writer-1' })
    expect(lease.ok).toBe(true)
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    const edited = await call(client, 'edit_note', {
      lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'quick', new_text: 'slow', base_version: a.body.version,
    })
    expect(edited.ok).toBe(true)
    const created = await call(client, 'write_note', {
      lease_id: lease.body.lease_id, path: 'notes/new.md', text: '# New\n', base_version: null,
    })
    expect(created.ok).toBe(true)

    // A file outside the lease that someone else left uncommitted must not end up in the agent commit
    await writeFile(path.join(vault, 'notes', 'b.md'), '# B\n\nchanged by hand\n')

    const released = await call(client, 'release_lease', { lease_id: lease.body.lease_id, message: 'swap a word' })
    expect(released.body.commit).toMatch(/^[0-9a-f]{40}$/)
    const files = git('show', '--name-only', '--format=', released.body.commit).split('\n').sort()
    expect(files).toEqual(['notes/a.md', 'notes/new.md'])
    expect(git('log', '-1', '--format=%an|%s', released.body.commit)).toBe('writer-1 (hetu agent)|agent(writer-1): notes/a.md, notes/new.md')
    expect(git('show', '--format=', '--unified=0', released.body.commit, '--', 'notes/a.md')).toContain('+The slow brown fox')
  })

  it('refuses a second lease on any overlapping file, all or nothing', async () => {
    const one = await connect('agent-1')
    const two = await connect('agent-2')
    const first = await call(one, 'acquire_lease', { paths: ['notes/a.md', 'notes/b.md'], label: 'one' })
    expect(first.ok).toBe(true)
    // Only Windows and macOS ignore case, on Linux NOTES/B.md is a different file
    const overlap = process.platform === 'win32' || process.platform === 'darwin' ? 'NOTES/B.md' : 'notes/b.md'
    const second = await call(two, 'acquire_lease', { paths: ['notes/c.md', overlap], label: 'two' })
    expect(second.ok).toBe(false)
    expect(second.body.error).toBe('LeaseHeld')
    // c.md was not leased by the failed call
    const third = await call(two, 'acquire_lease', { paths: ['notes/c.md'], label: 'two' })
    expect(third.ok).toBe(true)
  })

  it('never shows a refused caller the holder lease id, so the refusal cannot be used to take over the lease', async () => {
    const holder = await connect('holder')
    const other = await connect('other')
    const held = await call(holder, 'acquire_lease', { paths: ['notes/a.md'], label: 'holder' })
    const refused = await call(other, 'acquire_lease', { paths: ['notes/a.md'], label: 'other' })
    expect(refused.body.error).toBe('LeaseHeld')
    expect(JSON.stringify(refused.body)).not.toContain(held.body.lease_id)
    // What the caller needs to wait or narrow its request stays
    expect(refused.body.details).toEqual([{ path: 'notes/a.md', holder: 'holder', expires_at: held.body.expires_at }])
  })

  it('refuses writes outside the lease scope, stale versions and paths outside the vault', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'] })
    const b = await call(client, 'read_note', { path: 'notes/b.md' })
    const outOfScope = await call(client, 'write_note', { lease_id: lease.body.lease_id, path: 'notes/b.md', text: 'x', base_version: b.body.version })
    expect(outOfScope.body.error).toBe('OutOfScope')
    const stale = await call(client, 'write_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', text: 'x', base_version: 'old' })
    expect(stale.body.error).toBe('StaleVersion')
    for (const bad of ['../escape.md', '.git/config', 'C:/Windows/x.md']) {
      const res = await call(client, 'acquire_lease', { paths: [bad] })
      expect(res.body.error).toBe('OutsideVault')
    }
  })

  it('commits a human save after the debounce', async () => {
    await writeFile(path.join(vault, 'notes', 'c.md'), '# C\n\nSaved in an editor\n')
    await until(() => git('log', '-1', '--format=%s') === 'edit: notes/c.md')
    expect(git('status', '--porcelain')).toBe('')
  })

  it('does not commit a human write to a leased file as a human edit, and flags it at release', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'writer' })
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    await writeFile(path.join(vault, 'notes', 'a.md'), 'overwritten outside the daemon\n')
    await new Promise(r => setTimeout(r, DEBOUNCE * 3))
    expect(git('log', '-1', '--format=%s')).toBe('init: vault')
    // The agent's version is now stale, so it can't silently overwrite the outside change
    const write = await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'outside', new_text: 'x', base_version: a.body.version })
    expect(write.body.error).toBe('StaleVersion')
    const released = await call(client, 'release_lease', { lease_id: lease.body.lease_id })
    expect(released.body.warnings).toEqual(['notes/a.md was changed outside the daemon during the lease'])
  })

  it('commits an expired lease with a note in the message', async () => {
    await daemon.close()
    daemon = await startDaemon({ vault, token: TOKEN, humanDebounceMs: DEBOUNCE, leaseTtlSeconds: 1, events: events() })
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'sleepy' })
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'fox', new_text: 'cat', base_version: a.body.version })
    await until(() => git('log', '-1', '--format=%B').includes('(lease expired)'))
    const again = await call(client, 'release_lease', { lease_id: lease.body.lease_id })
    expect(again.body.error).toBe('LeaseNotFound')
  })

  it('shows history for a note', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'historian' })
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'fox', new_text: 'owl', base_version: a.body.version })
    await call(client, 'release_lease', { lease_id: lease.body.lease_id })
    const history = await call(client, 'note_history', { path: 'notes/a.md' })
    expect(history.body.map((c: { message: string }) => c.message.split('\n')[0])).toEqual(['agent(historian): notes/a.md', 'init: vault'])
  })

  it('commits files changed while the daemon was stopped on the next start', async () => {
    await daemon.close()
    await writeFile(path.join(vault, 'notes', 'b.md'), 'edited while stopped\n')
    daemon = await startDaemon({ vault, token: TOKEN, humanDebounceMs: DEBOUNCE, events: events() })
    expect(git('log', '-1', '--format=%s')).toBe('edit: changes made while the daemon was stopped')
    expect(await readFile(path.join(vault, 'notes', 'b.md'), 'utf8')).toBe('edited while stopped\n')
  })
})

describe('event log', () => {
  it('ties one tool call to its domain events with a shared req id and names the tool', async () => {
    const client = await connect('agent')
    await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'tracer' })
    const [acquired] = find('lease.acquired')
    const [callEvent] = find('mcp.call').filter(e => e.tool === 'acquire_lease')
    expect(acquired.req).toMatch(/^[0-9a-f]{8}$/)
    expect(acquired.req).toBe(callEvent.req)
    expect(acquired.tool).toBe('acquire_lease')
    expect(acquired).toMatchObject({ label: 'tracer', paths: ['notes/a.md'], ttl_s: 120 })
    expect(callEvent).toMatchObject({ outcome: 'success', paths: ['notes/a.md'] })
    expect(callEvent.era).toMatch(/^(legacy|modern)$/)
    expect(Number.isNaN(Date.parse(acquired.ts))).toBe(false)
  })

  it('records a refused lease with who holds the conflicting files', async () => {
    const one = await connect('agent-1')
    const two = await connect('agent-2')
    const first = await call(one, 'acquire_lease', { paths: ['notes/a.md'], label: 'one' })
    await call(two, 'acquire_lease', { paths: ['notes/a.md', 'notes/b.md'], label: 'two' })
    const [denied] = find('lease.denied')
    expect(denied).toMatchObject({ label: 'two', conflicts: [{ path: 'notes/a.md', holder: 'one', lease: first.body.lease_id }] })
    expect(find('mcp.call').at(-1)).toMatchObject({ outcome: 'failure', error: 'LeaseHeld', level: 'info' })
  })

  it('records reads and each write version, which git never sees', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'w' })
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    const one = await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'quick', new_text: 'slow', base_version: a.body.version })
    const two = await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'slow', new_text: 'calm', base_version: one.body.version })
    expect(find('note.read')).toMatchObject([{ path: 'notes/a.md', version: a.body.version.slice(0, 12), tool: 'read_note' }])
    expect(find('note.written').map(w => [w.op, w.base, w.version])).toEqual([
      ['edit', a.body.version.slice(0, 12), one.body.version.slice(0, 12)],
      ['edit', one.body.version.slice(0, 12), two.body.version.slice(0, 12)],
    ])
  })

  it('records a release with the commit hash and lease facts, never the commit content', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'r' })
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'quick', new_text: 'slow', base_version: a.body.version })
    const released = await call(client, 'release_lease', { lease_id: lease.body.lease_id, message: 'a secret commit message' })
    const [event] = find('lease.released')
    expect(event).toMatchObject({ lease: lease.body.lease_id, reason: 'agent', commit: released.body.commit, writes: 1, outside_writes: [] })
    // Git already holds the files, message, author and time of the commit, and note text never belongs in the log
    const all = JSON.stringify(logged)
    expect(all).not.toContain('a secret commit message')
    expect(all).not.toContain('quick brown')
    expect(all).not.toContain('slow brown')
  })

  it('flags an outside write to a leased file once, as a warning', async () => {
    const client = await connect('agent')
    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'holder' })
    await writeFile(path.join(vault, 'notes', 'a.md'), 'overwritten outside the daemon\n')
    await until(() => find('watch.outside_write').length > 0)
    await new Promise(r => setTimeout(r, DEBOUNCE))
    const flagged = find('watch.outside_write')
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({ level: 'warn', path: 'notes/a.md', lease: lease.body.lease_id, holder: 'holder', source: 'watcher', deleted: false })
    expect(flagged[0].req).toBeUndefined()
    await call(client, 'release_lease', { lease_id: lease.body.lease_id })
    expect(find('lease.released')[0]).toMatchObject({ level: 'warn', outside_writes: ['notes/a.md'] })
  })

  it('records an expiry under the timer, not under the call that took the lease', async () => {
    await daemon.close()
    logged = []
    daemon = await startDaemon({ vault, token: TOKEN, humanDebounceMs: DEBOUNCE, leaseTtlSeconds: 1, events: events() })
    const client = await connect('agent')
    await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'sleepy' })
    await until(() => find('lease.released').length > 0)
    const [event] = find('lease.released')
    expect(event).toMatchObject({ reason: 'expired', source: 'timer', commit: null })
    expect(event.req).toBeUndefined()
  })

  it('records refused requests by guard without the token', async () => {
    await fetch(daemon.url, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer leaked-guess' } })
    await fetch(daemon.url, { method: 'POST', headers: { Origin: 'https://evil.example' } })
    await fetch(daemon.url.replace('/mcp', '/admin'), { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(find('http.rejected').map(e => [e.reason, e.auth])).toEqual([['token', 'present'], ['origin', 'none'], ['path', 'present']])
    expect(JSON.stringify(logged)).not.toContain('leaked-guess')
  })

  it('warns on a path outside the vault', async () => {
    const client = await connect('agent')
    await call(client, 'read_note', { path: '../../secrets.txt' })
    expect(find('mcp.call').at(-1)).toMatchObject({ level: 'warn', error: 'OutsideVault', path: '../../secrets.txt' })
  })

  it('records a human save as the commit hash only', async () => {
    await writeFile(path.join(vault, 'notes', 'c.md'), '# C\n\nSaved in an editor\n')
    await until(() => find('human.commit').length > 0)
    const [event] = find('human.commit')
    expect(Object.keys(event).sort()).toEqual(['commit', 'event', 'level', 'source', 'ts'])
    expect(event.commit).toBe(git('rev-parse', 'HEAD'))
  })
})

describe('editor API', () => {
  const api = (route: string, init: RequestInit = {}) =>
    fetch(daemon.url.replace('/mcp', route), { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } })

  // Collects Server-Sent Events from /api/events into an array until the test aborts the stream
  async function stream() {
    const controller = new AbortController()
    const res = await api('/api/events', { signal: controller.signal })
    const got: { event: string; data: any }[] = []
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += value
          let end
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const event = /^event: (.+)$/m.exec(block)?.[1]
            const data = /^data: (.+)$/m.exec(block)?.[1]
            if (event && data) got.push({ event, data: JSON.parse(data) })
          }
        }
      } catch {}
    })()
    await until(() => got.some(e => e.event === 'hello'))
    return { res, got, close: () => controller.abort() }
  }

  it('lists and reads notes', async () => {
    const list = await (await api('/api/notes')).json()
    expect(list.map((n: { path: string }) => n.path)).toEqual(['.gitattributes', 'notes/a.md', 'notes/b.md', 'notes/c.md'])
    const a = await (await api('/api/notes/notes/a.md')).json()
    expect(a).toMatchObject({ path: 'notes/a.md', text: '# A\n\nThe quick brown fox\n' })
  })

  it('serves raw files as inert text so an artifact never runs on the editor origin', async () => {
    await writeFile(path.join(vault, 'notes', 'x.artifact.html'), '<script>alert(1)</script>')
    const res = await api('/api/files/notes/x.artifact.html')
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(await res.text()).toBe('<script>alert(1)</script>')
  })

  it('saves and commits at once, refuses stale versions', async () => {
    const a = await (await api('/api/notes/notes/a.md')).json()
    const save = await api('/api/notes/notes/a.md', { method: 'PUT', body: JSON.stringify({ text: '# A\n\nSaved from the editor\n', baseVersion: a.version }) })
    expect(save.status).toBe(200)
    const saved = await save.json()
    expect(saved.commit).toBe(git('rev-parse', 'HEAD'))
    expect(git('log', '-1', '--format=%s')).toBe('edit: notes/a.md')
    // The watcher sees the daemon's own write and must not make a second commit
    await new Promise(r => setTimeout(r, DEBOUNCE * 3))
    expect(git('log', '-1', '--format=%H')).toBe(saved.commit)
    const stale = await api('/api/notes/notes/a.md', { method: 'PUT', body: JSON.stringify({ text: 'x', baseVersion: a.version }) })
    expect(stale.status).toBe(409)
    expect((await stale.json()).error).toBe('StaleVersion')
  })

  it('refuses a save while an agent holds the note, naming the holder', async () => {
    const client = await connect('agent')
    await call(client, 'acquire_lease', { paths: ['notes/b.md'], label: 'busy-agent' })
    const b = await (await api('/api/notes/notes/b.md')).json()
    const res = await api('/api/notes/notes/b.md', { method: 'PUT', body: JSON.stringify({ text: 'x', baseVersion: b.version }) })
    expect(res.status).toBe(423)
    expect(await res.json()).toMatchObject({ error: 'LeaseHeld', details: { holder: 'busy-agent' } })
  })

  it('rejects paths outside the vault and requests without the token', async () => {
    expect((await api('/api/notes/..%2F..%2Fsecret.md')).status).toBe(400)
    expect((await api('/api/files/.git%2Fconfig')).status).toBe(400)
    expect((await fetch(daemon.url.replace('/mcp', '/api/notes'))).status).toBe(401)
  })

  it('streams leases and each agent write live, without lease ids', async () => {
    const client = await connect('agent')
    const early = await call(client, 'acquire_lease', { paths: ['notes/c.md'], label: 'early' })
    const s = await stream()
    // An editor connecting mid-lease learns about the lease from the hello event
    expect(s.got[0].data.leases).toEqual([{ paths: ['notes/c.md'], holder: 'early', expires_at: expect.any(String) }])

    const lease = await call(client, 'acquire_lease', { paths: ['notes/a.md'], label: 'live' })
    const a = await call(client, 'read_note', { path: 'notes/a.md' })
    const one = await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'quick', new_text: 'slow', base_version: a.body.version })
    const two = await call(client, 'edit_note', { lease_id: lease.body.lease_id, path: 'notes/a.md', old_text: 'slow', new_text: 'calm', base_version: one.body.version })
    const released = await call(client, 'release_lease', { lease_id: lease.body.lease_id })
    await until(() => s.got.some(e => e.event === 'lease.released'))

    expect(s.got.slice(1).map(e => e.event)).toEqual(['lease.acquired', 'note.changed', 'note.changed', 'lease.released'])
    expect(s.got[2].data).toEqual({ type: 'note.changed', path: 'notes/a.md', version: one.body.version, by: 'agent', holder: 'live' })
    expect(s.got[3].data.version).toBe(two.body.version)
    expect(s.got[4].data).toEqual({ type: 'lease.released', paths: ['notes/a.md'], holder: 'live', commit: released.body.commit })
    const all = JSON.stringify(s.got)
    expect(all).not.toContain(lease.body.lease_id)
    expect(all).not.toContain(early.body.lease_id)
    s.close()
  })

  it('streams saves made outside the daemon', async () => {
    const s = await stream()
    await writeFile(path.join(vault, 'notes', 'b.md'), '# B\n\nfrom another editor\n')
    await until(() => s.got.some(e => e.event === 'note.changed'))
    expect(s.got.find(e => e.event === 'note.changed')!.data).toMatchObject({ path: 'notes/b.md', by: 'outside' })
    s.close()
  })
})
