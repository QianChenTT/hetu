import { describe, expect, it } from 'vitest'
import { loadHost } from '../backend/runtime/hosts.ts'
import type { HostLink, HostStart } from '../backend/loader/seams.ts'

const encode = (text: string) => Buffer.from(text, 'utf8')

// A host half's link as the loader hands it: what the half posted, and the carrier's messages to it
function link() {
  const posted: unknown[] = []
  let listener: ((message: unknown) => void) | null = null
  const made: HostLink = {
    post: message => posted.push(message),
    listen: next => {
      listener = next
    },
  }
  return { link: made, posted, send: (message: unknown) => listener?.(message) }
}

const init = { v: 1, kind: 'init', id: 'luoshu', incarnation: 1, api: 1, deps: {}, lastStop: null, previousVersion: null }

function start(entry = 'host.js', text = 'export default 1', over: Partial<HostStart> = {}): HostStart & { sent: ReturnType<typeof link> } {
  const sent = link()
  return { id: 'luoshu', incarnation: 1, root: '/install/luoshu', files: [{ path: entry, bytes: encode(text) }], entry, link: sent.link, sent, ...over }
}

const plugin = { kind: 'hetu-plugin', spec: { start() {} } }

describe('loading a host half', () => {
  it('imports the bytes the loader hashed, as one data: module, after freezing the built-ins', async () => {
    const order: string[] = []
    let imported = ''
    await loadHost(start('host.js', 'export const é = 1'), {
      freeze: () => order.push('freeze'),
      importer: async url => {
        order.push('import')
        imported = url
        return { default: plugin }
      },
    })
    expect(order).toEqual(['freeze', 'import'])
    expect(imported.startsWith('data:text/javascript;base64,')).toBe(true)
    expect(Buffer.from(imported.slice('data:text/javascript;base64,'.length), 'base64').toString('utf8')).toBe('export const é = 1')
  })

  it('runs the module\'s plugin on its link, so the half answers init with ready', async () => {
    const made = start()
    await loadHost(made, { freeze: () => {}, importer: async () => ({ default: plugin }) })
    made.sent.send(init)
    await expect.poll(() => made.sent.posted).toContainEqual({ v: 1, kind: 'ready' })
  })

  it('hands on the roles the module exports and nothing else', async () => {
    const provider = { prepare: async () => ({ scope: {} }), perform: async () => ({}) }
    const gate = { decide: () => ({ allow: true }) }
    const luoshu = { open: () => {} }
    const roles = await loadHost(start(), {
      freeze: () => {},
      importer: async () => ({ default: plugin, provider, gate, luoshu, other: {}, watchdog: 5 }),
    })
    expect(roles).toEqual({ provider, gate, luoshu })
  })

  it('hands on the history and exec roles, which the loader gives the notes folder and the view of the grants', async () => {
    const history = { open: () => {} }
    const exec = { stateChanged: () => {} }
    expect(await loadHost(start(), { freeze: () => {}, importer: async () => ({ default: plugin, history }) })).toEqual({ history })
    expect(await loadHost(start(), { freeze: () => {}, importer: async () => ({ default: plugin, exec }) })).toEqual({ exec })
  })

  it('refuses an entry the files don\'t hold, a module whose default isn\'t a plugin and a module that throws', async () => {
    const options = (module: unknown) => ({ freeze: () => {}, importer: async () => module })
    await expect(loadHost(start('missing.js', '', { files: [] }), options({ default: plugin }))).rejects.toThrow('missing.js')
    await expect(loadHost(start(), options({ default: { kind: 'other' } }))).rejects.toThrow('plugin')
    await expect(loadHost(start(), { freeze: () => {}, importer: async () => { throw new Error('broken module') } })).rejects.toThrow('broken')
  })
})
