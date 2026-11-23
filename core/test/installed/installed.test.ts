import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executableIn, INSTALL_GUID } from '../../build/package.ts'
import { cleanup, homeEnv, start } from '../packaged/helpers.ts'
import { elevated, INTEGRITY, integrityOf, registryKeyExists, registryValue, requestedLevels } from './windows.ts'

// The real install, run only when HETU_INSTALLED names it: by CI after the silent setup and by hand after installing.
// HETU_SETUP names the setup that made it
const installed = process.env.HETU_INSTALLED
const setup = process.env.HETU_SETUP

const UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INSTALL_GUID}`
const INSTALL_KEY = `Software\\${INSTALL_GUID}`

afterEach(cleanup)

describe.runIf(installed !== undefined && process.platform === 'win32')('the install for the current user', () => {
  const dir = installed!
  const uninstaller = path.join(dir, 'Uninstall hetu.exe')

  it('is in the account\'s own programs folder with hetu.exe and its uninstaller in it', () => {
    expect(path.resolve(dir).toLowerCase()).toBe(path.join(process.env.LOCALAPPDATA!, 'Programs', 'hetu').toLowerCase())
    expect(statSync(executableIn(dir)).isFile()).toBe(true)
    expect(statSync(uninstaller).isFile()).toBe(true)
  })

  it('ships no elevation helper', () => {
    expect(existsSync(path.join(dir, 'resources', 'elevate.exe'))).toBe(false)
  })

  it('is listed for this account only, its uninstall entry naming the uninstaller in the folder', () => {
    const entry = `HKCU\\${UNINSTALL_KEY}`
    expect(registryValue(entry, 'UninstallString', 64)?.toLowerCase()).toContain(uninstaller.toLowerCase())
    expect(registryValue(`HKCU\\${INSTALL_KEY}`, 'InstallLocation', 64)?.toLowerCase()).toBe(path.resolve(dir).toLowerCase())
    for (const view of [32, 64] as const) {
      expect(registryKeyExists(`HKLM\\${UNINSTALL_KEY}`, view), `HKLM uninstall entry, ${view} bit view`).toBe(false)
      expect(registryKeyExists(`HKLM\\${INSTALL_KEY}`, view), `HKLM install key, ${view} bit view`).toBe(false)
    }
  })

  it('asks for no administrator rights in hetu.exe, the uninstaller or the setup', async () => {
    const files = [executableIn(dir), uninstaller, ...(setup === undefined ? [] : [setup])]
    for (const file of files) {
      const levels = requestedLevels(await readFile(file))
      expect(levels.length, file).toBeGreaterThan(0)
      expect(levels.every(level => level === 'asInvoker'), `${file}: ${levels.join(', ')}`).toBe(true)
    }
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

  // Started from an elevated shell every process is High, so this proves something only from a shell that isn't,
  // which is how a person starts hetu. CI's runner is elevated
  it.runIf(!elevated())('runs no process of hetu at High integrity', async () => {
    let levels: { pid: number, level: number }[] = []
    const started = await start({
      dir,
      until: records => {
        if (!records.some(record => record.event === 'core.ready')) return false
        levels = integrityOf(executableIn(dir))
        return true
      },
    })
    expect(started.ready).toBe(true)
    expect(levels.length).toBeGreaterThan(0)
    for (const { pid, level } of levels) {
      expect(level, `process ${pid}`).toBeGreaterThanOrEqual(0)
      expect(level, `process ${pid}`).toBeLessThan(INTEGRITY.high)
    }
  })
})
