import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Metafile } from 'esbuild'

// The file beside main.js, inside app.asar, naming every third-party package a bundle holds with its license text. The
// bundles keep no license comments, so this file is where those licenses travel
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'

// Licenses vendored for a package that ships none of its own text, by SPDX id
const VENDORED = path.join(import.meta.dirname, 'licenses')
// A package's license file by its name, in any case
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i

// One bundle's inputs: its metafile and the folder esbuild resolved the metafile's paths from
export type Bundled = { metafile: Metafile, from: string }

export type Package = { name: string, version: string, license: string, author: string | null, text: string }

// The folder of the package an input sits in, null for an input outside node_modules. A scoped package takes two parts
export function packageFolder(input: string): string | null {
  const parts = input.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at === -1 || at + 1 >= parts.length) return null
  const take = parts[at + 1]!.startsWith('@') ? 2 : 1
  if (at + take >= parts.length) return null
  return parts.slice(0, at + 1 + take).join('/')
}

function authorOf(author: unknown): string | null {
  if (typeof author === 'string') return author
  if (typeof author === 'object' && author !== null && typeof (author as { name?: unknown }).name === 'string') return (author as { name: string }).name
  return null
}

// One package's name, version, license and license text: its own file, else the vendored text of its SPDX id. A package
// with neither stops the build, since shipping it would leave its license out
export async function packageOf(folder: string): Promise<Package> {
  const manifest = JSON.parse(await readFile(path.join(folder, 'package.json'), 'utf8')) as Record<string, unknown>
  const name = String(manifest.name)
  const license = typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN'
  const own = (await readdir(folder)).filter(file => LICENSE_FILE.test(file)).sort()
  let text: string
  if (own.length > 0) {
    text = (await Promise.all(own.map(file => readFile(path.join(folder, file), 'utf8')))).join('\n')
  } else {
    try {
      text = await readFile(path.join(VENDORED, `${license}.txt`), 'utf8')
    } catch {
      throw new Error(`${name} ships no license file and no ${license} text is vendored in core/build/licenses`)
    }
  }
  return { name, version: String(manifest.version), license, author: authorOf(manifest.author), text: text.trim() }
}

// Every third-party package the bundles hold, once each, in name order
export async function bundledPackages(bundles: readonly Bundled[]): Promise<Package[]> {
  const folders = new Set<string>()
  for (const { metafile, from } of bundles) {
    for (const input of Object.keys(metafile.inputs)) {
      const folder = packageFolder(path.resolve(from, input).split(path.sep).join('/'))
      if (folder !== null) folders.add(folder)
    }
  }
  const packages = await Promise.all([...folders].map(packageOf))
  const byName = new Map(packages.map(each => [`${each.name}@${each.version}`, each]))
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1))
}

// The notices file's text: a line on what it is, then each package with its license text
export function noticesText(packages: readonly Package[]): string {
  const rule = '-'.repeat(78)
  const head = [
    'hetu bundles the third-party packages below into its own files. Each is listed with its version, its license and the',
    'license text it ships. Electron and Chromium carry their own notices in LICENSE and LICENSES.chromium.html beside hetu.exe',
  ]
  const entries = packages.map(each => [
    rule,
    `${each.name} ${each.version}`,
    `License: ${each.license}${each.author === null ? '' : `, by ${each.author}`}`,
    '',
    each.text,
  ].join('\n'))
  return `${[head.join('\n'), ...entries].join('\n\n')}\n`
}
