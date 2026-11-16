import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FuseState, FuseV1Options } from '@electron/fuses'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asarHeader, electronCopyIn, endedRefused, exitText, fuseFileIn, fuseFileOf, fuseText, plistAsarHash } from './packaged/helpers.ts'

// The packaged suite's helpers that need no packed build and no Electron

describe('where a copy of hetu named electron goes', () => {
  // Beside the executable: the folder root on Windows and Linux, inside the bundle on macOS, where the executable finds
  // the Electron framework
  it.each([
    ['win32', ['electron.exe']],
    ['linux', ['electron']],
    ['darwin', ['hetu.app', 'Contents', 'MacOS', 'electron']],
  ] as const)('on %s', (platform, inside) => {
    expect(electronCopyIn('app', platform)).toBe(path.join('app', ...inside))
  })
})

describe('the text of an exit', () => {
  const started = { code: null, signal: null, killed: false, stderr: '', records: [], dataDir: '', ready: false }

  it('names the signal a process ended by', () => {
    expect(exitText({ ...started, signal: 'SIGTRAP' })).toContain('signal SIGTRAP')
  })

  it('tells a process the test ended from one that ended alone', () => {
    expect(exitText({ ...started, killed: true })).toContain('ended by the test')
    expect(exitText({ ...started, code: 1 })).not.toContain('ended by the test')
  })

  it('holds the end of stderr and not its start', () => {
    const text = exitText({ ...started, stderr: `first line\n${'x'.repeat(5000)}\nlast line` })
    expect(text).toContain('last line')
    expect(text).not.toContain('first line')
  })
})

describe('a start the app ended as refused', () => {
  const started = { code: null, signal: null, killed: false, stderr: '', records: [], dataDir: '', ready: false }

  it.each(['win32', 'darwin'] as const)('ends with an exit code other than 0 on %s', platform => {
    expect(endedRefused({ ...started, code: 1 }, platform)).toBe(true)
    expect(endedRefused({ ...started, code: 0x80000003 }, platform)).toBe(true)
    expect(endedRefused({ ...started, code: 0 }, platform)).toBe(false)
  })

  it('ends on macOS by the trap a failed FATAL check raises, with no exit code', () => {
    expect(endedRefused({ ...started, signal: 'SIGTRAP' }, 'darwin')).toBe(true)
    expect(endedRefused({ ...started, signal: 'SIGILL' }, 'darwin')).toBe(true)
  })

  it('never ends on a signal from outside', () => {
    expect(endedRefused({ ...started, signal: 'SIGKILL' }, 'darwin')).toBe(false)
    expect(endedRefused({ ...started, signal: 'SIGTERM' }, 'darwin')).toBe(false)
    expect(endedRefused({ ...started, signal: 'SIGSEGV' }, 'darwin')).toBe(false)
  })

  it('ends on Windows with an exit code alone', () => {
    expect(endedRefused({ ...started, signal: 'SIGTRAP' }, 'win32')).toBe(false)
  })

  it.each(['win32', 'darwin'] as const)('is never a start the test ended or one that reached ready on %s', platform => {
    expect(endedRefused({ ...started, killed: true }, platform)).toBe(false)
    expect(endedRefused({ ...started, code: 1, ready: true }, platform)).toBe(false)
    expect(endedRefused({ ...started, signal: 'SIGTRAP', ready: true }, platform)).toBe(false)
  })
})

