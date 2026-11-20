import { definePlugin, type PluginContext, Refused } from '@hetu/sdk'
import { Index } from './index.ts'
import { listAll } from './listing.ts'

const CACHE_KEY = 'index'
// What the listing at start reads. A path of any other kind is read when an event names it
const NOTE = '.md'
// What gate.filterReadable takes in one call
const MAX_HITS = 1024
// A read that fails for a while goes again after a second, doubling to half a minute while it keeps failing, for at
// most this many notes at once
const MAX_RETRIES = 1024
const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30_000
// Reads again for a resync or a retry go this many at a time, so they never fill the calls search may have in flight
// and a query never waits behind them
const BATCH = 16
// Refusals that mean the note is gone or no longer search's to read. Any other is passing: the gate or the luoshu is
// starting, busy or down
const gone = new Set(['not-found', 'not-granted', 'switched-off'])

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

  const retries = new Set<string>()
  let retryMs = FIRST_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const retryLater = () => {
    if (retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      retryMs = Math.min(retryMs * 2, LAST_RETRY_MS)
      readAgain(retries)
    }, retryMs)
  }

  // Notes to read again, read by one loop a batch at a time
  const due = new Set<string>()
  let reading = false
  function readAgain(paths: Iterable<string>): void {
    for (const path of paths) due.add(path)
    if (reading) return
    reading = true
    void (async () => {
      try {
        while (due.size > 0) {
          const batch = [...due].slice(0, BATCH)
          for (const path of batch) due.delete(path)
          await Promise.all(batch.map(refresh))
        }
      } finally {
        reading = false
      }
    })()
  }

  // Reads the note again. One that is gone or that search may no longer read leaves the index. One whose read failed
  // for a passing reason keeps its entry and is read again later
  async function refresh(path: string): Promise<void> {
    const read = await ctx.try(ctx.luoshu.read({ path }))
    if (!read.ok) {
      if (gone.has(read.refused.code)) {
        retries.delete(path)
        index.remove(path)
        return
      }
      if (retries.size < MAX_RETRIES) retries.add(path)
      retryLater()
      return
    }
    retries.delete(path)
    if (retries.size === 0) retryMs = FIRST_RETRY_MS
    index.add(path, read.value.text)
    await ctx.try(ctx.events.publish('indexed', path))
  }

  // Each start reads every listed note again, so one changed while search wasn't running is read too. A path the index
  // holds that the listing no longer names is read again as well and leaves once its read answers not-found, which keeps
  // a note made after its page was listed. A refused listing leaves the rest of the index as it is
  async function listing(): Promise<void> {
    const listed = await listAll(args => ctx.luoshu.list(args))
    const named = new Set(listed.paths)
    const unlisted = listed.refused === null ? index.paths().filter(path => !named.has(path)) : []
    readAgain([...listed.paths.filter(path => path.endsWith(NOTE)), ...unlisted])
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
  await ctx.try(ctx.events.on(['luoshu.changed', 'luoshu.outside'], event => (event.path === undefined ? undefined : refresh(event.path)), {
    onResync: () => {
      readAgain([...index.paths(), ...retries])
    },
  }))
  // After the subscribe, so a change made while it lists is heard. The cache answers queries meanwhile
  void listing()

  ctx.onStop(async () => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    await ctx.try(ctx.cache.set({ key: CACHE_KEY, value: index.toJSON() }))
  })
}

export default definePlugin({ start })
