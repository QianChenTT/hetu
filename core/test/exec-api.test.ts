import { describe, expect, it } from 'vitest'
import { providerActions } from '../api/actions.ts'
import { capability } from '../api/capabilities.ts'
import { reasonCodes } from '../api/envelope.ts'
import {
  commandKey, envNameProblem, EXEC_OUTPUT_BYTES, EXEC_RUNNING, HISTORY_FILE_BYTES, loadsCode, LOG_PAGE, MAX_COMMIT_MESSAGE,
  MAX_COMMIT_PATHS, MAX_LOG_PAGE,
} from '../api/exec.ts'
import { capabilityText } from '../api/trusted.ts'

const exec = (env: string[], commands: string[][] = [['git', 'status']]) => ({ type: 'exec', commands, env })

describe('the names exec passes through', () => {
  it.each(['HOME', 'PATH', 'SystemRoot', 'ProgramFiles(x86)', '_private', 'SSH_AUTH_SOCK', 'a1'])('takes %s', name => {
    expect(envNameProblem(name)).toBeNull()
    expect(capability.safeParse(exec([name])).success).toBe(true)
  })

  it.each(['', '1ST', 'HOME=/tmp', 'A B', 'A-B', 'A.B', 'x'.repeat(65), 'PATH;X', '%PATH%', '$HOME'])('refuses the name %j', name => {
    expect(envNameProblem(name)).not.toBeNull()
    expect(capability.safeParse(exec([name])).success).toBe(false)
  })

  it.each([
    'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB',
    'BASH_ENV', 'ENV', 'ELECTRON_RUN_AS_NODE', 'JAVA_TOOL_OPTIONS', 'DOTNET_STARTUP_HOOKS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES', 'GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_EXTERNAL_DIFF', 'GIT_DIR',
  ])('refuses %s, which makes a program load code', name => {
    expect(loadsCode(name)).toBe(true)
    expect(envNameProblem(name)).not.toBeNull()
    expect(capability.safeParse(exec([name])).success).toBe(false)
  })

  it('reads a name without case, as Windows does', () => {
    expect(loadsCode('node_options')).toBe(true)
    expect(loadsCode('Git_Config_Count')).toBe(true)
    expect(loadsCode('ld_preload')).toBe(true)
    expect(capability.safeParse(exec(['Node_Options'])).success).toBe(false)
  })

  it.each(['HOME', 'PATH', 'NODE_ENV', 'GITHUB_TOKEN', 'LDFLAGS', 'ENVIRONMENT', 'MY_GIT_DIR'])('leaves %s alone', name => {
    expect(loadsCode(name)).toBe(false)
  })
})

describe('a command as one key', () => {
  it('tells apart commands that read alike joined with spaces', () => {
    expect(commandKey(['git', 'a b'])).not.toBe(commandKey(['git', 'a', 'b']))
    expect(commandKey(['git', 'status'])).toBe(commandKey(['git', 'status']))
    expect(commandKey(['git', 'status', ''])).not.toBe(commandKey(['git', 'status']))
  })
})

describe('an exec item on the approval screen', () => {
  it('shows each command as its argument array, so two that run differently never read alike', () => {
    const one = capabilityText({ type: 'exec', commands: [['git', 'commit -m x']], env: [] })
    const other = capabilityText({ type: 'exec', commands: [['git', 'commit', '-m', 'x']], env: [] })
    expect(one).toBe('exec of ["git","commit -m x"]')
    expect(other).toBe('exec of ["git","commit","-m","x"]')
  })

  it('names the variables it passes through', () => {
    expect(capabilityText({ type: 'exec', commands: [['git', 'status'], ['git', 'log']], env: ['HOME', 'PATH'] }))
      .toBe('exec of ["git","status"], ["git","log"] with HOME, PATH from your environment')
  })
})

