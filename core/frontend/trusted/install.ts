// The Install button's flow, kept apart from the DOM: a zip or a folder picked in main's dialog or a link's release,
// staged by the core, then the plugins found with the ones that can install ticked and one Confirm that installs and
// approves them. Every word is this file's, a plugin's own text only quoted
import type { InstallProblem, InstallSource, ReleaseAsset, StagedPlugin, StagedProblem, StagedSource } from '../../api/actions.ts'
import { classNames } from '../../api/policy-jobs.ts'
import { grantSentence } from '../../api/trusted.ts'

export type InstallFlow =
  | { step: 'assets', link: string, tag: string, assets: ReleaseAsset[] }
  | { step: 'found', staged: string, source: StagedSource, plugins: StagedPlugin[], picked: ReadonlySet<string> }

// high marks class 3 and 4 and a class not known. lines are the grant risk classifier's on why
export type FoundRow = { id: string, label: string, line: string, high: boolean, lines: string[], grants: string[], problem: string | null, picked: boolean }

// What the box over the plugin list draws: a release's zips to pick from, or the plugins found under their Confirm,
// ready once one is ticked
export type InstallBox =
  | { step: 'assets', heading: string, assets: { name: string, line: string }[] }
  | { step: 'found', staged: string, source: string, unsigned: string, plugins: FoundRow[], ready: boolean }

const quoted = (value: string) => JSON.stringify(value)

const UNSIGNED = 'Unsigned: nothing proves who made these plugins. Install only what comes from a source you trust'

const problems: Readonly<Record<InstallProblem, string>> = {
  'not-github': 'That isn’t a link to a GitHub repository or release',
  'no-release': 'That repository has no release',
  'no-zip': 'That release has no zip to install from',
  'rate-limited': 'GitHub asks hetu to wait before it looks again. Try again later',
  offline: 'hetu couldn’t reach GitHub',
  invalid: 'That doesn’t read as a zip or a plugin folder',
  name: 'It holds a file name that could land outside its folder, so nothing was taken',
  duplicate: 'It holds two files under one name, so nothing was taken',
  special: 'It holds a link or another special file, so nothing was taken',
  encrypted: 'It holds an encrypted file, so nothing was taken',
  'too-many': 'It holds more files than one install takes, so nothing was taken',
  'too-big': 'It is bigger than one install takes, so nothing was taken',
  'not-a-folder': 'That isn’t a folder',
  'same-id': 'It holds two plugins with one id, so nothing was taken',
  none: 'No plugin in it. A plugin’s folder holds hetu-plugin.json',
}

const refused: Readonly<Record<StagedProblem, string>> = {
  invalid: 'Its manifest doesn’t parse or check out, so what it asks for can’t be read and it can’t be installed',
  'install-only': 'It asks for what only hetu’s own parts hold, so it can’t be installed',
  api: 'It needs a hetu API this hetu doesn’t have, so it can’t be installed',
  reserved: 'Its id is one hetu keeps, so it can’t be installed',
}

// The source as the core staged it, a link's with the release it took the zip from
function sourceLine(source: StagedSource): string {
  if (source.kind === 'link') return `From ${quoted(source.asset)} in the release ${quoted(source.tag)} of ${quoted(source.link)}`
  return `From the ${source.kind} ${quoted(source.path)}`
}

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

// The plugin's name as its author wrote it in quotes, then its id and version as hetu read them
function rowOf(plugin: StagedPlugin, picked: ReadonlySet<string>): FoundRow {
  const label = [plugin.name === null ? plugin.id : `${quoted(plugin.name)} (${plugin.id})`, ...(plugin.version === null ? [] : [`version ${plugin.version}`])].join(', ')
  const high = plugin.class === null || plugin.class >= 3
  const known = plugin.class === null ? 'class unknown, counted as 4' : `class ${plugin.class}, ${classNames[plugin.class]}`
  const unread = plugin.problem === 'invalid'
  return {
    id: plugin.id,
    label,
    line: [high ? `Higher risk: ${known}` : known, ...(plugin.replaces === null ? [] : [`replaces version ${plugin.replaces}`])].join(' · '),
    high,
    lines: plugin.lines,
    grants: unread ? [] : plugin.capabilities.length === 0 ? ['It asks for nothing'] : plugin.capabilities.map(grantSentence),
    problem: plugin.problem === null ? null : refused[plugin.problem],
    picked: plugin.problem === null && picked.has(plugin.id),
  }
}

