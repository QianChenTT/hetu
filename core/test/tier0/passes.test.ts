// Each tier 0 pass writes its own report, so the timing pass never takes the place of the main pass's report
import { describe, expect, it } from 'vitest'
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
})