describe('the history and exec actions', () => {
  it('checks history by access and exec by the command', () => {
    expect(providerActions['history.commit']).toMatchObject({ capability: 'history', access: 'commit', scope: 'paths', write: true })
    expect(providerActions['history.log']).toMatchObject({ capability: 'history', access: 'read', scope: 'path', write: false })
    expect(providerActions['history.read']).toMatchObject({ capability: 'history', access: 'read', scope: 'path', write: false })
    expect(providerActions['exec.run']).toMatchObject({ capability: 'exec', scope: 'command', write: true })
    expect('access' in providerActions['exec.run']).toBe(false)
    expect('access' in providerActions['luoshu.read']).toBe(false)
  })

  it('holds the caps', () => {
    expect([MAX_COMMIT_PATHS, MAX_COMMIT_MESSAGE, LOG_PAGE, MAX_LOG_PAGE]).toEqual([64, 4096, 50, 200])
    expect([HISTORY_FILE_BYTES, EXEC_OUTPUT_BYTES, EXEC_RUNNING]).toEqual([16 * 1024 * 1024, 1024 * 1024, 4])
  })

  const sha = 'a'.repeat(40)
  it.each([
    ['history.commit', { paths: ['notes/a.md'], message: 'save' }, true],
    ['history.commit', { paths: ['notes/a.md'], message: 'a title\n\nand a body' }, true],
    ['history.commit', { paths: [], message: 'save' }, false],
    ['history.commit', { paths: ['notes/a.md'] }, false],
    ['history.commit', { paths: ['notes/a.md'], message: '' }, false],
    ['history.commit', { paths: ['notes/a.md'], message: 'x'.repeat(MAX_COMMIT_MESSAGE + 1) }, false],
    ['history.commit', { paths: ['notes/a.md'], message: `a${String.fromCharCode(7)}b` }, false],
    ['history.commit', { paths: ['notes/a.md'], message: `a${String.fromCodePoint(0x202e)}b` }, false],
    ['history.commit', { paths: ['notes/a.md'], message: 'a\r\nb' }, false],
    ['history.commit', { paths: ['notes\\a.md'], message: 'save' }, false],
    ['history.commit', { paths: ['../a.md'], message: 'save' }, false],
    ['history.commit', { paths: Array.from({ length: MAX_COMMIT_PATHS + 1 }, (_, i) => `${i}.md`), message: 'save' }, false],
    ['history.commit', { paths: ['a.md'], message: 'save', author: 'someone' }, false],
    ['history.log', { path: 'notes/a.md' }, true],
    ['history.log', { path: 'notes/a.md', limit: 200 }, true],
    ['history.log', { path: 'notes/a.md', limit: 0 }, false],
    ['history.log', { path: 'notes/a.md', limit: 201 }, false],
    ['history.log', { path: 'notes/a.md', limit: 1.5 }, false],
    ['history.log', {}, false],
    ['history.log', { path: ':(glob)**' }, false],
    ['history.read', { path: 'notes/a.md', commit: sha }, true],
    ['history.read', { path: 'notes/a.md' }, false],
    ['history.read', { path: 'notes/a.md', commit: 'HEAD' }, false],
    ['history.read', { path: 'notes/a.md', commit: `${sha}~1` }, false],
    ['history.read', { path: 'notes/a.md', commit: '--all' }, false],
    ['history.read', { path: 'notes/a.md', commit: 'A'.repeat(40) }, false],
    ['exec.run', { command: ['git', 'status'] }, true],
    ['exec.run', { command: ['git'] }, true],
    ['exec.run', { command: [] }, false],
    ['exec.run', { command: 'git status' }, false],
    ['exec.run', { command: ['git', 7] }, false],
    ['exec.run', { command: ['git', ''] }, false],
    ['exec.run', { command: ['git', `a${String.fromCharCode(0)}b`] }, false],
    ['exec.run', { command: Array.from({ length: 65 }, () => 'x') }, false],
    ['exec.run', { command: ['git', 'status'], env: { A: '1' } }, false],
    ['exec.run', { command: ['git', 'status'], cwd: '/tmp' }, false],
    ['exec.run', { command: ['git', 'status'], stdin: 'x' }, false],
  ])('checks %s with %j', (action, args, ok) => {
    expect(providerActions[action].args.safeParse(args).success).toBe(ok)
  })

  it('has a reason for a file that isn\'t text', () => {
    expect(reasonCodes).toContain('not-text')
  })
})
