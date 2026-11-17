import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { providerActions } from '../api/actions.ts'
import { API_VERSION, apiChanges } from '../api/manifest.ts'
import { hidesOnScreen } from '../api/scope.ts'
import { toolFor, toolList } from '../api/tools.ts'

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'
const PATH_WORDS = 'A note path inside the notes folder, its segments split by /, at most 512 characters. No segment is empty, . or .. or starts with a dot and none holds a backslash, a colon or a control character'
const notePath = (description = PATH_WORDS) => ({ type: 'string', minLength: 1, maxLength: 512, description })

// The provider actions no agent reaches: removing and moving a note, a command, a plugin's own space, a commit, a
// note's text at a commit and the leases
const closed = [
  'luoshu.remove', 'luoshu.move', 'exec.run', 'storage.get', 'storage.set', 'storage.delete', 'cache.get', 'cache.set', 'cache.delete',
  'history.commit', 'history.read', 'leases.acquire', 'leases.renew', 'leases.release', 'leases.list',
]

// Paths the provider's own args take that name no note an agent can reach, then spellings the provider's args refuse
const dotted = ['.obsidian/app.json', 'notes/.git/config', '.a.md', 'notes/.hidden/a.md', `notes/.${String.fromCharCode(0x200c)}git/a.md`, `${String.fromCharCode(0x200d)}.x/a.md`]
const refusedByProvider = [
  '', 'a'.repeat(513), 'notes/../a.md', 'notes/./a.md', 'notes//a.md', '/notes/a.md', 'notes\\a.md', 'C:/a.md', 'notes/a:b.md',
  `notes/a${String.fromCharCode(7)}.md`, `notes/${String.fromCharCode(0xd800)}.md`,
]

const tools = () => Object.entries(providerActions).flatMap(([action, spec]) => (spec.agent === undefined ? [] : [{ action, ...spec.agent }]))
const optional = (schema: z.ZodType) => schema.safeParse(undefined).success

