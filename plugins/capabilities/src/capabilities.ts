import type { Capability } from 'hetu-core/api/capabilities.ts'
import { classNames, type Capabilities, type ScreenSubject } from 'hetu-core/api/slots.ts'
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
    case 'luoshu.read':
    case 'luoshu.list':
      return 1
    case 'luoshu.write':
      return granted.paths.every(confined) ? 2 : 4
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

// What tells a plugin a note's content: reading it, listing it, the key stream and history read, and a write, whose
// version check answers whether a guessed text is the note's
const reads = (granted: Capability) => granted.type === 'luoshu.read' || granted.type === 'luoshu.list' || granted.type === 'ui.keys'
  || granted.type === 'luoshu.write' || (granted.type === 'history' && granted.access === 'read')
const network = (granted: Capability) => granted.type === 'net.fetch'

// Reading and network anywhere in what a plugin holds and reaches, which together could send notes out
const paired = (all: readonly Capability[]) => all.some(reads) && all.some(network)

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
  const classify = (granted: readonly Capability[], reachable: readonly Capability[]): number => {
    const all = [...granted, ...reachable]
    return paired(all) ? 4 : Math.max(0, ...all.map(classOf))
  }

  return {
    classify,

    // The items whose own class is 4, and for a pair the items that close it: the plugin's network items, or with none of
    // its own the plugin.call and events.subscribe items that bring the network in
    firstUse(granted: readonly Capability[], reachable: readonly Capability[]): Capability[] {
      const pair = paired([...granted, ...reachable])
      const closing = granted.some(network) ? network : (item: Capability) => item.type === 'plugin.call' || item.type === 'events.subscribe'
      return granted.filter(item => classOf(item) === 4 || (pair && closing(item)))
    },

    // A plugin with network, its own or through the plugins it is connected to, names the connected plugins that read.
    // Connected is through plugin.call or a subscription to another plugin's topics
    screen({ granted, reachable, callers }: ScreenSubject): string[] {
      const n = classify(granted, reachable)
      const readers = [...granted, ...reachable].some(network) ? callers.filter(caller => caller.granted.some(reads)).map(caller => caller.id) : []
      let head = `Class ${n}, ${classNames[n]}`
      if (n === 4 && paired([...granted, ...reachable])) head += ': it can read notes and reach the network, so it could send notes out'
      else if (n === 4) head += `: ${granted.filter(item => classOf(item) === 4).map(capabilityText).join(', ')}`
      const lines = [head]
      if (reachable.length > 0) lines.push(`Through plugin.call or events it is connected to: ${[...new Set(reachable.map(capabilityText))].join(', ')}`)
      if (readers.length > 0) lines.push(`Plugins that read and are connected to it through plugin.call or events: ${readers.join(', ')}`)
      const runners = runsOthers([...granted, ...reachable])
      if (runners.length > 0) lines.push(`It can run programs that run other programs or code: ${runners.join(', ')}`)
      return lines
    },
  }
}
