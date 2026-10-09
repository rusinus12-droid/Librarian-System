'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pluginPath = path.resolve(__dirname, '..', 'plugins', 'LIBRA.js');
const source = fs.readFileSync(pluginPath, 'utf8');
const store = new Map();
let unload = null;
const storage = {
  async getItem(key) { return store.has(key) ? store.get(key) : null; },
  async setItem(key, value) { store.set(key, value); },
  async removeItem(key) { store.delete(key); }
};
const host = {
  pluginStorage: storage, safeLocalStorage: storage,
  async getArgument() { return undefined; }, async getArg() { return undefined; },
  async nativeFetch() { throw new Error('offline runtime test'); },
  async onUnload(handler) { unload = handler; return true; },
  async registerSetting() { return true; }, async registerButton() { return true; },
  async addRisuReplacer() { return true; }, async addRisuChatListener() { return true; },
  async addRisuScriptHandler() { return true; }
};
const context = vm.createContext({
  risuai: host, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  queueMicrotask,
  URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto,
  structuredClone: globalThis.structuredClone, performance: globalThis.performance,
  Blob: globalThis.Blob, atob: globalThis.atob, btoa: globalThis.btoa
});
const waitFor = async predicate => {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('LIBRA runtime load timeout');
};

(async () => {
  vm.runInContext(source, context, { filename: pluginPath });
  const api = await waitFor(() => context.__LIBRA__);
  const normalizeStart = source.indexOf('const normalizeCanonicalArtifactForRead =');
  const normalizeEnd = source.indexOf('const canonicalJsonHasDuplicateKeys =', normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'legacy artifact read normalizer must be extractable');
  const normalizeSource = source.slice(normalizeStart, normalizeEnd);
  const normalizeContext = {
    clone: value => value == null ? value : JSON.parse(JSON.stringify(value)),
    asObject: value => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    asArray: value => Array.isArray(value) ? value : [],
    isPlainObject: value => !!value && typeof value === 'object' && !Array.isArray(value),
    string: value => String(value ?? '').trim(),
    stableHash: value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24),
    CANONICAL_ARTIFACT_SCHEMA: 'libra.canonical_artifact.v3',
    CANONICAL_ARTIFACT_LEGACY_SCHEMA: 'libra.canonical_artifact.v2',
    // T03/D02: the read normalizer asks whether a schema is READABLE (v4 or v5)
    // instead of comparing against one literal. This slice is compiled without the
    // constants it closes over, so they are supplied here with the plugin's values.
    UNIFIED_ARTIFACT_SCHEMA: 'libra.canonical_artifact.v4',
    UNIFIED_ARTIFACT_SCHEMA_V5: 'libra.canonical_artifact.v5',
    UNIFIED_READABLE_ARTIFACT_SCHEMAS: Object.freeze(['libra.canonical_artifact.v4', 'libra.canonical_artifact.v5']),
    unifiedArtifactSchemaReadable: value => ['libra.canonical_artifact.v4', 'libra.canonical_artifact.v5'].includes(String(value || '').trim()),
    canonicalEvidenceComparable: value => String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim(),
    canonicalArtifactDomainForRow: (field, row = {}) => ({
      chronology: 'event', characters: 'character', relationships: 'relationship', world: 'world',
      openThreads: 'narrative', uncertainties: String(row?.domain || 'event').toLowerCase()
    })[field] || 'event',
    normalizeCanonicalTemporalRole: (value, fallback = 'current_sequence') => {
      const role = String(value ?? '').trim().toLowerCase();
      return ['current_sequence', 'historical', 'flashback', 'reported', 'hypothetical', 'uncertain'].includes(role) ? role : fallback;
    }
  };
  vm.createContext(normalizeContext);
  vm.runInContext(`${normalizeSource}\nthis.normalizeCanonicalArtifactForRead = normalizeCanonicalArtifactForRead;`, normalizeContext);
  const legacyRow = {
    schema: 'libra.canonical_artifact.v2', state: { characters: [{ name: 'stale mutation' }] },
    chronology: [{ event: 'A entered.', evidenceRefs: ['T11-A'], evidenceSpans: [{ ref: 'T11-A', quote: 'A entered.' }] }],
    characters: [], relationships: [], world: [], openThreads: [], uncertainties: [], recallTerms: ['A']
  };
  const normalizedLegacyOne = normalizeContext.normalizeCanonicalArtifactForRead(legacyRow);
  const normalizedLegacyTwo = normalizeContext.normalizeCanonicalArtifactForRead(legacyRow);
  assert.equal(normalizedLegacyOne.schema, 'libra.canonical_artifact.v3');
  assert.equal(normalizedLegacyOne.legacySchema, 'libra.canonical_artifact.v2');
  assert.equal(Object.hasOwn(normalizedLegacyOne, 'state'), false, 'legacy state mutation is never carried into v3');
  assert.match(normalizedLegacyOne.chronology[0].assertionId, /^legacy_ca_[0-9a-f]+$/);
  assert.equal(normalizedLegacyOne.chronology[0].assertionId, normalizedLegacyTwo.chronology[0].assertionId,
    'legacy assertion metadata augmentation must be deterministic');
  assert.equal(normalizedLegacyOne.legacyStateObservationCompatible, true);
  const incompleteLegacy = normalizeContext.normalizeCanonicalArtifactForRead({
    ...legacyRow, chronology: [{ event: 'A entered.', evidenceRefs: ['t11-a'], evidenceSpans: [] }]
  });
  assert.equal(incompleteLegacy.legacyStateObservationCompatible, false,
    'legacy rows without locally bound evidence must be skipped by state tracking');
  assert.match(source, /LEGACY_STATE_REPLAY_EVIDENCE_REQUIRED/);
  const batch = Array.from({ length: 5 }, (_, index) => ({
    turn: 11 + index,
    user: { text: index === 0 ? 'A가 문 앞에서 기다렸다.' : `User source ${11 + index}` },
    assistant: { text: index === 0 ? '문이 열리자 A가 방에 들어왔다.' : `Assistant source ${11 + index}` }
  }));
  const artifact = {
    schema: 'libra.canonical_artifact.v3',
    chronology: [{ event: '문이 열렸다.', actors: ['A'], evidenceRefs: ['t11-a'], evidenceSpans: [{ ref: 't11-a', quote: '문이 열리자 A가 방에 들어왔다.' }] }],
    characters: [{ name: 'A', fact: '방에 들어왔다.', evidenceRefs: ['t11-a'], evidenceSpans: [{ ref: 't11-a', quote: 'A가 방에 들어왔다.' }] }],
    relationships: [], world: [], openThreads: [], uncertainties: [],
    recallTerms: ['문', 'A']
  };
  assert.equal(api.debugValidateCanonicalArtifact(artifact, batch).ok, true);
  const attractionArtifact = structuredClone(artifact);
  attractionArtifact.relationships = [{
    subject: 'A', target: 'B', dimension: 'attraction', state: 'explicit directional attraction',
    temporalRole: 'current_sequence', certainty: 'confirmed', evidenceRefs: ['t11-u'],
    evidenceSpans: [{ ref: 't11-u', quote: 'A가 문 앞에서 기다렸다.' }]
  }];
  assert.equal(api.debugValidateCanonicalArtifact(attractionArtifact, batch).ok, true,
    'canonical relationship schema accepts the qualitative attraction dimension');
  const invalidDimension = structuredClone(attractionArtifact);
  invalidDimension.relationships[0].dimension = 'attraction_score';
  assert.ok(api.debugValidateCanonicalArtifact(invalidDimension, batch).issues.includes('relationship_dimension_invalid_0'),
    'unknown or numeric relationship dimensions must fail the canonical validator');
  const forbiddenMutation = structuredClone(artifact);
  forbiddenMutation.statePatch = { characters: [] };
  assert.ok(api.debugValidateCanonicalArtifact(forbiddenMutation, batch).issues.includes('unknown_top_level_statePatch'),
    'canonical artifact v3 rejects a derived-state mutation surface');
  const bound = api.debugBindCanonicalArtifactEvidence(artifact, batch);
  assert.match(bound.chronology[0].evidenceSpans[0].sourceHash, /^[0-9a-f]+$/i);
  assert.match(bound.chronology[0].evidenceSpans[0].quoteHash, /^[0-9a-f]+$/i);
  const paraphrasedEvidence = structuredClone(artifact);
  paraphrasedEvidence.chronology[0].evidenceSpans[0].quote = 'A가 문을 열고 방에 들어왔다.';
  assert.ok(api.debugValidateCanonicalArtifact(paraphrasedEvidence, batch).issues.some(issue => issue.startsWith('evidence_span_quote_mismatch')),
    'paraphrased evidence cannot masquerade as an exact source span');
  const missingSpan = structuredClone(artifact);
  delete missingSpan.characters[0].evidenceSpans;
  assert.ok(api.debugValidateCanonicalArtifact(missingSpan, batch).issues.some(issue => issue.startsWith('evidence_span_empty')),
    'every cited canonical fact requires a direct quote binding');
  const itoPatch = {
    schema: 'libra.ito_patch.v1', stage: 'character_ito', ok: true, analysis: { summary: 'grounded edit' }, domain: {},
    edits: [{
      operation: 'insert_after', target: 'p001', expectedHash: 'deadbeef', content: 'A의 현재 위치를 방으로 명확히 한다.',
      evidenceRefs: ['t11-a'], evidenceSpans: [{ ref: 't11-a', quote: 'A가 방에 들어왔다.' }]
    }]
  };
  const itoBound = api.debugValidateAndBindItoPatchEvidence(itoPatch, batch);
  assert.equal(itoBound.ok, true, 'ito additions/replacements must carry direct source bindings');
  assert.match(itoBound.patch.edits[0].evidenceSpans[0].sourceHash, /^[0-9a-f]+$/i);
  const badItoPatch = structuredClone(itoPatch);
  badItoPatch.edits[0].evidenceSpans[0].quote = 'A는 복도로 나갔다.';
  assert.ok(api.debugValidateAndBindItoPatchEvidence(badItoPatch, batch).issues.some(issue => issue.startsWith('ito_edit_evidence_quote_mismatch')),
    'ito cannot add a fact using an invented source quote');

  const rendered = api.debugRenderCanonicalArtifact(artifact);
  assert.equal(api.debugValidateCanonicalRenderedText(rendered).ok, true);
  assert.equal((rendered.match(/^# 종합 기억$/gm) || []).length, 1);
  assert.equal((rendered.match(/^## /gm) || []).length, 6);

  const leaked = structuredClone(artifact);
  leaked.chronology[0].event = 'Let me analyze the five turns first.';
  assert.ok(api.debugValidateCanonicalArtifact(leaked, batch).issues.includes('reasoning_or_meta_leak'));
  const wrongTurn = structuredClone(artifact);
  wrongTurn.chronology[0].evidenceRefs = ['t99-a'];
  assert.ok(api.debugValidateCanonicalArtifact(wrongTurn, batch).issues.some(issue => issue.startsWith('evidence_out_of_range')));
  assert.throws(() => api.debugParseCanonicalArtifact('{"schema":"a","schema":"b"}'), /duplicate_key/);
  const glmCapability = api.debugProviderModelCapability('ollama_cloud', 'glm-5.3-flash');
  assert.equal(glmCapability.forcedReasoning, true);
  assert.equal(glmCapability.canonicalReasoningEffort, 'low');
  assert.equal(glmCapability.nativeStructuredOutput, false);

  if (unload) await unload();
  console.log('libra_canonical_artifact_v2_runtime_test: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
