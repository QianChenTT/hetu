import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, callOf, commitOf, logOf, place, started, type Place } from './helpers.ts'

// The page size of each rev-list history runs. heldMs holds each one back once it ran
const pages: string[] = []
let heldMs = 0

vi.mock('hetu-core/lib/clean-env.ts', async original => {
  const real = await original<typeof import('hetu-core/lib/clean-env.ts')>()
  return {
    ...real,
    runClean: async (...args: Parameters<typeof real.runClean>) => {
      const ran = await real.runClean(...args)
      if (args[1].includes('rev-list')) {
        pages.push(args[1].find(arg => arg.startsWith('--max-count='))!)
        if (heldMs > 0) await new Promise(resolve => setTimeout(resolve, heldMs))
      }
      return ran
    },
  }
})

let where: Place

beforeEach(async () => {
  where = await place()
  await writeNote('journal/b.md', 'note b')
})

afterEach(async () => {
  pages.length = 0
  heldMs = 0
  await cleanup()
})

async function writeNote(name: string, text: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(path.dirname(path.join(where.notes, name)), { recursive: true })
  await writeFile(path.join(where.notes, name), text)
}

// Commits on top of the last that change only the paths given, as a build from before dot names were refused made them
async function planted(count: number, at: string): Promise<void> {
  const history = path.join(where.dataDir, 'host', 'history')
  const repo = path.join(history, (await readdir(history)).find(name => name !== 'empty')!, 'shadow.git')
  const env = { ...process.env, GIT_DIR: repo, GIT_INDEX_FILE: path.join(where.base, 'index'), GIT_AUTHOR_NAME: 'old', GIT_AUTHOR_EMAIL: 'old@hetu.invalid', GIT_COMMITTER_NAME: 'old', GIT_COMMITTER_EMAIL: 'old@hetu.invalid' }
  const gitIn = async (args: string[], input?: string) => {
    const running = promisify(execFile)('git', args, { env, cwd: where.base })
    if (input !== undefined) running.child.stdin!.end(input)
    return (await running).stdout.trim()
  }
  for (let i = 0; i < count; i++) {
    const blob = await gitIn(['hash-object', '-w', '--stdin'], `dot ${i}`)
    await gitIn(['read-tree', 'refs/heads/main'])
    await gitIn(['update-index', '--add', '--cacheinfo', `100644,${blob},${at}`])
    const made = await gitIn(['commit-tree', await gitIn(['write-tree']), '-p', 'refs/heads/main', '-m', `dot ${i}`])
    await gitIn(['update-ref', 'refs/heads/main', made])
  }
}

describe('a log over commits that changed only dot paths', () => {
  // A commit, three commits planted with six plain git runs each and two logs of two pages each took up to 3.8 s on a
  // shared Windows runner
  it('asks for the limit first and the largest page after it, so a run of such commits costs one more page', async () => {
    const history = await started(where)
    const plain = await commitOf(history, ['journal/b.md'], 'plain')
    await planted(3, 'journal/.hidden.md')
    pages.length = 0
    expect((await logOf(history, 'journal', 1)).map(listed => listed.commit)).toEqual([plain])
    expect(pages).toEqual(['--max-count=1', '--max-count=200'])
    // The second page reaches the first commit and comes back short, so no third is asked for
    pages.length = 0
    expect((await logOf(history, 'journal', 2)).map(listed => listed.commit)).toEqual([plain])
    expect(pages).toEqual(['--max-count=2', '--max-count=200'])
  }, 20_000)

  it('asks for one page only when the first fills the limit', async () => {
    const history = await started(where)
    const plain = await commitOf(history, ['journal/b.md'], 'plain')
    pages.length = 0
    expect((await logOf(history, 'journal', 1)).map(listed => listed.commit)).toEqual([plain])
    expect(pages).toEqual(['--max-count=1'])
  })

  // history runs one call at a time, so a log that pages on past its deadline would hold every call behind it. A commit,
  // two commits planted with six plain git runs each and a log held 600 ms took up to 3.5 s on a shared Windows runner
  // and only the test's own limit follows that, the 300 ms deadline it asserts stays
  it('stops paging once the call\'s deadline has passed and answers timeout', async () => {
    const history = await started(where)
    await commitOf(history, ['journal/b.md'], 'plain')
    await planted(2, 'journal/.hidden.md')
    pages.length = 0
    heldMs = 600
    // The deadline falls inside the first page, wherever git's other calls of the log end on a busy machine
    const call = { ...callOf('history.log', { path: 'journal', limit: 1 }), deadline: Date.now() + 300 }
    const prepared = await history.provider.prepare(call)
    await expect(history.provider.perform(call, prepared as never)).rejects.toEqual({ code: 'timeout' })
    expect(pages).toEqual(['--max-count=1'])
  }, 20_000)

  it('answers a log of one page past its deadline, since nothing waits on another page', async () => {
    const history = await started(where)
    const plain = await commitOf(history, ['journal/b.md'], 'plain')
    heldMs = 600
    const call = { ...callOf('history.log', { path: 'journal', limit: 1 }), deadline: Date.now() + 300 }
    const prepared = await history.provider.prepare(call)
    expect(((await history.provider.perform(call, prepared as never)) as { commits: { commit: string }[] }).commits.map(listed => listed.commit)).toEqual([plain])
  })
})
