import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { unpackZip } from '../../backend/plugins-manager/unpack.ts'
import { MIN_FREE_GB, runFacts } from './instance.ts'
import { waitForMemory } from './memory.ts'
import { baselineFile, check, MEASURES, notesFolder, prepare, readBaseline, summarize, timedRun, type Baseline, type Sample } from './timing.ts'

const RUNS = 5

describe('tier 0 timing', () => {
  it(`starts, opens the first note and quits ${RUNS} times cold and warm on the shipped plugins and stays within the baseline`, async context => {
    const facts = await runFacts()
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hetu-tier0-timing-'))
    context.onTestFinished(({ task }) => task.result?.state === 'fail' ? undefined : rm(folder, { recursive: true, force: true, maxRetries: 5 }))
    const unpacked = path.join(folder, 'unpacked')
    await mkdir(unpacked)
    const staged = await unpackZip(await readFile(facts.plugins.zip), unpacked)
    if (staged.problem !== null) throw new Error(`the plugin zip didn't unpack: ${staged.problem}`)
    // The shipped profile: every plugin but mcp, whose door's fixed port and pipe two instances can't share
    const ids = (await readdir(unpacked)).filter(id => id !== 'mcp').sort()

    const samples: Sample[] = []
    for (let run = 0; run < RUNS; run++) {
      const memory = await waitForMemory({ floor: MIN_FREE_GB, waitMs: 20_000 })
      if (!memory.ok) context.skip(`skipped for memory: ${memory.free.toFixed(2)} GB free, under the ${MIN_FREE_GB} GB an instance needs`)
      const data = path.join(folder, `${run}`, 'data')
      const notes = path.join(folder, `${run}`, 'notes')
      await mkdir(notes, { recursive: true })
      await prepare(data, notes, unpacked, ids, notesFolder())
      // Cold then warm on the same folder, so a busy spell on the machine falls on both kinds alike
      samples.push(await timedRun(data, 'cold', 'Welcome', 'Start here.'))
      samples.push(await timedRun(data, 'warm', 'Welcome', 'Start here.'))
    }

    const summary = summarize(samples)
    const baseline = await readBaseline()
    const record = { build: facts.build, os: facts.os, plugins: { commit: facts.plugins.commit, sha256: facts.plugins.sha256, ids }, measures: MEASURES, baseline: { file: baselineFile(), ...baseline }, samples, summary }
    const kept = process.env.HETU_TIER0_RUN ?? folder
    await writeFile(path.join(kept, `timing-${Date.now()}.json`), `${JSON.stringify(record, null, 2)}\n`)
    console.log(Object.entries(summary).map(([name, { values, median, spread }]) => `${name}: median ${median} ms, spread ${spread} ms (${values.join(', ')})`).join('\n'))
    if (baseline.status === 'pending') console.warn(`tier 0 timing: the baseline in ${baselineFile()} is pending, nothing checked`)
    const failures = check(baseline, summary)
    expect(failures, failures.join('\n')).toEqual([])
  }, 230_000)

  it('fails a measure past its baseline times the factor, naming the baseline, the value and the factor, and checks nothing while pending', () => {
    const summary = summarize([
      { kind: 'cold', ms: { ready: 700, shown: 2100, firstNote: 90, quit: 1000 }, stoppingMs: 5, freeGb: 4, load: 2, others: 1 },
      { kind: 'cold', ms: { ready: 720, shown: 2050, firstNote: 80, quit: 1100 }, stoppingMs: 5, freeGb: 4, load: 2, others: 1 },
      { kind: 'cold', ms: { ready: 690, shown: 2000, firstNote: 85, quit: 1050 }, stoppingMs: 5, freeGb: 4, load: 2, others: 1 },
    ])
    expect(summary['cold.shown']).toEqual({ values: [2100, 2050, 2000], median: 2050, spread: 100 })
    const set: Baseline = { status: 'set', factor: 1.5, measures: { 'cold.ready': 700, 'cold.shown': 600, 'cold.firstNote': 90 } }
    expect(check(set, summary)).toEqual([
      'cold.shown: 2050 ms, past its baseline 600 ms × 1.5 = 900 ms',
      'cold.quit: 1050 ms with no baseline',
    ])
    expect(check({ status: 'pending' }, summary)).toEqual([])
  })
})
