import { describe, expect, it } from 'vitest'
import { elevated, INTEGRITY, integrityOf, registryKeyExists, registryValue, requestedLevels } from './installed/windows.ts'

// The installed suite's Windows reads, checked here where no install is needed
describe('the execution levels a manifest asks for', () => {
  const manifest = (level: string) => Buffer.from(`MZ\0\0<trustInfo><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo>\0`, 'latin1')

  it('reads each level in the bytes', () => {
    expect(requestedLevels(manifest('asInvoker'))).toEqual(['asInvoker'])
    expect(requestedLevels(Buffer.concat([manifest('asInvoker'), manifest('requireAdministrator')]))).toEqual(['asInvoker', 'requireAdministrator'])
  })

  it('reads none where no manifest asks for a level', () => {
    expect(requestedLevels(Buffer.from('MZ no manifest here'))).toEqual([])
  })
})

describe.runIf(process.platform === 'win32')('the Windows reads', () => {
  it('reads this process\'s integrity level, High only when this shell is elevated', () => {
    const own = integrityOf(process.execPath).find(found => found.pid === process.pid)
    expect(own?.level).toBe(elevated() ? INTEGRITY.high : INTEGRITY.medium)
  })

  it('finds no process for an executable that isn\'t running', () => {
    expect(integrityOf('C:\\nowhere\\not-running.exe')).toEqual([])
  })

  it('reads a key and a value that exist and none that doesn\'t', () => {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'
    expect(registryKeyExists(key, 64)).toBe(true)
    expect(registryValue(key, 'Desktop', 64)).toMatch(/\\Desktop$/)
    expect(registryKeyExists('HKCU\\Software\\hetu-no-such-key', 64)).toBe(false)
    expect(registryValue(key, 'NoSuchValue', 64)).toBeUndefined()
  })
})
