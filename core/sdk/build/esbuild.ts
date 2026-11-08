import { mkdir, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { parse } from 'acorn'
import { simple } from 'acorn-walk'
import { build, type BuildOptions, type Plugin } from 'esbuild'

// Electron 45's Chromium
const TARGET = 'chrome156'
const builtins = new Set(builtinModules)

function isBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(specifier.split('/')[0])
}

// Fails the build for any Node built-in a worker or a view reaches, from its own code or from a dependency's. A worker
// has no Node, so the import would only fail later in hetu
export const refuseNodeImports: Plugin = {
  name: 'hetu-refuse-node-imports',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => (args.kind !== 'entry-point' && isBuiltin(args.path)
      ? { errors: [{ text: `${args.path} is a Node built-in, which a worker or a view can't import` }] }
      : undefined))
  },
}

const WORKER = 'hetu-worker:'
const sdkWorker = path.join(import.meta.dirname, '..', 'worker.ts')

// A worker entry is the plugin's own module with runInWorker around it, so the bundle starts itself on the port the
// worker host page hands it and the plugin's code only exports definePlugin
const runsInWorker = (root: string): Plugin => ({
  name: 'hetu-runs-in-worker',
  setup(builder) {
    builder.onResolve({ filter: /^hetu-worker:/ }, args => ({
      path: path.resolve(root, args.path.slice(WORKER.length)),
      namespace: 'hetu-worker',
    }))
    builder.onLoad({ filter: /.*/, namespace: 'hetu-worker' }, args => ({
      contents: `import plugin from ${JSON.stringify(args.path)}\nimport { runInWorker } from ${JSON.stringify(sdkWorker)}\nrunInWorker(plugin)\n`,
      resolveDir: root,
      loader: 'ts',
    }))
  },
})

// One classic script per entry, each output path from its source, both relative to the plugin's folder. A worker
// starts from a data: URL and a view from its own token path, so nothing is split or loaded later. Each output named in
// workers starts itself in its worker
export function bundleOptions(root: string, entries: Record<string, string>, workers: readonly string[] = []): BuildOptions {
  return {
    absWorkingDir: root,
    entryPoints: Object.entries(entries).map(([output, source]) => ({
      in: workers.includes(output) ? `${WORKER}${source}` : source,
      out: output.replace(/\.js$/, ''),
    })),
    outdir: root,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: TARGET,
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    logLevel: 'silent',
    plugins: [runsInWorker(root), refuseNodeImports],
  }
}

export type BuiltOutput = { path: string, text: string, bytes: number, inputs: string[] }

// Builds each entry and checks each bundle with checkBundle. Throws with every problem found, writes nothing then
export async function buildPlugin(
  root: string,
  options: { entries: Record<string, string>, workers?: readonly string[], write?: boolean },
): Promise<BuiltOutput[]> {
  const result = await build({ ...bundleOptions(root, options.entries, options.workers), write: false })
  const outputs = (result.outputFiles ?? []).map(file => {
    const relative = path.relative(root, file.path).split(path.sep).join('/')
    const meta = Object.entries(result.metafile?.outputs ?? {}).find(([name]) => path.resolve(root, name) === file.path)?.[1]
    return { path: relative, text: file.text, bytes: file.contents.byteLength, inputs: Object.keys(meta?.inputs ?? {}) }
  })
  const problems = outputs.flatMap(output => checkBundle(output.text).map(problem => `${output.path}:${problem}`))
  if (problems.length > 0) throw new Error(`the bundle holds code a plugin may not run:\n${problems.join('\n')}`)
  if (options.write !== false) {
    for (const output of outputs) {
      const file = path.join(root, output.path)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, output.text)
    }
  }
  return outputs
}

type Node = { type: string, loc?: { start: { line: number, column: number } }, [key: string]: unknown }

// An identifier with that name, or that name read off window, self or globalThis
function named(node: Node, name: string): boolean {
  if (node.type === 'Identifier') return node.name === name
  if (node.type !== 'MemberExpression' || node.computed === true) return false
  const { object, property } = node as unknown as { object: Node, property: Node }
  return property.type === 'Identifier' && property.name === name && object.type === 'Identifier'
    && ['window', 'self', 'globalThis'].includes(object.name as string)
}

// Code a bundle may not hold, one line:column problem each: eval, Function as a constructor or a call, a timer given
// a string. A worker's CSP refuses all of them, so they only fail later in hetu
export function checkBundle(code: string): string[] {
  const problems: string[] = []
  const at = (node: Node) => `${node.loc!.start.line}:${node.loc!.start.column + 1}`
  const tree = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true })
  simple(tree, {
    CallExpression(found) {
      const node = found as unknown as Node
      const callee = node.callee as Node
      const [first] = node.arguments as Node[]
      if (named(callee, 'eval')) problems.push(`${at(node)} eval`)
      else if (named(callee, 'Function')) problems.push(`${at(node)} Function called to make code`)
      else if ((named(callee, 'setTimeout') || named(callee, 'setInterval')) && first?.type === 'Literal' && typeof first.value === 'string') {
        problems.push(`${at(node)} a timer given a string`)
      }
    },
    NewExpression(found) {
      const node = found as unknown as Node
      if (named(node.callee as Node, 'Function')) problems.push(`${at(node)} new Function`)
    },
  })
  return problems
}

// The Node built-ins a host half imports that its manifest's node list doesn't name, from its own code or its
// dependencies'. node names built-ins with or without node:
export async function checkHostImports(entry: string, node: readonly string[]): Promise<string[]> {
  const allowed = new Set(node.map(name => name.replace(/^node:/, '').split('/')[0]))
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  const problems = new Set<string>()
  for (const input of Object.values(result.metafile.inputs)) {
    for (const item of input.imports) {
      if (item.external !== true || !isBuiltin(item.path)) continue
      if (!allowed.has(item.path.replace(/^node:/, '').split('/')[0])) problems.add(`${item.path} isn't in the manifest's node list`)
    }
  }
  return [...problems].sort()
}
