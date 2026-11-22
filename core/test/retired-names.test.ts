import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { shippedFiles } from './shipped-files.ts'
import { retiredNames, type RetiredName } from './retired-names.ts'

// no retired name in shipped code outside the places retired-names.ts lists for it

const core = path.join(import.meta.dirname, '..')
const repo = path.join(core, '..')
const posix = (file: string) => file.split(path.sep).join('/')

// Shipped code, every text file of it: what hetu runs, not its tests, build tooling or the SDK's testing and build
// helpers
function shipped(): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'testing') continue
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|js|css|html|md|json)$/.test(name) && !/\.(test|d)\.ts$/.test(name)) files.push(posix(path.relative(repo, full)))
    }
  }
  for (const dir of ['core/api', 'core/lib', 'core/sdk', 'core/frontend', 'core/backend']) walk(path.join(repo, dir))
  for (const plugin of readdirSync(path.join(repo, 'core-plugins'))) {
    const src = path.join(repo, 'core-plugins', plugin, 'src')
    if (statSync(src, { throwIfNoEntry: false })?.isDirectory()) walk(src)
  }
  return files.filter(file => !file.startsWith('core/sdk/build/')).sort()
}

export interface Hit {
  file: string
  line: number
  name: string
  text: string
}

// Every retired name in a file, line by line, so a pattern's nearness never reaches across lines
export function hitsIn(file: string, source: string, names: readonly RetiredName[] = retiredNames): Hit[] {
  const hits: Hit[] = []
  source.split('\n').forEach((content, index) => {
    for (const { name, pattern } of names) {
      for (const match of content.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))) {
        hits.push({ file, line: index + 1, name, text: match[0] })
      }
    }
  })
  return hits
}

export function allowedHit(hit: Hit, names: readonly RetiredName[] = retiredNames): boolean {
  const entry = names.find(({ name }) => name === hit.name)
  return entry?.allowed.some(({ place, text }) => {
    const here = place.endsWith('/') ? hit.file.startsWith(place) : hit.file === place
    return here && (text === undefined || text === hit.text)
  }) ?? false
}

// What fails: each retired name found outside its allowed places, as file:line: text (the name, now what)
export function refused(file: string, source: string, names: readonly RetiredName[] = retiredNames): string[] {
  return hitsIn(file, source, names).filter(hit => !allowedHit(hit, names)).map(hit => {
    const now = names.find(({ name }) => name === hit.name)!.now
    return `${hit.file}:${hit.line}: ${hit.text} (retired ${hit.name}, now ${now})`
  })
}

const files = shipped()

describe('retired names', () => {
  it('has files to check in every shipped folder', () => {
    for (const dir of ['core/api/', 'core/lib/', 'core/sdk/', 'core/frontend/', 'core/backend/', 'core-plugins/mcp-http-handler/src/']) {
      expect(files.some(file => file.startsWith(dir)), dir).toBe(true)
    }
  })

  it('finds no retired name in shipped code outside its allowed places', () => {
    const problems = files.flatMap(file => refused(file, readFileSync(path.join(repo, file), 'utf8')))
    expect(problems).toEqual([])
  })

  it('lists only allowed places that still exist, each with a reason', () => {
    for (const { name, allowed } of retiredNames) {
      for (const { place, why } of allowed) {
        expect(existsSync(path.join(repo, place)), `${name}: ${place}`).toBe(true)
        expect(why.length, `${name}: ${place}`).toBeGreaterThan(0)
      }
    }
  })

  it('still finds each allowed exact text where it is listed, so a value moved or renamed takes its entry out', () => {
    for (const { name, allowed } of retiredNames) {
      for (const { place, text } of allowed) {
        if (text === undefined) continue
        const hits = hitsIn(place, readFileSync(path.join(repo, place), 'utf8')).filter(hit => hit.name === name && hit.text === text)
        expect(hits.length, `${name}: ${text} in ${place}`).toBeGreaterThan(0)
      }
    }
  })
  // The proof the later move of this walk to shipped-files.ts leans on
  it('walks the files shippedFiles lists', () => {
    expect(shipped()).toEqual(shippedFiles({ kinds: ['ts', 'js', 'css', 'html', 'md', 'json'], plugins: 'src' }))
  })
})

