// the names hetu retired, refused in shipped code outside the places listed with each. GLOSSARY.md is the one
// glossary but is git-ignored for now, so a fresh clone or CI has no copy and this list stands in for its replaced
// names. A name settled or renamed in GLOSSARY.md gets its entry here in the same change
//
// Each entry: the retired name, what replaced it, a pattern that finds it and the places it may stay. A place is a
// file or a folder ending in / and with text set only that exact match is allowed there

export interface Place {
  place: string
  text?: string
  why: string
}

export interface RetiredName {
  name: string
  now: string
  pattern: RegExp
  allowed: readonly Place[]
}
// "slot" can't be refused as a plain word. Nearly every slot in shipped code is the layout's slot, a node kind of the
// UI tree where a view is drawn, or plain English such as "array slot" and neither is the retired name. So the
// pattern catches the policy-job sense only, in the shapes the code before the merge used it, which the check's own
// samples keep: slot-on and slot-off, slots.ts, slot joined in one name with a policy word or a word only the policy
// job had (slotOn, slotIds, SlotState, isSlot, policySlots), a slot with a policy job's state (the slot is on, the
// slot's state, slot === 'off', this.slot(id), the slot.state notice) and slot within three words of a policy word
// (the gate slot, this.slot('gate'), the slot holders, a slot role). A local variable named slot that holds a policy
// job's half, as slot.classify(...) did, is past what a pattern can tell from the layout's slot
const policyWord = String.raw`(?:polic(?:y|ies)|gates?|classifiers?|capabilities|jobs?|watchdog|guards?|roles?|holders?)`
const jobState = String.raw`(?:on|off|down|starting|failed|absent|tampered|states?)`
const slotPattern = new RegExp([
  String.raw`\bslot-(?:on|off)\b`,
  String.raw`\bslots\.ts\b`,
  String.raw`\bslots?(?:on|off|ids?|states?|${policyWord})\b`,
  String.raw`\bisSlots?\b|\.slot\(|\bslot\.state\b`,
  String.raw`${policyWord}slots?\b`,
  String.raw`\bslots?(?:'s)?\s+(?:(?:is|was|were|are|be|stays?|switched|turned)\s+)?${jobState}\b`,
  String.raw`\bslots?\s*[!=]==?\s*['"]`,
  String.raw`\b${policyWord}(?:'s)?\W+(?:\w+\W+){0,3}?slots?\b`,
  String.raw`\bslots?\W+(?:\w+\W+){0,3}?${policyWord}\b`,
].join('|'), 'gi')

// The layout's slot, a different meaning from the policy job, is allowed where the layout kind is held, drawn or laid
// out, so a policy word near it in these files is not taken for the retired name
const layoutSlot = 'the layout\'s slot node kind, where a view is drawn, a different meaning from the policy job'

export const retiredNames: readonly RetiredName[] = [
  {
    name: 'slot',
    now: 'policy job',
    pattern: slotPattern,
    allowed: [
      { place: 'core/api/changes.ts', text: 'slot-on', why: 'a class move\'s cause, in classCauses: the class.raised notice and owed.cause in state files store it and an old state file must still read' },
      { place: 'core/api/describe.ts', text: 'slot-on', why: 'describes the stored cause slot-on' },
      { place: 'core/backend/plugins-manager/plugins-manager.ts', text: 'slot-on', why: 'raises and passes the stored cause slot-on' },
      { place: 'core/api/ui.ts', why: layoutSlot },
      { place: 'core/frontend/editor/', why: layoutSlot },
      { place: 'core-plugins/layout/src/', why: layoutSlot },
    ],
  },
  {
    name: 'the loader',
    now: 'plugins-manager',
    // Any loader as a part of hetu, not a word holding it such as downloader. esbuild's loader option is in
    // core/sdk/build, which ships no code
    pattern: /(?<![A-Za-z])loaders?\b|Loaders?\b/g,
    allowed: [],
  },
  {
    name: 'log.history',
    now: 'log.segments',
    // The action's name only. The event log's own history() method is called log.history() in the carrier, which the
    // pattern leaves out
    pattern: /\blog\.history\b(?!\s*\()/g,
    allowed: [],
  },
  { name: 'StateView', now: 'grants snapshot', pattern: /\bStateView\b/g, allowed: [] },
  { name: 'requestEnvelope', now: 'callEnvelope', pattern: /\brequestEnvelope\b/g, allowed: [] },
  { name: 'installIds', now: 'corePluginIds', pattern: /\binstallIds\b/g, allowed: [] },
  { name: 'core/frontend/mount', now: 'core/frontend/editor', pattern: /\bfrontend\/mount\b/g, allowed: [] },
  { name: 'luoshu.set', now: 'luoshu.pick', pattern: /\bluoshu\.set\b/g, allowed: [] },
  {
    name: 'floor constants and floor records',
    now: 'limits and core records',
    // The two phrases only: floor alone still names the carrier's fixed rules
    pattern: /\bfloor[ -]?(?:constants?|records?)\b/gi,
    allowed: [],
  },
  {
    name: 'install plugin and host-level plugin',
    now: 'core plugin',
    pattern: /\binstall[ -]plugins?\b|\bhost[ -]level[ -]plugins?\b|\bhostLevelPlugins?\b/gi,
    allowed: [],
  },
  { name: 'capabilities plugin', now: 'grant-risk-classifier', pattern: /\bcapabilities[ -]plugins?\b/gi, allowed: [] },
  {
    name: 'recordNothing',
    now: 'recording, a core module whose switch is in switches.off',
    // The name only, since record nothing as plain words names no switch
    pattern: /\brecordNothing\b/g,
    allowed: [{ place: 'core/backend/boot/state.ts', why: 'a switches file from before recording was a core module still holds it, read once as recording in off' }],
  },
]
