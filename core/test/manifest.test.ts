import { describe, expect, it } from 'vitest'
import { API_VERSION, apiChanges, folderManifest, installManifest, MAX_LIST, MAX_MANIFEST_BYTES, supportsApi } from '../api/manifest.ts'

const raw = (text: string) => JSON.parse(text)
const many = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i))

// A full manifest example
const search = {
  id: 'search',
  name: 'Search',
  version: '1.2.0',
  api: '^2',
  entries: { worker: 'dist/worker.js', frames: { panel: 'dist/panel.html' } },
  requires: ['luoshu'],
  provides: { actions: { query: {} }, topics: ['indexed'] },
  capabilities: [
    { type: 'luoshu.read', paths: ['**'] },
    { type: 'events.subscribe', topics: ['luoshu.changed', 'luoshu.outside'] },
    { type: 'ui.view' },
  ],
}
const minimal = { id: 'hello', name: 'Hello', version: '0.1.0', api: '^2', entries: { worker: 'worker.js' } }
const leases = {
  id: 'leases',
  name: 'Leases',
  version: '1.0.0',
  api: '^2',
  entries: { host: 'host.js' },
  provides: { actions: { acquire: {}, renew: {}, release: {}, list: {} } },
  capabilities: [{ type: 'guard.hook' }],
  guards: ['luoshu.write'],
  node: ['fs', 'fs/promises', 'node_modules_free'],
}
const both = [['folder', folderManifest], ['install', installManifest]] as const

