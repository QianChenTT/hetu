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

// The luoshu's hold on a path from prepare to perform is the latch, so lock means the lock module's note lock alone.
// Lock stays the word for the data folder's lock, git's index.lock and a disk locked for a moment, so the pattern
// catches the latch's sense only, in the shapes the luoshu, the contract and canonical wrote it
const latchPattern = new RegExp([
  String.raw`\bper-path locks?\b`,
  String.raw`\b(?:un)?lock\((?:key|target\.key|call\.callId)`,
  String.raw`\blocks? (?:on|of) (?:its|the path's|both)\b`,
  String.raw`\bunder (?:the|both|one) locks?\b`,
  String.raw`\b(?:takes?|holds?) the locks\b|\bboth locks\b`,
  String.raw`\blets? go of (?:the |its |no )?lock\b`,
  String.raw`\b(?:key's|provider's) lock\b|\bone lock for\b|\block the other waits on\b|\block from prepare\b|\bwaits on its lock\b`,
  String.raw`\bfor locks and leases\b`,
].join('|'), 'gi')

export const retiredNames: readonly RetiredName[] = [
  {
    name: 'slot',
    now: 'policy job',
    pattern: slotPattern,
    allowed: [
      { place: 'core/api/changes.ts', text: 'slot-on', why: 'a class move\'s cause, in classCauses: the class.raised notice and owed.cause in state files store it and an old state file must still read' },
      { place: 'core/api/describe.ts', text: 'slot-on', why: 'describes the stored cause slot-on' },
      { place: 'core/backend/plugins-manager/classes.ts', text: 'slot-on', why: 'raises and passes the stored cause slot-on' },
      { place: 'core/backend/plugins-manager/changes.ts', text: 'slot-on', why: 'the pass once the grant risk classifier is switched on again carries the stored cause slot-on' },
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
    // The action's name only. The event log's own history() method is called log.history() in the router, which the
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
    // The two phrases only: floor alone still names the router's fixed rules
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
  // The core actions renamed into the namespace of the part that serves them
  { name: 'core.filterReadable', now: 'gate.filterReadable', pattern: /\bcore\.filterReadable\b/g, allowed: [] },
  { name: 'editor.reach', now: 'gate.reach', pattern: /\beditor\.reach\b/g, allowed: [] },
  { name: 'core.quit', now: 'app.quit', pattern: /\bcore\.quit\b/g, allowed: [] },
  { name: 'core.relaunch', now: 'app.relaunch', pattern: /\bcore\.relaunch\b/g, allowed: [] },
  { name: 'core.pickFolder', now: 'app.pickFolder', pattern: /\bcore\.pickFolder\b/g, allowed: [] },
  { name: 'security.open', now: 'app.openSecurity', pattern: /\bsecurity\.open\b/g, allowed: [] },
  { name: 'the luoshu\'s lock', now: 'latch', pattern: latchPattern, allowed: [] },
  { name: 'carrier', now: 'router', pattern: /carriers?/gi, allowed: [] },
  { name: 'core.agentAsk', now: 'core.identityAsk', pattern: /\bcore\.agentAsk\b/g, allowed: [] },
  { name: 'core.agentConnect', now: 'core.consentAsk', pattern: /\bcore\.agentConnect\b/g, allowed: [] },
  { name: 'core.agentConnected', now: 'core.consentAnswer', pattern: /\bcore\.agentConnected\b/g, allowed: [] },
  { name: 'core.agents', now: 'core.identities', pattern: /\bcore\.agents\b/g, allowed: [] },
  { name: 'core.agentRefused', now: 'core.refused', pattern: /\bcore\.agentRefused\b|'agentRefused'/g, allowed: [] },
  { name: 'agent.ask', now: 'identity.ask', pattern: /(?<![\w.])agent\.ask\b/g, allowed: [] },
  { name: 'agent.revoke', now: 'identity.revoke', pattern: /(?<![\w.])agent\.revoke\b/g, allowed: [] },
  { name: 'agent.connect', now: 'consent.ask', pattern: /(?<![\w.])agent\.connect\b/g, allowed: [] },
  { name: 'http.refused', now: '<plugin id>.refused', pattern: /\bhttp\.refused\b/g, allowed: [] },
  { name: 'from http', now: 'from utility', pattern: /\bfrom(?::| ===) 'http'/g, allowed: [] },
  { name: 'from agent', now: 'from pair', pattern: /\bfrom(?::| ===) 'agent'/g, allowed: [] },
  { name: 'the tool table', now: 'the types a pair may hold, in the contract', pattern: /\bapi\/tools\.ts\b|\btoolList\b|\btoolFor\b/g, allowed: [] },
  // The agent names the core held, each now a pair's, an identity's or a consent's. Any word agent in the core is
  // refused by no-agent-word.test.ts, these catch the old names in the core plugins too
  { name: 'agentLabel', now: 'labelOk in mcp-http-handler, the core taking any field', pattern: /\bagentLabel\b/g, allowed: [] },
  { name: 'agentDoor and agentHost', now: 'the pair of the root plugin and the field', pattern: /\bagent(?:Door|Host|Own)\b/g, allowed: [] },
  { name: 'agentAsk and AgentAsk', now: 'identityAsk and IdentityAsk', pattern: /\b[aA]gentAsk\b/g, allowed: [] },
  { name: 'agentConnect and AgentConnect', now: 'consentAsk and ConsentAsk', pattern: /\b[aA]gentConnect\b/g, allowed: [] },
  { name: 'connectLabel', now: 'the field the connect names', pattern: /\bconnectLabel\b/g, allowed: [] },
  { name: 'ListedAgent', now: 'ListedIdentity', pattern: /\bListedAgents?\b/g, allowed: [] },
  { name: 'agentRefusals', now: 'refusedReasons', pattern: /\b[aA]gentRefusals?\b/g, allowed: [] },
  { name: 'MAX_AGENTS_ASKED', now: 'MAX_FIELDS_ASKED', pattern: /\bMAX_AGENTS_ASKED\b/g, allowed: [] },
  {
    name: 'the agent constants',
    now: 'IDENTITY_ASK_LAPSE_MS, IDENTITY_ASK_PAUSE_MS, CONSENT_LAPSE_MS, CONSENT_PAUSE_MS, MAX_CONSENT_ANSWERS, MAX_PAIR_ITEMS',
    pattern: /\b(?:AGENT_ASK_LAPSE_MS|AGENT_ASK_PAUSE_MS|AGENT_CONNECT_LAPSE_MS|AGENT_CONNECT_PAUSE_MS|MAX_CONNECT_ANSWERS|MAX_AGENT_NUMBER(?:_DIGITS)?|MAX_AGENT_ITEMS)\b/g,
    allowed: [],
  },
  { name: 'agentItems and agent-items.ts', now: 'the pairs held in memory by the plugins manager', pattern: /\bagentItems\b|\bagent-items\.ts\b/g, allowed: [] },
  {
    name: 'the revoked marks',
    now: 'the pairs revoked in memory for the run',
    pattern: /\b(?:marksOf|setMarksAside|withMarks|marksHandedBack|markDropped|revokedAside|heardOut)\b|plugins-manager\/marks\.ts\b/g,
    allowed: [],
  },
  { name: 'PluginsAgents', now: 'PluginsIdentities', pattern: /\bPluginsAgents\b/g, allowed: [] },
]
