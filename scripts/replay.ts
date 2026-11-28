// Replays past faults against tier 0: `node scripts/replay.ts <fault|all> [--ref <ref>] [--baseline <file>] [--no-main]`.
// main first, then each fault on a throwaway copy: a git worktree of hetu at the ref and, for a plugin fault, a copy of
// the plugins checkout, each fault planted, then packed and run through the copy's own npm run tier0. A test that
// fails on the fault and passed on main caught it. The copies go, the reports, logs and kept traces stay under
// dist-package/replay with a summary and the recall. A fault that doesn't plant cleanly is refused, naming the conflict
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { faultsNamed, patchFile, type Fault, type Plant } from '../core/test/tier0/faults/faults.ts'
import { failuresOf, outcomeOf, refused, summaryOf, type Outcome, type Report, type Run } from '../core/test/tier0/faults/outcome.ts'
import { pluginsDir } from '../core/test/tier0/instance.ts'
import { passReport, PASSES } from '../core/test/tier0/passes.ts'

const repo = path.join(import.meta.dirname, '..')
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args.splice(at, 2)[1]
}
const ref = option('--ref') ?? 'HEAD'
const baseline = option('--baseline')
const withMain = !args.includes('--no-main')
const named = args.find(arg => !arg.startsWith('--'))
if (named === undefined) throw new Error('name a fault or all')
const chosen = faultsNamed(named)
const commit = git(repo, 'rev-parse', '--short', `${ref}^{commit}`).trim()

class Refusal extends Error {}

const describePlant = (plant: Plant) => 'revert' in plant
  ? `${plant.repo} revert ${plant.revert}${plant.paths === undefined ? '' : ` on ${plant.paths.join(', ')}`}`
  : `${plant.repo} patch ${plant.patch}`

// A plant goes in through git apply's three-way merge, as git revert would, and anything it can't merge is refused
function plant(dir: string, what: Plant): void {
  // A copied checkout's index holds the stat of the files it was copied from
  spawnSync('git', ['-C', dir, 'update-index', '-q', '--refresh'])
  const input = 'revert' in what ? git(dir, 'diff', what.revert, `${what.revert}^`, '--', ...(what.paths ?? [])) : readFileSync(patchFile(what.patch))
  const applied = spawnSync('git', ['-C', dir, 'apply', '--3way', '--whitespace=nowarn'], { input, encoding: 'utf8' })
  const unmerged = git(dir, 'diff', '--name-only', '--diff-filter=U').trim()
  if (applied.status !== 0 || unmerged !== '') {
    const said = `${applied.stderr}`.split('\n').filter(line => /conflict|error|does not/i.test(line)).join(', ')
    throw new Refusal(`${describePlant(what)} doesn't apply cleanly: ${said || unmerged || 'git apply failed'}`)
  }
}

// node_modules cloned in place of installed, as copy-on-write on APFS, so a copy costs seconds
function cloneTree(from: string, to: string): void {
  if (process.platform === 'darwin') execFileSync('cp', ['-cR', from, to])
  else execFileSync('cp', ['-R', from, to])
}

function quietRun(command: string, argv: string[], cwd: string, log: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const out = openSync(log, 'a')
  return new Promise(resolve => {
    const child = spawn(command, argv, { cwd, env, stdio: ['ignore', out, out] })
    child.on('close', code => resolve(code ?? 1))
  })
}

const out = path.join(repo, 'dist-package', 'replay', new Date().toISOString().replace(/[:.]/g, '-'))
await mkdir(out, { recursive: true })
console.log(`replay of ${chosen.map(fault => fault.name).join(', ')} on ${commit} into ${out}`)

