'use strict';

// Phase D4 semantic timeline caps. This is a real canonical chain built through
// LIBRA's deployed fixture API; the provider is deterministic and local.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { sourceRows } = require('./fixtures/unified_vertical_source.json');

const ALL_MODES = ['plugin_only', 'mirror', 'server_only'];
const MODE_FILTER = process.env.PHASE_D_TIMELINE_CAP_MODE || '';
assert.ok(!MODE_FILTER || ALL_MODES.includes(MODE_FILTER), `unknown PHASE_D_TIMELINE_CAP_MODE: ${MODE_FILTER}`);
const MODES = MODE_FILTER ? [MODE_FILTER] : ALL_MODES;
const BATCHES = 65;
const PROFILE_COUNT = 5;
const clone = value => JSON.parse(JSON.stringify(value));
const parse = value => { try { return JSON.parse(value); } catch (_) { return null; } };
const memoryOf = (snapshot, start = 1) => {
  const manifest = snapshot.getManifest() || parse(snapshot.local.get([...snapshot.local.keys()].find(key => /:manifest$/.test(key)) || ''));
  const ref = manifest?.memories?.[String(start)];
  if (ref) {
    const serverRow = snapshot.storedRows().find(row => row.key === ref.key);
    if (serverRow) return serverRow.value;
    const localValue = parse(snapshot.local.get(ref.key));
    if (localValue) return localValue;
  }
  const candidates = [
    ...snapshot.storedRows().map(row => row.value),
    ...[...snapshot.local.values()].map(parse)
  ].filter(value => value?.schema === 'libra.canonical_memory.v1');
  return candidates.find(value => Number(value.turnRange?.start) === Number(start))
    || candidates.sort((a, b) => Number(b.turnRange?.start || 0) - Number(a.turnRange?.start || 0))[0]
    || null;
};

const exposeStorageBridge = source => {
  const anchor = '  const RisuCompat = (() => {';
  assert.ok(source.includes(anchor), 'storage bridge injection anchor must exist');
  return source.replace(anchor, '  globalThis.__phaseDTimelineCapsStorageBridge = MemorySuiteStorageBridge;\n' + anchor);
};

const appendFivePairs = (f, startTurn) => {
  for (let index = 0; index < 10; index += 1) {
    const turn = startTurn + Math.floor(index / 2);
    f.chat.message.push({ role: sourceRows[index].role, data: sourceRows[index].text, chatId: `t${turn}-${index % 2 ? 'a' : 'u'}` });
  }
  f.chat.messages = f.chat.message;
};

const batchArtifact = (f, startTurn, batchNumber) => {
  const offset = startTurn - 1;
  const evidenceRef = `t${startTurn + 3}-a`;
  const source = f.chat.message.find(row => row.chatId === evidenceRef);
  assert.ok(source, `batch ${batchNumber} has its profile evidence source`);
  const quote = [
    ...Array.from({ length: PROFILE_COUNT }, (_, index) => `민아는 기록${index + 1}을 ${batchNumber}차에도 좋아한다고 말했다.`)
  ].join(' ');
  source.data = quote;
  const value = clone(artifact());
  value.schema = 'libra.canonical_artifact.v5';
  for (const row of [...value.entities, ...value.facts]) {
    for (const span of row.evidenceSpans || []) {
      span.ref = span.ref.replace(/^t(\d+)/, (_, turn) => `t${Number(turn) + offset}`);
      const actual = f.chat.message.find(message => message.chatId === span.ref);
      if (actual) span.quote = actual.data;
    }
  }
  const mina = value.entities.find(entity => entity.tempId === 'mina');
  for (let index = 0; index < PROFILE_COUNT; index += 1) {
    const content = `기록${index + 1}을 ${batchNumber}차에도 좋아한다`;
    value.facts.push({
      tempFactId: `d4_profile_${batchNumber}_${index + 1}`,
      domain: 'character', subjectTempRef: mina.tempId, claimKind: 'character_preference',
      values: { preferences: [{ content, topic: `기록${index + 1}`, kind: 'preference' }] },
      text: `민아는 ${content}고 말했다.`, temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [{ ref: evidenceRef, quote }]
    });
  }
  return value;
};

