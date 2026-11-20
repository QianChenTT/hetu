import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Caller } from '../../../api/envelope.ts'
import type { Call } from '../../../api/policy-jobs.ts'
import { createLuoshu, type Luoshu } from '../../../backend/providers/luoshu/luoshu.ts'

const run = promisify(execFile)
const onWindows = process.platform === 'win32'
const caller: Caller = { kind: 'window', role: 'editor', n: 0 }

// Two notes folders with the same plain notes. dotted also holds dot names and links into them, bare holds nothing
// else, so every name below that leads to a dot name in dotted is missing in bare
let base: string
let dotted: string
let bare: string
let n = 0
const live: Luoshu[] = []

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-aliases-')))
  dotted = path.join(base, 'dotted')
  bare = path.join(base, 'bare')
  for (const folder of [dotted, bare]) {
    await mkdir(path.join(folder, 'journal'), { recursive: true })
    await writeFile(path.join(folder, 'a.md'), 'note a')
    await writeFile(path.join(folder, 'journal', 'b.md'), 'note b')
  }
  await mkdir(path.join(dotted, '.obsidian', 'plugins', 'x'), { recursive: true })
  await writeFile(path.join(dotted, '.obsidian', 'plugins', 'x', 'main.js'), 'plugin code')
  await writeFile(path.join(dotted, '.obsidian', 'app.json'), '{}')
  await mkdir(path.join(dotted, '.git'))
  await writeFile(path.join(dotted, '.git', 'config'), '[core]\n')
  await writeFile(path.join(dotted, '.env'), 'secret')
  await symlink(path.join(dotted, '.obsidian'), path.join(dotted, 'cfg'), 'junction')
  await symlink(path.join(dotted, '.git'), path.join(dotted, 'repo'), 'junction')
  for (const dir of ['data', 'install', 'bin']) await mkdir(path.join(base, dir))
})

afterEach(async () => {
  for (const made of live.splice(0)) made.close()
  await rm(base, { recursive: true, force: true })
})

type Opened = Luoshu & { heard: [string, string][], binned: string[] }

function opened(folder: string): Opened {
  const heard: [string, string][] = []
  const binned: string[] = []
  const made = createLuoshu({ publish: (topic, at) => heard.push([topic, at]) })
  live.push(made)
  made.role.open({
    folder, dataDir: path.join(base, 'data'), installDir: path.join(base, 'install'),
    trash: async absolute => {
      binned.push(absolute)
      await rename(absolute, path.join(base, 'bin', `${binned.length}-${path.basename(absolute)}`))
    },
  })
  return Object.assign(made, { heard, binned })
}

// prepare then perform, as the router makes a call, with every listed name allowed as the gate off allows. The scope
// prepare gave is what the gate and the event log see
async function ask(made: Luoshu, action: string, args: unknown): Promise<{ scope: unknown, answer: unknown }> {
  const call: Call = { callId: `c${++n}`, caller, root: caller, action, args, deadline: Date.now() + 30000, ...(action === 'luoshu.list' ? { canList: () => true } : {}) }
  const prepared = await made.provider.prepare(call)
  if (!('scope' in prepared)) return { scope: null, answer: { refused: prepared } }
  try {
    return { scope: prepared.scope, answer: await made.provider.perform(call, prepared) }
  } catch (err) {
    return { scope: prepared.scope, answer: { refused: err } }
  }
}

// Every name under a folder, dot names and links included
async function tree(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name
    found.push(name)
    if (entry.isDirectory()) found.push(...await tree(path.join(dir, entry.name), `${name}/`))
  }
  return found.sort()
}

// The 8.3 short name Windows made for a name in a folder, as dir /x shows it. null when the volume makes none
async function shortName(dir: string, name: string): Promise<string | null> {
  const { stdout } = await run('cmd.exe', ['/d', '/c', 'dir', '/x', '/a'], { cwd: dir })
  for (const line of stdout.split(/\r?\n/).map(l => l.trimEnd())) {
    if (!line.endsWith(` ${name}`)) continue
    const short = line.slice(0, -name.length).trimEnd().split(/\s+/).at(-1)
    if (short?.includes('~')) return short
  }
  return null
}