describe('the retired names check itself', () => {
  const names = (source: string, file = 'core/backend/planted.ts') => hitsIn(file, source).map(hit => `${hit.name}: ${hit.text}`)

  it.each([
    ["const cause = 'slot-on'", "slot: slot-on"],
    ["if (cause === 'slot-off') return", "slot: slot-off"],
    ['const slotOn = true', 'slot: slotOn'],
    ['policySlots.set(id, job)', 'slot: policySlots'],
    ['const jobSlot = jobs[0]', 'slot: jobSlot'],
    ['// the classifier\'s slot is held', "slot: classifier's slot"],
    ['// a policy slot for each job', 'slot: policy slot'],
    ['// the slot of the gate', 'slot: slot of the gate'],
    ['// the unheld watchdog slot', 'slot: watchdog slot'],
    ["if (this.slot(id) !== 'on') return", 'slot: .slot('],
    ['// only while the slot is on', 'slot: slot is on'],
    ["if (slot === 'down') return null", "slot: slot === '"],
    ["import type { SlotState } from '../../api/slots.ts'", 'slot: SlotState', 'slot: slots.ts'],
    ['private isSlot(id: string): boolean', 'slot: isSlot'],
    ["this.note('slot.state', { id })", 'slot: slot.state'],
    ['// the slot holders and every guard', 'slot: slot holders'],
    ["registry.call('log.history', {})", 'log.history: log.history'],
    ['// the loader starts each plugin', 'the loader: loader'],
    ['class PluginLoader {}', 'the loader: Loader'],
    ['type S = StateView', 'StateView: StateView'],
    ['import { requestEnvelope } from \'./envelope.ts\'', 'requestEnvelope: requestEnvelope'],
    ['const installIds = []', 'installIds: installIds'],
    ["// see core/frontend/mount/page.ts", 'core/frontend/mount: frontend/mount'],
    ["call('luoshu.set', note)", 'luoshu.set: luoshu.set'],
    ['// the floor records the router writes', 'floor constants and floor records: floor records'],
    ['const FLOOR_CONSTANTS = floorConstants', 'floor constants and floor records: floorConstants'],
    ['// an install plugin is trusted', 'install plugin and host-level plugin: install plugin'],
    ['// a host-level plugin', 'install plugin and host-level plugin: host-level plugin'],
    ['// the capabilities plugin classes each grant', 'capabilities plugin: capabilities plugin'],
    ['// holds the per-path lock on key', "the luoshu's lock: per-path lock"],
    ['await lock(key, call.callId)', "the luoshu's lock: lock(key"],
    ['unlock(call.callId)', "the luoshu's lock: unlock(call.callId"],
    ['// the version is checked under the lock', "the luoshu's lock: under the lock"],
    ['// a move takes the locks of both ends', "the luoshu's lock: takes the locks"],
    ['// the provider lets go of its lock here', "the luoshu's lock: lets go of its lock"],
  ])('finds %j', (source, ...found) => {
    expect(names(source)).toEqual(found)
  })

  it.each([
    ["{ kind: 'slot', id: 's-1', instance: 'a' }"],
    ['// every value and array slot, counted as the walk goes'],
    ['.hetu-slot { overflow: hidden }'],
    ['const slots: Record<string, { width: number, height: number }> = {}'],
    ['// the editor slot the layout placed for it'],
    ['// laid over its slot, or hidden while no slot holds it'],
    ['/* slots clip what they hold */'],
    ['const slotOf = (view: LayoutView): UiNode => ({'],
    ["if (node.kind === 'slot' || node.kind === 'editor') slots[node.id] = size"],
    ["const segments = await log.history()"],
    ["call.action === 'log.segments' ? log.history() : log.verify()"],
    ['// the floor decides, then the gate'],
    ['const n = Math.floor(x)'],
    ['// the downloader fetches it'],
    ["registry.call('luoshu.settings')"],
    ['// a core plugin from the install'],
    ["const job = policyJob('grant-risk-classifier')"],
    ['// Who holds the lock, or null when it was left by a run that is gone'],
    ['const release = await lock(dataDir)'],
    ['// a lock here was left by a git ended mid-write'],
    ["// lock means the lock module's note lock"],
    ['// a disk locked for a moment costs nothing'],
  ])('leaves %j alone', source => {
    expect(names(source)).toEqual([])
  })

  it('allows a listed exact text only where it is listed and a layout slot near a policy word in a layout file', () => {
    expect(refused('core/api/changes.ts', "export const classCauses = ['start', 'slot-on']")).toEqual([])
    expect(refused('core/api/changes.ts', 'const slotOn = true')).toEqual(['core/api/changes.ts:1: slotOn (retired slot, now policy job)'])
    expect(refused('core/backend/router/router.ts', "if (cause === 'slot-on') return")).toEqual(['core/backend/router/router.ts:1: slot-on (retired slot, now policy job)'])
    expect(refused('core/frontend/editor/layers.ts', '// a slot the gate never sees')).toEqual([])
    expect(refused('core/frontend/trusted/page.ts', '// a slot the gate never sees')).toEqual(['core/frontend/trusted/page.ts:1: slot the gate (retired slot, now policy job)'])
  })
})