const runMode = async mode => {
  const modeStarted = Date.now();
  console.log(JSON.stringify({ record: 'timeline_caps_mode_start', mode, batchCount: BATCHES }));
  const snapshot = await serverFixture({ mode, transformSource: exposeStorageBridge });
  try {
    const f = snapshot.f;
    const bridge = f.r.context.__phaseDTimelineCapsStorageBridge;
    assert.ok(bridge, `${mode}: production storage bridge is exposed to verify the route`);
    const scopeKey = (await f.r.api.getHostLineageStatus()).scopeKey;
    const scope = { scopeId: scopeKey, scopeKey, characterId: f.character.id, chatId: f.chat.id,
      aliases: [scopeKey, f.chat.id], label: f.chat.id };
    // A mirror fixture represents a persisted pre-retirement setting, not a new selection.
    if (mode !== 'mirror') await bridge.setScopeMode(scope, mode);
    const actualMode = await bridge.getScopeMode(scope);
    assert.equal(actualMode.mode, mode, `${mode}: selected mode is installed on the actual scope`);
    assert.equal((await f.r.api.getUnifiedStorageStatus()).mode, mode, `${mode}: LIBRA reports the same active mode`);
    f.control.onCall = () => ({ type: 'success', result: JSON.stringify(f.control.artifact) });
    for (let batch = 1; batch <= BATCHES; batch += 1) {
      const startTurn = (batch - 1) * 5 + 1;
      if (batch > 1) appendFivePairs(f, startTurn);
      f.control.artifact = batchArtifact(f, startTurn, batch);
      const result = await f.run();
      assert.equal(result.completed, 1, `${mode}: batch ${batch} commits`);
      if (batch % 5 === 0 || batch === BATCHES) console.log(JSON.stringify({
        record: 'timeline_caps_progress', mode, batch, totalBatches: BATCHES,
        elapsedMs: Date.now() - modeStarted, storageMode: actualMode.mode
      }));
    }
    const expectedStart = BATCHES * 5 - 4;
    const final = memoryOf(snapshot, expectedStart);
    assert.ok(final?.memoryId && final.revision, `${mode}: final canonical memory is readable`);
    const history = await f.r.api.getWorldManagerHistoryDetail({ memoryId: final.memoryId, revision: final.revision });
    const timeline = history.semanticTimeline;
    assert.equal(timeline.maxCanonicalRefs, 64, `${mode}: semantic timeline declares the 64-ref cap`);
    assert.equal(timeline.availableCanonicalRefs, BATCHES, `${mode}: timeline reports all available canonical refs`);
    assert.equal(timeline.scannedCanonicalRefs, 64, `${mode}: timeline scans only the bounded suffix`);
    assert.equal(timeline.partial, true, `${mode}: timeline discloses its truncated prefix`);
    assert.ok(timeline.reasons.includes('canonical_ref_cap'), `${mode}: timeline reports canonical ref truncation`);
    assert.ok(timeline.reasons.includes('semantic_event_cap'), `${mode}: timeline reports event cap truncation`);
    assert.equal(timeline.events.length, 256, `${mode}: timeline retains at most 256 events`);
    assert.equal(timeline.firstObservation, 'first_observed', `${mode}: suffix events are marked first observed`);
    const manifestKey = [...snapshot.local.keys()].find(key => String(key).endsWith(':manifest'));
    const localManifest = parse(snapshot.local.get(manifestKey || ''));
    const serverManifest = snapshot.getManifest();
    if (mode === 'plugin_only') assert.equal(serverManifest, undefined, 'plugin_only has no durable server manifest');
    if (mode === 'mirror') assert.ok(serverManifest && localManifest, 'mirror holds both server and plugin-local manifests');
    if (mode === 'server_only') {
      assert.ok(serverManifest, 'server_only manifest is durable in SQLite');
      assert.equal(localManifest, null, 'server_only has no plugin-local canonical manifest');
    }
    const result = {
      mode, canonicalRefs: timeline.availableCanonicalRefs, scannedCanonicalRefs: timeline.scannedCanonicalRefs,
      eventCount: timeline.events.length, maxCanonicalRefs: timeline.maxCanonicalRefs,
      maxEvents: 256, partial: timeline.partial, reasons: timeline.reasons, storageMode: actualMode.mode,
      backend: mode === 'plugin_only' ? 'plugin_local' : mode === 'mirror' ? 'server_and_local' : 'server_only'
    };
    console.log(JSON.stringify({ record: 'timeline_caps_mode_complete', ...result, elapsedMs: Date.now() - modeStarted }));
    return result;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = [];
  for (const mode of MODES) results.push(await runMode(mode));
  for (const row of results) {
    assert.equal(row.scannedCanonicalRefs, 64, `${row.mode}: all modes retain the bounded 64-ref suffix`);
    assert.equal(row.eventCount, 256, `${row.mode}: all modes retain the bounded 256-event suffix`);
    assert.deepEqual(row.reasons, results[0].reasons,
      `${row.mode}: truncation disclosure reasons match the first exercised mode`);
  }
  console.log(JSON.stringify({
    test: 'libra_phase_d_timeline_caps', passed: results.length, results,
    boundary: 'actual World Manager History semanticTimeline; deterministic local provider; no live model'
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
