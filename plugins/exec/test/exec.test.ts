import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecResult } from 'hetu-core/api/actions.ts'
import type { Caller } from 'hetu-core/api/envelope.ts'
import type { Call, ExecGrant, ExecView } from 'hetu-core/api/slots.ts'
import { createExec, type Exec, type ExecOptions } from '../src/exec.ts'

const node = process.execPath
const onWindows = process.platform === 'win32'
const git: Caller = { kind: 'plugin', id: 'git', half: 'worker', incarnation: 1 }
const other: Caller = { kind: 'plugin', id: 'other', half: 'worker', incarnation: 1 }
const editor: Caller = { kind: 'window', role: 'editor', n: 0 }
const exists = (file: string) => stat(file).then(() => true, () => false)

let base: string
let notes: string
let dataDir: string
let installDir: string
let marker: string
let n = 0

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'hetu-exec-')))
  notes = path.join(base, 'notes')
  dataDir = path.join(base, 'data')
  installDir = path.join(base, 'install')
  marker = path.join(base, 'ran.txt')
  for (const dir of [notes, installDir, path.join(dataDir, 'storage', 'git'), path.join(base, 'outside')]) await mkdir(dir, { recursive: true })
  await writeFile(path.join(notes, 'a.md'), 'note a')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// A command that runs node on a line of code, then more arguments
const js = (code: string, ...more: string[]) => [node, '-e', code, ...more]
const touch = js(`require('node:fs').writeFileSync(${JSON.stringify('MARKER')}, 'ran')`)
const marks = () => touch.map(arg => arg.replace('MARKER', marker.split(path.sep).join('/')))

function viewOf(plugins: Record<string, ExecGrant[]>, more: Partial<ExecView> = {}): ExecView {
  return { plugins: Object.assign(Object.create(null), plugins), any: [], opening: { folder: notes, dataDir, installDir }, ...more }
}

async function started(view: ExecView | null, options: ExecOptions = {}): Promise<Exec> {
  const exec = createExec(options)
  await exec.start(dataDir)
  if (view !== null) exec.role.stateChanged(view)
  return exec
}

const callOf = (command: unknown, caller: Caller = git, deadline = Date.now() + 30000): Call =>
  ({ callId: `c${++n}`, caller, action: 'exec.run', args: { command }, deadline })

// prepare then perform, as the carrier makes a call, the command it judged laid over the prepared scope
async function run(exec: Exec, command: unknown, caller: Caller = git, deadline?: number): Promise<ExecResult | { refused: unknown }> {
  const call = callOf(command, caller, deadline)
  const prepared = await exec.provider.prepare(call)
  if (!('scope' in prepared)) return { refused: prepared }
  try {
    return await exec.provider.perform(call, { scope: { ...prepared.scope, command: command as string[] } }) as ExecResult
  } catch (err) {
    return { refused: err }
  }
}

const notGranted = { refused: { code: 'not-granted' } }

describe('before it can serve', () => {
  it('answers unavailable until it has started and holds a view of the grants', async () => {
    const exec = createExec()
    expect(await run(exec, marks())).toEqual({ refused: { code: 'unavailable' } })
    await exec.start(dataDir)
    expect(await run(exec, marks())).toEqual({ refused: { code: 'unavailable' } })
    exec.role.stateChanged(viewOf({ git: [{ commands: [marks()], env: [] }] }))
    expect(await run(exec, marks())).toMatchObject({ code: 0 })
    expect(await exists(marker)).toBe(true)
  })

  it('throws on a view it can\'t read, which marks exec failed', async () => {
    const exec = await started(null)
    for (const bad of [null, {}, { plugins: {}, any: 'git', opening: { folder: null, dataDir, installDir } }, { plugins: {}, any: [] },
      { plugins: { git: 'all' }, any: [], opening: { folder: null, dataDir, installDir } },
      { plugins: { git: [{ commands: [['a', 7]], env: [] }] }, any: [], opening: { folder: null, dataDir, installDir } },
      { plugins: {}, any: [], opening: { folder: 7, dataDir, installDir } }]) {
      expect(() => exec.role.stateChanged(bad as never)).toThrow()
    }
  })
})

