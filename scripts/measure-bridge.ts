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
// ranges counts the editor.viewport events the marking plugin heard while the keys were typed
export type Run = { typed: Summary, marked: Summary, load?: Record<string, number>, ranges?: number }
export const LOADS = ['view', 'flood', 'search'] as const
export type Load = typeof LOADS[number]
export type RunName = 'quiet' | Load
export const RUNS: readonly RunName[] = ['quiet', ...LOADS]
// One app started, the quiet run and each load in turn
export type Sitting = Record<RunName, Run>

export type Kept = { repeats: number[], median: number, spread: boolean }
export type Verdict = {
  // typed and marked keep the 95th percentiles of the repeats, typedMedian and markedMedian their medians
  runs: Record<RunName, { typed: Kept, marked: Kept, typedMedian: Kept, markedMedian: Kept }>
  // The median of a load's 95th percentiles over the quiet run's median
  ratios: Record<Load, number>
  // Whether every repeat held the load within twice its own quiet run
  meets: Record<Load, boolean>
  // What each load did in each repeat, so a run is seen to have been loaded
  loads: Record<Load, Record<string, number[]>>
  // The marking plugin's viewport events in each run of each repeat, null when the sittings counted none
  ranges: Record<RunName, number[]> | null
}

// Under a load, the 95th percentile from a key to its text stays within twice the quiet run's of the same sitting
export const RATIO = 2

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

export const within = (quiet: number, loaded: number) => loaded <= RATIO * quiet

// Each load of one sitting against the quiet run of that sitting, by the 95th percentile from a key to its text
export function held(sitting: Sitting): Record<Load, { ratio: number, within: boolean }> {
  const quiet = sitting.quiet.typed.p95
  return Object.fromEntries(LOADS.map(load => {
    const loaded = sitting[load].typed.p95
    return [load, { ratio: loaded / quiet, within: within(quiet, loaded) }]
  })) as Record<Load, { ratio: number, within: boolean }>
}

export function verdict(sittings: Sitting[]): Verdict {
  const runs = Object.fromEntries(RUNS.map(name => [name, {
    typed: kept(sittings.map(sitting => sitting[name].typed.p95)),
    marked: kept(sittings.map(sitting => sitting[name].marked.p95)),
    typedMedian: kept(sittings.map(sitting => sitting[name].typed.median)),
    markedMedian: kept(sittings.map(sitting => sitting[name].marked.median)),
  }])) as Verdict['runs']
  const quiet = runs.quiet.typed.median
  const ratios = Object.fromEntries(LOADS.map(load => [load, runs[load].typed.median / quiet])) as Record<Load, number>
  const meets = Object.fromEntries(LOADS.map(load => [load, sittings.every(sitting => held(sitting)[load].within)])) as Record<Load, boolean>
  const loads = Object.fromEntries(LOADS.map(load => {
    const names = [...new Set(sittings.flatMap(sitting => Object.keys(sitting[load].load ?? {})))]
    return [load, Object.fromEntries(names.map(name => [name, sittings.map(sitting => sitting[load].load?.[name] ?? 0)]))]
  })) as Verdict['loads']
  const counted = sittings.some(sitting => RUNS.some(name => sitting[name].ranges !== undefined))
  const ranges = counted ? Object.fromEntries(RUNS.map(name => [name, sittings.map(sitting => sitting[name].ranges ?? 0)])) as Record<RunName, number[]> : null
  return { runs, ratios, meets, loads, ranges }
}

export type Conditions = { title: string, commit: string, when: string, cpus: number, model: string, conditions: string }

const ms = (value: number) => value.toFixed(1)

const what: Record<RunName, string> = {
  quiet: 'no other traffic',
  view: "a plugin's view of 100 rows redrawn ten times a second beside the note",
  flood: 'a second plugin sending decorations of 2,500 marks back to back, past the 20,000 marks a second the drawer takes',
  search: 'the 469 notes of the folder rewritten in turn and each read again by a plugin indexing them, as search does',
}

// One sitting's section: each run's 95th percentile and median in ms, key to text and key to mark, with the ratio
// of the median of its 95th percentiles to the quiet run's and whether each repeat held the bar
export function report(at: Conditions, result: Verdict): string {
  const lines = [
    `## ${at.title}`,
    '',
    `Commit ${at.commit}, ${at.when}. ${at.cpus} logical CPUs (${at.model}). ${at.conditions}`,
    '',
    'Each run types 100 keys at the end of a note of 2,000 list items each with a link and bold text, then a plain last line, while a plugin marks each key typed. Key to text is from the key event to its character on screen, key to mark to the plugin\'s mark on it. Three repeats, each one app with the quiet run and the three loads in turn, the median of the repeats kept',
    '',
    'The bar: under each load the 95th percentile from a key to its text stays within twice the quiet run\'s of the same repeat. The last column says whether each repeat held it. The ratio is the median of the three 95th percentiles of a load over the quiet run\'s',
    '',
    ...RUNS.map(name => `- ${name}: ${what[name]}`),
    '',
    'From a key to its text, ms: the 95th percentile and the median of each repeat, then the median of the repeats',
    '',
    '| run | 95th percentile, repeats | 95th percentile | median, repeats | median | ratio of the medians to quiet | each repeat within the bar |',
    '|---|---|---|---|---|---|---|',
    ...RUNS.map(name => {
      const { typed, typedMedian } = result.runs[name]
      const ratio = name === 'quiet' ? '' : result.ratios[name].toFixed(2)
      const meets = name === 'quiet' ? '' : result.meets[name] ? 'yes' : 'no'
      const spread = typed.spread ? `${meets === '' ? '' : `${meets}, `}repeats spread` : meets
      return `| ${name} | ${typed.repeats.map(ms).join(', ')} | ${ms(typed.median)} | ${typedMedian.repeats.map(ms).join(', ')} | ${ms(typedMedian.median)} | ${ratio} | ${spread} |`
    }),
    '',
    'From a key to the plugin\'s mark, ms',
    '',
    '| run | 95th percentile, repeats | 95th percentile | median, repeats | median |',
    '|---|---|---|---|---|',
    ...RUNS.map(name => {
      const { marked, markedMedian } = result.runs[name]
      return `| ${name} | ${marked.repeats.map(ms).join(', ')} | ${ms(marked.median)} | ${markedMedian.repeats.map(ms).join(', ')} | ${ms(markedMedian.median)} |`
    }),
    '',
    'What each load did in each repeat',
    '',
    ...LOADS.map(load => `- ${load}: ${Object.entries(result.loads[load]).map(([name, each]) => `${name} ${each.join(', ')}`).join(', ')}`),
    ...result.ranges === null ? [] : [`- editor.viewport events the marking plugin heard while the keys were typed: ${RUNS.map(name => `${name} ${result.ranges![name].join(', ')}`).join(', ')}`],
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
      // The test writes its numbers before it holds the loads to the bar, so a repeat past the bar is kept too
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null) process.exit(status === 0 ? 1 : status ?? 1)
      if (status !== 0) console.log(`repeat ${i + 1} failed past its numbers, kept`)
      sittings.push(JSON.parse(text) as Sitting)
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
