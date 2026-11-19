import { execFile } from 'node:child_process'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { Call, Prepared } from '../../../api/policy-jobs.ts'
import { ask, callOf, cleanup, commitOf, logOf, place, started, type Place } from './helpers.ts'

const run = promisify(execFile)

afterEach(cleanup)

// A judge that answers as the gate would for a caller granted the paths allowed and keeps each ask
function judging(call: Call, allowed: (paths: readonly string[]) => boolean) {
  const asked: string[][] = []
  const judge = (paths: readonly string[]) => {
    asked.push([...paths])
    return allowed(paths) ? null : { code: 'not-granted' as const }
  }
  return { call: { ...call, judge }, asked }
}

async function performed(history: Awaited<ReturnType<typeof started>>, call: Call, prepared: Prepared): Promise<unknown> {
  try {
    return await history.provider.perform(call, prepared)
  } catch (err) {
    return { refused: err }
  }
}

// git on history's own repo for the notes folder, with an index of the test's own
async function repoGit(where: Place) {
  const home = path.join(where.dataDir, 'host', 'history')
  const key = (await readdir(home)).find(name => name !== 'empty')!
  const env = { ...process.env, GIT_DIR: path.join(home, key, 'shadow.git'), GIT_INDEX_FILE: path.join(where.base, 'test-index') }
  return async (args: string[], input?: string) => {
    const child = run('git', args, { env, cwd: where.base })
    if (input !== undefined) child.child.stdin!.end(input)
    return (await child).stdout.trim()
  }
}