describe('the tools an agent sees', () => {
  it('lists four, each with the core\'s words and the JSON Schema of what an agent sends', () => {
    expect(toolList()).toEqual([
      {
        name: 'read_note',
        description: 'Read one note from the notes folder. Answers its text, its path and its version, the SHA-256 of its bytes in hex. Only a note this agent holds a grant to read is answered',
        inputSchema: { $schema: DRAFT, type: 'object', properties: { path: notePath() }, required: ['path'], additionalProperties: false },
      },
      {
        name: 'list_notes',
        description: 'List the paths of the notes under a folder, or in the whole notes folder when none is named, in name order and at most 1000 at a time. Answers paths and next, the after of the next page or null on the last. Only paths this agent holds a grant to list or read are listed',
        inputSchema: {
          $schema: DRAFT,
          type: 'object',
          properties: {
            folder: notePath('A folder inside the notes folder, in the form of a note path. Left out for the whole notes folder'),
            after: notePath('The next of the page before. Left out for the first page'),
          },
          additionalProperties: false,
        },
      },
      {
        name: 'write_note',
        description: 'Write the whole text of one note. Answers its new version. baseVersion is the version the note has now, left out only when no note is at that path, or the write answers stale and changes nothing. Only a path this agent holds a grant to write is written',
        inputSchema: {
          $schema: DRAFT,
          type: 'object',
          properties: {
            path: notePath(),
            text: { type: 'string', description: 'The whole new text of the note' },
            baseVersion: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'The version the note has now, 64 lowercase hex digits. Left out for a new note' },
          },
          required: ['path', 'text'],
          additionalProperties: false,
        },
      },
      {
        name: 'note_history',
        description: 'List the commits in hetu\'s history that changed one note, newest first, each with its id, author, committer, date and message. Only a note this agent holds a grant to read the history of is answered',
        inputSchema: {
          $schema: DRAFT,
          type: 'object',
          properties: { path: notePath(), limit: { type: 'integer', minimum: 1, maximum: 200, description: 'The most commits to answer, 50 when left out' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ])
  })

  it('maps each tool to its own row\'s action and nothing else', () => {
    expect(Object.fromEntries(toolList().map(tool => [tool.name, toolFor(tool.name)?.action]))).toEqual({
      read_note: 'luoshu.read', list_notes: 'luoshu.list', write_note: 'luoshu.write', note_history: 'history.log',
    })
    for (const tool of tools()) {
      const found = toolFor(tool.name)
      expect(found?.action).toBe(tool.action)
      expect(found?.args).toBe(providerActions[tool.action].agent?.args)
    }
  })

  it('finds no tool by an action\'s name, an Object member or a name no row holds', () => {
    for (const name of ['luoshu.read', 'read', 'remove_note', 'move_note', 'run', 'toString', '__proto__', 'constructor', 'hasOwnProperty', '', 'READ_NOTE', 'read_note ']) {
      expect(toolFor(name)).toBeNull()
    }
  })

  it('keeps every other provider action closed, removing and moving a note among them', () => {
    expect(tools().map(tool => tool.action)).toEqual(['luoshu.read', 'luoshu.list', 'luoshu.write', 'history.log'])
    for (const action of closed) {
      expect(providerActions[action].agent).toBeUndefined()
      expect(toolList().map(tool => toolFor(tool.name)?.action)).not.toContain(action)
    }
    expect([...closed, 'luoshu.read', 'luoshu.list', 'luoshu.write', 'history.log'].sort()).toEqual(Object.keys(providerActions).sort())
  })

  it('names each tool once in the form MCP takes', () => {
    const names = toolList().map(tool => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z_]{0,63}$/)
  })

  it('gives each tool an object schema with no open additionalProperties, every required field among its properties', () => {
    for (const tool of toolList()) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      const properties = Object.keys(tool.inputSchema.properties as object)
      for (const field of (tool.inputSchema.required ?? []) as string[]) expect(properties).toContain(field)
    }
  })

  it('narrows each provider\'s args: no field the provider lacks and every field the provider needs needed', () => {
    for (const tool of tools()) {
      const own = (providerActions[tool.action].args as z.ZodObject).shape
      const agent = tool.args.shape
      for (const field of Object.keys(agent)) expect(Object.keys(own)).toContain(field)
      for (const [field, schema] of Object.entries(own)) {
        if (!optional(schema as z.ZodType)) expect(optional(agent[field] as z.ZodType)).toBe(false)
      }
    }
  })

  it.each(['read_note', 'list_notes', 'write_note', 'note_history'])('refuses for %s every path the provider refuses or can never reach', name => {
    const tool = toolFor(name)!
    const fields = Object.keys((tool.args as z.ZodObject).shape).filter(field => ['path', 'folder', 'after'].includes(field))
    expect(fields.length).toBeGreaterThan(0)
    const base = name === 'write_note' ? { text: 'x' } : {}
    for (const field of fields) {
      for (const bad of [...dotted, ...refusedByProvider]) expect(tool.args.safeParse({ ...base, path: 'a.md', [field]: bad }).success).toBe(false)
    }
    for (const bad of refusedByProvider) {
      expect(providerActions[tool.action].args.safeParse({ ...base, path: 'a.md', [fields[0]]: bad }).success).toBe(false)
    }
  })

  it.each<[string, unknown, boolean]>([
    ['read_note', { path: 'notes/a.md' }, true],
    ['read_note', { path: 'a'.repeat(512) }, true],
    ['read_note', { path: 'notes/a.md.' }, true],
    ['read_note', { path: 'notes/\u4e2d\u6587.md' }, true],
    ['read_note', {}, false],
    ['read_note', undefined, false],
    ['read_note', { path: 'a.md', follow: true }, false],
    ['read_note', { path: 7 }, false],
    ['list_notes', {}, true],
    ['list_notes', { folder: 'notes' }, true],
    ['list_notes', { folder: 'notes', after: 'notes/a.md' }, true],
    ['list_notes', undefined, false],
    ['list_notes', { page: 2 }, false],
    ['write_note', { path: 'a.md', text: '' }, true],
    ['write_note', { path: 'a.md', text: 'x', baseVersion: 'f'.repeat(64) }, true],
    ['write_note', { path: 'a.md', text: 'x', baseVersion: 'F'.repeat(64) }, false],
    ['write_note', { path: 'a.md', text: 'x', baseVersion: 'f'.repeat(63) }, false],
    ['write_note', { path: 'a.md' }, false],
    ['write_note', { path: 'a.md', text: 42 }, false],
    ['write_note', { path: 'a.md', text: 'x', overwrite: true }, false],
    ['note_history', { path: 'a.md' }, true],
    ['note_history', { path: 'a.md', limit: 1 }, true],
    ['note_history', { path: 'a.md', limit: 200 }, true],
    ['note_history', { path: 'a.md', limit: 0 }, false],
    ['note_history', { path: 'a.md', limit: 201 }, false],
    ['note_history', { path: 'a.md', limit: 1.5 }, false],
    ['note_history', { path: 'a.md', commit: 'f'.repeat(40) }, false],
  ])('checks %s with %j with the provider taking what the tool takes', (name, args, ok) => {
    const tool = toolFor(name)!
    const parsed = tool.args.safeParse(args)
    expect(parsed.success).toBe(ok)
    if (parsed.success) expect(providerActions[tool.action].args.safeParse(parsed.data).success).toBe(true)
  })

  it('freezes each tool entry and answers a fresh list each time', () => {
    for (const tool of Object.values(providerActions).map(spec => spec.agent).filter(entry => entry !== undefined)) expect(Object.isFrozen(tool)).toBe(true)
    const first = toolList()
    const properties = first[0].inputSchema.properties as Record<string, unknown>
    first[0].description = 'changed'
    properties.path = {}
    expect(toolList()[0].description).not.toBe('changed')
    expect((toolList()[0].inputSchema.properties as Record<string, unknown>).path).toEqual(notePath())
  })

  it('holds nothing in its words that could hide on a screen', () => {
    for (const tool of toolList()) {
      expect(hidesOnScreen(tool.description)).toBe(false)
      expect(hidesOnScreen(JSON.stringify(tool.inputSchema))).toBe(false)
    }
  })

  // The tools are the core's own words to an agent, which no plugin's manifest names, so a change to them is no change
  // a plugin's api range reads
  it('leaves the API version as it was', () => {
    expect(API_VERSION).toBe(3)
    expect(Object.keys(apiChanges)).toEqual(['2', '3'])
  })
})
