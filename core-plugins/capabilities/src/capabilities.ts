import { capabilityKey, type Capability } from 'hetu-core/api/capabilities.ts'
import { classNames, type Capabilities, type ClassMove, type Flow, type ScreenSubject } from 'hetu-core/api/slots.ts'
import { capabilityText } from 'hetu-core/api/trusted.ts'

// A scope stays inside one place when its first part is a plain folder or note name. One with a wildcard there, **
// or * or another, reaches across the whole notes folder, whatever comes after
const confined = (scope: string) => {
  const first = scope.split('/')[0]
  return first !== '' && !/[*?[\]{}]/.test(first)
}

// One grant's class, from the class table. A subscription reaches nothing on its own, since an event
// carries a path only to a subscriber that may list it. The key stream holds what is typed, so it reads. A type this
// plugin doesn't know is 4, so nothing new is ever class 0 and updates on its own by default
function classOf(granted: Capability): number {
  switch (granted.type) {
    case 'ui.view':
    case 'ui.decoration':
    case 'ui.command':
    case 'ui.layout':
    case 'storage':
    case 'events.subscribe':
    case 'plugin.call':
      return 0
    case 'ui.keys':
    case 'ui.read':
    case 'luoshu.read':
    case 'luoshu.list':
      return 1
    case 'luoshu.write':
      return granted.paths.every(confined) ? 2 : 4
    // Each edit waits in the editor for the human's save, so every scope is a writer's, ** included
    case 'ui.edit':
    case 'history':
      return 2
    case 'net.fetch':
      return granted.hosts.includes('*') ? 4 : 3
    case 'exec':
    case 'guard.hook':
    case 'log.read':
      return 4
    default:
      return 4
  }
}

// What tells a plugin a note's content: reading it, through the luoshu or through the editor, listing it, the key
// stream and history read, and a write, whose version check answers whether a guessed text is the note's
const reads = (granted: Capability) => granted.type === 'luoshu.read' || granted.type === 'luoshu.list' || granted.type === 'ui.keys'
  || granted.type === 'ui.read'
  || granted.type === 'luoshu.write' || (granted.type === 'history' && granted.access === 'read')
const network = (granted: Capability) => granted.type === 'net.fetch'

// With no flow given the links are plugin.call's alone, each both ways, so what lies upstream and downstream is what
// plugin.call reaches
const flowOf = (reachable: readonly Capability[], flow: Flow | undefined): Flow =>
  flow ?? { upstream: [{ id: '', granted: reachable }], downstream: [{ id: '', granted: reachable }], heard: [] }
const holdings = (peers: Flow['upstream']) => peers.flatMap(peer => [...peer.granted])

// A read that can reach the plugin and network it can reach, which together could send notes out: a read here or
// upstream, and network here or downstream
const paired = (granted: readonly Capability[], flow: Flow) =>
  [...granted, ...holdings(flow.upstream)].some(reads) && [...granted, ...holdings(flow.downstream)].some(network)

// Programs that run another program or code they are handed: shells, interpreters, package runners, fetchers and the
// Windows hosts for scripts. An exact command with one of these runs whatever its arguments or its config name, so
// the screen says so. The list misses programs, as any list does, and only adds a line
const RUNS_OTHERS = new Set([
  'git', 'node', 'nodejs', 'deno', 'bun', 'npm', 'npx', 'pnpm', 'yarn', 'python', 'py', 'pip', 'pipx', 'uv', 'uvx', 'perl',
  'ruby', 'gem', 'php', 'lua', 'java', 'dotnet', 'go', 'cargo', 'make', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd',
  'powershell', 'pwsh', 'wsl', 'cscript', 'wscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'curl', 'wget', 'ssh', 'env',
  'xargs', 'find', 'sudo', 'doas', 'osascript', 'open', 'start', 'pythonw', 'javaw', 'msbuild', 'forfiles', 'wmic', 'schtasks',
  'docker', 'awk', 'gawk', 'sed', 'tar', 'busybox', 'nohup', 'timeout', 'at', 'cron', 'crontab', 'launchctl', 'systemctl',
])
const PROGRAM_EXTENSION = /\.(exe|com|cmd|bat|ps1)$/

// A program's base name on the list without its folder or its extension, or else without a version on its end, so
// python3.12.exe reads python and rundll32 stays itself. Null for a program not on the list
function listedName(program: string): string | null {
  const base = program.split(/[\\/]/).at(-1)!.toLowerCase().replace(PROGRAM_EXTENSION, '')
  if (RUNS_OTHERS.has(base)) return base
  const unversioned = base.replace(/[\d.]+$/, '')
  return RUNS_OTHERS.has(unversioned) ? unversioned : null
}

