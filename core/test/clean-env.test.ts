import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baseEnv, findProgram, inside, nullDevice, runClean, withDeclared } from '../lib/clean-env.ts'

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hetu-clean-env-')))
  made.push(dir)
  return dir
}

const win = process.platform === 'win32'
const node = process.execPath
// A file that passes for a program: its name alone matters to the lookup
async function program(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await writeFile(file, '')
  if (!win) await chmod(file, 0o755)
  return file
}
const tool = win ? 'tool.exe' : 'tool'
const print = (code: string) => ['-e', code]

describe('the environment a command starts from', () => {
  it('is empty on macOS and Linux', () => {
    const ambient = { PATH: '/bin', HOME: '/home/han', NODE_OPTIONS: '--require ./x.js', SECRET: 's' }
    expect(baseEnv(ambient, 'linux')).toEqual({})
    expect(baseEnv(ambient, 'darwin')).toEqual({})
    expect(Object.getPrototypeOf(baseEnv(ambient, 'linux'))).toBeNull()
  })

  // libuv copies these eleven into every Windows child that lacks them, so the base sets each on purpose
  it('holds on Windows what a process start carries anyway, with a PATH of System32 alone in place of hetu\'s own', () => {
    const ambient = {
      SystemRoot: 'C:\\Windows', Path: 'C:\\Users\\han\\bin;C:\\notes\\tools', USERPROFILE: 'C:\\Users\\han', HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\han', TEMP: 'C:\\Temp', USERNAME: 'han', USERDOMAIN: 'PC', LOGONSERVER: '\\\\PC', SystemDrive: 'C:', windir: 'C:\\Windows',
      NODE_OPTIONS: '--require ./x.js', SECRET: 's', APPDATA: 'C:\\Users\\han\\AppData\\Roaming',
    }
    expect(baseEnv(ambient, 'win32')).toEqual({
      SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\han', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\han',
      TEMP: 'C:\\Temp', USERNAME: 'han', USERDOMAIN: 'PC', LOGONSERVER: '\\\\PC', SystemDrive: 'C:', windir: 'C:\\Windows',
    })
    expect(baseEnv({ SYSTEMROOT: 'D:\\Win' }, 'win32')).toEqual({ SystemRoot: 'D:\\Win', PATH: 'D:\\Win\\System32' })
    expect(baseEnv({}, 'win32')).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' })
  })

  it('puts hetu\'s own PATH in place of the base one only when it is named, as one variable whatever its case', () => {
    const ambient = { SystemRoot: 'C:\\Windows', Path: 'C:\\Users\\han\\bin' }
    const named = withDeclared(baseEnv(ambient, 'win32'), ['Path'], ambient, 'win32')
    expect(Object.keys(named).filter(name => name.toUpperCase() === 'PATH')).toEqual(['Path'])
    expect(named.Path).toBe('C:\\Users\\han\\bin')
  })

  it('adds only the variables named, with the value hetu itself has', () => {
    const ambient = { HOME: '/home/han', PATH: '/bin', SECRET: 's', EMPTY: '' }
    expect(withDeclared({}, ['HOME', 'UNSET', 'EMPTY'], ambient, 'linux')).toEqual({ HOME: '/home/han', EMPTY: '' })
    expect(withDeclared({ SystemRoot: 'C:\\Windows' }, ['PATH'], ambient, 'linux')).toEqual({ SystemRoot: 'C:\\Windows', PATH: '/bin' })
  })

  it('never passes a variable that makes a program load code, nor one that is no name', () => {
    const ambient = { NODE_OPTIONS: '--require ./x.js', GIT_CONFIG_COUNT: '1', LD_PRELOAD: '/x.so', 'A=B': 'x', HOME: '/home/han' }
    expect(withDeclared({}, ['NODE_OPTIONS', 'GIT_CONFIG_COUNT', 'LD_PRELOAD', 'A=B', 'node_options', 'HOME'], ambient, 'linux')).toEqual({ HOME: '/home/han' })
  })

  it('finds a name without case on Windows, as Windows does, and with case elsewhere', () => {
    expect(withDeclared({}, ['path', 'userprofile'], { Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\han' }, 'win32')).toEqual({ path: 'C:\\bin', userprofile: 'C:\\Users\\han' })
    expect(withDeclared({}, ['path'], { PATH: '/bin' }, 'linux')).toEqual({})
  })

  it('names the null device git takes as a config file', () => {
    expect(nullDevice('win32')).toBe('NUL')
    expect(nullDevice('linux')).toBe('/dev/null')
    expect(nullDevice('darwin')).toBe('/dev/null')
  })
})

describe('a program looked up by name', () => {
  it('comes from the first folder on the path that holds it, as its real absolute path', async () => {
    const root = await temp()
    const found = await program(path.join(root, 'second'), tool)
    await mkdir(path.join(root, 'first'))
    const lookup = [path.join(root, 'first'), path.join(root, 'second')].join(path.delimiter)
    expect(await findProgram('tool', { path: lookup, outside: [] })).toBe(found)
    expect(await findProgram('other', { path: lookup, outside: [] })).toBeNull()
    expect(await findProgram('tool', { path: undefined, outside: [] })).toBeNull()
    expect(await findProgram('tool', { path: '', outside: [] })).toBeNull()
  })

  it('skips an entry that is no absolute folder, so the working directory is never searched', async () => {
    const root = await temp()
    await program(path.join(root, 'here'), tool)
    const before = process.cwd()
    process.chdir(path.join(root, 'here'))
    try {
      for (const entry of ['.', '', 'here', `..${path.sep}here`]) {
        expect(await findProgram('tool', { path: entry, outside: [] })).toBeNull()
      }
    } finally {
      process.chdir(before)
    }
  })

  it('skips a folder inside one a command may run nothing from, and a link that leads into one', async () => {
    const root = await temp()
    const notes = path.join(root, 'notes')
    await program(path.join(notes, 'bin'), tool)
    const safe = await program(path.join(root, 'safe'), tool)
    const lookup = [path.join(notes, 'bin'), path.join(root, 'safe')].join(path.delimiter)
    expect(await findProgram('tool', { path: lookup, outside: [notes] })).toBe(safe)
    expect(await findProgram('tool', { path: path.join(notes, 'bin'), outside: [notes] })).toBeNull()
    // The same folder reached through a link outside the notes
    const link = path.join(root, 'link')
    await symlink(path.join(notes, 'bin'), link, 'junction')
    expect(await findProgram('tool', { path: link, outside: [notes] })).toBeNull()
    expect(await findProgram('tool', { path: link, outside: [] })).toBe(path.join(notes, 'bin', tool))
  })

  it('takes an absolute path as it is, by its real path, and refuses one inside such a folder', async () => {
    const root = await temp()
    const notes = path.join(root, 'notes')
    const planted = await program(notes, tool)
    const safe = await program(path.join(root, 'safe'), tool)
    expect(await findProgram(safe, { path: '', outside: [notes] })).toBe(safe)
    expect(await findProgram(planted, { path: '', outside: [notes] })).toBeNull()
    expect(await findProgram(path.join(root, 'safe', 'missing'), { path: '', outside: [] })).toBeNull()
  })

  it('refuses a name with a folder in it, which would be read against the working directory', async () => {
    const root = await temp()
    await program(path.join(root, 'bin'), tool)
    for (const name of ['bin/tool', `bin${path.sep}tool`, './tool', '../bin/tool']) {
      expect(await findProgram(name, { path: root, outside: [] })).toBeNull()
    }
  })

  it.runIf(win)('tries .exe and .com on Windows and never a .cmd or .bat, which a shell would run', async () => {
    const root = await temp()
    await program(path.join(root, 'scripts'), 'tool.cmd')
    await program(path.join(root, 'scripts'), 'other.bat')
    const com = await program(path.join(root, 'bin'), 'tool.com')
    const lookup = [path.join(root, 'scripts'), path.join(root, 'bin')].join(path.delimiter)
    expect(await findProgram('tool', { path: lookup, outside: [] })).toBe(com)
    expect(await findProgram('other', { path: lookup, outside: [] })).toBeNull()
    expect(await findProgram('tool.cmd', { path: lookup, outside: [] })).toBeNull()
    expect(await findProgram(path.join(root, 'scripts', 'other.bat'), { path: '', outside: [] })).toBeNull()
    expect(await findProgram('TOOL.COM', { path: lookup, outside: [] })).toBe(com)
  })

  it.runIf(!win)('takes only a file the user may execute', async () => {
    const root = await temp()
    const file = path.join(root, 'tool')
    await writeFile(file, '')
    await chmod(file, 0o644)
    expect(await findProgram('tool', { path: root, outside: [] })).toBeNull()
    await chmod(file, 0o755)
    expect(await findProgram('tool', { path: root, outside: [] })).toBe(file)
  })
})

describe('whether a path lies inside a folder', () => {
  it('holds for the folder and what is under it, never for a name that only starts alike', () => {
    const folder = path.join(path.sep, 'data', 'notes')
    expect(inside(folder, folder)).toBe(true)
    expect(inside(folder, path.join(folder, 'a', 'b.md'))).toBe(true)
    expect(inside(folder, `${folder}-other`)).toBe(false)
    expect(inside(folder, path.join(path.sep, 'data'))).toBe(false)
  })

  it('ignores case where the volume does', () => {
    const folder = path.join(path.sep, 'Data', 'Notes')
    expect(inside(folder, path.join(path.sep, 'data', 'notes', 'a.md'), 'win32')).toBe(true)
    expect(inside(folder, path.join(path.sep, 'data', 'notes', 'a.md'), 'darwin')).toBe(true)
    expect(inside(folder, path.join(path.sep, 'data', 'notes', 'a.md'), 'linux')).toBe(false)
  })
})

describe('running a program', () => {
  it('gives its exit code and what it wrote', async () => {
    const cwd = await temp()
    const ran = await runClean(node, print('process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3'), { cwd, env: baseEnv(), maxOutput: 1024 })
    expect({ code: ran.code, signal: ran.signal, truncated: ran.truncated, timedOut: ran.timedOut }).toEqual({ code: 3, signal: null, truncated: false, timedOut: false })
    expect(ran.stdout.toString()).toBe('out')
    expect(ran.stderr.toString()).toBe('err')
  })

  it('starts it with exactly the environment given, nothing of hetu\'s own', async () => {
    const cwd = await temp()
    process.env.HETU_TEST_SECRET = 'leaked'
    process.env.HETU_TEST_NAMED = 'named'
    try {
      const env = withDeclared(baseEnv(), ['HETU_TEST_NAMED'])
      const ran = await runClean(node, print('process.stdout.write(JSON.stringify(process.env))'), { cwd, env, maxOutput: 65536 })
      const seen = JSON.parse(ran.stdout.toString()) as Record<string, string>
      expect(seen.HETU_TEST_NAMED).toBe('named')
      expect(seen.HETU_TEST_SECRET).toBeUndefined()
      // macOS gives every process one variable of its own
      const names = Object.keys(seen).filter(name => name !== '__CF_USER_TEXT_ENCODING').map(name => name.toUpperCase()).sort()
      expect(names).toEqual(Object.keys(env).map(name => name.toUpperCase()).sort())
      for (const name of ['HOME', 'APPDATA', 'NODE_OPTIONS', 'PATHEXT']) expect(Object.keys(seen).map(key => key.toUpperCase())).not.toContain(name)
      // hetu's own PATH never arrives unnamed: none at all, or on Windows System32 alone
      const lookup = Object.entries(seen).find(([name]) => name.toUpperCase() === 'PATH')?.[1]
      expect(lookup).toBe(win ? path.join(seen.SystemRoot ?? seen.SYSTEMROOT, 'System32') : undefined)
    } finally {
      delete process.env.HETU_TEST_SECRET
      delete process.env.HETU_TEST_NAMED
    }
  })

  it('runs in the folder given', async () => {
    const cwd = await temp()
    const ran = await runClean(node, print('process.stdout.write(process.cwd())'), { cwd, env: baseEnv(), maxOutput: 4096 })
    expect(await realpath(ran.stdout.toString())).toBe(cwd)
  })

  it('hands each argument over as it is, with no shell to read it', async () => {
    const cwd = await temp()
    const args = ['& echo pwned', '$(whoami)', '%PATH%', '`id`', 'a b', '"quoted"', '', 'x;y', '>out.txt', 'tail\\']
    const ran = await runClean(node, [...print('process.stdout.write(JSON.stringify(process.argv.slice(1)))'), ...args], { cwd, env: baseEnv(), maxOutput: 4096 })
    expect(JSON.parse(ran.stdout.toString())).toEqual(args)
  })

  it('writes the input to its stdin and closes it, and closes it at once with none', async () => {
    const cwd = await temp()
    const echo = print('let all = ""; process.stdin.on("data", piece => { all += piece }).on("end", () => process.stdout.write(`[${all}]`))')
    expect((await runClean(node, echo, { cwd, env: baseEnv(), maxOutput: 4096, input: 'line one\nline two' })).stdout.toString()).toBe('[line one\nline two]')
    expect((await runClean(node, echo, { cwd, env: baseEnv(), maxOutput: 4096, input: Buffer.from([0xff, 0x00, 0x41]) })).stdout.length).toBeGreaterThan(2)
    expect((await runClean(node, echo, { cwd, env: baseEnv(), maxOutput: 4096 })).stdout.toString()).toBe('[]')
  })

  it('keeps output up to the cap, says more was dropped and lets the program end', async () => {
    const cwd = await temp()
    const ran = await runClean(node, print('process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(10))'), { cwd, env: baseEnv(), maxOutput: 1000 })
    expect(ran.stdout.length).toBe(1000)
    expect(ran.stderr.length).toBe(10)
    expect(ran.truncated).toBe(true)
    expect(ran.code).toBe(0)
  })

  it('ends a program still running at the deadline', async () => {
    const cwd = await temp()
    const started = Date.now()
    const ran = await runClean(node, print('setInterval(() => {}, 1000)'), { cwd, env: baseEnv(), maxOutput: 1024, deadline: Date.now() + 300 })
    expect(ran.timedOut).toBe(true)
    expect(ran.code === null || ran.code !== 0).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('ends a program when its signal is aborted, and starts none on a signal already aborted', async () => {
    const cwd = await temp()
    const stop = new AbortController()
    const running = runClean(node, print('setInterval(() => {}, 1000)'), { cwd, env: baseEnv(), maxOutput: 1024, signal: stop.signal })
    setTimeout(() => stop.abort(), 200)
    expect((await running).code === 0).toBe(false)
    await expect(runClean(node, print('process.exit(0)'), { cwd, env: baseEnv(), maxOutput: 1024, signal: stop.signal })).rejects.toThrow()
  })

  it('rejects for a program that can\'t start', async () => {
    const cwd = await temp()
    await expect(runClean(path.join(cwd, win ? 'missing.exe' : 'missing'), [], { cwd, env: baseEnv(), maxOutput: 1024 })).rejects.toThrow()
  })
})
