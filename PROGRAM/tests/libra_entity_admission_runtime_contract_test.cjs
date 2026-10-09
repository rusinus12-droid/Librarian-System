'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(sourcePath, 'utf8');

const sourceSection = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
};

const pureCore = sourceSection(
  '/* LIBRA CANONICAL STATE PIPELINE V3 START */',
  '/* LIBRA CANONICAL STATE PIPELINE V3 PURE CORE END */'
);
const basisRuntime = sourceSection(
  'const entityAdmissionBasisFor =',
  'const entityAdmissionReceiptDigest ='
);
const receiptRuntime = sourceSection(
  'const entityAdmissionReceiptDigest =',
  'const manualStateDispositionIntentProjection ='
);
const admissionRuntime = sourceSection(
  'const ensureIndependentPersonAdmission =',
  'const callStateObserver ='
);
const orchestratorRuntime = sourceSection(
  'const runStateTrackingAfterCommit =',
  'const persistStatePipelineSkipReceipt ='
);

assert.match(orchestratorRuntime,/runUnifiedStateAfterCommit/);
assert.match(orchestratorRuntime,/LEGACY_STATE_REPLAY_EVIDENCE_REQUIRED/);
assert.doesNotMatch(admissionRuntime,/callProviderWithOperationBudget\(/);

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isPlainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const asArray = value => Array.isArray(value) ? value : [];
const string = value => String(value ?? '');
const compact = (value, limit = 900) => string(value).replace(/\s+/g, ' ').trim().slice(0, limit);
const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  }
  return value;
};
const stableReferenceJson = value => JSON.stringify(stableValue(value));
const stableStringify = stableReferenceJson;
const digest = value => crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : stableReferenceJson(value))
  .digest('hex');
const stableHash = value => digest(value).slice(0, 24);

const raw = new Map();
const storage = {
  async getJson(key, fallback = null) {
    return raw.has(String(key)) ? clone(raw.get(String(key))) : clone(fallback);
  },
  async setJson(key, value) {
    raw.set(String(key), clone(value));
    return clone(value);
  }
};

let providerCalls = 0;
let providerImplementation = async () => { throw new Error('provider must not be called'); };
const traces = [];
const context = {
  Object, Array, String, Number, Boolean, JSON, Math, Date, RegExp, Set, Map,
  structuredClone: globalThis.structuredClone,
  safeClone: clone, clone, asObject, isPlainObject, asArray,
  string, text: string, compact, stableReferenceJson, stableStringify, digest, stableHash,
  STATE_OBSERVATION_SCHEMA: 'libra.state_observation.v2',
  ENTITY_REGISTRY_SCHEMA: 'libra.entity_registry.v2',
  CONTINUITY_STATE_SCHEMA: 'libra.continuity_state.v2',
  CONTINUITY_STATE_PROVENANCE_VERSION: 4,
  CONTINUITY_STATE_RELATION_DIMENSIONS: Object.freeze([
      'trust', 'affection', 'attraction', 'fear', 'obligation', 'hostility', 'distance',
    'cooperation', 'authority', 'dependency', 'knowledge', 'other'
  ]),
  PREFIX: 'libra:v1',
  storage,
  key: {
    entityAdmission: (scope, memoryId, revision) => `libra:v1:scope:${scope.scopeKey}:entity-admission:${memoryId}:r${revision}`
  },
  nowIso: () => '2026-09-01T00:00:00.000Z',
  mergeCreativeDirectionText: (customPrompt, extraPrompt) => [customPrompt, extraPrompt].filter(Boolean).join('\n'),
  STATE_ENTITY_ADMISSION_PROMPT_STAGE_ID: 'state_entity_admission',
  compileStatePromptOverride: (stageId, override = {}) => ({
    primary: `[LIBRA RUNTIME LOCK · test]\nstage=${stageId}`,
    customBlock: override?.customPrompt ? `[USER ADDITIONAL STATE INSTRUCTION — LOWER PRIORITY]\n${override.customPrompt}` : '',
    reassertion: `[LIBRA RUNTIME LOCK REASSERTION · test]\nstage=${stageId}`,
    provenance: { schema: 'libra.prompt_profile_provenance.v1', domain: 'state', stage: stageId, owner: 'State', authority: 'derived_state_only' }
  }),
  // Authorized-source boundary for this isolated admission test; complete consent paths are tested in source_edit_libra_*_test.cjs.
  assertLibraStateSourceEditPermission: async () => {},
  statePipelineProviderOptions: (_stageId, options) => clone(options),
  parseCanonicalArtifactJson: value => JSON.parse(String(value)),
  recordStageTrace: value => traces.push(clone(value)),
  LibraProviderBridge: {
    async callTask(...args) {
      providerCalls += 1;
      return await providerImplementation(...args);
    }
  },
  callProviderWithOperationBudget: async (...args) => {
    providerCalls += 1;
    return await providerImplementation(...args);
  }
};
vm.createContext(context);
vm.runInContext(`${pureCore}\n${basisRuntime}\n${receiptRuntime}\n${admissionRuntime}\nthis.api = {
  statePipelinePersonAdmissionPacket,
  buildCanonicalEntityRegistry,
  entityAdmissionBasisFor,
  entityAdmissionReceiptDigest,
  validateEntityAdmissionReceipt,
  ensureIndependentPersonAdmission
};`, context, { filename: 'libra-entity-admission-runtime.js', timeout: 3000 });
const api = context.api;

