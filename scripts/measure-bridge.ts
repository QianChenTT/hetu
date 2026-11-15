// Measures the editor bridge: 100 keys typed into a large note, each timed from the key to its text on screen and to a
// plugin's mark on it, with nothing else running and under three loads, three times in one sitting. Writes the numbers
// to a dated file under docs/measurements, a new section for each sitting
//   npm run measure:bridge -- --title "<heading>" --conditions "<what else ran on the machine>"
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

export type Summary = { median: number, p95: number, max: number }
export type Run = { typed: Summary, marked: Summary, load?: Record<string, number> }
export const LOADS = ['view', 'flood', 'search'] as const
export type Load = typeof LOADS[number]
export type RunName = 'quiet' | Load
export const RUNS: readonly RunName[] = ['quiet', ...LOADS]
// One app started, the quiet run and each load in turn
export type Sitting = Record<RunName, Run>

export type Kept = { repeats: number[], median: number, spread: boolean }
export type Verdict = {
  runs: Record<RunName, { typed: Kept, marked: Kept }>
  ratios: Record<Load, number>
  meets: Record<Load, boolean>
  // What each load did in each repeat, so a run is seen to have been loaded
  loads: Record<Load, Record<string, number[]>>
}

// Under a load, the 95th percentile from a key to its text stays within twice the quiet run's and within a frame
export const RATIO = 2
export const FRAME_MS = 16

const nearest = (sorted: number[], share: number) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]

// By nearest rank, so for 100 keys the 50th, the 95th and the 100th
export function summary(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: nearest(sorted, 0.5), p95: nearest(sorted, 0.95), max: sorted[sorted.length - 1] }
}

// The median of the repeats, spread when they lie further apart than half of it
export function kept(repeats: number[]): Kept {
  const median = nearest([...repeats].sort((a, b) => a - b), 0.5)
  return { repeats, median, spread: Math.max(...repeats) - Math.min(...repeats) > median / 2 }
}

export const within = (quiet: number, loaded: number) => loaded <= RATIO * quiet && loaded <= FRAME_MS

export function verdict(sittings: Sitting[]): Verdict {
  const runs = Object.fromEntries(RUNS.map(name => [name, {
    typed: kept(sittings.map(sitting => sitting[name].typed.p95)),
    marked: kept(sittings.map(sitting => sitting[name].marked.p95)),
  }])) as Verdict['runs']
  const quiet = runs.quiet.typed.median
  const ratios = Object.fromEntries(LOADS.map(load => [load, runs[load].typed.median / quiet])) as Record<Load, number>
  const meets = Object.fromEntries(LOADS.map(load => [load, within(quiet, runs[load].typed.median)])) as Record<Load, boolean>
  const loads = Object.fromEntries(LOADS.map(load => {
    const names = [...new Set(sittings.flatMap(sitting => Object.keys(sitting[load].load ?? {})))]
    return [load, Object.fromEntries(names.map(name => [name, sittings.map(sitting => sitting[load].load?.[name] ?? 0)]))]
  })) as Verdict['loads']
  return { runs, ratios, meets, loads }
}

export type Conditions = { title: string, commit: string, when: string, cpus: number, model: string, conditions: string }

const ms = (value: number) => value.toFixed(1)

const what: Record<RunName, string> = {
  quiet: 'no other traffic',
  view: "a plugin's view of 100 rows redrawn ten times a second beside the note",
  flood: 'a second plugin sending decorations of 2,500 marks back to back, past the 20,000 marks a second the drawer takes',
  search: 'the 469 notes of the folder rewritten in turn and indexed again by search',
}

// One sitting's section: each run's 95th percentiles in ms, key to text and key to mark, the ratio to the quiet run
export function report(at: Conditions, result: Verdict): string {
  const lines = [
    `## ${at.title}`,
    '',
    `Commit ${at.commit}, ${at.when}. ${at.cpus} logical CPUs (${at.model}). ${at.conditions}`,
    '',
    'Each run types 100 keys at the end of a note of 2,000 list items, each with a link and bold text, and a plain last line, while a plugin marks each key typed. Key to text is from the key event to its character on screen, key to mark to the plugin\'s mark on it. Three repeats, the median kept',
    '',
    ...RUNS.map(name => `- ${name}: ${what[name]}`),
    '',
    '95th percentile from a key to its text, ms',
    '',
    '| run | repeats | median | ratio to quiet | within the bar |',
    '|---|---|---|---|---|',
    ...RUNS.map(name => {
      const typed = result.runs[name].typed
      const ratio = name === 'quiet' ? '' : result.ratios[name].toFixed(2)
      const meets = name === 'quiet' ? '' : result.meets[name] ? 'yes' : 'no'
      const spread = typed.spread ? `${meets === '' ? '' : `${meets}, `}repeats spread` : meets
      return `| ${name} | ${typed.repeats.map(ms).join(', ')} | ${ms(typed.median)} | ${ratio} | ${spread} |`
    }),
    '',
    '95th percentile from a key to the plugin\'s mark, ms',
    '',
    '| run | repeats | median |',
    '|---|---|---|',
    ...RUNS.map(name => `| ${name} | ${result.runs[name].marked.repeats.map(ms).join(', ')} | ${ms(result.runs[name].marked.median)} |`),
    '',
    'What each load did in each repeat',
    '',
    ...LOADS.map(load => `- ${load}: ${Object.entries(result.loads[load]).map(([name, each]) => `${name} ${each.join(', ')}`).join(', ')}`),
    '',
  ]
  return lines.join('\n')
}

const repo = path.join(import.meta.dirname, '..')
const run = (command: string, cwd: string, env: Record<string, string> = {}) =>
  spawnSync(command, { cwd, shell: true, stdio: 'inherit', env: { ...process.env, ...env } }).status

const TEST = 'measures the bridge from a key to the text and to a decoration, quiet and under three loads'

if (import.meta.main) {
  const { values } = parseArgs({ options: { title: { type: 'string' }, conditions: { type: 'string' }, repeats: { type: 'string' } } })
  if (run('npm run build:main', repo) !== 0) process.exit(1)
  const dir = await mkdtemp(path.join(tmpdir(), 'hetu-measure-'))
  const sittings: Sitting[] = []
  try {
    for (let i = 0; i < Number(values.repeats ?? 3); i++) {
      const file = path.join(dir, `${i}.json`)
      // Windows only runs npx through a shell. One fixed command string, the file reaching the test through the environment
      const status = run(`npx vitest run --config test/e2e/vitest.config.ts test/e2e/drawer.test.ts -t "${TEST}"`, path.join(repo, 'core'), { HETU_MEASURE: file })
      if (status !== 0) process.exit(status ?? 1)
      sittings.push(JSON.parse(await readFile(file, 'utf8')) as Sitting)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const now = new Date()
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim() !== ''
  const section = report({
    title: values.title ?? now.toISOString(),
    commit: dirty ? `${commit} with changes not committed` : commit,
    when: now.toISOString(),
    cpus: cpus().length,
    model: cpus()[0]?.model.trim() ?? 'unknown',
    conditions: values.conditions ?? '',
  }, verdict(sittings))
  // The date where the machine is
  const file = path.join(repo, 'docs', 'measurements', `bridge-${now.toLocaleDateString('sv-SE')}.md`)
  await mkdir(path.dirname(file), { recursive: true })
  const before = await readFile(file, 'utf8').catch(() => '# The editor bridge under load\n')
  await writeFile(file, `${before}\n${section}`)
  console.log(section)
  console.log(`written to ${file}`)
}