describe('the exact list', () => {
  it('runs a command the caller\'s grants list and answers how it ended with what it wrote', async () => {
    const command = js('process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3')
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    expect(await run(exec, command)).toEqual({ code: 3, signal: null, stdout: 'out', stderr: 'err', truncated: false })
  })

  it('refuses every command that isn\'t one of them argument for argument, and runs none of it', async () => {
    const listed = marks()
    const exec = await started(viewOf({ git: [{ commands: [listed], env: [] }] }))
    const [program, flag, code] = listed
    for (const command of [
      [program, flag, code, 'extra'], [program, flag], [program], [`${program} ${flag} ${code}`], [program, `${flag} ${code}`],
      [program, flag, `${code};`], [flag, program, code], [program, flag.toUpperCase(), code],
    ]) {
      expect(await run(exec, command)).toEqual(notGranted)
    }
    expect(await exists(marker)).toBe(false)
  })

  it('refuses a caller that holds no exec: another plugin, a window and a content frame', async () => {
    const exec = await started(viewOf({ git: [{ commands: [marks()], env: [] }], constructor: [] }))
    for (const caller of [other, editor, { kind: 'content', plugin: 'git', token: 'a'.repeat(32) }, { ...git, id: 'constructor' }, { ...git, id: '__proto__' }] as Caller[]) {
      expect(await run(exec, marks(), caller)).toEqual(notGranted)
    }
    expect(await exists(marker)).toBe(false)
  })

  it.each([[[]], ['git status'], [[node, 7]], [[node, '']], [undefined], [[7]]])('refuses %j as no command at all', async command => {
    const exec = await started(viewOf({ git: [{ commands: [marks()], env: [] }] }))
    expect(await run(exec, command)).toEqual({ refused: { code: 'invalid' } })
  })

  it('hands each argument to the program as it is, with no shell to read it', async () => {
    const args = ['& echo pwned', '$(whoami)', '%PATH%', 'a b', '"quoted"', '>out.txt']
    const command = js('process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args)
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    expect(JSON.parse((await run(exec, command) as ExecResult).stdout)).toEqual(args)
  })

  it('follows the newest view, so a grant taken away stops its command', async () => {
    const exec = await started(viewOf({ git: [{ commands: [marks()], env: [] }] }))
    exec.role.stateChanged(viewOf({}))
    expect(await run(exec, marks())).toEqual(notGranted)
    expect(await exists(marker)).toBe(false)
  })
})

describe('any command, the human\'s switch for one plugin', () => {
  it('lifts the list for a plugin that holds an exec item and gives nothing to one that holds none', async () => {
    const listed = js('process.exit(0)')
    const exec = await started(viewOf({ git: [{ commands: [listed], env: [] }] }, { any: ['git', 'other', 'nobody'] }))
    expect(await run(exec, marks())).toMatchObject({ code: 0 })
    expect(await exists(marker)).toBe(true)
    await rm(marker)
    expect(await run(exec, marks(), other)).toEqual(notGranted)
    expect(await run(exec, marks(), editor)).toEqual(notGranted)
    expect(await exists(marker)).toBe(false)
  })

  it('keeps the rest of the rules: the folders a command may run nothing from', async () => {
    await writeFile(path.join(notes, 'x.js'), '')
    const exec = await started(viewOf({ git: [{ commands: [js('0')], env: [] }] }, { any: ['git'] }))
    expect(await run(exec, [node, path.join(notes, 'x.js')])).toEqual(notGranted)
  })
})

describe('the environment', () => {
  const printEnv = js('process.stdout.write(JSON.stringify(process.env))')
  const seen = async (exec: Exec, command: string[]) => JSON.parse((await run(exec, command) as ExecResult).stdout) as Record<string, string>
  const ambient = { ...process.env, HETU_A: 'a', HETU_B: 'b', HETU_SECRET: 'secret', NODE_OPTIONS: '--no-warnings', GIT_CONFIG_COUNT: '0' }

  it('starts empty and holds only the variables the command\'s item names, with hetu\'s own values', async () => {
    const exec = await started(viewOf({ git: [{ commands: [printEnv], env: ['HETU_A', 'HETU_UNSET'] }] }), { ambient })
    const env = await seen(exec, printEnv)
    expect(env.HETU_A).toBe('a')
    for (const name of ['HETU_B', 'HETU_SECRET', 'HETU_UNSET', 'NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'HOME', 'APPDATA']) expect(env[name]).toBeUndefined()
    if (!onWindows) expect(Object.keys(env).filter(name => name !== '__CF_USER_TEXT_ENCODING')).toEqual(['HETU_A'])
  })

  it('takes a command\'s variables from the items that list it, and from all the caller\'s items once the list is lifted', async () => {
    const second = js('process.stdout.write(JSON.stringify(process.env))', 'second')
    const unlisted = js('process.stdout.write(JSON.stringify(process.env))', 'unlisted')
    const grants = { git: [{ commands: [printEnv], env: ['HETU_A'] }, { commands: [second, printEnv], env: ['HETU_B'] }] }
    const exec = await started(viewOf(grants), { ambient })
    expect(await seen(exec, printEnv)).toMatchObject({ HETU_A: 'a', HETU_B: 'b' })
    const only = await seen(exec, second)
    expect([only.HETU_A, only.HETU_B]).toEqual([undefined, 'b'])
    const lifted = await started(viewOf(grants, { any: ['git'] }), { ambient })
    expect(await seen(lifted, unlisted)).toMatchObject({ HETU_A: 'a', HETU_B: 'b' })
  })

  it('refuses a command whose item names a variable that loads code, should one ever reach the grants', async () => {
    const exec = await started(viewOf({ git: [{ commands: [marks()], env: ['HETU_A', 'NODE_OPTIONS'] }] }), { ambient })
    expect(await run(exec, marks())).toEqual(notGranted)
    const family = await started(viewOf({ git: [{ commands: [marks()], env: ['git_config_count'] }] }), { ambient })
    expect(await run(family, marks())).toEqual(notGranted)
    expect(await exists(marker)).toBe(false)
  })

  it('gives the program no input: its stdin is closed from the start', async () => {
    const command = js('let all = ""; process.stdin.on("data", piece => { all += piece }).on("end", () => process.stdout.write(`[${all}]`))')
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    expect(await run(exec, command)).toMatchObject({ code: 0, stdout: '[]' })
  })
})

describe('where a command runs', () => {
  const where = js('process.stdout.write(process.cwd())')
  const leave = js('require("node:fs").writeFileSync("left.js", "x"); process.stdout.write(process.cwd())')
  const look = js('process.stdout.write(JSON.stringify(require("node:fs").readdirSync(".")))')

  it('in a new empty folder of exec\'s own each time, removed when the command ends', async () => {
    const exec = await started(viewOf({ git: [{ commands: [where, leave, look], env: [] }] }))
    const first = await realpath(path.dirname((await run(exec, where) as ExecResult).stdout))
    const left = (await run(exec, leave) as ExecResult).stdout
    expect(first).toBe(path.join(dataDir, 'host', 'exec'))
    expect(await exists(left)).toBe(false)
    // What one command left is not there for the next
    expect((await run(exec, look) as ExecResult).stdout).toBe('[]')
    expect((await readdir(path.join(dataDir, 'host', 'exec'))).filter(name => name.startsWith('run-'))).toEqual([])
  })

  it('removes the folders a crash left, at start', async () => {
    const stale = path.join(dataDir, 'host', 'exec', 'run-0123456789abcdef')
    await mkdir(stale, { recursive: true })
    await writeFile(path.join(stale, 'left.js'), 'x')
    await started(viewOf({}))
    expect(await exists(stale)).toBe(false)
  })
})

describe('write-then-run: no file from the notes folder or hetu\'s data as a program or an argument', () => {
  const stored = () => path.join(dataDir, 'storage', 'git', 'x.js')
  const noted = () => path.join(notes, 'x.js')

  async function refuses(make: () => string[] | Promise<string[]>): Promise<void> {
    await writeFile(noted(), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)
    await writeFile(stored(), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)
    const command = await make()
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    expect(await run(exec, command)).toEqual(notGranted)
    expect(await exists(marker)).toBe(false)
  }

  it('refuses a script in the notes folder', () => refuses(() => [node, noted()]))
  it('refuses a script in the caller\'s own storage', () => refuses(() => [node, stored()]))
  it('refuses a path after an equals sign', () => refuses(() => [node, `--require=${noted()}`, '-e', '0']))
  it('refuses a path written with the other slash', () => refuses(() => [node, noted().split(path.sep).join('/')]))
  it('refuses a file URL', () => refuses(() => [node, pathToFileURL(noted()).href]))
  it('refuses a relative path that climbs out of the working folder into the data folder', () =>
    refuses(() => [node, path.join('..', '..', '..', 'storage', 'git', 'x.js')]))
  it('refuses a path that reaches the notes through a link from outside', () => refuses(async () => {
    await symlink(notes, path.join(base, 'outside', 'link'), 'junction')
    return [node, path.join(base, 'outside', 'link', 'x.js')]
  }))
  it('refuses a file that isn\'t there yet under one of those folders', () => refuses(() => [node, '-e', '0', path.join(notes, 'new', 'out.js')]))
  it.runIf(onWindows)('refuses a path in another case, which Windows opens all the same', () => refuses(() => [node, noted().toUpperCase()]))

  it('refuses a program that lies in the notes folder, by its path or found by its name', async () => {
    const planted = path.join(notes, 'bin')
    await mkdir(planted)
    const tool = path.join(planted, onWindows ? 'tool.exe' : 'tool')
    await writeFile(tool, '', { mode: 0o755 })
    const exec = await started(viewOf({ git: [{ commands: [[tool], ['tool']], env: [] }] }), { path: planted })
    expect(await run(exec, [tool])).toEqual(notGranted)
    expect(await run(exec, ['tool'])).toEqual(notGranted)
  })

  it('finds a program by its bare name on hetu\'s path, past one planted in the notes folder', async () => {
    const planted = path.join(notes, 'bin')
    await mkdir(planted)
    // Running this would fail: an empty file under node's name
    await writeFile(path.join(planted, path.basename(node)), '', { mode: 0o755 })
    const command = [path.basename(node, '.exe'), '-e', 'process.stdout.write(process.execPath)']
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }), { path: [planted, path.dirname(node)].join(path.delimiter) })
    const ran = await run(exec, command) as ExecResult
    expect(ran.code).toBe(0)
    expect(await realpath(ran.stdout)).toBe(await realpath(node))
  })

  it('runs a script from anywhere else, and takes a plain word that happens to name a note as a word', async () => {
    const script = path.join(base, 'outside', 'ok.js')
    await writeFile(script, 'process.stdout.write(process.argv[2])')
    const command = [node, script, 'a.md']
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    expect(await run(exec, command)).toMatchObject({ code: 0, stdout: 'a.md' })
  })

  it('with no notes folder picked still keeps hetu\'s data out', async () => {
    await writeFile(stored(), '')
    await writeFile(noted(), 'process.stdout.write("ran")')
    const commands = [[node, stored()], [node, noted()]]
    const exec = await started(viewOf({ git: [{ commands, env: [] }] }, { opening: { folder: null, dataDir, installDir } }))
    expect(await run(exec, commands[0])).toEqual(notGranted)
    expect(await run(exec, commands[1])).toMatchObject({ stdout: 'ran' })
  })
})

