// Each tier 0 pass writes its own report, so the timing pass never takes the place of the main pass's report
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { repo } from './instance.ts'
import { passArgs, passReport, PASSES } from './passes.ts'

describe('tier 0\'s passes', () => {
  it('names a report per pass beside the one asked for', () => {
    expect(PASSES.map(pass => passReport('/runs/F10/report.json', pass))).toEqual(['/runs/F10/report.main.json', '/runs/F10/report.timing.json'])
    expect(passReport('/runs/a.b/report', 'timing')).toBe('/runs/a.b/report.timing')
    expect(passReport('C:\\runs\\a.b\\report', 'main')).toBe('C:\\runs\\a.b\\report.main')
    expect(passReport('/runs/.report', 'main')).toBe('/runs/.report.main')
  })

  it('gives each pass its own report file and leaves every other argument as given', () => {
    const args = ['--reporter=default', '--reporter=json', '--outputFile.json=/r/report.json', 'timing.real.test.ts']
    expect(passArgs(args, 'main')).toEqual(['--reporter=default', '--reporter=json', '--outputFile.json=/r/report.main.json', 'timing.real.test.ts'])
    expect(passArgs(args, 'timing')).toEqual(['--reporter=default', '--reporter=json', '--outputFile.json=/r/report.timing.json', 'timing.real.test.ts'])
    expect(passArgs(['--outputFile', '/r/out.json', '-t', 'T-50'], 'timing')).toEqual(['--outputFile', '/r/out.timing.json', '-t', 'T-50'])
    expect(passArgs(['--outputFile.junit', '/r/out.xml'], 'main')).toEqual(['--outputFile.junit', '/r/out.main.xml'])
    expect(passArgs(['--outputFileX=/r/a.json', '--outputFile'], 'main')).toEqual(['--outputFileX=/r/a.json', '--outputFile'])
  })

  // The replay reads both passes' reports and refuses a fault missing one, so a pass whose filter matches none of its
  // files must still write its report, as F6's timing filter leaves the main pass with nothing to run
  it('writes a pass\'s report when its filter matches none of the pass\'s files', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hetu-pass-'))
    try {
      const report = path.join(dir, 'report.json')
      const ran = spawnSync(process.execPath, [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'test/tier0/vitest.config.ts', '--passWithNoTests', ...passArgs(['--reporter=json', `--outputFile.json=${report}`, 'timing.real.test.ts'], 'main')], {
        cwd: path.join(repo, 'core'), encoding: 'utf8', env: { ...process.env, HETU_TIER0_TIMING: '' },
      })
      expect(ran.status, ran.stderr).toBe(0)
      expect(existsSync(passReport(report, 'main'))).toBe(true)
      expect(JSON.parse(readFileSync(passReport(report, 'main'), 'utf8'))).toMatchObject({ numTotalTests: 0, testResults: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
