// Replays past faults against tier 0: `node scripts/replay.ts <fault|all> [--ref <ref>] [--baseline <file>] [--no-main]`.
// Each run is on a throwaway copy: a git worktree of hetu at the ref, packed and run through the copy's own npm run
// tier0, with plugins built and packed fresh from a clone of the plugins checkout, unplanted for main and every hetu
// fault, planted for a plugin fault. main runs twice and must be green both times but for a known red, else the replay
// stops with no recall. A fault's failing tests run again on its copy and only one failing both times caught it. A
// fault that doesn't plant cleanly, a file that doesn't load and a run of no test refuse the fault. The copies go, the
// reports, logs and kept traces stay under dist-package/replay with a summary and the recall. --no-main runs each
// fault once and lists its failures with no recall
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { faultsNamed, knownReds, patchFile, type Fault, type Plant } from '../core/test/tier0/faults/faults.ts'
import { failuresOf, mainVerdict, outcomeOf, refused, rerunArgs, summaryOf, toRerun, type MainReport, type Outcome, type Report, type Run } from '../core/test/tier0/faults/outcome.ts'
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
const title = `# tier 0 replay on ${commit}${ref === 'HEAD' ? '' : ` (${ref})`}`

// The summary written as it stands, so a replay that stops early still leaves what it saw
async function writeSummary(text: string, json: object): Promise<void> {
  await writeFile(path.join(out, 'summary.md'), `${title}\n\n${text}`)
  await writeFile(path.join(out, 'summary.json'), `${JSON.stringify({ commit, ref, ...json }, null, 2)}\n`)
  console.log(`${title}\n\n${text}`)
}

// A clone of the plugins checkout with plants when given, built and packed as the release is
async function pluginsBuilt(into: string, plants: readonly Plant[], log: string): Promise<string> {
  cloneTree(pluginsDir(), into)
  for (const each of plants) plant(into, each)
  for (const step of ['build.ts', 'pack.ts']) {
    if (await quietRun(process.execPath, [step], into, log) !== 0) throw new Refusal(`the plugins copy didn't ${step === 'build.ts' ? 'build' : 'pack'}, see ${log}`)
  }
  return into
}

type Copy = { copy: string, scratch: string, plugins: string, log: string, folder: string }

// One copy: hetu at the ref with the fault's hetu plants, and the plugins a plugin fault plants or else the control
async function made(fault: Fault | null, folder: string, control: string): Promise<Copy> {
  await mkdir(folder, { recursive: true })
  const log = path.join(folder, 'run.log')
  // The real path, as vitest names its files by it
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hetu-replay-')))
  const copy = path.join(scratch, 'hetu')
  const result = { copy, scratch, plugins: control, log, folder }
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
    const pluginPlants = plants.filter(one => one.repo === 'plugins')
    if (pluginPlants.length > 0) result.plugins = await pluginsBuilt(path.join(scratch, 'plugins'), pluginPlants, log)
    return result
  } catch (err) {
    await removed(result)
    throw err
  }
}

// The copies go, the run folders kept: only failed instances' traces and folders and passed ones' records
async function removed({ copy, scratch, folder }: Copy): Promise<void> {
  const runs = path.join(copy, 'dist-package', 'tier0')
  if (existsSync(runs)) await cp(runs, path.join(folder, 'tier0'), { recursive: true }).catch(() => undefined)
  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', copy])
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 })
  spawnSync('git', ['-C', repo, 'worktree', 'prune'])
}

