'use strict';
// Regression guard: canonical packet v3 nested contract keys must survive the
// live entity adapter.  The packet shape the product asks the model for
// (CanonicalPacketContract.promptShape) nests character detail under
// identity/profile/continuity/povKnowledge and relation detail under
// relationType/currentStatus/dynamics.  Cold start writes that same nested
// shape.  If the live adapter only reads flat keys, a model answering the
// documented contract has those fields silently discarded.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'LIBRA World Manager Full.js');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const assertions = [];
const check = (name, ok, detail = null) => {
  assertions.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

async function load() {
  const chat = { id: 'packet-nested-chat', localLore: [], msgs: [], message: [], isStreaming: false };
  const char = { id: 'packet-nested-char', name: 'Packet Nested Test', chatPage: 0, chats: [chat], globalLore: [] };
  const args = new Map(Object.entries({ debug: 'false', embedding_enabled: 'false', activity_dashboard: 'off' }));
  const risuai = {
    apiVersion: '3.0-test', async getRuntimeInfo(){ return { apiVersion: '3.0-test' }; },
    async getArgument(name){ return args.get(name); }, async requestPluginPermission(){ return true; },
    async getCharacter(){ return clone(char); }, async getCurrentCharacterIndex(){ return 0; }, async getCurrentChatIndex(){ return 0; },
    async getCharacterFromIndex(){ return clone(char); }, async getChatFromIndex(){ return clone(chat); },
    async setChatToIndex(_a, _b, next){ Object.assign(chat, clone(next)); char.chats[0] = chat; return true; },
    async setCharacter(next){ Object.assign(char, clone(next)); return true; }, async getDatabase(){ return { personas: [] }; },
    async addRisuReplacer(){ return true; }, async removeRisuReplacer(){ return true; }, async addRisuScriptHandler(){ return true; },
    async removeRisuScriptHandler(){ return true; }, async registerBodyIntercepter(){ return 'packet-nested-test'; },
    async unregisterBodyIntercepter(){ return true; }, async onUnload(){ return true; }, async registerSetting(){ return true; },
    async registerButton(){ return true; }, async showContainer(){ return true; }, async hideContainer(){ return true; },
    pluginStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    safeLocalStorage: { async getItem(){ return null; }, async setItem(){ return true; }, async removeItem(){ return true; } },
    async getLocalPluginStorage(){ return this.pluginStorage; }, async nativeFetch(){ throw new Error('unexpected fetch'); }
  };
  let code = fs.readFileSync(DIST, 'utf8');
  const close = code.lastIndexOf('\n})();');
  if (close < 0) throw new Error('IIFE close not found');
  code = code.slice(0, close)
    + '\n;globalThis.__LIBRA_PACKET_NESTED_TEST__={EntityProcessor:EntityAwareProcessor,MemoryEngine,CanonicalPacketContract};\n'
    + code.slice(close);
  const context = {
    console: { log(){}, warn(){}, error(){}, debug(){} }, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    crypto: { randomUUID: crypto.randomUUID }, AbortController, TextEncoder, TextDecoder, URL, Buffer,
    fetch: async()=>{ throw new Error('unexpected fetch'); }, risuai, Risuai: risuai, globalThis: null, process: { env: {} },
    atob: text => Buffer.from(String(text), 'base64').toString('binary'), btoa: text => Buffer.from(String(text), 'binary').toString('base64')
  };
  context.globalThis = context;
  vm.createContext(context);
  const result = vm.runInContext(code, context, { filename: DIST, timeout: 15000 });
  if (result && typeof result.then === 'function') await result;
  await new Promise(resolve => setTimeout(resolve, 40));
  return context.__LIBRA_PACKET_NESTED_TEST__;
}

// The packet is written in exactly the documented v3 contract shape:
// identity / profile / visualCanon / currentState / continuity / povKnowledge,
// relationType / currentStatus / dynamics.  Every value carries a marker so a
// dropped field is unambiguous.
function contractPacket() {
  const M = 'NESTEDMARK';
  const evidenceRefs = [{ turn: 7, messageId: 'a-7', spanHash: 'h7', snippet: 'evidence', sourceKind: 'assistant' }];
  return {
    schema: 'libra.canonical_packet.v3',
    version: 3,
    meta: {
      turn: 7,
      sourceMessageIds: ['a-7'],
      summary_memory: { summary: `${M}-meta-summary`, recall: `${M}-meta-recall` },
      node_memory: { nodes: [`${M}-meta-node`] },
      audit_cautions: [],
      overpromotion_risks: []
    },
    memory: {
      events: [{ operation: 'add', id: 'e1', summary: `${M}-mem-event`, entities: ['도현'], time: 'T7', location: '루멘', evidenceRefs, importance: 0.7, confidence: 0.8 }],
      facts: [{ operation: 'add', id: 'f1', subject: '루멘 아카데미', slot: 'rule', value: `${M}-mem-fact`, evidenceRefs, importance: 0.6, confidence: 0.8 }],
      open_threads: [{ operation: 'add', id: 't1', summary: `${M}-mem-thread`, status: 'open', evidenceRefs, importance: 0.5, confidence: 0.7 }]
    },
    entity: {
      characters: [{
        operation: 'add',
        name: '도현',
        aliases: [`${M}-alias`],
        identity: { summary: `${M}-identity-summary`, occupation: `${M}-identity-occupation`, affiliation: `${M}-identity-affiliation`, roleInStory: `${M}-identity-role` },
        profile: {
          personality: { traits: [`${M}-profile-trait`], values: [`${M}-profile-value`], fears: [`${M}-profile-fear`] },
          speechStyle: { defaultTone: `${M}-speech-tone`, honorificStyle: `${M}-speech-honorific`, catchphrases: [`${M}-speech-catch`], notes: [`${M}-speech-note`] },
          psychology: { baseline: `${M}-psych-baseline`, currentConflict: `${M}-psych-conflict`, notes: [`${M}-psych-note`] }
        },
        currentState: { summary: `${M}-state-summary`, emotionalState: [`${M}-state-emotion`], cognitiveFocus: [`${M}-state-focus`] },
        continuity: { openThreads: [`${M}-continuity-thread`], unresolvedNeeds: [`${M}-continuity-need`], commitments: [`${M}-continuity-commitment`], nextActionHints: [`${M}-continuity-hint`] },
        povKnowledge: { knownToSelf: [`${M}-pov-self`], unknownToSelf: [`${M}-pov-unknown`], knownToOthers: [`${M}-pov-others`], privateExperiences: [`${M}-pov-private`] },
        evidenceRefs,
        quality: { confidence: 0.85 }
      }],
      relations: [{
        operation: 'add',
        entityA: '도현',
        entityB: '아리엘',
        relationType: `${M}-relation-type`,
        currentStatus: { summary: `${M}-relation-status`, publicLayer: `${M}-relation-public`, privateLayer: `${M}-relation-private`, boundaryState: `${M}-relation-boundary` },
        dynamics: { unresolvedIssues: [`${M}-relation-issue`], recentChanges: [`${M}-relation-change`] },
        evidenceRefs,
        quality: { confidence: 0.8 }
      }],
      pov_memories: [],
      secrets: [],
      current_state: []
    },
    world: { rules: [], places: [], organizations: [], social_rules: [], phenomena: [], systems: {}, physics: {}, exists: {}, active_events: [], offscreen_threads: [], state: { time: 'T7', location: '루멘', scene: `${M}-world-scene`, active_events: [], offscreen_threads: [] } },
    narrative: { scene_phase: 'turning_point', conflict_traces: [], scene_deltas: [], theme_motifs: [], unresolved_threads: [] },
    guards: { continuity_locks: [], audit_cautions: [], overpromotion_risks: [], conflicts: [], uncertain: [] },
    importance: { overall: 0.7, reason: [] }
  };
}

function flatten(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => flatten(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => flatten(item, out));
  return out;
}

(async () => {
  const { EntityProcessor, MemoryEngine, CanonicalPacketContract } = await load();
  if (MemoryEngine && typeof MemoryEngine.setTurn === 'function') MemoryEngine.setTurn(7);

  // Guard the premise: the packet we test against is the shape the product
  // documents to the model.
  const shape = String(CanonicalPacketContract?.promptShape || '');
  check('prompt_shape_declares_nested_character_contract',
    shape.includes('profile') && shape.includes('continuity') && shape.includes('povKnowledge'),
    { hasProfile: shape.includes('profile'), hasContinuity: shape.includes('continuity'), hasPov: shape.includes('povKnowledge') });

  const packet = contractPacket();
  const contract = CanonicalPacketContract.inspect(packet, { allowLegacy: true, requireCoreAxes: true });
  check('contract_packet_is_valid_v3', contract.valid === true, { errors: contract.errors });

  const extraction = EntityProcessor.extractStructuredEntitySignalsFromPackets(packet, {
    conversationText: 'T7 별핵 조사 장면', sourceMessageId: 'a-7', turn: 7
  });
  check('extraction_succeeded', extraction && extraction.success === true && Array.isArray(extraction.entities) && extraction.entities.length === 1,
    { success: extraction?.success, entities: extraction?.entities?.length });

  const entity = extraction.entities[0];
  const relation = Array.isArray(extraction.relations) ? extraction.relations[0] : null;
  // The adapter output is the record that reaches the entity/relation DB; assert
  // the nested contract values survive to the fields the GUI and prompt read.
  const stored = JSON.stringify(entity || {});
  const storedRelation = JSON.stringify(relation || {});
  const has = (haystack, needle) => haystack.includes(needle);

  const expectations = [
    ['profile.personality.traits', 'profile_traits_survive', 'NESTEDMARK-profile-trait', stored],
    ['profile.personality.values', 'profile_values_survive', 'NESTEDMARK-profile-value', stored],
    ['profile.personality.fears', 'profile_fears_survive', 'NESTEDMARK-profile-fear', stored],
    ['profile.speechStyle.defaultTone', 'speech_default_tone_survives', 'NESTEDMARK-speech-tone', stored],
    ['profile.speechStyle.honorificStyle', 'speech_honorific_survives', 'NESTEDMARK-speech-honorific', stored],
    ['profile.speechStyle.catchphrases', 'speech_catchphrases_survive', 'NESTEDMARK-speech-catch', stored],
    ['profile.psychology.baseline', 'psychology_baseline_survives', 'NESTEDMARK-psych-baseline', stored],
    ['profile.psychology.currentConflict', 'psychology_conflict_survives', 'NESTEDMARK-psych-conflict', stored],
    ['profile.psychology.notes', 'psychology_notes_survive', 'NESTEDMARK-psych-note', stored],
    ['continuity.openThreads', 'continuity_open_threads_survive', 'NESTEDMARK-continuity-thread', stored],
    ['continuity.unresolvedNeeds', 'continuity_unresolved_needs_survive', 'NESTEDMARK-continuity-need', stored],
    ['continuity.commitments', 'continuity_commitments_survive', 'NESTEDMARK-continuity-commitment', stored],
    ['continuity.nextActionHints', 'continuity_next_hints_survive', 'NESTEDMARK-continuity-hint', stored],
    ['povKnowledge.knownToSelf', 'pov_known_to_self_survives', 'NESTEDMARK-pov-self', stored],
    ['povKnowledge.unknownToSelf', 'pov_unknown_to_self_survives', 'NESTEDMARK-pov-unknown', stored],
    ['povKnowledge.knownToOthers', 'pov_known_to_others_survives', 'NESTEDMARK-pov-others', stored],
    ['povKnowledge.privateExperiences', 'pov_private_experiences_survive', 'NESTEDMARK-pov-private', stored],
    ['currentStatus.summary', 'relation_status_summary_survives', 'NESTEDMARK-relation-status', storedRelation],
    ['currentStatus.publicLayer', 'relation_public_layer_survives', 'NESTEDMARK-relation-public', storedRelation],
    ['currentStatus.privateLayer', 'relation_private_layer_survives', 'NESTEDMARK-relation-private', storedRelation],
    ['currentStatus.boundaryState', 'relation_boundary_survives', 'NESTEDMARK-relation-boundary', storedRelation]
  ];
  const dropped = [];
  for (const [contractPath, name, marker, subject] of expectations) {
    const ok = has(subject, marker);
    try { check(name, ok, { contractPath, marker }); }
    catch (error) { dropped.push(`${contractPath} (${name})`); }
  }

  // Prototype-collision guard: a model may return `personality` as a flat array of
  // strings (a documented, common shape) AND nest the same detail under profile.
  // `item.personality?.values` on an array resolves to Array.prototype.values --
  // a truthy native function -- which must never out-rank the nested contract value.
  const collisionPacket = contractPacket();
  const collChar = collisionPacket.entity.characters[0];
  collChar.personality = ['FLATTRAIT'];           // array-valued personality
  collChar.profile = {
    personality: { traits: ['NESTEDTRAIT'], values: ['NESTEDVALUE'], fears: ['NESTEDFEAR'] },
    speechStyle: { defaultTone: 'NESTEDTONE' },
    psychology: { baseline: 'NESTEDBASELINE' }
  };
  const collExtraction = EntityProcessor.extractStructuredEntitySignalsFromPackets(collisionPacket, {
    conversationText: 'collision case', sourceMessageId: 'a-7', turn: 7
  });
  const collEntity = collExtraction?.entities?.[0] || {};
  const collText = JSON.stringify(collEntity);
  check('array_personality_does_not_shadow_nested_values', collText.includes('NESTEDVALUE'),
    { observed: collEntity?.profile?.personality?.values, flat: collEntity?.personality?.values });
  check('array_personality_does_not_shadow_nested_fears', collText.includes('NESTEDFEAR'),
    { observed: collEntity?.profile?.personality?.fears });
  check('flat_array_personality_still_becomes_trait', collText.includes('FLATTRAIT'),
    { observed: collEntity?.personality?.traits });
  // An array-valued personality must also keep the entity accepted (evidence gate reads
  // `.values`/`.traits` on it; the native-function collision would reject real entities).
  check('array_personality_entity_is_accepted', Array.isArray(collExtraction?.entities) && collExtraction.entities.length === 1,
    { entities: collExtraction?.entities?.length, success: collExtraction?.success });
  // The evidence gate's own decision must not be fooled by an array-valued personality.
  check('array_personality_passes_stable_person_signal',
    EntityProcessor.shouldKeepExtractedEntity
      ? EntityProcessor.shouldKeepExtractedEntity({ name: '충돌검사', personality: ['용감함'] }, '충돌검사', { lorebook: [], packetEvidenceNames: new Set() }) === true
      : true,
    { note: 'shouldKeepExtractedEntity not exported; covered by the acceptance assertion above' });

  // Positive control: values the adapter already understood must keep working,
  // so this suite fails only for the nested-contract regression.
  check('control_flat_identity_summary_survives', has(stored, 'NESTEDMARK-identity-summary'), { marker: 'NESTEDMARK-identity-summary' });
  check('control_relation_dynamics_survives', has(storedRelation, 'NESTEDMARK-relation-issue'), { marker: 'NESTEDMARK-relation-issue' });
  check('control_current_state_summary_survives', has(stored, 'NESTEDMARK-state-summary'), { marker: 'NESTEDMARK-state-summary' });

  const failed = assertions.filter(item => !item.ok);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    assertions,
    droppedContractFields: dropped
  }, null, 2));
  if (failed.length) process.exit(1);
})().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error), stack: error?.stack || '', assertions }, null, 2));
  process.exit(1);
});
