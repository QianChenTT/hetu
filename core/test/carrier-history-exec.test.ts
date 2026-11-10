import { afterEach, describe, expect, it } from 'vitest'
import type { Access, AuditRecord, Call, Prepared, Provider } from '../api/slots.ts'
import { auditFields } from '../backend/carrier/audit.ts'
import type { Carrier } from '../backend/carrier/carrier.ts'
import { cleanup, code, editor, type FakeLog, harness, trusted, windowWay, worker } from './carrier-fakes.ts'

afterEach(cleanup)

// A provider that prepares whatever scope the test names and keeps what it was handed
class Recording implements Provider {
  readonly prepared: Call[] = []
  readonly performed: { call: Call, prepared: Prepared }[] = []
  scope: (call: Call) => unknown = call => {
    const args = call.args as { path?: string, paths?: string[] }
    const paths = args.paths ?? (args.path === undefined ? undefined : [args.path])
    return paths === undefined ? {} : { paths: paths.map(path => path.replace('GIT~1', '.git')) }
  }

  async prepare(call: Call): Promise<Prepared> {
    this.prepared.push(call)
    return { scope: this.scope(call) } as Prepared
  }

  async perform(call: Call, prepared: Prepared): Promise<unknown> {
    this.performed.push({ call, prepared })
    return { done: call.action }
  }
}

function started() {
  const made = harness()
  const history = new Recording()
  const exec = new Recording()
  made.providers.history = history
  made.providers.exec = exec
  made.loader.installed('history')
  made.loader.installed('exec')
  const asked: Access[] = []
  made.gate.decision = access => {
    asked.push(access)
    return made.gate.granted(access)
  }
  return { ...made, history, exec, asked }
}

async function written(carrier: Carrier, log: FakeLog): Promise<Record<string, unknown>[]> {
  await carrier.flush()
  return log.events('audit.call').map(record => record.fields)
}

