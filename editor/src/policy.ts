// The allow gate: the one place that decides what sandboxed code in a note may do.
// Least privilege by default. A tag can ask for more and the gate decides. Later the user's
// switches, approvals, warnings and MFA plug in here, without touching the sandbox itself

export type Capability =
  | 'note.read'
  | 'note.highlight'
  | 'note.popup'
  | 'note.scrollTo'
  | 'state.get'
  | 'state.set'
  | 'bus.publish'
  | 'bus.subscribe'
  | 'frame.resize'

export type Grants = {
  capabilities: Set<Capability>
  network: string[] // domains the frame may connect to, empty means none
  cdnScripts: boolean // may load scripts from the known CDNs
}

// Nothing here lets data leave or reads your notes
const DEFAULT: Capability[] = [
  'note.highlight',
  'note.popup',
  'note.scrollTo',
  'state.get',
  'state.set',
  'bus.publish',
  'bus.subscribe',
  'frame.resize',
]

// Extra capabilities a tag may ask for with grants="..."
const GRANTABLE: Capability[] = ['note.read']

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function grantsFor(attrs: Record<string, string>): Grants {
  const capabilities = new Set<Capability>(DEFAULT)
  for (const asked of (attrs.grants ?? '').split(/[\s,]+/).filter(Boolean)) {
    if ((GRANTABLE as string[]).includes(asked)) capabilities.add(asked as Capability)
  }
  const network = (attrs.network ?? '').split(/[\s,]+/).filter((d) => DOMAIN.test(d))

  // Reading the note and sending data out never go together. A frame with network loses note
  // access and bus input, and a frame that reads the note loses the CDN script channel
  if (network.length) {
    capabilities.delete('note.read')
    capabilities.delete('bus.subscribe')
  }
  return { capabilities, network, cdnScripts: !capabilities.has('note.read') }
}

export function allowed(grants: Grants, cap: Capability): boolean {
  return grants.capabilities.has(cap)
}