describe('the limits on a run', () => {
  it('keeps output up to the cap and says more was dropped', async () => {
    const command = js('process.stdout.write("x".repeat(5000)); process.stderr.write("y".repeat(5000))')
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }), { outputBytes: 100 })
    const ran = await run(exec, command) as ExecResult
    expect([ran.stdout.length, ran.stderr.length, ran.truncated, ran.code]).toEqual([100, 100, true, 0])
  })

  it('ends a command at the call\'s deadline and answers timeout', async () => {
    const command = js('setInterval(() => {}, 1000)')
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    const began = Date.now()
    expect(await run(exec, command, git, Date.now() + 400)).toEqual({ refused: { code: 'timeout' } })
    expect(Date.now() - began).toBeLessThan(5000)
    expect((await readdir(path.join(dataDir, 'host', 'exec'))).filter(name => name.startsWith('run-'))).toEqual([])
  })

  it('runs so many commands at once for one caller and answers throttled past that, per caller', async () => {
    const slow = js('setTimeout(() => {}, 600)')
    const exec = await started(viewOf({ git: [{ commands: [slow], env: [] }], other: [{ commands: [slow], env: [] }] }), { running: 2 })
    const results = await Promise.all([run(exec, slow), run(exec, slow), run(exec, slow), run(exec, slow, other)])
    const codes = results.map(result => ('refused' in result ? (result.refused as { code: string }).code : result.code))
    // Which of the three reaches the count third depends on how long each prepare takes
    expect(codes.slice(0, 3).sort()).toEqual([0, 0, 'throttled'])
    expect(codes[3]).toBe(0)
    expect(await run(exec, slow)).toMatchObject({ code: 0 })
  })

  it('ends what is running when it closes and serves nothing more', async () => {
    const command = js('setInterval(() => {}, 1000)')
    const exec = await started(viewOf({ git: [{ commands: [command], env: [] }] }))
    const running = run(exec, command)
    await new Promise(resolve => setTimeout(resolve, 300))
    exec.close()
    const ended = await running
    expect('refused' in ended || ended.code !== 0).toBe(true)
    expect(await run(exec, command)).toEqual({ refused: { code: 'unavailable' } })
  })

  it('fails a call whose prepared command isn\'t the one it was prepared with', async () => {
    const exec = await started(viewOf({ git: [{ commands: [marks()], env: [] }] }))
    const call = callOf(marks())
    const prepared = await exec.provider.prepare(call)
    await expect(exec.provider.perform(call, { scope: { ...(prepared as { scope: object }).scope, command: [node, '-e', '1'] } })).rejects.toMatchObject({ code: 'failed' })
    expect(await exists(marker)).toBe(false)
  })
})
