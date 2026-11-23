import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Metafile } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMain } from '../build/main.ts'
import { bundledPackages, NOTICES_FILE, noticesText, packageFolder, packageOf } from '../build/notices.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-notices-'))
  dirs.push(dir)
  return dir
}

// A package folder under root/node_modules with its package.json and the files named
async function plant(root: string, name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): Promise<string> {
  const folder = path.join(root, 'node_modules', ...name.split('/'))
  await mkdir(folder, { recursive: true })
  await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(folder, file), text)
  return folder
}

const metafile = (...inputs: string[]): Metafile => ({ inputs: Object.fromEntries(inputs.map(input => [input, { bytes: 1, imports: [] }])), outputs: {} })

describe('the package an input sits in', () => {
  it('takes one part after the last node_modules, two for a scope, and none outside node_modules', () => {
    expect(packageFolder('/r/node_modules/zod/v4/index.js')).toBe('/r/node_modules/zod')
    expect(packageFolder('/r/node_modules/@codemirror/view/dist/index.js')).toBe('/r/node_modules/@codemirror/view')
    expect(packageFolder('/r/node_modules/a/node_modules/b/x.js')).toBe('/r/node_modules/a/node_modules/b')
    expect(packageFolder('C:\\r\\node_modules\\yauzl\\index.js')).toBe('C:/r/node_modules/yauzl')
    expect(packageFolder('/r/core/backend/main.ts')).toBe(null)
    expect(packageFolder('/r/node_modules/@scope')).toBe(null)
  })
})

describe("a package's license", () => {
  it('reads its own license files in any case and spelling, with its author', async () => {
    const root = await temp()
    const one = await plant(root, 'one', { license: 'MIT', author: { name: 'Ann' } }, { 'LICENSE.md': 'MIT text\n', 'README.md': 'no' })
    expect(await packageOf(one)).toEqual({ name: 'one', version: '1.0.0', license: 'MIT', author: 'Ann', text: 'MIT text' })
    const two = await plant(root, 'two', { license: 'ISC', author: 'Bo' }, { licence: 'ISC text' })
    expect(await packageOf(two)).toMatchObject({ license: 'ISC', author: 'Bo', text: 'ISC text' })
  })

  it('takes the vendored text for a package that ships none, and stops the build for a license with none vendored', async () => {
    const root = await temp()
    const apache = await plant(root, '@scope/apache', { license: 'Apache-2.0' })
    expect((await packageOf(apache)).text).toMatch(/^Apache License\s+Version 2\.0, January 2004/)
    const bare = await plant(root, 'bare', { license: 'BSD-3-Clause' })
    await expect(packageOf(bare)).rejects.toThrow(/bare ships no license file and no BSD-3-Clause text/)
  })
})

describe('the notices file', () => {
  it('lists each package a bundle holds once, in name order, first-party inputs left out', async () => {
    const root = await temp()
    await plant(root, 'zed', { license: 'MIT' }, { LICENSE: 'zed text' })
    await plant(root, '@a/b', { license: 'MIT' }, { LICENSE: 'ab text' })
    const packages = await bundledPackages([
      { metafile: metafile('node_modules/zed/index.js', 'node_modules/zed/other.js', 'src/own.ts'), from: root },
      { metafile: metafile(path.join(root, 'node_modules', '@a', 'b', 'dist', 'index.js')), from: '/elsewhere' },
    ])
    expect(packages.map(each => each.name)).toEqual(['@a/b', 'zed'])
    const text = noticesText(packages)
    expect(text.split('\n').slice(0, 2).every(line => line.length > 0)).toBe(true)
    expect(text).toContain('@a/b 1.0.0\nLicense: MIT\n\nab text')
    expect(text.indexOf('@a/b 1.0.0')).toBeLessThan(text.indexOf('zed 1.0.0'))
  })

  it('is written beside main.js by the build, naming what the app bundles', async () => {
    const out = await temp()
    await buildMain(out)
    const text = await readFile(path.join(out, NOTICES_FILE), 'utf8')
    // Each entry's first line is the package's name and version
    const listed = text.split('\n').filter(line => /^\S+ \d+\.\d+\.\d+$/.test(line)).map(line => line.split(' ')[0])
    expect(listed).toEqual(expect.arrayContaining(['zod', 'yauzl', 'pend', '@humanwhocodes/momoa', '@codemirror/view', '@lezer/markdown']))
    // No workspace of hetu's own is listed as a package
    expect(listed.filter(name => name.startsWith('hetu') || name.startsWith('@hetu/'))).toEqual([])
  }, 120_000)
})
