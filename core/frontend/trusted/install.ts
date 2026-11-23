// The Install button's flow, kept apart from the DOM: a zip or a folder picked in main's dialog or a link's release,
// staged by the core, then the plugins found with the ones that can install ticked and Install, which asks for
// plugin.install as a security request. The Confirm that installs and approves them is that request's, in the plugins
// manager's words. The box's words are this file's and api/trusted.ts's, a plugin's own text only quoted
import { MAX_LINK_LENGTH, type InstallProblem, type ReleaseAsset, type StagedPlugin, type StagedProblem, type StagedSource } from '../../api/actions.ts'
import { classNames } from '../../api/policy-jobs.ts'
import { grantSentence, sourceLine, UNSIGNED } from '../../api/trusted.ts'

export type InstallFlow =
  | { step: 'assets', release: string, link: string, tag: string, assets: ReleaseAsset[] }
  | { step: 'found', staged: string, source: StagedSource, plugins: StagedPlugin[], picked: ReadonlySet<string>, busy: boolean }

// high marks class 3 and 4 and a class not known. lines are the grant risk classifier's on why
export type FoundRow = { id: string, label: string, line: string, high: boolean, lines: string[], grants: string[], problem: string | null, picked: boolean }

// What the box over the plugin list draws: a release's zips to pick from, or the plugins found under their Confirm,
// ready once one is ticked and busy while it is on its way
export type InstallBox =
  | { step: 'assets', heading: string, assets: { line: string }[] }
  | { step: 'found', staged: string, source: string, unsigned: string, plugins: FoundRow[], ready: boolean, busy: boolean }

const quoted = (value: string) => JSON.stringify(value)

const problems: Readonly<Record<InstallProblem, string>> = {
  'not-github': 'That isn’t a link to a GitHub repository or release',
  'no-release': 'That repository has no release',
  'no-zip': 'That release has no zip to install from',
  'rate-limited': 'GitHub asks hetu to wait before it looks again. Try again later',
  offline: 'hetu couldn’t reach GitHub',
  'off-github': 'The download pointed away from GitHub, so nothing was fetched',
  'not-found': 'GitHub no longer has that zip. Find the release again to see what it holds now',
  'digest-mismatch': 'The zip doesn’t match the checksum GitHub lists for it, so nothing was taken',
  'timed-out': 'GitHub took too long to answer. Try again',
  cancelled: 'The download stopped as hetu quit',
  'bad-answer': 'GitHub answered in a way hetu doesn’t read. Try again later or install from a downloaded zip',
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
      assets: flow.assets.map(asset => ({ line: `${quoted(asset.name)}, ${size(asset.bytes)}` })),
    }
  }
  const plugins = flow.plugins.map(plugin => rowOf(plugin, flow.picked))
  return { step: 'found', staged: flow.staged, source: sourceLine(flow.source), unsigned: UNSIGNED, plugins, ready: plugins.some(row => row.picked), busy: flow.busy }
}