export function installBox(flow: InstallFlow | null): InstallBox | null {
  if (flow === null) return null
  if (flow.step === 'assets') {
    return {
      step: 'assets',
      heading: `Pick a zip from the release ${quoted(flow.tag)} of ${quoted(flow.link)}`,
      assets: flow.assets.map(asset => ({ name: asset.name, line: `${quoted(asset.name)}, ${size(asset.bytes)}` })),
    }
  }
  const plugins = flow.plugins.map(plugin => rowOf(plugin, flow.picked))
  return { step: 'found', staged: flow.staged, source: sourceLine(flow.source), unsigned: UNSIGNED, plugins, ready: plugins.some(row => row.picked) }
}

// The core's answer as the page hears it
type Reply = { ok?: unknown, result?: unknown, refusal?: { code?: unknown } }

// What the flow needs of the page: a call to the core, settling an answer with a note of the flow's own and drawing
// again with no answer
export type InstallHost = {
  call(action: string, args: unknown, then?: (reply: Reply) => void): void
  settle(reply: Reply, note?: string): void
  redraw(): void
}

const problemOf = (result: unknown) => (result as { problem?: InstallProblem } | null)?.problem

export class Installer {
  flow: InstallFlow | null = null
  private readonly host: InstallHost

  constructor(host: InstallHost) {
    this.host = host
  }

  // main's dialog for a zip or a folder. A cancelled dialog asks for nothing
  pick(source: 'zip' | 'folder'): void {
    this.host.call('app.pickPlugins', { source }, reply => {
      if (reply.ok !== true) this.host.settle(reply)
      else if (typeof reply.result === 'string') this.stage({ kind: source, path: reply.result })
    })
  }

  // A release with one zip is staged at once, one with several waits for the human to pick
  find(typed: string): void {
    const link = typed.trim()
    if (link === '') return this.host.settle({ ok: true }, 'Paste a link to a GitHub repository or release')
    this.host.call('core.findRelease', { link }, reply => {
      const problem = problemOf(reply.result)
      if (reply.ok !== true || problem !== undefined) return this.host.settle(reply, problem === undefined ? undefined : problems[problem])
      const { tag, assets } = reply.result as { tag: string, assets: ReleaseAsset[] }
      if (assets.length === 1) return this.stage({ kind: 'link', link, asset: assets[0].name })
      this.flow = { step: 'assets', link, tag, assets }
      this.host.settle(reply)
    })
  }

  asset(name: string): void {
    if (this.flow?.step === 'assets') this.stage({ kind: 'link', link: this.flow.link, asset: name })
  }

  tick(id: string, on: boolean): void {
    if (this.flow?.step !== 'found') return
    const picked = new Set(this.flow.picked)
    if (on) picked.add(id)
    else picked.delete(id)
    this.flow = { ...this.flow, picked }
    this.host.redraw()
  }

  // The Confirm. A staging gone drops the box, any other refusal keeps it to confirm again
  install(): void {
    const flow = this.flow
    if (flow?.step !== 'found') return
    const plugins = flow.plugins.filter(plugin => plugin.problem === null && flow.picked.has(plugin.id)).map(({ id, digest }) => ({ id, digest }))
    if (plugins.length === 0) return
    this.host.call('core.install', { staged: flow.staged, plugins }, reply => {
      const code = reply.ok === true ? null : reply.refusal?.code
      if (reply.ok === true || code === 'not-found') this.flow = null
      const installed = (reply.result as { installed?: string[] } | null)?.installed
      this.host.settle(reply, reply.ok === true && installed !== undefined ? `Installed ${installed.join(', ')}` : undefined)
    })
  }

  cancel(): void {
    this.drop()
    this.host.redraw()
  }

  // A staging the core holds is dropped, with no answer waited for
  private drop(): void {
    if (this.flow?.step === 'found') this.host.call('core.unstage', { staged: this.flow.staged })
    this.flow = null
  }

  private stage(source: InstallSource): void {
    this.drop()
    this.host.call('core.stage', { source }, reply => {
      const problem = problemOf(reply.result)
      if (reply.ok !== true || problem !== undefined) return this.host.settle(reply, problem === undefined ? undefined : problems[problem])
      const { staged, source: from, plugins } = reply.result as { staged: string, source: StagedSource, plugins: StagedPlugin[] }
      const picked = new Set(plugins.filter(plugin => plugin.problem === null).map(plugin => plugin.id))
      this.flow = { step: 'found', staged, source: from, plugins, picked }
      this.host.settle(reply)
    })
  }
}