// One run of tier 0 on a copy, packed on the first and reused after, its two passes' reports read as one run. vitest
// writes a pass's report even when its filter matches none of the pass's files, so a missing one means the pass
// stopped before it reported
async function tier0(on: Copy, name: string, filters: readonly string[], reuse: boolean): Promise<Run> {
  const report = path.join(on.folder, `report-${name}.json`)
  const env = { ...process.env, HETU_PLUGINS_DIR: on.plugins, ...(baseline === undefined ? {} : { HETU_TIER0_BASELINE: path.resolve(baseline) }) }
  const started = Date.now()
  await quietRun(process.execPath, ['scripts/tier0.ts', ...(reuse ? ['--reuse'] : []), '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, ...filters], on.copy, on.log, env)
  const testResults: Report['testResults'] = []
  for (const pass of PASSES) {
    const read = await readFile(passReport(report, pass), 'utf8').catch(() => null)
    if (read === null) throw new Refusal(`tier 0's ${pass} pass of the ${name} run wrote no report${filters.length > 0 ? ` for ${filters.join(' ')}` : ''}, so it stopped before reporting: see ${on.log}`)
    testResults.push(...(JSON.parse(read) as Report).testResults)
  }
  console.log(`  ${path.basename(on.folder)} ${name}: tier 0 ran in ${Math.round((Date.now() - started) / 1000)} s`)
  return failuresOf({ testResults }, path.join(on.copy, 'core', 'test', 'tier0'))
}

// The whole replay, answering its exit code. A stop before the faults writes why as the summary
async function replayAll(scratchRoot: string): Promise<number> {
  let control: string
  try {
    control = await pluginsBuilt(path.join(scratchRoot, 'plugins'), [], path.join(out, 'control.log'))
  } catch (err) {
    if (!(err instanceof Refusal)) throw err
    await writeSummary(`The unplanted plugins didn't build, so nothing ran and nothing is counted: ${err.message}\n`, { stopped: err.message })
    return 1
  }

  let main: MainReport | null = null
  if (withMain) {
    const runs: Run[] = []
    try {
      const copy = await made(null, path.join(out, 'main'), control)
      try {
        for (const name of ['first', 'second']) runs.push(await tier0(copy, name, [], name !== 'first'))
      } finally {
        await removed(copy)
      }
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      await writeSummary(`main didn't run through, so nothing is counted and there is no recall: ${err.message}\n`, { stopped: err.message, main: runs })
      return 1
    }
    const verdict = mainVerdict(runs, knownReds)
    if (!verdict.green) {
      await writeSummary(`main isn't green, so no fault ran and there is no recall:\n${verdict.why.map(line => `- ${line}`).join('\n')}\n`, { stopped: 'main not green', main: runs })
      return 1
    }
    main = { runs, known: verdict.known }
    console.log(`  main: green in both runs${verdict.known.length > 0 ? `, ${verdict.known.length} known red` : ''}`)
  }

  const outcomes: Outcome[] = []
  for (const fault of chosen) {
    const how = fault.plants.map(describePlant).join(' and ')
    const named = { name: fault.name, how, expected: fault.expected }
    try {
      const copy = await made(fault, path.join(out, fault.name), control)
      try {
        const first = await tier0(copy, 'first', fault.tests ?? [], false)
        const again = main === null ? [] : toRerun(first, main.known)
        const rerun = again.length > 0 && first.failed.every(failed => failed.test !== '(the file)') ? await tier0(copy, 'again', rerunArgs(again), true) : null
        outcomes.push(outcomeOf(named, first, rerun, main?.known ?? null))
      } finally {
        await removed(copy)
      }
    } catch (err) {
      if (!(err instanceof Refusal)) throw err
      outcomes.push(refused(fault.name, how, err.message))
    }
    const outcome = outcomes.at(-1)!
    const files = [...new Set(outcome.caughtBy.map(failed => failed.file))]
    console.log(`  ${fault.name}: ${outcome.state}${files.length > 0 ? ` by ${files.join(', ')}` : ''}${outcome.reason === undefined ? '' : `, ${outcome.reason}`}`)
  }
  await writeSummary(summaryOf(outcomes, main), { main, outcomes })
  return 0
}

const scratchRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hetu-replay-control-')))
try {
  process.exitCode = await replayAll(scratchRoot)
} finally {
  await rm(scratchRoot, { recursive: true, force: true, maxRetries: 5 })
}
