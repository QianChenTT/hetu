import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilityTypes } from '../api/capabilities.ts'

// the class rules live in the grant risk classifier alone. The rest of the backend holds no class number, names no
// capability type outside the places listed here and defines or calls none of the classifier's own functions

const core = path.join(import.meta.dirname, '..')
const classifier = 'backend/policy/grant-risk-classifier/'
// The gate judges each call by the item it uses, so the capability types are its own words as they are the classifier's
const policies = 'backend/policy/'

function backend(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.ts')) files.push(path.relative(core, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(core, 'backend'))
  return files.filter(file => !file.startsWith(classifier)).sort()
}

// A file's code with its line comments blanked, each line kept where it was
const code = (file: string) => readFileSync(path.join(core, file), 'utf8').split('\n').map(line => line.replace(/(^|\s)\/\/.*$/, '')).join('\n')

const classNumber = [
  /\bclassNames\b/,
  /\bclass\s*(===|!==|>=|<=|>|<)\s*\d/,
  /\d\s*(===|!==|>=|<=|>|<)\s*[\w.?!]*\bclass\b/,
  /\bclass\b[^\n]*\?\?\s*\d/,
  /\?\?\s*4\b/,
  /\.max\(\s*4\s*\)/,
  /\baskOnUpdateTypes\b/,
]
const moved = ['holders', 'connected', 'flow', 'reachable', 'links', 'followed', 'targetsOf', 'publishersOf', 'decide', 'alerts',
  'changeOf', 'shown', 'classed', 'screen', 'classify', 'firstUse', 'moves', 'paired', 'classOf']
const names = moved.join('|')
const ownFunction = new RegExp(`(this\\.|private\\s+|function\\s+)(${names})\\s*\\(|const\\s+(${names})\\s*=\\s*(async\\s*)?\\(`)
const capabilityType = new RegExp(`\\b(type|capability)\\s*(===|!==|:)\\s*'(${capabilityTypes.map(type => type.replace('.', '\\.')).join('|')})'`)

// The places a capability type is named outside the policies, each with why. None of them classes a plugin
const typesAllowed: readonly { place: string, text: string, why: string }[] = [
  { place: 'backend/plugins-manager/lifecycle.ts', text: "item.type === 'plugin.call' ? item.targets", why: 'a plugin\'s plugin.call targets are dependencies its lifecycle waits on' },
  { place: 'backend/plugins-manager/agents.ts', text: "capability.type === 'plugin.call' && capability.targets", why: 'an agent\'s ask names only plugins hetu knows as targets' },
  { place: 'backend/plugins-manager/changes.ts', text: "capability.type === 'exec' && !off", why: 'exec is handed each plugin\'s own exec items to check a command against' },
  { place: 'backend/router/shape.ts', text: "capability: 'plugin.call'", why: 'a plugin call is judged under plugin.call' },
]

describe('the class rules in the classifier alone', () => {
  const files = backend()

  it('has backend files to read and leaves the classifier out', () => {
    expect(files).toContain('backend/plugins-manager/plugins-manager.ts')
    expect(files.some(file => file.startsWith(classifier))).toBe(false)
  })

  it('finds no class number in the backend outside the classifier', () => {
    const found = files.flatMap(file => code(file).split('\n').flatMap((line, at) =>
      classNumber.some(pattern => pattern.test(line)) ? [`${file}:${at + 1}: ${line.trim()}`] : []))
    expect(found).toEqual([])
  })

  it('finds none of the classifier\'s own functions defined or called in the backend outside it', () => {
    const found = files.flatMap(file => code(file).split('\n').flatMap((line, at) => ownFunction.test(line) ? [`${file}:${at + 1}: ${line.trim()}`] : []))
    expect(found).toEqual([])
  })

  it('finds a capability type outside the policies only in the places listed', () => {
    const found = files.filter(file => !file.startsWith(policies)).flatMap(file => code(file).split('\n').flatMap((line, at) =>
      capabilityType.test(line) && !typesAllowed.some(allowed => allowed.place === file && line.includes(allowed.text)) ? [`${file}:${at + 1}: ${line.trim()}`] : []))
    expect(found).toEqual([])
  })

  it('lists only places that still name a capability type', () => {
    const stale = typesAllowed.filter(allowed => !code(allowed.place).includes(allowed.text))
    expect(stale).toEqual([])
  })

  it('catches each kind of break it looks for', () => {
    expect(classNumber.some(pattern => pattern.test('if (k.entry.class === 0) apply()'))).toBe(true)
    expect(classNumber.some(pattern => pattern.test('const rank = n ?? 4'))).toBe(true)
    expect(ownFunction.test('const reach = this.reachable(id, granted)')).toBe(true)
    expect(ownFunction.test('function followed(links, start) {')).toBe(true)
    expect(ownFunction.test('const decide = (other: string) => other')).toBe(true)
    expect(ownFunction.test('const shown = k.live === null')).toBe(false)
    expect(classNumber.some(pattern => pattern.test('const n = (this.minted.get(k.id) ?? 0) + 1'))).toBe(false)
    expect(capabilityType.test("granted.some(item => item.type === 'net.fetch')")).toBe(true)
    expect(capabilityType.test("modules.provider('storage')")).toBe(false)
  })
})