const artifact = {
  schema: 'libra.canonical_artifact.v3',
  chronology: [{
    event: '박하린은 기록실에 들어왔다.', actors: ['박하린'], assertionId: 'ca_event_harin',
    evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: '박하린은 기록실에 들어왔다.' }]
  }],
  relationships: [], world: [],
  characters: [{
    name: '박하린', domain: 'character', certainty: 'confirmed', assertionId: 'ca_person_harin',
    evidenceRefs: ['t10-a'], evidenceSpans: [{ ref: 't10-a', quote: '박하린은 기록실에 들어왔다.' }]
  }]
};
const scope = { scopeKey: 'scope:entity-admission' };
const memory = {
  memoryId: 'mem_000006', revision: 2, sourceDigest: 'source-digest-2',
  artifactSchema: artifact.schema, canonicalArtifact: clone(artifact), artifactDigest: digest(artifact),
  worldlineId: 'main', turnRange: { start: 6, end: 10 }
};
const ref = {
  key: 'libra:v1:scope:scope:entity-admission:memory:6:r2', status: 'committed',
  memoryId: memory.memoryId, revision: memory.revision, sourceDigest: memory.sourceDigest,
  artifactSchema: memory.artifactSchema, artifactDigest: memory.artifactDigest,
  worldlineId: 'main', turnRange: clone(memory.turnRange)
};
const previousRegistry = {
  schema: 'libra.entity_registry.v2', scopeKey: scope.scopeKey,
  entities: [{ id: 'char_alice', type: 'person', name: 'Alice', aliases: [], validated: true }],
  byId: { char_alice: { id: 'char_alice', type: 'person', name: 'Alice', aliases: [], validated: true } },
  fingerprint: 'registry-before', diagnostics: []
};
const runtimeArgs = settings => ({
  context: { scope }, memory: clone(memory), ref: clone(ref), worldlineId: 'main',
  previousRegistry: clone(previousRegistry), settings: clone(settings)
});
const enabledSettings = {
  stateTracking: { domains: { character: { verifierEnabled: true } } },
  statePromptOverrides: { state_character_verifier: {} }
};
const disabledSettings = {
  stateTracking: { domains: { character: { verifierEnabled: false } } },
  statePromptOverrides: { state_character_verifier: {} }
};

const promptValueAfter = (prompt, marker) => {
  const lines = String(prompt).split(/\r?\n/);
  const index = lines.indexOf(marker);
  assert.ok(index >= 0 && lines[index + 1], `missing prompt marker: ${marker}`);
  return lines[index + 1];
};

