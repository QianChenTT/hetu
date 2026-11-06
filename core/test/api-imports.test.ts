import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const api = path.join(import.meta.dirname, '..', 'api')
const files = readdirSync(api).filter(name => name.endsWith('.ts')).sort()

// Every module specifier a file names, plus a marker for anything that loads code another way. Comments are read
// too, which can only flag more
function imports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]*)\1/g)) found.push(match[2])
  for (const match of source.matchAll(/\bimport\s*(['"])([^'"]*)\1/g)) found.push(match[2])
  if (/\bimport\s*\(/.test(source)) found.push('<dynamic import>')
  if (/\brequire\s*\(/.test(source)) found.push('<require>')
  return found
}

// zod and core/api's own files, nothing else
function allowed(specifier: string): boolean {
  if (specifier === 'zod') return true
  return /^\.\/[a-z-]+\.ts$/.test(specifier) && files.includes(specifier.slice(2))
}

describe('core/api imports', () => {
  it('has files to check', () => {
    expect(files).toEqual(expect.arrayContaining(['envelope.ts', 'scope.ts', 'manifest.ts', 'capabilities.ts', 'changes.ts']))
  })

  it.each(files)('%s imports only zod and core/api', name => {
    const found = imports(readFileSync(path.join(api, name), 'utf8'))
    expect(found.filter(specifier => !allowed(specifier))).toEqual([])
  })

  it.each([
    ["import { readFile } from 'node:fs/promises'", 'node:fs/promises'],
    ["import path from 'path'", 'path'],
    ['import type { Stats } from "node:fs"', 'node:fs'],
    ["import {\n  retried,\n  syncDir,\n} from '../lib/disk.ts'", '../lib/disk.ts'],
    ["export * from '../backend/boot/state.ts'", '../backend/boot/state.ts'],
    ["export { x } from './missing.ts'", './missing.ts'],
    ["import './side-effect.js'", './side-effect.js'],
    ["import 'zod/v4/core'", 'zod/v4/core'],
    ["const fs = await import('node:fs')", '<dynamic import>'],
    ["const fs = require('fs')", '<require>'],
  ])('catches %j', (source, specifier) => {
    const found = imports(source)
    expect(found).toContain(specifier)
    expect(found.every(allowed)).toBe(false)
  })

  it('loads no types and only the es2024 library, so a Node import or a DOM global fails the typecheck', () => {
    const config = JSON.parse(readFileSync(path.join(api, 'tsconfig.json'), 'utf8'))
    expect(config.compilerOptions.types).toEqual([])
    expect(config.compilerOptions.lib).toEqual(['es2024'])
    expect(config.include).toEqual(['.'])
  })

  it('is typechecked on its own by the typecheck script', () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    expect(manifest.scripts.typecheck).toContain('tsc --noEmit -p api')
  })
})
