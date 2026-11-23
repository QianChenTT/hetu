import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { providerActions, roleActions } from '../api/actions.ts'
import { providerActionNames } from '../sdk/client.ts'
import { roleActionNames } from '../sdk/serving.ts'

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

  it('hands a plugin the core\'s own isDotName, not a copy', async () => {
    const [sdk, scope] = await Promise.all([import('../sdk/index.ts'), import('../api/scope.ts')])
    expect(sdk.isDotName).toBe(scope.isDotName)
  })

  // A plugin checks a path as the schema does, with no zod in its bundle
  it('hands a plugin the core\'s own actionPathProblem, the one the path schema refuses by', async () => {
    const [sdk, actions] = await Promise.all([import('../sdk/index.ts'), import('../api/actions.ts')])
    expect(sdk.actionPathProblem).toBe(actions.actionPathProblem)
    for (const path of ['notes/.obsidian/a.md', 'a//b.md', 'C:/a.md']) {
      const parsed = providerActions['luoshu.read'].args.safeParse({ path })
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues[0].message).toBe(sdk.actionPathProblem(path))
    }
    expect(sdk.actionPathProblem('notes/a.md')).toBeNull()
  })

  it('bundles the path check with no zod and no Node', async () => {
    const result = await build({
      entryPoints: [path.join(import.meta.dirname, '..', 'api', 'paths.ts')],
      bundle: true,
      platform: 'neutral',
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some(input => input.endsWith('api/paths.ts'))).toBe(true)
    expect(inputs.filter(input => input.includes('zod') || input.startsWith('node:'))).toEqual([])
  })

  it('names every provider action core/api has', () => {
    expect([...providerActionNames].sort()).toEqual(Object.keys(providerActions).sort())
  })

  it('names every role action core/api has', () => {
    expect([...roleActionNames].sort()).toEqual(Object.keys(roleActions).sort())
  })
})
