import { expect, it } from 'vitest'
import type { Provider } from '../../api/policy-jobs.ts'
import type { Quotas } from '../../backend/providers/storage/store.ts'
import { ask, editorCaller, pluginCaller } from './ask.ts'

// A store made empty for each case and the quotas it holds each space to: core/api's for the fake, small ones for the
// storage module, whose disk takes seconds to fill core/api's key count
export type StorageSubject = { provider: Provider, quotas: Quotas }

// storage.* and cache.* as every caller reaches them
export function storageCases(made: () => Promise<StorageSubject>): void {
  const make = async () => (await made()).provider
  const other = pluginCaller('other')

  it('answers what was set through JSON, null for a key never set and null for set and delete', async () => {
    const store = await make()
    expect(await ask(store, 'storage.get', { key: 'index' })).toBeNull()
    expect(await ask(store, 'storage.set', { key: 'index', value: { notes: ['a.md'], n: 1, gone: null, nan: Number.NaN, dropped: undefined } })).toBeNull()
    expect(await ask(store, 'storage.get', { key: 'index' })).toEqual({ notes: ['a.md'], n: 1, gone: null, nan: null })
    expect(await ask(store, 'storage.delete', { key: 'index' })).toBeNull()
    expect(await ask(store, 'storage.delete', { key: 'index' })).toBeNull()
    expect(await ask(store, 'storage.get', { key: 'index' })).toBeNull()
  })

  it('keeps each caller\'s space, each kind and keys apart only by case apart', async () => {
    const store = await make()
    await ask(store, 'storage.set', { key: 'myKey', value: 'upper' })
    await ask(store, 'storage.set', { key: 'mykey', value: 'lower' })
    await ask(store, 'cache.set', { key: 'myKey', value: 'cached' })
    await ask(store, 'storage.set', { key: 'myKey', value: 'theirs' }, { caller: other })
    await ask(store, 'storage.set', { key: 'myKey', value: 'editor' }, { caller: editorCaller })
    expect(await ask(store, 'storage.get', { key: 'myKey' })).toBe('upper')
    expect(await ask(store, 'storage.get', { key: 'mykey' })).toBe('lower')
    expect(await ask(store, 'cache.get', { key: 'myKey' })).toBe('cached')
    expect(await ask(store, 'storage.get', { key: 'myKey' }, { caller: other })).toBe('theirs')
    expect(await ask(store, 'storage.get', { key: 'myKey' }, { caller: editorCaller })).toBe('editor')
  })

  it('refuses undefined, a key outside core/api\'s grammar and a verb it doesn\'t serve invalid', async () => {
    const store = await make()
    const invalid = { refused: { code: 'invalid' } }
    expect(await ask(store, 'storage.set', { key: 'k', value: undefined })).toEqual(invalid)
    expect(await ask(store, 'cache.set', { key: 'k' })).toEqual(invalid)
    for (const key of ['Key', '1a', 'a-b', 'a.b', '', 'a'.repeat(65), 42, undefined]) {
      expect(await ask(store, 'storage.set', { key, value: 1 }), String(key)).toEqual(invalid)
      expect(await ask(store, 'storage.get', { key }), String(key)).toEqual(invalid)
    }
    expect(await ask(store, 'storage.get', null)).toEqual(invalid)
    expect(await ask(store, 'storage.list', { key: 'k' })).toEqual(invalid)
  })

  it('refuses a content caller, which has no space, not-granted', async () => {
    const content = { kind: 'content', plugin: 'reader', token: 'a'.repeat(32) } as const
    expect(await ask(await make(), 'storage.get', { key: 'k' }, { caller: content })).toEqual({ refused: { code: 'not-granted' } })
  })

  it('holds a space to its key count, replacing a key at the count still allowed', async () => {
    const { provider: store, quotas } = await made()
    for (let i = 0; i < quotas.storage.keys; i++) expect(await ask(store, 'storage.set', { key: `k${i}`, value: 1 })).toBeNull()
    expect(await ask(store, 'storage.set', { key: 'more', value: 1 })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, 'storage.set', { key: 'k0', value: 2 })).toBeNull()
    expect(await ask(store, 'storage.set', { key: 'more', value: 1 }, { caller: other })).toBeNull()
  })

  // A key's line and, in storage, the 64-character hash line under it
  it('holds a space to its bytes, counted as the key\'s line and in storage its hash line', async () => {
    const { provider: store, quotas } = await made()
    const line = '{"space":"reader","key":"big","value":""}\n'.length
    const big = 'x'.repeat(quotas.storage.bytes - line - 65)
    expect(await ask(store, 'storage.set', { key: 'big', value: `${big}x` })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, 'storage.set', { key: 'big', value: big })).toBeNull()
    expect(await ask(store, 'storage.set', { key: 'one', value: 1 })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    // The cache has no hash line, so its line alone fills its bytes
    const cached = 'x'.repeat(quotas.cache.bytes - line)
    expect(await ask(store, 'cache.set', { key: 'big', value: `${cached}x` })).toEqual({ refused: { code: 'failed', reason: 'quota' } })
    expect(await ask(store, 'cache.set', { key: 'big', value: cached })).toBeNull()
  })
}