// Windows and macOS read two cases of one name as one file
describe.runIf(process.platform === 'win32' || process.platform === 'darwin')('a commit of a note made under another case of its last name after prepare', () => {
  it('refuses the commit when the gate does not allow the other case and commits nothing', async () => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    await mkdir(at('box'))
    await writeFile(at('box', 'seed.md'), 'seed')
    const history = await started(where)
    await commitOf(history, ['box/seed.md'], 'first')
    const { call, asked } = judging(callOf('history.commit', { paths: ['box/n.md'], message: 'mine' }), paths => paths[0] === 'box/n.md')
    const prepared = await history.provider.prepare(call) as Prepared
    expect(prepared.scope.paths).toEqual(['box/n.md'])
    await writeFile(at('box', 'N.md'), 'OTHER NOTE')
    expect(await performed(history, call, prepared)).toEqual({ refused: { code: 'not-granted' } })
    expect(asked).toEqual([['box/N.md']])
    expect((await logOf(history, 'box')).map(listed => listed.message)).toEqual(['first'])
  })

  it('commits the note under the case it has when the gate allows that case', async () => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    await mkdir(at('box'))
    const history = await started(where)
    const { call, asked } = judging(callOf('history.commit', { paths: ['box/n.md'], message: 'mine' }), () => true)
    const prepared = await history.provider.prepare(call) as Prepared
    await writeFile(at('box', 'N.md'), 'OTHER NOTE')
    const made = await performed(history, call, prepared) as { commit: string }
    expect(made.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(asked).toEqual([['box/N.md']])
    const git = await repoGit(where)
    expect((await git(['ls-tree', '-r', '--name-only', made.commit])).split('\n')).toEqual(['box/N.md'])
  })

  it('refuses the commit when the other case is made while the commit waits behind a log in history\'s queue', async () => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    await mkdir(at('big'))
    await mkdir(at('box'))
    const history = await started(where)
    for (let k = 0; k < 5; k++) {
      await writeFile(at('big', 'x.md'), `x ${k}`)
      await commitOf(history, ['big/x.md'], `x ${k}`)
    }
    const log = callOf('history.log', { path: 'big/x.md' })
    const logPrepared = await history.provider.prepare(log) as Prepared
    const { call, asked } = judging(callOf('history.commit', { paths: ['box/n.md'], message: 'mine' }), paths => paths[0] === 'box/n.md')
    const prepared = await history.provider.prepare(call) as Prepared
    const ahead = history.provider.perform(log, logPrepared)
    const made = performed(history, call, prepared)
    // Lands while the log's git runs and the commit waits its turn
    await writeFile(at('box', 'N.md'), 'OTHER NOTE')
    await ahead
    expect(await made).toEqual({ refused: { code: 'not-granted' } })
    expect(asked).toEqual([['box/N.md']])
    expect(await logOf(history, 'box')).toEqual([])
  }, 20_000)

  it('refuses a commit with no judge on the call when the note was made under another case', async () => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    await mkdir(at('box'))
    const history = await started(where)
    const call = callOf('history.commit', { paths: ['box/n.md'], message: 'mine' })
    const prepared = await history.provider.prepare(call) as Prepared
    await writeFile(at('box', 'N.md'), 'OTHER NOTE')
    expect(await performed(history, call, prepared)).toEqual({ refused: { code: 'not-granted' } })
  })

  it.each([
    ['refuses it when the gate allows the old case only', (paths: readonly string[]) => paths.every(at => /^h\d\/n\.md$/.test(at)), { refused: { code: 'not-granted' } }, null],
    ['commits it under the new case when the gate allows that case', () => true, { commit: expect.stringMatching(/^[0-9a-f]{40}$/) }, 'h0/N.md'],
  ])('a note the human renames in case while its commit waits: %s', async (_name, allowed, answer, committed) => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    await mkdir(at('h0'))
    await writeFile(at('h0', 'n.md'), 'own note')
    const history = await started(where)
    const { call, asked } = judging(callOf('history.commit', { paths: ['h0/n.md'], message: 'honest' }), allowed)
    const prepared = await history.provider.prepare(call) as Prepared
    expect(prepared.scope.paths).toEqual(['h0/n.md'])
    await rename(at('h0', 'n.md'), at('h0', 'N.md'))
    const made = await performed(history, call, prepared)
    expect(made).toEqual(answer)
    expect(asked).toEqual([['h0/N.md']])
    const commit = (made as { commit?: string }).commit
    if (committed === null) expect(commit).toBeUndefined()
    else expect((await (await repoGit(where))(['ls-tree', '-r', '--name-only', commit!])).split('\n')).toEqual([committed])
  })

  it('commits nothing and asks no judge for a note still missing at perform', async () => {
    const where = await place()
    await mkdir(path.join(where.notes, 'box'))
    const history = await started(where)
    const { call, asked } = judging(callOf('history.commit', { paths: ['box/gone.md'], message: 'gone' }), () => false)
    const prepared = await history.provider.prepare(call) as Prepared
    expect(await performed(history, call, prepared)).toEqual({ commit: null })
    expect(asked).toEqual([])
  })

  it('logs and reads a commit made before the check as before, the other note\'s bytes under the judged path', async () => {
    const where = await place()
    const at = (...names: string[]) => path.join(where.notes, ...names)
    await mkdir(at('box'))
    await writeFile(at('box', 'seed.md'), 'seed')
    const history = await started(where)
    const first = await commitOf(history, ['box/seed.md'], 'first')
    // As a build without the check committed it: the bytes of box/N.md recorded under box/n.md
    const git = await repoGit(where)
    await git(['read-tree', first!])
    const blob = await git(['hash-object', '-w', '--stdin'], 'OTHER NOTE')
    await git(['update-index', '--add', '--cacheinfo', `100644,${blob},box/n.md`])
    const tree = await git(['write-tree'])
    const old = await git(['commit-tree', tree, '-p', first!, '-m', 'before the check'])
    await git(['update-ref', 'refs/heads/main', old])
    expect((await logOf(history, 'box/n.md')).map(listed => listed.commit)).toEqual([old])
    expect(await ask(history, 'history.read', { path: 'box/n.md', commit: old })).toMatchObject({ text: 'OTHER NOTE' })
  }, 20_000)
})
