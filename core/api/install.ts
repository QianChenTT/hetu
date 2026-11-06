import { z } from 'zod'
import { firstPartyIds, installIds, MAX_NAME_LENGTH, pluginId } from './ids.ts'
import { plain } from './plain.ts'
import { pathProblem } from './scope.ts'

// The install list sits in the install folder under this name. The build writes it from step 9 with each install
// plugin's version and hash, so tests write fixtures
export const INSTALL_LIST = 'hetu-install.json'
export const INSTALL_LIST_FORMAT = 1
// Refused unread past this size. The schema holds the parsed value to the same cap
export const MAX_INSTALL_LIST_BYTES = 256 * 1024

// The signer a first-party copy's entry carries until provenance lands. The loader accepts it only while the copy's
// bytes equal the install's. The space keeps it apart from any signer identity provenance could pin, which is a URI or
// an address
export const FIRST_PARTY_SIGNER = 'hetu first-party'

// The manifest's version grammar: three whole numbers and no ranges, since everything in v1 ships together
export const pluginVersion = z.string()
  .max(MAX_NAME_LENGTH, { abort: true })
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/)

// Whether version a is later than version b, both in the manifest's grammar
export function isNewer(a: string, b: string): boolean {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i]
  }
  return false
}

// A folder inside the install, / between names. pathProblem refuses a leading slash, a drive, a backslash and every
// empty, . or .. segment, so the path can't leave the install
const installPath = z.string().superRefine((value, ctx) => {
  const problem = pathProblem(value)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem })
})

// One plugin the install holds: where its folder is, its version and the hash of its files as hashFiles gives it.
// firstParty marks a bundled copy of a first-party folder plugin, which the reconcile copies into the plugin folder.
// Every other entry is an install plugin, whose grants are its manifest
const listed = z.strictObject({
  path: installPath,
  version: pluginVersion,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  firstParty: z.literal(true).optional(),
})
export type Listed = z.infer<typeof listed>

const isOne = (list: readonly string[], value: string) => list.includes(value)

// Read with the strict parser, so a duplicate key or a __proto__ refuses the whole list. An install id is never marked
// first party and a first-party id always is, so the mark can't move a plugin from the folder into the install or the
// other way. Each folder is named once
export const installList = plain(
  z.strictObject({
    format: z.literal(INSTALL_LIST_FORMAT),
    plugins: z.record(pluginId, listed).transform(entries => Object.assign(Object.create(null), entries) as typeof entries),
  }).superRefine((list, ctx) => {
    const paths = new Set<string>()
    for (const [id, entry] of Object.entries(list.plugins)) {
      const fits = entry.firstParty === true ? isOne(firstPartyIds, id) : isOne(installIds, id)
      if (!fits) ctx.addIssue({ code: 'custom', message: `${id} is not ${entry.firstParty ? 'a first-party' : 'an install'} id` })
      if (paths.has(entry.path)) ctx.addIssue({ code: 'custom', message: `a folder named twice: ${entry.path}` })
      paths.add(entry.path)
    }
  }),
  MAX_INSTALL_LIST_BYTES,
)
export type InstallList = z.infer<typeof installList>
