import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { shippedFiles } from './shipped-files.ts'

// The core names a caller by its way in and judges a pair, so no word agent is in what it ships outside the places
// listed here, each with why. Any case, as a word of its own or a part of a joined name such as userAgent

const core = path.join(import.meta.dirname, '..')
const posix = (file: string) => file.split(path.sep).join('/')

// A word agent or agents standing alone or starting a joined name, or a part of one after a lower case letter
export const agentWord = /(?<![A-Za-z])agents?(?![a-z])|(?<![A-Za-z])Agents?(?![a-z])|(?<![A-Za-z])AGENTS?(?![A-Z])|(?<=[a-z])Agents?(?![a-z])/g

// A place is a file of core/ and the joined name or word allowed there
export type Place = { place: string, word: string, why: string }

export const allowed: readonly Place[] = [
  { place: 'frontend/editor/page.ts', word: 'userAgent', why: 'the browser\'s own name for the text it reads to tell macOS from Windows' },
  { place: 'backend/boot/state.ts', word: 'agents', why: 'a field of a format 2 entry, which the reader for format 2 names to drop' },
  { place: 'backend/boot/state.ts', word: 'revokedAgents', why: 'a field of a format 2 switches file, which the reader for format 2 names to drop' },
  { place: 'backend/boot/README.md', word: 'agents', why: 'names the format 2 field the reader drops' },
  { place: 'backend/boot/README.md', word: 'revokedAgents', why: 'names the format 2 field the reader drops' },
  { place: 'backend/plugins-manager/github.ts', word: 'agent', why: 'the user-agent header, which GitHub\'s API asks every request to send' },
]

// Shipped code in core/, every text file of it: not its tests, build tooling or the SDK's testing and build helpers
function shipped(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'testing') continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|js|css|html|md|json)$/.test(name) && !/\.(test|d)\.ts$/.test(name)) files.push(posix(path.relative(core, full)))
    }
  }
  for (const dir of ['api', 'lib', 'sdk', 'frontend', 'backend']) walk(path.join(core, dir))
  return files.filter(file => !file.startsWith('sdk/build/')).sort()
}

export type Hit = { file: string, line: number, word: string }

export function hitsIn(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  source.split('\n').forEach((text, index) => {
    for (const found of text.matchAll(agentWord)) {
      // The whole joined name the word sits in, so an allowed place names what the code holds
      const start = text.slice(0, found.index).search(/[A-Za-z0-9_]*$/)
      const end = found.index + found[0].length + (text.slice(found.index + found[0].length).match(/^[A-Za-z0-9_]*/)?.[0].length ?? 0)
      hits.push({ file, line: index + 1, word: text.slice(start, end) })
    }
  })
  return hits
}

const isAllowed = (hit: Hit) => allowed.some(place => place.place === hit.file && place.word === hit.word)

describe('the word agent in the core', () => {
  it('finds the word alone or in a joined name in any case, never inside another word', () => {
    const words = (text: string) => hitsIn('x.ts', text).map(hit => hit.word)
    expect(words('an agent, the agents, Agent, AGENTS, agentHost, revokedAgents, navigator.userAgent')).toEqual([
      'agent', 'agents', 'Agent', 'AGENTS', 'agentHost', 'revokedAgents', 'userAgent',
    ])
    expect(words('reagent, management, agentic, pageant, Reagents')).toEqual([])
  })

  it('is in no shipped file of core/ outside the places listed', () => {
    const files = shipped()
    expect(files).toContain('api/actions.ts')
    expect(files).toContain('frontend/trusted/view.ts')
    expect(files.filter(file => file.startsWith('sdk/build/') || file.includes('/test/'))).toEqual([])
    const hits = files.flatMap(file => hitsIn(file, readFileSync(path.join(core, file), 'utf8')))
    expect(hits.filter(hit => !isAllowed(hit))).toEqual([])
  })

  it('lists only places that still hold the word they allow, each with why', () => {
    const files = shipped()
    for (const place of allowed) {
      expect(files, place.place).toContain(place.place)
      expect(hitsIn(place.place, readFileSync(path.join(core, place.place), 'utf8')).map(hit => hit.word), place.place).toContain(place.word)
      expect(place.why.length).toBeGreaterThan(10)
    }
  })
  // The proof the later move of this walk to shipped-files.ts leans on
  it('walks the files shippedFiles lists', () => {
    expect(shipped()).toEqual(shippedFiles({ kinds: ['ts', 'js', 'css', 'html', 'md', 'json'], from: 'core' }))
  })
})