// Each read, listing, remove and from end of a move answers in dotted what it answers in bare, scope included. A write
// and the to end of a move answer not-granted, since a write to a missing name makes it. Nothing in dotted changes
async function answersAsMissing(spellings: string[]): Promise<void> {
  const before = await tree(dotted)
  const inDotted = opened(dotted)
  const inBare = opened(bare)
  for (const spelled of spellings) {
    const tries: [string, unknown][] = [
      ['luoshu.list', { folder: spelled }],
      ['luoshu.read', { path: spelled }],
      ['luoshu.remove', { path: spelled }],
      ['luoshu.remove', { path: spelled, baseVersion: 'f'.repeat(64) }],
      ['luoshu.move', { from: spelled, to: 'moved.md' }],
      ['luoshu.write', { path: spelled, text: 'x', baseVersion: 'f'.repeat(64) }],
    ]
    for (const [action, args] of tries) {
      expect(await ask(inDotted, action, args), `${action} ${JSON.stringify(args)}`).toEqual(await ask(inBare, action, args))
    }
    for (const [action, args] of [
      ['luoshu.write', { path: spelled, text: 'planted' }],
      ['luoshu.write', { path: `${spelled}/new.js`, text: 'planted' }],
      ['luoshu.move', { from: 'a.md', to: spelled }],
      ['luoshu.move', { from: 'journal/b.md', to: `${spelled}/b.md` }],
    ] as const) {
      expect((await ask(inDotted, action, args)).answer, `${action} ${JSON.stringify(args)}`).toEqual({ refused: { code: 'not-granted' } })
    }
  }
  expect(await tree(dotted)).toEqual(before)
  expect(await readFile(path.join(dotted, '.obsidian', 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
  expect(await readFile(path.join(dotted, '.env'), 'utf8')).toBe('secret')
  expect(inDotted.heard).toEqual([])
  expect(inDotted.binned).toEqual([])
}

describe('a name spelled with no dot that leads to a dot name', () => {
  it('answers as a missing name through a junction into a dot folder or into .git', async () => {
    await answersAsMissing(['cfg', 'cfg/plugins', 'cfg/plugins/x/main.js', 'cfg/app.json', 'cfg/plugins/y/new.js', 'repo', 'repo/config'])
  })

  it('answers as a missing name through what lies past the junction: a link out, a link to nowhere and one back', async () => {
    await mkdir(path.join(base, 'outside'))
    await writeFile(path.join(base, 'outside', 'secret.md'), 'outside secret')
    await symlink(path.join(base, 'outside'), path.join(dotted, '.obsidian', 'out'), 'junction')
    await symlink(path.join(base, 'nowhere'), path.join(dotted, '.obsidian', 'ghost'), 'junction')
    await symlink(path.join(dotted, 'journal'), path.join(dotted, '.obsidian', 'back'), 'junction')
    await answersAsMissing(['cfg/out/secret.md', 'cfg/out', 'cfg/ghost/x.md', 'cfg/back/b.md', 'cfg/back'])
  })

  it.runIf(onWindows)('answers as a missing name by the 8.3 short name of a dot folder, a dot file and .git', async ({ skip }) => {
    const shorts = await Promise.all(['.obsidian', '.env', '.git'].map(name => shortName(dotted, name)))
    if (shorts.includes(null)) {
      if (process.env.CI) throw new Error('no 8.3 short names on this CI volume, the dot names\' short names unproven')
      return skip('this volume makes no 8.3 short names')
    }
    const [obsidian, env, git] = shorts as string[]
    expect(await readFile(path.join(dotted, obsidian, 'plugins', 'x', 'main.js'), 'utf8')).toBe('plugin code')
    expect(await readFile(path.join(dotted, env), 'utf8')).toBe('secret')
    await answersAsMissing([obsidian, `${obsidian}/plugins/x/main.js`, `${obsidian}/app.json`, env, git, `${git}/config`])
  })

  it('keeps answering not-granted for a name spelled with its dot', async () => {
    const made = opened(dotted)
    for (const [action, args] of [
      ['luoshu.list', { folder: '.obsidian' }],
      ['luoshu.read', { path: '.obsidian/plugins/x/main.js' }],
      ['luoshu.read', { path: '.env' }],
      ['luoshu.read', { path: '.git/config' }],
      ['luoshu.remove', { path: '.env' }],
      ['luoshu.move', { from: '.env', to: 'env.md' }],
      ['luoshu.read', { path: 'cfg/.hidden.md' }],
    ] as const) {
      expect(await ask(made, action, args), `${action} ${JSON.stringify(args)}`).toEqual({ scope: null, answer: { refused: { code: 'not-granted' } } })
    }
  })
})