describe('the header of an archive', () => {
  const require = createRequire(import.meta.url)
  const builder = createRequire(path.join(path.dirname(require.resolve('electron-builder/package.json')), 'package.json'))
  const { computeData } = builder('app-builder-lib/out/asar/integrity') as {
    computeData(options: { resourcesPath: string, resourcesRelativePath: string, resourcesDestinationPath: string }): Promise<Record<string, { hash: string }>>
  }
  // A pickled size, then a pickled JSON header padded to four bytes, then the content
  const archive = (json: string, content: string) => {
    const text = Buffer.from(json)
    const padded = Math.ceil(text.length / 4) * 4
    const head = Buffer.alloc(16 + padded)
    head.writeUInt32LE(4, 0)
    head.writeUInt32LE(8 + padded, 4)
    head.writeUInt32LE(4 + padded, 8)
    head.writeUInt32LE(text.length, 12)
    text.copy(head, 16)
    return Buffer.concat([head, Buffer.from(content)])
  }

  it('is the JSON text alone, with no padding and no content', () => {
    const json = '{"files":{"a.js":{"size":5,"offset":"0"}}}'
    const bytes = archive(json, 'hello')
    const header = asarHeader(bytes)
    expect(bytes.subarray(header.start, header.start + header.length).toString()).toBe(json)
  })

  // The same bytes electron-builder hashes into the integrity Electron checks the header against
  it('hashes to what electron-builder records for the archive', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hetu-header-'))
    try {
      const bytes = archive('{"files":{"b.js":{"size":2,"offset":"0"}}}', 'hi')
      await writeFile(path.join(dir, 'app.asar'), bytes)
      const list = await computeData({ resourcesPath: dir, resourcesRelativePath: 'Resources', resourcesDestinationPath: dir })
      const header = asarHeader(bytes)
      const hash = createHash('sha256').update(bytes.subarray(header.start, header.start + header.length)).digest('hex')
      expect(hash).toBe(list[path.join('Resources', 'app.asar')]!.hash)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the file that holds the fuses', () => {
  const base = path.resolve('app')

  it.each([
    ['win32', ['hetu.exe']],
    ['linux', ['hetu']],
    ['darwin', ['hetu.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework']],
  ] as const)('on %s', (platform, inside) => {
    expect(fuseFileIn(base, platform)).toBe(path.join(base, ...inside))
  })

  // The form linkedCopy takes, so a copy holds that file of its own
  describe('inside a packed folder', () => {
    let dir = ''
    beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'hetu-fuse-file-')) })
    afterEach(() => rm(dir, { recursive: true, force: true }))

    it('is the executable on Windows', async () => {
      await writeFile(path.join(dir, 'hetu.exe'), '')
      expect(await fuseFileOf(dir, 'win32')).toBe('hetu.exe')
    })

    // The framework's top names its binary through links, which a copy makes again as links. Windows makes no file
    // link without a privilege
    it.skipIf(process.platform === 'win32')('is the framework binary the links lead to on macOS', async () => {
      const framework = path.join(dir, 'hetu.app', 'Contents', 'Frameworks', 'Electron Framework.framework')
      await mkdir(path.join(framework, 'Versions', 'A'), { recursive: true })
      await writeFile(path.join(framework, 'Versions', 'A', 'Electron Framework'), '')
      await symlink('A', path.join(framework, 'Versions', 'Current'))
      await symlink(path.join('Versions', 'Current', 'Electron Framework'), path.join(framework, 'Electron Framework'))
      expect(await fuseFileOf(dir, 'darwin')).toBe('hetu.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')
    })
  })
})

describe('the state of a fuse', () => {
  const wire = { [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE, [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.DISABLE, [FuseV1Options.RunAsNode]: FuseState.REMOVED }

  it('is on or off as its byte in the wire reads', () => {
    expect(fuseText(wire, 'EnableEmbeddedAsarIntegrityValidation')).toBe('EnableEmbeddedAsarIntegrityValidation on')
    expect(fuseText(wire, 'OnlyLoadAppFromAsar')).toBe('OnlyLoadAppFromAsar off')
  })

  it('names any other byte', () => {
    expect(fuseText(wire, 'RunAsNode')).toBe(`RunAsNode byte ${FuseState.REMOVED}`)
    expect(fuseText(wire, 'WasmTrapHandlers')).toBe('WasmTrapHandlers byte undefined')
  })
})

describe('the integrity in Info.plist', () => {
  const plist = (entries: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>hetu</string>
  <key>ElectronAsarIntegrity</key>
  <dict>
${entries}
  </dict>
</dict>
</plist>
`
  const entry = (file: string, hash: string) => `    <key>${file}</key>
    <dict>
      <key>algorithm</key>
      <string>SHA256</string>
      <key>hash</key>
      <string>${hash}</string>
    </dict>`

  it('is the hash recorded for Resources/app.asar', () => {
    const text = plist(`${entry('Resources/other.asar', 'b'.repeat(64))}\n${entry('Resources/app.asar', 'a'.repeat(64))}`)
    expect(plistAsarHash(text)).toBe('a'.repeat(64))
  })

  it('is missing when no entry names app.asar', () => {
    expect(plistAsarHash(plist(entry('Resources/other.asar', 'b'.repeat(64))))).toBeUndefined()
    expect(plistAsarHash('<plist><dict></dict></plist>')).toBeUndefined()
  })
})
