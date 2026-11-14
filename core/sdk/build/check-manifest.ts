import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { folderManifest, type InstallManifest, installManifest, MAX_MANIFEST_BYTES, supportsApi } from '../../api/manifest.ts'
import { entryPaths } from '../../backend/loader/verify.ts'
import { parseStrict } from '../../lib/hashed-file.ts'

// The problems the loader would refuse a plugin folder's manifest for, as text, none when it passes: the strict
// parse with duplicate keys refused, core/api's schema (the install one with install) and the API range. built adds
// each entry file the manifest names that is missing
export async function checkManifest(dir: string, options: { install?: boolean, built?: boolean } = {}): Promise<string[]> {
  let bytes: Buffer
  try {
    bytes = await readFile(path.join(dir, 'hetu-plugin.json'))
  } catch {
    return ['hetu-plugin.json is missing']
  }
  if (bytes.length > MAX_MANIFEST_BYTES) return [`hetu-plugin.json is over ${MAX_MANIFEST_BYTES} bytes`]
  let manifest: InstallManifest
  try {
    manifest = parseStrict(bytes, options.install === true ? installManifest : folderManifest) as InstallManifest
  } catch (err) {
    if (err instanceof z.ZodError) return err.issues.map(issue => `${issue.path.join('.') || 'the manifest'}: ${issue.message}`)
    return [`hetu-plugin.json: ${err instanceof Error ? err.message : String(err)}`]
  }
  const problems: string[] = []
  if (!supportsApi(manifest.api, (manifest.capabilities ?? []).map(granted => granted.type))) problems.push(`api ${manifest.api} leaves out this core's API`)
  if (options.built === true) {
    for (const entry of entryPaths(manifest)) {
      try {
        await access(path.join(dir, entry))
      } catch {
        problems.push(`${entry} is missing`)
      }
    }
  }
  return problems
}

// node core/sdk/build/check-manifest.ts <dir> [--install] [--built] prints each problem and exits 1 on any
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const dir = args.find(arg => !arg.startsWith('--')) ?? '.'
  const problems = await checkManifest(dir, { install: args.includes('--install'), built: args.includes('--built') })
  for (const problem of problems) console.error(problem)
  process.exitCode = problems.length === 0 ? 0 : 1
}
