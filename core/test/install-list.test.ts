import { describe, expect, it } from 'vitest'
import { FIRST_PARTY_SIGNER, installList, isNewer, MAX_INSTALL_LIST_BYTES, pluginVersion } from '../api/install.ts'
import { dependencyReason, depsMessage, init, reason, ready, stop, stopped } from '../api/lifecycle.ts'
import { parseStrict } from '../lib/hashed-file.ts'

const hash = 'a'.repeat(64)
const list = (plugins: object) => ({ format: 1, plugins })

describe('the install list', () => {
  it('takes install plugins and marked first-party copies', () => {
    const parsed = installList.parse(list({
      gate: { path: 'plugins/gate', version: '1.0.0', hash },
      git: { path: 'plugins/git', version: '2.1.0', hash, firstParty: true },
    }))
    expect(parsed.plugins.gate).toEqual({ path: 'plugins/gate', version: '1.0.0', hash })
    expect(parsed.plugins.git.firstParty).toBe(true)
    // No prototype, so an id naming one of Object's members finds nothing
    expect(Object.getPrototypeOf(parsed.plugins)).toBe(null)
  })

  it.each([
    ['an install id marked first party', { gate: { path: 'g', version: '1.0.0', hash, firstParty: true } }],
    ['a first-party id left unmarked', { git: { path: 'g', version: '1.0.0', hash } }],
    ['an id that is neither', { search2: { path: 'g', version: '1.0.0', hash } }],
    ['a community id marked first party', { 'my-plugin': { path: 'g', version: '1.0.0', hash, firstParty: true } }],
    ['firstParty false, which marks nothing', { gate: { path: 'g', version: '1.0.0', hash, firstParty: false } }],
    ['a folder named twice', { gate: { path: 'p', version: '1.0.0', hash }, log: { path: 'p', version: '1.0.0', hash } }],
    ['a path out of the install', { gate: { path: '../gate', version: '1.0.0', hash } }],
    ['an absolute path', { gate: { path: '/opt/gate', version: '1.0.0', hash } }],
    ['a drive', { gate: { path: 'C:/gate', version: '1.0.0', hash } }],
    ['a backslash', { gate: { path: 'plugins\\gate', version: '1.0.0', hash } }],
    ['a version range', { gate: { path: 'g', version: '^1.0.0', hash } }],
    ['an uppercase hash', { gate: { path: 'g', version: '1.0.0', hash: 'A'.repeat(64) } }],
    ['a field it does not know', { gate: { path: 'g', version: '1.0.0', hash, signer: 'x' } }],
  ])('refuses %s', (_name, plugins) => {
    expect(installList.safeParse(list(plugins)).success).toBe(false)
  })

  it('refuses another format, a field it does not know and a list past its size', () => {
    expect(installList.safeParse({ format: 2, plugins: {} }).success).toBe(false)
    expect(installList.safeParse({ format: 1, plugins: {}, extra: true }).success).toBe(false)
    expect(installList.safeParse({ format: 1, plugins: {}, pad: 'x'.repeat(MAX_INSTALL_LIST_BYTES) }).success).toBe(false)
  })

  it('refuses a duplicate key through the strict parser, which JSON.parse would let through', () => {
    const text = `{"format":1,"plugins":{"gate":{"path":"a","version":"1.0.0","hash":"${hash}"},"gate":{"path":"b","version":"1.0.0","hash":"${hash}"}}}`
    expect(() => parseStrict(Buffer.from(text), installList)).toThrow()
  })

  it('keeps the first-party signer apart from anything provenance could pin', () => {
    expect(FIRST_PARTY_SIGNER).toContain(' ')
  })

  it('orders versions by their numbers, not their text', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', '1.0.1')).toBe(false)
    expect(isNewer('1.0.1', '1.0.0')).toBe(true)
    expect(isNewer('1.0.10', '1.0.9')).toBe(true)
    expect(pluginVersion.safeParse('01.0.0').success).toBe(false)
  })
})

describe('the lifecycle messages', () => {
  const sent = { v: 1, kind: 'init', id: 'search', incarnation: 2, api: 3, deps: { luoshu: 'ready' }, lastStop: 'dependency:luoshu:crashed', previousVersion: '1.0.0' }

  it('carries the id, the API version, the dependencies, lastStop and previousVersion in init', () => {
    expect(init.parse(sent)).toEqual(sent)
    expect(init.parse({ ...sent, lastStop: null, previousVersion: null }).lastStop).toBe(null)
  })

  it.each([
    ['another API version', { ...sent, api: 1 }],
    ['incarnation 0', { ...sent, incarnation: 0 }],
    ['a dependency state of its own', { ...sent, deps: { luoshu: 'crashed' } }],
    ['a reason outside the fixed list', { ...sent, lastStop: 'the luoshu plugin is down' }],
    ['a dependency reason naming no plugin id', { ...sent, lastStop: 'dependency:My.Luoshu:crashed' }],
    ['a dependency reason with a why of its own', { ...sent, lastStop: 'dependency:luoshu:sad' }],
    ['another envelope version', { ...sent, v: 2 }],
    ['a field it does not know', { ...sent, grants: [] }],
  ])('refuses init with %s', (_name, message) => {
    expect(init.safeParse(message).success).toBe(false)
  })

  it('names only the direct requirement in a dependency reason', () => {
    expect(dependencyReason('luoshu', 'off')).toBe('dependency:luoshu:off')
    expect(reason.safeParse(dependencyReason('luoshu', 'off')).success).toBe(true)
    expect(reason.safeParse('cycle').success).toBe(true)
    expect(reason.safeParse('dependency:con:off').success).toBe(false)
  })

  it('keeps ready and stopped empty and stop to its grace', () => {
    expect(ready.safeParse({ v: 1, kind: 'ready' }).success).toBe(true)
    expect(ready.safeParse({ v: 1, kind: 'ready', id: 'gate' }).success).toBe(false)
    expect(stopped.safeParse({ v: 1, kind: 'stopped' }).success).toBe(true)
    expect(stop.parse({ v: 1, kind: 'stop', graceMs: 3000 }).graceMs).toBe(3000)
    expect(stop.safeParse({ v: 1, kind: 'stop' }).success).toBe(false)
    expect(depsMessage.safeParse({ v: 1, kind: 'deps', deps: { git: 'starting' } }).success).toBe(true)
  })
})
