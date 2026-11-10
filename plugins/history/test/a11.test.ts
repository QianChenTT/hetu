import { execFile } from 'node:child_process'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ask, cleanup, commitOf, logOf, place, started, type Place } from './helpers.ts'

// A-11: git reads config, hooks, filters and nested repos from the folder it works in, and each can name a program to
// run. Every plant below is first shown to fire under plain git in the notes folder, then shown not to fire through
// history, which is what makes the second half mean something

const exec = promisify(execFile)
const slashes = (file: string) => file.split(path.sep).join('/')
const exists = (file: string) => stat(file).then(() => true, () => false)

let where: Place
let marker: string
let plant: string
// The planted program as a shell command: it appends its label to the marker file
const fires = (label: string) => `'${slashes(process.execPath)}' '${slashes(plant)}' ${label}`
const fired = async (): Promise<string[]> => (await exists(marker) ? (await readFile(marker, 'utf8')).split('\n').filter(Boolean) : [])
const saved: Record<string, string | undefined> = {}

// Plain git as a careless program would run it: in the folder, with whatever environment is around
const plain = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => exec('git', args, { cwd, env }).catch(err => err as { stdout: string })

function setEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in saved)) saved[name] = process.env[name]
    process.env[name] = value
  }
}

beforeEach(async () => {
  where = await place()
  marker = path.join(where.base, 'fired.txt')
  plant = path.join(where.base, 'plant.cjs')
  await writeFile(plant, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv[2] + '\\n')\n`)
  await mkdir(path.join(where.notes, 'sub'))
  await writeFile(path.join(where.notes, 'a.md'), 'note a')
  await writeFile(path.join(where.notes, 'sub', 'b.md'), 'note b')
})

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete saved[name]
  }
  await cleanup()
})

// Every history action over notes at the root and inside the nested repo's folder
async function useHistory(): Promise<void> {
  const history = await started(where)
  const commit = await commitOf(history, ['a.md', 'sub/b.md'], 'first')
  expect(commit).toMatch(/^[0-9a-f]{40}$/)
  await writeFile(path.join(where.notes, 'a.md'), 'note a, edited')
  await writeFile(path.join(where.notes, 'sub', 'b.md'), 'note b, edited')
  const second = await commitOf(history, ['a.md', 'sub/b.md'], 'second')
  expect(second).toMatch(/^[0-9a-f]{40}$/)
  expect(await logOf(history, 'sub/b.md')).toHaveLength(2)
  expect(await ask(history, 'history.read', { path: 'sub/b.md', commit })).toMatchObject({ text: 'note b' })
  // A note in a nested repo's folder is a plain file in history. A git that took the notes for its work tree would
  // record the nested repo as a link and lose the note
  expect(await ask(history, 'history.read', { path: 'sub/b.md', commit: second })).toMatchObject({ text: 'note b, edited' })
  history.close()
}

describe('A-11, a program planted for git to run', () => {
  it('in the notes folder\'s own .git/config fires under plain git and never through history', async () => {
    await plain(where.notes, ['init', '-q'])
    await plain(where.notes, ['config', 'core.fsmonitor', fires('root-fsmonitor')])
    await plain(where.notes, ['status'])
    expect(await fired()).toContain('root-fsmonitor')
    await rm(marker)
    await useHistory()
    expect(await fired()).toEqual([])
  })

  it('in a repo nested in a subfolder fires under plain git there and never through history, which stores its notes as plain files', async () => {
    const sub = path.join(where.notes, 'sub')
    await plain(sub, ['init', '-q'])
    // With a commit of its own, which is when git over the outer folder starts a child git in it
    await plain(sub, ['add', 'b.md'])
    await plain(sub, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'nested'])
    await plain(sub, ['config', 'core.fsmonitor', fires('nested-fsmonitor')])
    // A filter as well: a git over the outer folder hands its own -c settings down to the child, a filter isn't one
    await plain(sub, ['config', 'filter.plant.clean', fires('nested-filter')])
    await writeFile(path.join(sub, '.gitattributes'), '* filter=plant\n')
    // Written again since the nested commit, so its time no longer matches the index and git hashes it again, running
    // the filter. Untouched, git trusts the index and runs the filter only when the file's time ties the index's
    await writeFile(path.join(sub, 'b.md'), 'note b')
    await plain(sub, ['status'])
    await plain(sub, ['add', '--dry-run', 'b.md'])
    expect(await fired()).toEqual(expect.arrayContaining(['nested-fsmonitor', 'nested-filter']))
    await rm(marker)
    await useHistory()
    expect(await fired()).toEqual([])
  })

  it('as a clean filter named by .gitattributes fires under plain git add and never through history', async () => {
    await plain(where.notes, ['init', '-q'])
    await plain(where.notes, ['config', 'filter.plant.clean', fires('clean-filter')])
    await writeFile(path.join(where.notes, '.gitattributes'), '* filter=plant\n')
    await plain(where.notes, ['add', 'a.md'])
    expect(await fired()).toContain('clean-filter')
    await rm(marker)
    await useHistory()
    expect(await fired()).toEqual([])
  })

  it('as a hook in the notes folder\'s repo fires under plain git commit and never through history', async () => {
    await plain(where.notes, ['init', '-q'])
    const hooks = path.join(where.notes, '.git', 'hooks')
    await mkdir(hooks, { recursive: true })
    await writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\n${fires('pre-commit-hook')}\n`)
    await chmod(path.join(hooks, 'pre-commit'), 0o755)
    await plain(where.notes, ['add', 'a.md'])
    await plain(where.notes, ['-c', 'user.name=x', '-c', 'user.email=x@example.com', 'commit', '-q', '-m', 'x'])
    expect(await fired()).toContain('pre-commit-hook')
    await rm(marker)
    await useHistory()
    expect(await fired()).toEqual([])
  })

  it('through hetu\'s own environment fires under plain git and never through history, whose environment starts empty', async () => {
    const home = path.join(where.base, 'home')
    await mkdir(home)
    await writeFile(path.join(home, '.gitconfig'), `[core]\n\tfsmonitor = ${fires('home-gitconfig')}\n`)
    const global = path.join(where.base, 'global.gitconfig')
    await writeFile(global, `[core]\n\tfsmonitor = ${fires('global-config')}\n`)
    const scratch = path.join(where.base, 'scratch')
    await mkdir(scratch)
    await plain(scratch, ['init', '-q'])
    // Each one alone, so each is seen to work
    await plain(scratch, ['status'], { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: fires('config-count') })
    await plain(scratch, ['status'], { ...process.env, GIT_CONFIG_GLOBAL: global })
    await plain(scratch, ['status'], { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') })
    expect(await fired()).toEqual(expect.arrayContaining(['config-count', 'global-config', 'home-gitconfig']))
    await rm(marker)
    // All of them at once in the environment hetu itself runs with
    setEnv({
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: fires('config-count'),
      GIT_CONFIG_GLOBAL: global, HOME: home, USERPROFILE: home, GIT_DIR: path.join(scratch, '.git'), GIT_WORK_TREE: where.notes,
      GIT_EXTERNAL_DIFF: fires('external-diff'), GIT_SSH_COMMAND: fires('ssh-command'),
      // Where git would put its index, its objects and a trace, were any of these to reach it
      GIT_INDEX_FILE: path.join(where.base, 'stolen-index'), GIT_OBJECT_DIRECTORY: path.join(where.base, 'stolen-objects'),
      GIT_TRACE: path.join(where.base, 'trace.txt'),
    })
    await useHistory()
    expect(await fired()).toEqual([])
    for (const name of ['stolen-index', 'stolen-objects', 'trace.txt']) expect(await exists(path.join(where.base, name))).toBe(false)
    for (const name of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_TRACE']) delete process.env[name]
    // Nothing went to the repo the environment named either
    expect((await plain(scratch, ['rev-list', '--all', '--count'])).stdout.trim()).toBe('0')
  })

  it('in history\'s own repo, as config and as a hook, doesn\'t fire: every call overrides the keys that run a program', async () => {
    const history = await started(where)
    await commitOf(history, ['a.md'], 'first')
    const home = path.join(where.dataDir, 'host', 'history')
    const key = (await readdir(home)).find(name => /^[0-9a-f]{16}$/.test(name))!
    const repo = path.join(home, key, 'shadow.git')
    const hooks = path.join(repo, 'hooks')
    await mkdir(hooks, { recursive: true })
    await writeFile(path.join(hooks, 'reference-transaction'), `#!/bin/sh\n${fires('shadow-hook')}\n`)
    await chmod(path.join(hooks, 'reference-transaction'), 0o755)
    const config = await readFile(path.join(repo, 'config'), 'utf8')
    await writeFile(path.join(repo, 'config'), `${config}\n[core]\n\tfsmonitor = ${fires('shadow-fsmonitor')}\n`)
    // The hook is real: a ref moved by plain git with this repo runs it
    const head = (await plain(where.base, ['--git-dir', repo, 'rev-parse', 'refs/heads/main'])).stdout.trim()
    await plain(where.base, ['--git-dir', repo, 'update-ref', 'refs/heads/control', head])
    expect(await fired()).toContain('shadow-hook')
    await rm(marker)
    await writeFile(path.join(where.notes, 'a.md'), 'note a, edited')
    expect(await commitOf(history, ['a.md'], 'second')).toMatch(/^[0-9a-f]{40}$/)
    expect(await logOf(history, 'a.md')).toHaveLength(2)
    expect(await fired()).toEqual([])
    history.close()
  })

  it('leaves the notes folder\'s own repo as it was: no index entry, no commit, no file', async () => {
    await plain(where.notes, ['init', '-q'])
    const before = (await readdir(where.notes, { recursive: true })).sort()
    await useHistory()
    expect((await readdir(where.notes, { recursive: true })).sort()).toEqual(before)
    expect((await plain(where.notes, ['ls-files'])).stdout.trim()).toBe('')
    expect((await plain(where.notes, ['rev-list', '--all', '--count'])).stdout.trim()).toBe('0')
  })
})