describe('a history call through the carrier', () => {
  it('asks the gate with the action\'s own access at both stages, on the raw paths and then the canonical ones', async () => {
    const { connect, gate, history, asked } = started()
    gate.grants.git = [{ type: 'history', access: 'commit', paths: ['notes/**'] }]
    const reply = await connect(worker('git')).ask('history.commit', { paths: ['notes/a.md', 'notes/b.md'], message: 'save' })
    expect(reply.result).toEqual({ done: 'history.commit' })
    expect(asked.map(access => [access.stage, access.capability, access.scope])).toEqual([
      ['raw', 'history', { paths: ['notes/a.md', 'notes/b.md'], access: 'commit' }],
      ['canonical', 'history', { paths: ['notes/a.md', 'notes/b.md'], access: 'commit' }],
    ])
    expect(history.performed[0].prepared.scope).toEqual({ paths: ['notes/a.md', 'notes/b.md'], access: 'commit' })
    expect(Object.isFrozen(history.performed[0].prepared.scope)).toBe(true)
  })

  it('reads the access from core/api\'s table, whatever the provider\'s prepare says', async () => {
    const { connect, gate, history, asked } = started()
    gate.grants.git = [{ type: 'history', access: 'read', paths: ['**'] }]
    // A prepare that calls a commit a read would turn a read grant into a commit
    history.scope = () => ({ paths: ['notes/a.md'], access: 'read' })
    const reply = await connect(worker('git')).ask('history.commit', { paths: ['notes/a.md'], message: 'save' })
    expect(code(reply)).toBe('not-granted')
    expect(asked[0].scope.access).toBe('commit')
    expect(history.prepared).toEqual([])
    gate.grants.git = [{ type: 'history', access: 'commit', paths: ['**'] }]
    await connect(worker('git', 2)).ask('history.commit', { paths: ['notes/a.md'], message: 'save' })
    expect(asked.at(-1)).toMatchObject({ stage: 'canonical', scope: { paths: ['notes/a.md'], access: 'commit' } })
    expect(history.performed[0].prepared.scope.access).toBe('commit')
  })

  it('judges a read on the canonical path, so an alias the grant matches by its text reaches nothing', async () => {
    const { connect, gate, history } = started()
    gate.grants.git = [{ type: 'history', access: 'read', paths: ['**'] }]
    const reply = await connect(worker('git')).ask('history.log', { path: 'GIT~1/config' })
    expect(code(reply)).toBe('not-granted')
    expect(history.performed).toEqual([])
  })

  it('lets the editor window read history and never commit, and gives the trusted window neither', async () => {
    const { carrier, history } = started()
    const way = windowWay(carrier, { e: editor, t: trusted })
    expect((await way.ask('e', 'history.log', { path: 'notes/a.md' })).ok).toBe(true)
    expect((await way.ask('e', 'history.read', { path: 'notes/a.md', commit: 'a'.repeat(40) })).ok).toBe(true)
    expect(code(await way.ask('e', 'history.commit', { paths: ['notes/a.md'], message: 'save' }))).toBe('not-granted')
    expect(code(await way.ask('t', 'history.log', { path: 'notes/a.md' }))).toBe('not-granted')
    expect(history.performed.map(({ call }) => call.action)).toEqual(['history.log', 'history.read'])
  })

  it('records a commit once with its paths and access, and reads coalesced', async () => {
    const { carrier, connect, gate, log } = started()
    gate.grants.git = [{ type: 'history', access: 'commit', paths: ['**'] }, { type: 'history', access: 'read', paths: ['**'] }]
    const git = connect(worker('git'))
    await git.ask('history.commit', { paths: ['notes/a.md'], message: 'a secret message' })
    await git.ask('history.log', { path: 'notes/a.md' })
    await git.ask('history.log', { path: 'notes/a.md' })
    const records = await written(carrier, log)
    expect(records).toMatchObject([
      { action: 'history.commit', paths: '["notes/a.md"]', pathCount: 1, access: 'commit', code: null, count: 1 },
      { action: 'history.log', access: 'read', code: null, count: 2 },
    ])
    expect(JSON.stringify(records)).not.toContain('a secret message')
  })
})

