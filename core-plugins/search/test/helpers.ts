import path from 'node:path'
import { definePlugin, type Plugin, type PluginContext, type UiNode } from '@hetu/sdk'
import { type FakeCore, fakeCore, type FakeCoreOptions, FakeDrawer } from '@hetu/sdk/testing'
import search from '../src/worker.ts'

export const manifest = path.join(import.meta.dirname, '..', 'hetu-plugin.json')

const cores: FakeCore[] = []

// A fake core with a drawer, closed by close()
export function core(options: Omit<FakeCoreOptions, 'manifest' | 'drawer'> = {}): { fake: FakeCore, drawer: FakeDrawer } {
  const drawer = new FakeDrawer()
  const fake = fakeCore({ manifest, drawer, ...options })
  cores.push(fake)
  return { fake, drawer }
}

export async function close(): Promise<void> {
  for (const made of cores.splice(0)) await made.close()
}

export const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

// Waits ms of the clock, however long each check takes
export async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('nothing arrived in time')
    await tick(10)
  }
}

// The paths a query found, or the refusal's code
export async function query(fake: FakeCore, text: unknown, grants?: Parameters<FakeCore['call']>[2]): Promise<string[] | string> {
  const reply = await fake.call('search.query', { text }, grants)
  return reply.ok ? (reply.result as { paths: string[] }).paths : reply.refusal.code
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export const finds = (fake: FakeCore, text: string, paths: string[], ms?: number) => until(async () => same(await query(fake, text), paths), ms)

// Every node of a tree, a list's rows and a node's children alike
export function nodes(tree: UiNode | null): UiNode[] {
  if (tree === null) return []
  const kids = [...((tree as { children?: UiNode[] }).children ?? []), ...((tree as { rows?: UiNode[] }).rows ?? [])]
  return [tree, ...kids.flatMap(nodes)]
}

export function instance(drawer: FakeDrawer): string {
  return drawer.instances()[0]!.instance
}

export function view(drawer: FakeDrawer): UiNode | null {
  return drawer.instances().length === 0 ? null : drawer.tree(instance(drawer))
}

function list(drawer: FakeDrawer): UiNode[] {
  return (nodes(view(drawer)).find(node => node.kind === 'list') as { rows: UiNode[] } | undefined)?.rows ?? []
}

// The text each row shows
export function rows(drawer: FakeDrawer): string[] {
  return list(drawer).map(row => (row as { text: string }).text)
}

// The id of the row showing text, the node a click on it names
export function row(drawer: FakeDrawer, text: string): string {
  const found = list(drawer).find(at => (at as { text?: string }).text === text)
  if (found === undefined) throw new Error(`no row ${text} in ${JSON.stringify(rows(drawer))}`)
  return found.id
}

// The status line's text, or null with none drawn
export function status(drawer: FakeDrawer): string | null {
  const found = nodes(view(drawer)).find(node => node.id === 'status')
  return found === undefined ? null : (found as { text: string }).text
}

export function click(drawer: FakeDrawer, node: string): void {
  drawer.emit({ topic: 'view.event', instance: instance(drawer), node, type: 'click' })
}

export function type(drawer: FakeDrawer, node: string, value: string): void {
  drawer.emit({ topic: 'view.event', instance: instance(drawer), node, type: 'input', value })
}

// search with parts of its ctx swapped by change, for a test that needs a call to fail in a way the fake core can't make
export function wrapped(change: (ctx: PluginContext) => Partial<PluginContext>): Plugin {
  return definePlugin({ start: ctx => search.spec.start({ ...ctx, ...change(ctx) }) })
}
