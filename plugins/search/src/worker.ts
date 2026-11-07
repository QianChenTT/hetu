import { definePlugin, type PluginContext, Refused } from '@hetu/sdk'
import { Index } from './index.ts'

const CACHE_KEY = 'index'
// What core.filterReadable takes in one call
const MAX_HITS = 1024

// The query's args exactly: { text: string } and nothing else, since they come from another plugin
function textOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null
  const keys = Object.keys(args)
  const { text } = args as { text?: unknown }
  return keys.length === 1 && typeof text === 'string' ? text : null
}

async function start(ctx: PluginContext): Promise<void> {
  const saved = await ctx.try(ctx.cache.get({ key: CACHE_KEY }))
  const index = Index.from(saved.ok ? saved.value : null)

  // Reads the note again. One that is gone or that search may no longer read leaves the index
  const refresh = async (path: string) => {
    const read = await ctx.try(ctx.vault.read({ path }))
    if (!read.ok) return index.remove(path)
    index.add(path, read.value.text)
    await ctx.try(ctx.events.publish('indexed', path))
  }

  // Answers only the notes the caller may read too
  ctx.provide('query', async (call, args) => {
    const text = textOf(args)
    if (text === null) throw new Refused('invalid', call.action)
    const hits = index.search(text).slice(0, MAX_HITS)
    return { paths: hits.length === 0 ? [] : await ctx.filterReadable(call, hits) }
  })

  // A path-less event names no note, so it waits for the resync that follows. A refused subscribe leaves search
  // answering from the index it has
  await ctx.try(ctx.events.on(['vault.changed', 'vault.outside'], event => (event.path === undefined ? undefined : refresh(event.path)), {
    onResync: () => {
      void Promise.all(index.paths().map(refresh))
    },
  }))

  ctx.onStop(async () => {
    await ctx.try(ctx.cache.set({ key: CACHE_KEY, value: index.toJSON() }))
  })
}

export default definePlugin({ start })
