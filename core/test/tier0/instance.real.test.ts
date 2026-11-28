import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { heard, ROUTES } from './input.ts'
import { drivenApp, drivenOut, isSerial, pluginsZip, profiles, repo, start, until, watchFrontmost } from './instance.ts'
import { readBuildStamp, treeState } from './provenance.ts'

const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

describe('a tier 0 instance', () => {
  it('opens Welcome and the trusted window twice on the driven build with the shipped plugins, never the active app, and records what happened', async context => {
    const front = watchFrontmost()
    const instance = await start(context, { notes: { 'Welcome.md': '# Welcome\n\nStart here.\n' } })
    const pid = instance.app.process().pid
    const editor = await instance.editor()
    const explorer = () => editor.frames().find(frame => frame.url().includes('file-explorer.views'))
    await until(() => explorer() !== undefined, 'the explorer frame')
    const row = explorer()!.locator('[role=treeitem]', { hasText: 'Welcome' })
    await until(async () => await row.count() === 1, 'the Welcome row')
    await instance.click(row)
    await until(async () => (await editor.locator('#title').innerText()).startsWith('Welcome'), 'Welcome in the note bar')
    expect(await editor.locator('#editors > .editor:not([hidden]) .cm-content').innerText()).toContain('Start here.')

    // The trusted window opened, then focus() called on it by a second press, which is what brought hetu to the front
    // before the quiet launch
    const plugins = editor.getByRole('button', { name: 'Plugins and security' })
    await instance.click(plugins)
    await instance.trusted()
    await instance.app.evaluate(({ BrowserWindow }) => {
      const counted = globalThis as unknown as { focusCalls: number }
      counted.focusCalls = 0
      const focus = BrowserWindow.prototype.focus
      BrowserWindow.prototype.focus = function (this: InstanceType<typeof BrowserWindow>) {
        counted.focusCalls++
        return focus.call(this)
      }
    })
    await instance.click(plugins)
    await until(async () => await instance.app.evaluate(() => (globalThis as unknown as { focusCalls: number }).focusCalls) > 0, 'hetu to call focus() on the trusted window')
    // The OS brought hetu forward 1 to 2.5 s after that call when nothing kept it back, so the watch runs past it
    await new Promise(resolve => setTimeout(resolve, 3000))

    const record = await instance.quit()
    const seen = await front.stop()
    expect(record.exitCode).toBe(0)
    expect(record.quitMs).toBeGreaterThan(0)
    // The build is what was packed, and the tree it was packed from is the one here
    const stamp = await readBuildStamp(drivenOut())
    const tree = treeState(repo)
    expect(record.build).toEqual({ ...stamp, app: drivenApp() })
    expect(record.build.commit).toBe(tree.commit)
    expect(record.build.dirty).toBe(tree.dirty)
    expect(record.os).toEqual({ platform: process.platform, release: os.release(), arch: process.arch })
    expect(record.input).toEqual([ROUTES.mouse])
    expect(record.harness).toEqual([])
    expect(record.focus).toBe('emulated')
    expect(record.quiet).toEqual({ activation: process.platform === 'darwin' ? 'prohibited' : 'not set off macOS', mouse: 'ignored' })
    // The plugins: the zip's own facts, the one installed and the folders hetu held
    expect(record.plugins).toMatchObject({ zip: pluginsZip(), sha256: await sha256(pluginsZip()), sums: 'matches', commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(record.plugins.installed).toEqual({ route: 'approved', zip: pluginsZip(), sha256: record.plugins.sha256 })
    expect(record.plugins.folders).toEqual(record.plugins.ids)
    expect(record.plugins.folders).toContain('file-explorer')
    expect(record.plugins.folders).not.toContain('mcp')
    expect(record).toMatchObject({ profile: 'shipped', serial: false })
    if (process.platform === 'darwin') {
      expect(seen.samples).toBeGreaterThan(30)
      expect(seen.pids).not.toContain(pid)
    }
  })

  it('installs a profile\'s plugins through the trusted window\'s install flow and records the zip it installed', async context => {
    const instance = await start(context, { profile: { name: 'explorer', plugins: ['file-explorer'] }, route: 'install' })
    const editor = await instance.editor()
    await until(() => editor.frames().some(frame => frame.url().includes('file-explorer.views')), 'the installed explorer drawing')
    const profileZip = path.join(instance.folder, 'profile.zip')
    const installed = await sha256(profileZip)
    // Main heard each install press on the trusted window: Install from a zip, Install and the Confirm, some maybe
    // pressed again after main dropped them
    const pressed = await heard(instance.app, 0, { url: 'hetu://trusted/', kind: 'mouse' })
    expect(pressed.filter(input => input.type === 'mouseDown' && !input.prevented).length).toBeGreaterThanOrEqual(3)
    const record = await instance.quit()
    const onTrusted = record.presses.filter(each => each.url === 'hetu://trusted/')
    expect(onTrusted.length).toBeGreaterThanOrEqual(3)
    for (const each of onTrusted) expect(Math.abs(each.heard.x - each.intended.x) + Math.abs(each.heard.y - each.intended.y)).toBeLessThanOrEqual(2)
    expect(record).toMatchObject({ profile: 'explorer', serial: false, exitCode: 0, input: [ROUTES.mouse] })
    expect(record.plugins.installed).toEqual({ route: 'install', zip: profileZip, sha256: installed })
    expect(installed).not.toBe(record.plugins.sha256)
    expect(record.plugins.folders).toEqual(['file-explorer'])
    // Whether the startup window gave its own show differs from run to run, so either answer is recorded as it came
    expect([[], ['emitted show on the trusted window, which had none']]).toContainEqual(record.harness)
  })

  it('keeps a failed test\'s trace and folders, only a passed one\'s record, and skips for memory saying so', async () => {
    const run = await mkdtemp(path.join(os.tmpdir(), 'hetu-tier0-kept-'))
    try {
      const report = path.join(run, 'report.json')
      await promisify(execFile)(process.execPath, [path.join(repo, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'test/tier0/vitest.config.ts', '--reporter=json', `--outputFile=${report}`], {
        cwd: path.join(repo, 'core'), env: { ...process.env, HETU_TIER0_FIXTURES: '1', HETU_TIER0_RUN: run },
      }).catch(() => {
        // One fixture fails on purpose, so the run exits 1. The report says the rest
      })
      const states = (JSON.parse(await readFile(report, 'utf8')) as { testResults: { assertionResults: { title: string, status: string }[] }[] })
        .testResults.flatMap(file => file.assertionResults).map(test => [test.title, test.status])
      expect(Object.fromEntries(states)).toEqual({ passes: 'passed', fails: 'failed', 'waits for memory': 'skipped' })
      const folder = async (prefix: string) => {
        const name = (await readdir(run)).find(entry => entry.startsWith(`${prefix}-`))!
        return { name, files: (await readdir(path.join(run, name))).sort() }
      }
      expect((await folder('kept-pass')).files).toEqual(['record.json'])
      const failed = await folder('kept-fail')
      expect(failed.files).toEqual(['data', 'notes', 'record.json', 'trace.zip'])
      expect(JSON.parse(await readFile(path.join(run, failed.name, 'record.json'), 'utf8')).trace).toBe(path.join(run, failed.name, 'trace.zip'))
      const low = await folder('memory')
      expect(low.files).toEqual(['skipped.json'])
      expect(JSON.parse(await readFile(path.join(run, low.name, 'skipped.json'), 'utf8')).reason).toMatch(/^skipped for memory: 0\.50 GB free/)
    } finally {
      await rm(run, { recursive: true, force: true })
    }
  })

  it('marks a profile holding mcp as one that runs alone', () => {
    expect(isSerial(profiles.door.plugins)).toBe(true)
    expect(isSerial(profiles.bare.plugins)).toBe(false)
  })
})
