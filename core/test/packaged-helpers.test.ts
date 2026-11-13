import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FuseState, FuseV1Options } from '@electron/fuses'
import { describe, expect, it } from 'vitest'
import { asarHeader, electronCopyIn, exitText, fuseFileIn, fuseText, plistAsarHash } from './packaged/helpers.ts'

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
