import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { providerActions } from '../api/actions.ts'
import { providerActionNames } from '../sdk/client.ts'

const sdk = path.join(import.meta.dirname, '..', 'sdk')
const api = readdirSync(path.join(import.meta.dirname, '..', 'api')).filter(name => name.endsWith('.ts'))
const files = readdirSync(sdk).filter(name => name.endsWith('.ts')).sort()

// Every module specifier a file names, read as api-imports.test.ts reads them
function imports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]*)\1/g)) found.push(match[2])
  for (const match of source.matchAll(/\bimport\s*(['"])([^'"]*)\1/g)) found.push(match[2])
  if (/\bimport\s*\(/.test(source)) found.push('<dynamic import>')
  if (/\brequire\s*\(/.test(source)) found.push('<require>')
  return found
}

// core/api's files and the SDK's own, nothing else. testing/ and build/ run in Node and aren't bundled into plugins
function allowed(specifier: string): boolean {
  if (/^\.\.\/api\/[a-z-]+\.ts$/.test(specifier)) return api.includes(specifier.slice('../api/'.length))
  return /^\.\/[a-z-]+\.ts$/.test(specifier) && files.includes(specifier.slice(2))
}

describe('what a plugin bundles from the SDK', () => {
  it('has files to check', () => {
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'calls.ts', 'client.ts', 'refused.ts']))
  })

  it.each(files)('%s imports only core/api and the SDK\'s own files', name => {
    const found = imports(readFileSync(path.join(sdk, name), 'utf8'))
    expect(found.filter(specifier => !allowed(specifier))).toEqual([])
  })

  it('bundles the SDK with no zod and no Node', async () => {
    const result = await build({
      entryPoints: [path.join(sdk, 'index.ts')],
      bundle: true,
      platform: 'neutral',
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.length).toBeGreaterThan(1)
    expect(inputs.filter(input => input.includes('zod') || input.startsWith('node:'))).toEqual([])
  })

  it('names every provider action core/api has', () => {
    expect([...providerActionNames].sort()).toEqual(Object.keys(providerActions).sort())
  })
})
