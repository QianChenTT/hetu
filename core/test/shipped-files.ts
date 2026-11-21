import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// The shipped files every check reads: what hetu runs, not its tests, build tooling or the SDK's testing and build
// helpers. Each check names the kinds it reads, plugins: 'src' adds each core plugin's src folder and from: 'core'
// gives paths from core/ instead of the repo

export type Kind = 'ts' | 'js' | 'css' | 'html' | 'md' | 'json'

const repo = path.join(import.meta.dirname, '..', '..')
const roots = ['core/api', 'core/lib', 'core/sdk', 'core/frontend', 'core/backend']
const posix = (file: string) => file.split(path.sep).join('/')

// Paths from core/ take no plugins, whose paths start core-plugins/
type Options = { kinds: readonly Kind[] } & ({ plugins?: undefined, from?: 'core' } | { plugins: 'src', from?: undefined })

export function shippedFiles({ kinds, plugins, from }: Options): string[] {
  if (plugins === 'src' && from === 'core') throw new Error("plugins: 'src' takes paths from the repo, not from: 'core'")
  const kind = new RegExp(`\\.(${kinds.join('|')})$`)
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'testing') continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (kind.test(name) && !/\.(test|d)\.ts$/.test(name)) files.push(posix(path.relative(repo, full)))
    }
  }
  for (const root of roots) walk(path.join(repo, root))
  if (plugins === 'src') {
    for (const plugin of readdirSync(path.join(repo, 'core-plugins'))) {
      const src = path.join(repo, 'core-plugins', plugin, 'src')
      if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src)
    }
  }
  const shipped = files.filter(file => !file.startsWith('core/sdk/build/'))
  return (from === 'core' ? shipped.map(file => file.slice('core/'.length)) : shipped).sort()
}