// One run: the copies made, the fault planted when given, the plugins built and packed when changed, tier 0 run.
// What it ran and its report are kept in folder, the copies removed whatever happened
async function replay(fault: Fault | null, folder: string): Promise<Run> {
  await mkdir(folder, { recursive: true })
  const log = path.join(folder, 'run.log')
  // The real path, as vitest names its files by it
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hetu-replay-')))
  const copy = path.join(scratch, 'hetu')
  let plugins = pluginsDir()
  try {
    git(repo, 'worktree', 'add', '--detach', copy, commit)
    for (const modules of ['node_modules', 'core/node_modules', 'core/sdk/node_modules']) {
      if (existsSync(path.join(repo, modules))) cloneTree(path.join(repo, modules), path.join(copy, modules))
    }
    const plants = fault?.plants ?? []
    for (const each of plants.filter(one => one.repo === 'hetu')) plant(copy, each)
    for (const test of fault?.tests ?? []) {
      if (!existsSync(path.join(copy, 'core', 'test', 'tier0', test))) throw new Refusal(`${commit} has no ${test}, which needs ${fault?.needs ?? 'a later step'}: run with --ref on a branch that has it`)
    }
    if (plants.some(one => one.repo === 'plugins')) {
      plugins = path.join(scratch, 'plugins')
      cloneTree(pluginsDir(), plugins)
      for (const each of plants.filter(one => one.repo === 'plugins')) plant(plugins, each)
      for (const step of ['build.ts', 'pack.ts']) {
        if (await quietRun(process.execPath, [step], plugins, log) !== 0) throw new Refusal(`the plugins copy didn't ${step === 'build.ts' ? 'build' : 'pack'}, see ${log}`)
      }
    }
    const report = path.join(folder, 'report.json')
    const env = { ...process.env, HETU_PLUGINS_DIR: plugins, ...(baseline === undefined ? {} : { HETU_TIER0_BASELINE: path.resolve(baseline) }) }
    const started = Date.now()
    await quietRun(process.execPath, ['scripts/tier0.ts', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...(fault?.tests ?? [])], copy, log, env)
    // Each pass writes its own report, read together as one run
    const testResults: Report['testResults'] = []
    for (const pass of PASSES) {
      const read = await readFile(passReport(report, pass), 'utf8').catch(() => null)
      if (read === null) throw new Refusal(`tier 0's ${pass} pass wrote no report, see ${log}`)
      testResults.push(...(JSON.parse(read) as Report).testResults)
    }
    console.log(`  ${fault?.name ?? 'main'}: tier 0 ran in ${Math.round((Date.now() - started) / 1000)} s`)
    return failuresOf({ testResults }, path.join(copy, 'core', 'test', 'tier0'))
  } finally {
    // The run folders hold only failed instances' traces and folders and passed ones' records
    const runs = path.join(copy, 'dist-package', 'tier0')
    if (existsSync(runs)) await cp(runs, path.join(folder, 'tier0'), { recursive: true }).catch(() => undefined)
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', copy])
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 })
    spawnSync('git', ['-C', repo, 'worktree', 'prune'])
  }
}

let main: Run | null = null
if (withMain) {
  main = await replay(null, path.join(out, 'main'))
  console.log(`  main: ${main.passed} passed, ${main.failed.length} failed`)
}
const outcomes: Outcome[] = []
for (const fault of chosen) {
  const how = fault.plants.map(describePlant).join(' and ')
  try {
    const outcome = outcomeOf(fault.name, how, await replay(fault, path.join(out, fault.name)), main?.failed ?? null)
    outcomes.push(outcome)
    console.log(`  ${fault.name}: ${outcome.state}${outcome.caughtBy.length > 0 ? ` by ${outcome.caughtBy.map(failed => failed.file).join(', ')}` : ''}`)
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    outcomes.push(refused(fault.name, how, err.message))
    console.log(`  ${fault.name}: refused, ${err.message}`)
  }
}
const summary = `# tier 0 replay on ${commit}${ref === 'HEAD' ? '' : ` (${ref})`}\n\n${summaryOf(outcomes, main)}`
await writeFile(path.join(out, 'summary.md'), summary)
await writeFile(path.join(out, 'summary.json'), `${JSON.stringify({ commit, ref, main, outcomes }, null, 2)}\n`)
console.log(summary)