// What the page's status line says aloud when the box changes, null with no box
export function installSay(box: InstallBox | null): string | null {
  if (box === null) return null
  if (box.step === 'assets') return box.heading
  const count = `${box.plugins.length} plugin${box.plugins.length === 1 ? '' : 's'} found`
  return `${count}. ${box.source}. Tick the ones to install, then Install`
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

// A GitHub repository or release by its link, which the core resolves. Anything else isn't asked for
const GITHUB_LINK = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+/

// Each start (a pick, a link, a zip of a release) is numbered and only the latest one's answers apply. An older one's
// staging is dropped. The box shown stays until a newer staging is there to replace it, so a source that fails leaves
// the box the human was reading
export class Installer {
  flow: InstallFlow | null = null
  private readonly host: InstallHost
  private latest = 0

  constructor(host: InstallHost) {
    this.host = host
  }

  // main's dialog for a zip or a folder, which main stages at once, so no path passes through the page. A cancelled
  // dialog answers null and changes nothing
  pick(source: 'zip' | 'folder'): void {
    const mine = ++this.latest
    this.host.call('app.pickPlugins', { source }, reply => {
      if (reply.ok === true && reply.result === null) return
      this.took(mine, reply)
    })
  }

  // A release with one zip is staged at once, one with several waits for the human to pick
  find(typed: string): void {
    const link = typed.trim()
    if (link === '') return this.host.settle({ ok: true }, 'Paste a link to a GitHub repository or release')
    if (link.length > MAX_LINK_LENGTH || !GITHUB_LINK.test(link)) return this.host.settle({ ok: true }, problems['not-github'])
    const mine = ++this.latest
    this.host.call('core.findRelease', { link }, reply => {
      if (mine !== this.latest) return
      const problem = problemOf(reply.result)
      if (reply.ok !== true || problem !== undefined) return this.host.settle(reply, problem === undefined ? undefined : problems[problem])
      const { release, tag, assets } = reply.result as { release: string, tag: string, assets: ReleaseAsset[] }
      if (assets.length === 1) return this.stage(release, 0)
      this.replace({ step: 'assets', release, link, tag, assets })
      this.host.settle(reply)
    })
  }

  // A zip of the release shown, named by its place in the list main answered
  asset(place: number): void {
    if (this.flow?.step === 'assets') this.stage(this.flow.release, place)
  }

  tick(id: string, on: boolean): void {
    if (this.flow?.step !== 'found' || this.flow.busy) return
    const picked = new Set(this.flow.picked)
    if (on) picked.add(id)
    else picked.delete(id)
    this.flow = { ...this.flow, picked }
    this.host.redraw()
  }

  // The request for the staging the human saw, once. A click on a staging no longer shown, or while one request is on
  // its way, sends nothing. An answer clears only the box it was for. Held, the request is the Confirm and holds the
  // staging, which its Cancel drops, so the box goes and the staging stays. Applied at once, with the Confirm off or the
  // security view off, the plugins are in. A staging gone drops the box, one that no longer holds what was drawn drops
  // the staging with it, and any other refusal keeps the box to ask again
  install(shown: string): void {
    const flow = this.flow
    if (flow?.step !== 'found' || flow.staged !== shown || flow.busy) return
    const plugins = flow.plugins.filter(plugin => plugin.problem === null && flow.picked.has(plugin.id)).map(({ id, digest }) => ({ id, digest }))
    if (plugins.length === 0) return
    this.flow = { ...flow, busy: true }
    this.host.redraw()
    this.host.call('security.request', { change: { kind: 'plugin.install', staged: flow.staged, plugins } }, reply => {
      const code = reply.ok === true ? null : reply.refusal?.code
      const current = this.flow?.step === 'found' && this.flow.staged === shown ? this.flow : null
      if (current !== null) this.flow = reply.ok === true || code === 'not-found' || code === 'stale' ? null : { ...current, busy: false }
      if (code === 'stale') this.host.call('core.unstage', { staged: shown })
      const applied = reply.ok === true && (reply.result as { applied?: unknown } | null)?.applied === true
      this.host.settle(reply, applied ? `Installed ${plugins.map(plugin => plugin.id).join(', ')}` : undefined)
    })
  }

  // Answers still on their way are dropped with the box
  cancel(): void {
    this.latest++
    this.replace(null)
    this.host.redraw()
  }

  // A staging the core holds is dropped as the box moves on, with no answer waited for. One whose request is on its
  // way is the core's to drop
  private replace(next: InstallFlow | null): void {
    const old = this.flow
    if (old?.step === 'found' && !old.busy) this.host.call('core.unstage', { staged: old.staged })
    this.flow = next
  }

  private stage(release: string, zip: number): void {
    const mine = ++this.latest
    this.host.call('core.stage', { release, zip }, reply => this.took(mine, reply))
  }

  // A staging's answer, for the latest start only. An older one's staging is dropped
  private took(mine: number, reply: Reply): void {
    const problem = problemOf(reply.result)
    const result = reply.result as { staged?: string, source: StagedSource, plugins: StagedPlugin[] } | null
    if (mine !== this.latest) {
      if (reply.ok === true && typeof result?.staged === 'string') this.host.call('core.unstage', { staged: result.staged })
      return
    }
    if (reply.ok !== true || problem !== undefined || result === null || result.staged === undefined) {
      return this.host.settle(reply, problem === undefined ? undefined : problems[problem])
    }
    const picked = new Set(result.plugins.filter(plugin => plugin.problem === null).map(plugin => plugin.id))
    this.replace({ step: 'found', staged: result.staged, source: result.source, plugins: result.plugins, picked, busy: false })
    this.host.settle(reply)
  }
}
