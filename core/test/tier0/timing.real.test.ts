import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { unpackZip } from '../../backend/plugins-manager/unpack.ts'
import type { Quieted } from '../drive.ts'
import { MIN_FREE_GB, runFacts } from './instance.ts'
import { waitForMemory } from './memory.ts'
import { baselineFile, check, DRIVEN, MEASURES, mediansLine, notesFolder, prepare, readBaseline, summarize, timedRun, type Sample } from './timing.ts'

const RUNS = 5

describe('tier 0 timing', () => {
  it(`starts, opens the first note and quits ${RUNS} times cold and warm on the shipped plugins and stays within the baseline`, async context => {
    // A baseline that can't serve fails before a run is spent on it
    const baseline = await readBaseline()
    const unusable = check(baseline, {})
    expect(unusable, unusable.join('\n')).toEqual([])
    const facts = await runFacts()
    const folder = await mkdtemp(path.join(os.tmpdir(), 'hetu-tier0-timing-'))
    context.onTestFinished(({ task }) => task.result?.state === 'fail' ? undefined : rm(folder, { recursive: true, force: true, maxRetries: 5 }))
    const unpacked = path.join(folder, 'unpacked')
    await mkdir(unpacked)
    const staged = await unpackZip(await readFile(facts.plugins.zip), unpacked)
    if (staged.problem !== null) throw new Error(`the plugin zip didn't unpack: ${staged.problem}`)
    // The shipped profile: every plugin but mcp, whose door's fixed port and pipe two instances can't share
    const ids = (await readdir(unpacked)).filter(id => id !== 'mcp').sort()

    // The record is written again after every sample, so a run cut short keeps what it timed
    const samples: Sample[] = []
    let quiet: Quieted | null = null
    const recorded = path.join(process.env.HETU_TIER0_RUN ?? folder, `timing-${Date.now()}.json`)
    const record = async (extra: Record<string, unknown> = {}) => writeFile(recorded, `${JSON.stringify({
      build: facts.build, os: facts.os, plugins: { commit: facts.plugins.commit, sha256: facts.plugins.sha256, ids },
      ...DRIVEN, quiet, measures: MEASURES, baseline: { file: baselineFile(), ...baseline }, samples, summary: summarize(samples), ...extra,
    }, null, 2)}\n`)

    for (let run = 0; run < RUNS; run++) {
      const memory = await waitForMemory({ floor: MIN_FREE_GB, waitMs: 20_000 })
      if (!memory.ok) {
        const reason = `skipped for memory: ${memory.free.toFixed(2)} GB free, under the ${MIN_FREE_GB} GB an instance needs, ${2 * (RUNS - run)} of ${2 * RUNS} samples not taken`
        await record({ skipped: reason })
        context.skip(reason)
      }
      const data = path.join(folder, `${run}`, 'data')
      const notes = path.join(folder, `${run}`, 'notes')
      await mkdir(notes, { recursive: true })
      await prepare(data, notes, unpacked, ids, notesFolder())
      // Cold then warm on the same folder, so a busy spell on the machine falls on both kinds alike
      for (const kind of ['cold', 'warm'] as const) {
        const timed = await timedRun(context, data, kind, 'Welcome', 'Start here.')
        samples.push(timed.sample)
        quiet = timed.quiet
        await record()
      }
    }

    const summary = summarize(samples)
    console.log(`tier 0 timing medians (ms): ${mediansLine(summary)}`)
    const rose = samples.flatMap((sample, index) => sample.othersRose ? [`${index + 1} (${sample.kind})`] : [])
    if (rose.length > 0) console.warn(`tier 0 timing: other Electron processes rose during samples ${rose.join(', ')}`)
    if (baseline.status === 'pending') console.warn(`tier 0 timing: the baseline in ${baselineFile()} is pending, nothing checked`)
    const failures = check(baseline, summary)
    expect(failures, failures.join('\n')).toEqual([])
  }, 230_000)
})