function runsOthers(all: readonly Capability[]): string[] {
  const names = all.flatMap(item => item.type === 'exec' ? item.commands.map(command => listedName(command[0])) : [])
  return [...new Set(names.filter(name => name !== null))]
}

export function createCapabilities(): Capabilities {
  // The highest of its grants and what plugin.call reaches, or 4 for a pair. What it hears gives it none of the
  // speaker's grants, so the flow counts for the pair alone
  const classify = (granted: readonly Capability[], reachable: readonly Capability[], flow?: Flow): number =>
    paired(granted, flowOf(reachable, flow)) ? 4 : Math.max(0, ...[...granted, ...reachable].map(classOf))

  return {
    classify,

    // The items whose own class is 4, and for a pair the items that close it: the plugin's network items, or with none of
    // its own the plugin.call items that bring the network in, and for a plugin that reads nothing itself the
    // subscriptions a read moves in through
    firstUse(granted: readonly Capability[], reachable: readonly Capability[], flow?: Flow): Capability[] {
      const moves = flowOf(reachable, flow)
      const pair = paired(granted, moves)
      const bringsNetwork = granted.some(network) ? network : (item: Capability) => item.type === 'plugin.call'
      const bringsRead = new Set(granted.some(reads) ? [] : moves.heard.filter(heard => heard.upstream.some(reads)).map(heard => capabilityKey(heard.item)))
      return granted.filter(item => classOf(item) === 4 || (pair && (bringsNetwork(item) || bringsRead.has(capabilityKey(item)))))
    },

    // A plugin with network, its own or through the plugins it is connected to through plugin.call, names the connected
    // plugins that read. Past plugin.call, one with network here or downstream names the readers upstream, and one with a
    // read here or upstream names the network plugins downstream
    screen({ granted, reachable, callers, flow }: ScreenSubject): string[] {
      const n = classify(granted, reachable, flow)
      const moves = flowOf(reachable, flow)
      const readers = [...granted, ...reachable].some(network) ? callers.filter(caller => caller.granted.some(reads)).map(caller => caller.id) : []
      const called = new Set(callers.map(caller => caller.id))
      const beyond = (peers: Flow['upstream'], holds: (item: Capability) => boolean) =>
        flow === undefined ? [] : peers.filter(peer => !called.has(peer.id) && peer.granted.some(holds)).map(peer => peer.id)
      const readersUp = [...granted, ...holdings(moves.downstream)].some(network) ? beyond(moves.upstream, reads) : []
      const sendersDown = [...granted, ...holdings(moves.upstream)].some(reads) ? beyond(moves.downstream, network) : []
      let head = `Class ${n}, ${classNames[n]}`
      if (n === 4 && paired(granted, moves)) head += ': it can read notes and reach the network, so it could send notes out'
      else if (n === 4) head += `: ${granted.filter(item => classOf(item) === 4).map(capabilityText).join(', ')}`
      const lines = [head]
      if (reachable.length > 0) lines.push(`Through plugin.call it is connected to: ${[...new Set(reachable.map(capabilityText))].join(', ')}`)
      if (readers.length > 0) lines.push(`Plugins that read and are connected to it through plugin.call: ${readers.join(', ')}`)
      if (readersUp.length > 0) lines.push(`Plugins that read and can reach it through events: ${readersUp.join(', ')}`)
      if (sendersDown.length > 0) lines.push(`Plugins with network it can reach through events: ${sendersDown.join(', ')}`)
      const runners = runsOthers([...granted, ...reachable])
      if (runners.length > 0) lines.push(`It can run programs that run other programs or code: ${runners.join(', ')}`)
      return lines
    },

    // Each move up, named with the class the plugin held and the one it moves to. A move down asks nothing new, so it
    // shows nothing. A class not known counts as 4
    moves(moves: readonly ClassMove[]): string[] {
      const named = (n: number | null) => (n === null ? 'a class not known, counted as 4' : `class ${n}, ${classNames[n]}`)
      return moves.filter(move => (move.to ?? 4) > (move.from ?? 4)).map(move => `Raises ${move.id} from ${named(move.from)} to ${named(move.to)}`)
    },

    // A move up nobody confirmed alerts where the class changes what hetu does: leaving 0, whose updates apply on their
    // own, or entering 4, whose items ask at first use. A move inside 1 to 3 changes a label only. A class not known
    // counts as 4
    alerts(move: ClassMove): boolean {
      const from = move.from ?? 4
      const to = move.to ?? 4
      return to > from && (from === 0 || to === 4)
    },
  }
}