(async () => {
  const packet = clone(api.statePipelinePersonAdmissionPacket(artifact, previousRegistry, {}));
  assert.deepEqual(packet.candidates.map(row => row.assertionId), ['ca_person_harin']);

  raw.clear();
  providerCalls = 0;
  providerImplementation = async () => { throw new Error('disabled verifier submitted a provider call'); };
  const disabled = clone(await api.ensureIndependentPersonAdmission(runtimeArgs(disabledSettings)));
  assert.equal(disabled.ok, false);
  assert.equal(disabled.required, true);
  assert.equal(disabled.providerCalls, 0);
  assert.equal(providerCalls, 0, 'disabled verifier fails closed without provider submission');
  assert.equal(disabled.receipt.status, 'failed_closed');
  assert.equal(disabled.receipt.error, 'entity_admission_character_verifier_disabled');
  assert.deepEqual(disabled.approvedPersonAssertionIds, []);
  const disabledValidation = clone(api.validateEntityAdmissionReceipt(disabled.receipt, {
    packet: { ...packet, basis: clone(disabled.receipt.basis) }, basis: disabled.receipt.basis
  }));
  assert.equal(disabledValidation.ok, true, 'failed-closed is itself a durable valid receipt, never an approval');
  const closedRegistry = clone(api.buildCanonicalEntityRegistry(artifact, previousRegistry, {
    scopeKey: scope.scopeKey, approvedPersonAssertionIds: disabled.approvedPersonAssertionIds
  }));
  assert.equal(closedRegistry.entities.some(row => row.type === 'person' && row.name === '박하린'), false,
    'a failed-closed receipt cannot admit the new person');
  assert.ok(closedRegistry.byId.char_alice, 'previously validated people survive a failed new admission');

  raw.clear();providerCalls=0;
  const missing=clone(await api.ensureIndependentPersonAdmission(runtimeArgs(enabledSettings)));
  assert.equal(missing.ok,false);assert.equal(missing.reason,'LEGACY_STATE_REPLAY_EVIDENCE_REQUIRED');assert.equal(providerCalls,0);
  // Fixed, synthetic stored historical receipt: no retired generator is used to produce setup data.
  const storedReceipt=clone(disabled.receipt);storedReceipt.status='complete';storedReceipt.error='';storedReceipt.providerCalls=1;
  storedReceipt.decisions=[{assertionId:'ca_person_harin',decision:'approve',reason:'historical fixture exact actor evidence'}];storedReceipt.approvedPersonAssertionIds=['ca_person_harin'];
  storedReceipt.receiptDigest=api.entityAdmissionReceiptDigest(storedReceipt);raw.set(disabled.receiptKey,storedReceipt);
  const approved=clone(await api.ensureIndependentPersonAdmission(runtimeArgs(enabledSettings)));
  assert.equal(approved.ok,true);assert.equal(approved.reused,true);assert.equal(approved.providerCalls,0);assert.equal(providerCalls,0);
  const approvedRegistry = clone(api.buildCanonicalEntityRegistry(artifact, previousRegistry, {
    scopeKey: scope.scopeKey, approvedPersonAssertionIds: approved.approvedPersonAssertionIds
  }));
  assert.ok(approvedRegistry.entities.some(row => row.type === 'person' && row.name === '박하린'),
    'only the independently approved assertion may admit the new person');

  const callsBeforeReuse = providerCalls;
  const reused = clone(await api.ensureIndependentPersonAdmission(runtimeArgs(enabledSettings)));
  assert.equal(reused.ok, true);
  assert.equal(reused.reused, true);
  assert.equal(reused.providerCalls, 0);
  assert.equal(providerCalls, callsBeforeReuse, 'an exact durable complete receipt is reused without another provider call');

  const tamperedBasis = clone(approved.receipt);
  tamperedBasis.basisDigest = 'forged-basis';
  tamperedBasis.receiptDigest = api.entityAdmissionReceiptDigest(tamperedBasis);
  const badBasis = clone(api.validateEntityAdmissionReceipt(tamperedBasis, {
    packet: { ...packet, basis: clone(approved.receipt.basis) }, basis: approved.receipt.basis
  }));
  assert.deepEqual(badBasis, { ok: false, reason: 'entity_admission_basis_mismatch' });

  const tamperedApproval = clone(approved.receipt);
  tamperedApproval.approvedPersonAssertionIds = [];
  tamperedApproval.receiptDigest = api.entityAdmissionReceiptDigest(tamperedApproval);
  const badApproval = clone(api.validateEntityAdmissionReceipt(tamperedApproval, {
    packet: { ...packet, basis: clone(approved.receipt.basis) }, basis: approved.receipt.basis
  }));
  assert.deepEqual(badApproval, { ok: false, reason: 'entity_admission_approval_set_mismatch' });

  assert.equal(traces.length,0,'legacy receipt reuse cannot pretend a new verifier ran');
  process.stdout.write(`libra_entity_admission_runtime_contract_test: PASS (${path.basename(sourcePath)})\n`);
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
