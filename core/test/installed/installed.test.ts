import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executableIn } from '../../build/package.ts'
import { cleanup, homeEnv, start } from '../packaged/helpers.ts'

// The real install, run only when HETU_INSTALLED names it: by CI after the MSI, and by hand after installing it
const installed = process.env.HETU_INSTALLED
const elevated = () => spawnSync('net', ['session'], { stdio: 'ignore' }).status === 0

afterEach(cleanup)

describe.runIf(installed !== undefined && process.platform === 'win32')('the install in Program Files', () => {
  const dir = installed!

  it('is per machine in Program Files with hetu.exe in it', () => {
    expect(path.resolve(dir).toLowerCase()).toBe(path.join(process.env.ProgramFiles!, 'hetu').toLowerCase())
    expect(statSync(executableIn(dir)).isFile()).toBe(true)
  })

  // Users read and run it. No group a standard user is in may write, change or own anything in it
  it('lets no standard user write into it', () => {
    const listed = spawnSync('icacls', [dir], { encoding: 'utf8' }).stdout
    const grants = listed.split(/\r?\n/).map(line => line.replace(dir, '').trim()).filter(Boolean)
    const users = grants.filter(line => /^(BUILTIN\\Users|NT AUTHORITY\\Authenticated Users|Everyone):/i.test(line))
    expect(users.length).toBeGreaterThan(0)
    for (const line of users) expect(line, line).not.toMatch(/\((?:[^)]*,)?(F|M|W|WD|AD|WDAC|WO|D|DC)(,[^)]*)?\)/)
  })

  it.runIf(!elevated())('refuses this shell\'s own write, which isn\'t elevated', async () => {
    await expect(writeFile(path.join(dir, 'planted.txt'), 'x')).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EACCES/) })
  })

  it('starts and reaches core.ready', async () => {
    expect((await start({ dir })).ready).toBe(true)
  })

  it.each([['--remote-debugging-port=0'], ['--inspect=0'], ['notes.md']])('refuses %s', async arg => {
    const { env } = await homeEnv()
    const started = await start({ dir, env, args: [arg], ms: 20_000 })
    expect(started.code).toBe(1)
    expect(started.records).toEqual([])
  })
})