describe('a manifest', () => {
  it.each(both)('parses the full example from the %s', (_from, schema) => {
    expect(schema.parse(search)).toEqual(search)
  })

  it.each(both)('takes the least a plugin needs from the %s', (_from, schema) => {
    expect(schema.parse(minimal)).toEqual(minimal)
  })

  it('takes an install plugin with a host half, guards and Node built-ins', () => {
    expect(installManifest.parse(leases)).toEqual(leases)
  })

  it('leaves reserved ids to the loader, which takes the first-party copies', () => {
    expect(folderManifest.safeParse({ ...minimal, id: 'git' }).success).toBe(true)
    expect(installManifest.safeParse({ ...minimal, id: 'gate' }).success).toBe(true)
  })

  it('parses an api range outside this core, which the loader refuses with api', () => {
    expect(API_VERSION).toBe(3)
    expect(supportsApi('^3')).toBe(true)
    expect(supportsApi('^1')).toBe(false)
    expect(supportsApi('^4')).toBe(false)
    expect(supportsApi('^0')).toBe(false)
    // A prefix of this version is another version
    expect(supportsApi('^10')).toBe(false)
    expect(supportsApi('^12')).toBe(false)
    expect(folderManifest.safeParse({ ...minimal, api: '^1' }).success).toBe(true)
    expect(folderManifest.safeParse({ ...minimal, api: '^999999' }).success).toBe(true)
  })

  describe('an older major', () => {
    // Version 2 changed the ui verbs, version 3 only added ui.edit, version 4 reshaped history and dropped log.read
    const changes = {
      2: { added: ['ui.view'], removed: ['ui.panel'], reshaped: [], actionsChanged: true },
      3: { added: ['ui.edit'], removed: [], reshaped: [], actionsChanged: false },
      4: { added: [], removed: ['log.read'], reshaped: ['history'], actionsChanged: false },
    }

    it('loads when every major since only added, naming only types it had', () => {
      expect(supportsApi('^2', ['luoshu.read', 'storage'], 3, changes)).toBe(true)
      expect(supportsApi('^3', ['luoshu.read', 'ui.edit'], 3, changes)).toBe(true)
    })

    it('is refused naming a type a later major added, which needs that major', () => {
      expect(supportsApi('^2', ['luoshu.read', 'ui.edit'], 3, changes)).toBe(false)
    })

    it('is refused naming a type a later major removed or reshaped, and loads without it', () => {
      expect(supportsApi('^3', ['history'], 4, changes)).toBe(false)
      expect(supportsApi('^3', ['log.read'], 4, changes)).toBe(false)
      expect(supportsApi('^2', ['history'], 4, changes)).toBe(false)
      expect(supportsApi('^3', ['luoshu.read'], 4, changes)).toBe(true)
      expect(supportsApi('^2', ['luoshu.read'], 4, changes)).toBe(true)
    })

    it('is refused once a later major changed an action, a verb or an event, whatever it names', () => {
      expect(supportsApi('^1', [], 3, changes)).toBe(false)
      expect(supportsApi('^1', [], 2, changes)).toBe(false)
    })

    it('is refused past a major with no record, newer than the core, or 0', () => {
      expect(supportsApi('^2', [], 3, { 2: changes[2] })).toBe(false)
      expect(supportsApi('^4', [], 3, changes)).toBe(false)
      expect(supportsApi('^0', [], 3, changes)).toBe(false)
    })

    it('ends at version 1 in the record core/api keeps, since version 2 changed the ui verbs', () => {
      expect(apiChanges[2].actionsChanged).toBe(true)
      expect(supportsApi('^1')).toBe(false)
      expect(supportsApi(`^${API_VERSION}`, ['luoshu.read'])).toBe(true)
    })

    // Version 3 added ui.edit, ui.read, luoshu.remove and luoshu.move. editor.edit and editor.open only ask for more,
    // which an older plugin meets as a refusal
    it('keeps version 2 under version 3, which only added, unless the manifest names a type version 3 added', () => {
      expect(apiChanges[3]).toEqual({ added: ['ui.edit', 'ui.read'], removed: [], reshaped: [], actionsChanged: false })
      expect(supportsApi('^2', ['luoshu.read', 'luoshu.write', 'ui.view'])).toBe(true)
      expect(supportsApi('^2', ['luoshu.read', 'ui.edit'])).toBe(false)
      expect(supportsApi('^2', ['ui.read'])).toBe(false)
      expect(supportsApi('^3', ['ui.edit', 'ui.read'])).toBe(true)
    })
  })

  const refused: [string, object][] = [
    ['a dotted id', { ...minimal, id: 'my.plugin' }],
    ['a Windows device name', { ...minimal, id: 'aux' }],
    ['an uppercase id', { ...minimal, id: 'Hello' }],
    ['an id over 64 characters', { ...minimal, id: 'a'.repeat(65) }],
    ['an empty name', { ...minimal, name: '' }],
    ['a name with a control character', { ...minimal, name: 'Hello\nApproved by hetu' }],
    // Shown on the approval screen, where the override would reverse every letter after it
    ['a name with a right to left override', { ...minimal, name: 'Hello\u202edetavirp' }],
    ['a name with a bidi isolate', { ...minimal, name: 'Hello\u2068x\u2069' }],
    ['a version with two parts', { ...minimal, version: '1.2' }],
    ['a version with a leading zero', { ...minimal, version: '01.2.0' }],
    ['a prerelease version', { ...minimal, version: '1.2.0-beta' }],
    ['a version with a v', { ...minimal, version: 'v1.2.0' }],
    ['an api with no caret', { ...minimal, api: '1' }],
    ['an api range', { ...minimal, api: '>=1 <3' }],
    ['an api with a minor version', { ...minimal, api: '^1.0' }],
    ['an api with a leading zero', { ...minimal, api: '^01' }],
    ['an api major over six digits', { ...minimal, api: '^1000000' }],
    ['no entry', { ...minimal, entries: {} }],
    ['no entries field', { id: 'hello', name: 'Hello', version: '0.1.0', api: '^2' }],
    ['an empty frames map, which gives nothing to run', { ...minimal, entries: { frames: {} } }],
    ['an entry leaving the folder', { ...minimal, entries: { worker: '../worker.js' } }],
    ['a frame path leaving the folder', { ...minimal, entries: { frames: { panel: '../panel.html' } } }],
    ['an absolute frame path', { ...minimal, entries: { frames: { panel: '/panel.html' } } }],
    ['an absolute entry', { ...minimal, entries: { worker: '/worker.js' } }],
    ['an entry on a drive', { ...minimal, entries: { worker: 'C:/worker.js' } }],
    ['an entry with a backslash', { ...minimal, entries: { worker: 'dist\\worker.js' } }],
    ['an entry with an empty segment', { ...minimal, entries: { worker: 'dist//worker.js' } }],
    ['an unknown entry', { ...minimal, entries: { worker: 'w.js', service: 's.js' } }],
    ['a frame named after another half', { ...minimal, entries: { frames: { worker: 'w.html' } } }],
    ['a frame named host', { ...minimal, entries: { frames: { host: 'h.html' } } }],
    ['a frame named page', { ...minimal, entries: { frames: { page: 'p.html' } } }],
    ['a frame name that is not a name', { ...minimal, entries: { frames: { 'my panel': 'p.html' } } }],
    ['a dotted requirement', { ...minimal, requires: ['my.plugin'] }],
    ['a requirement with a version range', { ...minimal, requires: { luoshu: '^1' } }],
    ['an action name that is not a name', { ...minimal, provides: { actions: { 'search.query': {} } } }],
    ['an action open to a dotted caller', { ...minimal, provides: { actions: { handle: { from: ['my.http'] } } } }],
    ['an action with an unknown field', { ...minimal, provides: { actions: { handle: { to: ['x'] } } } }],
    ['a topic given with its namespace', { ...minimal, provides: { topics: ['search.indexed'] } }],
    ['an unknown provides field', { ...minimal, provides: { verbs: ['x'] } }],
    ['an unknown capability type', { ...minimal, capabilities: [{ type: 'watchdog.control' }] }],
    ['a scope outside the grammar', { ...minimal, capabilities: [{ type: 'luoshu.read', paths: ['notes/../**'] }] }],
    // Never the class, the signer, the tier or a second id
    ['a class', { ...minimal, class: 0 }],
    ['a signer', { ...minimal, signer: 'github.com/someone' }],
    ['a tier', { ...minimal, tier: 'host' }],
    ['a $schema', { ...minimal, $schema: 'https://example.com/schema.json' }],
    ['uses with version ranges, out of v1', { ...minimal, uses: { git: '^1' } }],
    ['a view with no title', { ...minimal, views: { tree: { kind: 'view' } } }],
    ['a view of an unknown kind', { ...minimal, views: { tree: { title: 'Tree', kind: 'panel' } } }],
    ['a view title with a right to left override', { ...minimal, views: { tree: { title: `Tree${String.fromCodePoint(0x202e)}`, kind: 'view' } } }],
    ['a view title past 64 characters', { ...minimal, views: { tree: { title: 'x'.repeat(65), kind: 'view' } } }],
    ['a view name that is not a name', { ...minimal, views: { 'my tree': { title: 'Tree', kind: 'view' } } }],
    ['a view with an unknown field', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', html: '<b>' } } }],
    ['a view whose frame is no frame entry', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', frame: 'panel' } } }],
    ['a view icon that is a script', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', icon: 'dist/icon.js' } } }],
    ['a view icon leaving the folder', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', icon: '../icon.svg' } } }],
    ['a view minimum past its maximum', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', size: { min: 400, max: 200 } } } }],
    ['a view size past 4096', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', size: { preferred: 5000 } } } }],
    ['a view size that is not whole', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', size: { min: 1.5 } } } }],
    ['a priority past 100', { ...minimal, views: { tree: { title: 'Tree', kind: 'view', priority: 101 } } }],
    ['17 views', { ...minimal, views: Object.fromEntries(many(17, i => `v${i}`).map(name => [name, { title: name, kind: 'item' }])) }],
    ['a theme token outside the list', { ...minimal, theme: { tokens: { 'color-link': '#000000' } } }],
    ['a theme color with a url', { ...minimal, theme: { tokens: { 'color-bg': 'url(x)' } } }],
    ['a theme color past its grammar', { ...minimal, theme: { tokens: { 'color-bg': '#00000000' } } }],
    ['a theme font with a quote', { ...minimal, theme: { tokens: { 'font-ui': 'Inter", x' } } }],
    ['a theme with an unknown field', { ...minimal, theme: { tokens: {}, css: 'a{}' } }],
    ['a theme font size past 24px', { ...minimal, theme: { tokens: { 'font-size': '25px' } } }],
  ]

  it.each(refused)('refuses %s from the folder and from the install', (_name, value) => {
    expect(folderManifest.safeParse(value).success).toBe(false)
    expect(installManifest.safeParse(value).success).toBe(false)
  })

  it('refuses a manifest that is not an object', () => {
    for (const value of [null, [], 'search', 5]) {
      expect(folderManifest.safeParse(value).success).toBe(false)
    }
  })
})

describe('views and a theme', () => {
  const drawn = {
    ...minimal,
    entries: { worker: 'dist/worker.js', frames: { board: 'dist/board.html' } },
    capabilities: [{ type: 'ui.view' }],
    views: {
      tree: { title: 'Notes', kind: 'view', icon: 'dist/tree.svg', size: { min: 160, preferred: 240, max: 480 }, priority: 40 },
      board: { title: 'Board', kind: 'view', frame: 'board' },
      words: { title: 'Words', kind: 'item', icon: 'dist/words.png', size: { min: 60 } },
    },
    theme: { tokens: { 'color-bg': '#fafafa', 'color-editor-fg': '#222', 'font-ui': 'Inter, system-ui', 'font-size': '14px', radius: '4px', space: '8px' } },
  }

  it.each(both)('takes views and a theme from the %s', (_from, schema) => {
    expect(schema.parse(drawn)).toEqual(drawn)
  })

  it.each(both)('comes out of the %s with a views map of no prototype', (_from, schema) => {
    const parsed = schema.parse({ ...minimal, views: raw('{"toString":{"title":"x","kind":"view"}}') })
    expect(Object.getPrototypeOf(parsed.views)).toBe(null)
  })
})

describe('install-only fields and types', () => {
  it.each([
    ['a host entry', { ...minimal, entries: { host: 'host.js' } }],
    ['a page entry', { ...minimal, entries: { worker: 'w.js', page: 'page.js' } }],
    ['guards', { ...minimal, capabilities: [{ type: 'guard.hook' }], guards: ['luoshu.write'] }],
    ['Node built-ins', { ...minimal, node: ['fs'] }],
    ['guard.hook', { ...minimal, capabilities: [{ type: 'guard.hook' }] }],
  ])('refuses %s from the plugin folder and takes it from the install', (_name, value) => {
    expect(folderManifest.safeParse(value).success).toBe(false)
    expect(installManifest.safeParse(value).success).toBe(true)
  })

  it('refuses guards without guard.hook', () => {
    expect(installManifest.safeParse({ ...leases, capabilities: [] }).success).toBe(false)
    expect(installManifest.safeParse({ ...leases, capabilities: undefined }).success).toBe(false)
  })

  it('refuses a guard on an action no guard may hook', () => {
    expect(installManifest.safeParse({ ...leases, guards: ['luoshu.read'] }).success).toBe(false)
  })

  // Host halves run with Node in main, so their entries keep to the plugin's own folder like any other
  it.each([
    ['a host entry leaving the folder', { host: '../host.js' }],
    ['an absolute host entry', { host: '/host.js' }],
    ['a page entry leaving the folder', { worker: 'w.js', page: '../page.js' }],
    ['an absolute page entry', { worker: 'w.js', page: '/page.js' }],
  ])('refuses %s from the install', (_name, entries) => {
    expect(installManifest.safeParse({ ...minimal, entries }).success).toBe(false)
  })

  it.each(['node:fs', 'FS', 'fs/', '../fs', ''])('refuses the Node built-in %j', name => {
    expect(installManifest.safeParse({ ...leases, node: [name] }).success).toBe(false)
  })
})

describe('size caps', () => {
  it.each([
    ['requires', (n: number) => ({ ...minimal, requires: many(n, i => `p${i}`) })],
    ['frames', (n: number) => ({ ...minimal, entries: { frames: Object.fromEntries(many(n, i => `f${i}`).map(name => [name, `${name}.html`])) } })],
    ['actions', (n: number) => ({ ...minimal, provides: { actions: Object.fromEntries(many(n, i => `a${i}`).map(name => [name, {}])) } })],
    ['callers of one action', (n: number) => ({ ...minimal, provides: { actions: { handle: { from: many(n, i => `p${i}`) } } } })],
    ['topics', (n: number) => ({ ...minimal, provides: { topics: many(n, i => `t${i}`) } })],
  ])(`takes ${MAX_LIST} %s and refuses one more`, (_name, make) => {
    expect(folderManifest.safeParse(make(MAX_LIST)).success).toBe(true)
    expect(folderManifest.safeParse(make(MAX_LIST + 1)).success).toBe(false)
  })

  it('caps the scopes per type across entries', () => {
    const half = () => many(32, i => `notes/${i}/**`)
    expect(folderManifest.safeParse({ ...minimal, capabilities: [{ type: 'luoshu.read', paths: half() }, { type: 'luoshu.read', paths: half() }] }).success).toBe(true)
    expect(folderManifest.safeParse({
      ...minimal, capabilities: [{ type: 'luoshu.read', paths: half() }, { type: 'luoshu.read', paths: [...half(), '**'] }],
    }).success).toBe(false)
  })

  it('refuses a value reached twice, which no JSON file holds', () => {
    const paths = ['notes/**']
    expect(folderManifest.safeParse({ ...minimal, capabilities: [{ type: 'luoshu.read', paths }, { type: 'luoshu.write', paths }] }).success).toBe(false)
  })

  it.each(both)(`refuses a manifest past ${MAX_MANIFEST_BYTES} bytes from the %s whose every list is within its own cap`, (_from, schema) => {
    const long = (prefix: string) => many(64, i => `${prefix}/${String(i).padStart(3, '0')}/${'x'.repeat(480)}`)
    const big = {
      ...minimal,
      capabilities: [
        { type: 'luoshu.read', paths: long('read') },
        { type: 'luoshu.write', paths: long('write') },
        { type: 'history', access: 'read', paths: long('history') },
      ],
    }
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_MANIFEST_BYTES)
    expect(schema.safeParse(big).success).toBe(false)
    expect(schema.safeParse({ ...big, capabilities: big.capabilities.slice(0, 1) }).success).toBe(true)
  })
})

// The loader looks names up in these maps, so an action or frame the author never declared must find nothing
describe('the parsed maps', () => {
  const declared = { ...minimal, entries: { frames: { panel: 'p.html' } }, provides: { actions: { query: { from: ['http'] } } } }

  it.each(both)('come out of the %s with no prototype', (_from, schema) => {
    const parsed = schema.parse(declared)
    for (const map of [parsed.provides!.actions!, parsed.entries.frames!] as Record<string, unknown>[]) {
      expect(Object.getPrototypeOf(map)).toBeNull()
      expect(map.toString).toBeUndefined()
      expect(map.constructor).toBeUndefined()
      expect('hasOwnProperty' in map).toBe(false)
    }
    expect(parsed.provides!.actions!.query).toEqual({ from: ['http'] })
    expect(parsed.entries.frames!.panel).toBe('p.html')
  })

  it.each(both)('keep an action from the %s named like a member of Object as only that action', (_from, schema) => {
    const parsed = schema.parse({ ...minimal, provides: { actions: { hasOwnProperty: { from: ['http'] }, toString: {} } } })
    const actions = parsed.provides!.actions! as Record<string, unknown>
    expect(Object.keys(actions)).toEqual(['hasOwnProperty', 'toString'])
    expect(actions.hasOwnProperty).toEqual({ from: ['http'] })
    expect(actions.valueOf).toBeUndefined()
  })
})

describe('keys that reach Object', () => {
  const minimalText = JSON.stringify(minimal)
  it.each([
    ['__proto__ at the top', minimalText.replace('{"id"', '{"__proto__":{"class":0},"id"')],
    ['__proto__ in the entries', minimalText.replace('{"worker"', '{"__proto__":{"host":"x.js"},"worker"')],
    ['__proto__ as a frame name', minimalText.replace('{"worker":"worker.js"}', '{"frames":{"__proto__":"x.html"}}')],
    ['constructor as a frame name', minimalText.replace('{"worker":"worker.js"}', '{"frames":{"constructor":"x.html"}}')],
    ['prototype as a frame name', minimalText.replace('{"worker":"worker.js"}', '{"frames":{"prototype":"x.html"}}')],
    ['__proto__ as an action', minimalText.replace(/}$/, ',"provides":{"actions":{"__proto__":{}}}}')],
    ['constructor as an action', minimalText.replace(/}$/, ',"provides":{"actions":{"constructor":{}}}}')],
    ['prototype as an action', minimalText.replace(/}$/, ',"provides":{"actions":{"prototype":{}}}}')],
    ['__proto__ inside an action', minimalText.replace(/}$/, ',"provides":{"actions":{"handle":{"__proto__":{"from":["x"]}}}}}')],
    ['__proto__ inside a capability', minimalText.replace(/}$/, ',"capabilities":[{"type":"storage","__proto__":{}}]}')],
    ['constructor inside a capability', minimalText.replace(/}$/, ',"capabilities":[{"type":"ui.view","constructor":1}]}')],
  ])('refuses %s', (_name, text) => {
    expect(folderManifest.safeParse(raw(text)).success).toBe(false)
    expect(installManifest.safeParse(raw(text)).success).toBe(false)
  })
})