describe('an exec call through the carrier', () => {
  it('asks the gate with the whole argument array at both stages and hands the provider the same one', async () => {
    const { connect, gate, exec, asked } = started()
    gate.grants.git = [{ type: 'exec', commands: [['git', 'status']], env: [] }]
    const reply = await connect(worker('git')).ask('exec.run', { command: ['git', 'status'] })
    expect(reply.result).toEqual({ done: 'exec.run' })
    expect(asked.map(access => [access.stage, access.capability, access.scope])).toEqual([
      ['raw', 'exec', { command: ['git', 'status'] }],
      ['canonical', 'exec', { command: ['git', 'status'] }],
    ])
    expect(exec.performed[0].prepared.scope).toEqual({ command: ['git', 'status'] })
    expect(Object.isFrozen(exec.performed[0].prepared.scope.command)).toBe(true)
  })

  it('keeps the caller\'s command as the one judged, whatever the provider\'s prepare says', async () => {
    const { connect, gate, exec, asked } = started()
    gate.grants.git = [{ type: 'exec', commands: [['git', 'status']], env: [] }]
    exec.scope = () => ({ command: ['rm', '-rf', '/'] })
    await connect(worker('git')).ask('exec.run', { command: ['git', 'status'] })
    expect(asked.at(-1)).toMatchObject({ stage: 'canonical', scope: { command: ['git', 'status'] } })
    expect(exec.performed[0].prepared.scope.command).toEqual(['git', 'status'])
  })

  it('refuses a command outside the list before the provider hears of it', async () => {
    const { connect, gate, exec } = started()
    gate.grants.git = [{ type: 'exec', commands: [['git', 'status']], env: [] }]
    const git = connect(worker('git'))
    expect(code(await git.ask('exec.run', { command: ['git', 'status', '--short'] }))).toBe('not-granted')
    expect(code(await git.ask('exec.run', { command: ['git status'] }))).toBe('not-granted')
    expect(exec.prepared).toEqual([])
  })

  it('gives no window exec: the trusted window by the floor and the editor by its grants', async () => {
    const { carrier, exec } = started()
    const way = windowWay(carrier, { e: editor, t: trusted })
    expect(code(await way.ask('e', 'exec.run', { command: ['git', 'status'] }))).toBe('not-granted')
    expect(code(await way.ask('t', 'exec.run', { command: ['git', 'status'] }))).toBe('not-granted')
    expect(exec.prepared).toEqual([])
  })

  it('hands the call to the provider with the gate off, which keeps its own check, and records it with gate off', async () => {
    const { carrier, connect, loader, exec, asked, log } = started()
    loader.slots.gate = 'off'
    const reply = await connect(worker('git')).ask('exec.run', { command: ['curl', 'https://example.com'] })
    expect(reply.ok).toBe(true)
    expect(asked).toEqual([])
    expect(exec.performed[0].prepared.scope.command).toEqual(['curl', 'https://example.com'])
    expect(await written(carrier, log)).toMatchObject([{ action: 'exec.run', gate: 'off', command: '["curl","https://example.com"]', commandArgs: 2 }])
  })

  it('records every run on its own with the command, a refused one included, and never its output', async () => {
    const { carrier, connect, gate, exec, log } = started()
    gate.grants.git = [{ type: 'exec', commands: [['git', 'status']], env: [] }]
    exec.perform = async () => ({ code: 0, signal: null, stdout: 'secret output', stderr: '', truncated: false })
    const git = connect(worker('git'))
    await git.ask('exec.run', { command: ['git', 'status'] })
    await git.ask('exec.run', { command: ['git', 'status'] })
    await git.ask('exec.run', { command: ['git', 'push'] })
    const records = await written(carrier, log)
    expect(records).toMatchObject([
      { action: 'exec.run', command: '["git","status"]', commandArgs: 2, code: null, count: 1 },
      { action: 'exec.run', command: '["git","status"]', commandArgs: 2, code: null, count: 1 },
      { action: 'exec.run', command: '["git","push"]', commandArgs: 2, code: 'not-granted', count: 1 },
    ])
    expect(JSON.stringify(records)).not.toContain('secret output')
  })
})

describe('the audit fields of a command and an access', () => {
  const alpha = { kind: 'plugin', id: 'alpha', half: 'worker', incarnation: 1 } as const
  const record = (scope: AuditRecord['scope']): AuditRecord =>
    ({ seq: 1, at: Date.UTC(2026, 10, 9), caller: alpha, root: alpha, action: 'exec.run', scope, code: null, ms: 1, gate: 'on', count: 1 })

  it('writes the command as a JSON list that reads back whole, with how many arguments there were', () => {
    const fields = auditFields(record({ command: ['git', 'commit', '-m', 'two words'] }))
    expect(JSON.parse(fields.command as string)).toEqual(['git', 'commit', '-m', 'two words'])
    expect(fields.commandArgs).toBe(4)
    expect(auditFields(record({ paths: ['a.md'], access: 'read' }))).toMatchObject({ access: 'read', paths: '["a.md"]' })
    expect('command' in auditFields(record({ paths: ['a.md'] }))).toBe(false)
    expect('access' in auditFields(record({ paths: ['a.md'] }))).toBe(false)
  })

  it('cuts a long command to the arguments that fit the log\'s value cap', () => {
    const command = Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(500, 'x'))
    const fields = auditFields(record({ command }))
    expect((fields.command as string).length).toBeLessThanOrEqual(4096)
    expect((JSON.parse(fields.command as string) as string[]).length).toBeLessThan(64)
    expect(fields.commandArgs).toBe(64)
  })
})
