import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import path from 'node:path'
import { transform, type Metafile } from 'esbuild'
import { coreModuleIds, type CoreModuleId } from '../api/ids.ts'
import { checkHostReach } from '../sdk/build/esbuild.ts'

// Each core module's folder, from core/. A module is the files under it and everything they import, hetu's own api and
// lib included, as its host half's bundle took them in when it was a core plugin
export const moduleFolders: Readonly<Record<CoreModuleId, string>> = {
  gate: 'backend/policy/gate',
  'grant-risk-classifier': 'backend/policy/grant-risk-classifier',
  storage: 'backend/providers/storage',
  luoshu: 'backend/providers/luoshu',
  history: 'backend/providers/history',
  exec: 'backend/providers/exec',
  'flood-control': 'backend/flood-control',
  heartbeat: 'backend/heartbeat',
  recording: 'backend/recording',
  'security-view': 'backend/security-view',
  lock: 'backend/lock',
}

// The Node built-ins each core module may reach, by the exact name it imports. The gate and the grant risk
// classifier judge from what they are handed and touch nothing. Storage reads and writes its files. The luoshu watches
// and writes the notes folder. History and exec run git and the commands a plugin was granted. Flood control counts
// what it is handed, the heartbeat asks the core through what it is handed and recording writes through the log and
// hashes with what it is handed. The security view decides from what it is handed. The lock reads the notes folder
// to turn each path it is asked about canonical
export const moduleBuiltins: Readonly<Record<CoreModuleId, readonly string[]>> = {
  gate: [],
  'grant-risk-classifier': [],
  storage: ['node:crypto', 'node:fs/promises', 'node:path'],
  luoshu: ['node:crypto', 'node:fs', 'node:fs/promises', 'node:path'],
  history: ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path'],
  exec: ['node:child_process', 'node:crypto', 'node:fs', 'node:fs/promises', 'node:path'],
  'flood-control': [],
  heartbeat: [],
  recording: [],
  'security-view': [],
  lock: ['node:crypto', 'node:fs/promises', 'node:path'],
}

const named = (specifier: string) => (specifier.startsWith('node:') ? specifier : `node:${specifier}`)
const posix = (file: string) => file.split(path.sep).join('/')

// What each core module reaches past its list, from the metafile of the build of main.ts with absWorkingDir at core/:
// a Node built-in not on its list, anything else left to load at run time (electron among them) and, in hetu's own files
// it takes in, the plain ways past an import that checkHostReach finds. A module folder with no file in the bundle is
// a problem too, so a moved folder can't pass by being empty. read is for tests
export async function checkModuleImports(
  metafile: Metafile,
  read: (file: string) => Promise<string> = file => readFile(file, 'utf8'),
  core: string = path.join(import.meta.dirname, '..'),
): Promise<string[]> {
  const inputs = metafile.inputs
  const problems: string[] = []
  const reachChecked = new Map<string, string[]>()
  for (const id of coreModuleIds) {
    const folder = moduleFolders[id]
    const own = Object.keys(inputs).filter(file => posix(file).startsWith(`${folder}/`))
    if (own.length === 0) {
      problems.push(`${id}: no file under ${folder} in the bundle`)
      continue
    }
    const allowed = new Set(moduleBuiltins[id])
    const seen = new Set<string>()
    const work = [...own]
    while (work.length > 0) {
      const file = work.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const item of inputs[file]?.imports ?? []) {
        if (!item.external) {
          work.push(item.path)
          continue
        }
        if (!isBuiltin(item.path)) problems.push(`${id}: ${item.path} would load at run time, from ${posix(file)}`)
        else if (!allowed.has(named(item.path))) problems.push(`${id}: ${item.path} isn't on its list, from ${posix(file)}`)
      }
    }
    // The ways past an import, in hetu's own files the module takes in. A dependency's code is bounded by its review
    for (const file of [...seen].filter(file => !posix(file).includes('node_modules/')).sort()) {
      let found = reachChecked.get(file)
      if (found === undefined) {
        const { code } = await transform(await read(path.resolve(core, file)), { loader: file.endsWith('.ts') ? 'ts' : 'js', format: 'esm' })
        found = checkHostReach(code)
        reachChecked.set(file, found)
      }
      for (const problem of found) problems.push(`${id}: ${problem} in ${posix(file)}, past its list`)
    }
  }
  return [...new Set(problems)].sort()
}
