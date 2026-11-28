// Tier 0: packs the driven build and stamps what it was packed from, or with --reuse keeps the one packed if the tree
// is still the one stamped, then runs tier 0's real tests on it with the shipped plugin zip, each instance's record
// under one run folder. Arguments after the options go to vitest, a test file's name among them
import { spawnSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { packageHetu } from '../core/build/package.ts'
import { checkReuse, readBuildStamp, stampBuild, treeState } from '../core/test/tier0/provenance.ts'

const repo = path.join(import.meta.dirname, '..')
const args = process.argv.slice(2)
const reuse = args.includes('--reuse')
const out = path.join(repo, 'dist-package', 'driven')
if (reuse) checkReuse(await readBuildStamp(out), treeState(repo))
else {
  // Read before the pack, which reads the tree as it is then
  const tree = treeState(repo)
  await packageHetu({ target: 'dir', locked: false, out })
  const stamp = await stampBuild(out, repo, false)
  if (stamp.state !== tree.state) throw new Error('the tree changed while it was packed: pack again')
}
const run = path.join(repo, 'dist-package', 'tier0', new Date().toISOString().replace(/[:.]/g, '-'))
await mkdir(run, { recursive: true })
console.log(`tier 0 run folder: ${run}`)
// Node runs vitest's own entry, with no shell between, so an argument reaches vitest as it was given. The timing file
// runs after the rest, alone, and a filter matching no file of a pass passes that pass
const pass = (timing: boolean) => spawnSync(process.execPath, [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'test/tier0/vitest.config.ts', '--passWithNoTests', ...args.filter(arg => arg !== '--reuse')], {
  cwd: path.join(repo, 'core'),
  stdio: 'inherit',
  env: { ...process.env, HETU_TIER0_RUN: run, ...(timing ? { HETU_TIER0_TIMING: '1' } : {}) },
}).status ?? 1
const statuses = [pass(false), pass(true)]
process.exit(statuses.find(status => status !== 0) ?? 0)
