'use strict';
// Task 23 of Librarian-System-0.3.61-STORAGE-MODE-CONTINUATION-PLAN.md.
//
// LIBRA-CANONICAL-CAPTURE (D1) is proven for `plugin_only` by
// `libra_canonical_job_runtime_test.cjs` and `native_branch_libra_runtime_test.cjs`.
// It is `unverified` for `mirror` and `server_only`, and it is verified first
// because every other LIBRA feature consumes Canonical: if Canonical is created
// differently per storage mode then State / Recall / Embedding / World Manager
// are all untrustworthy.
//
// This test executes the real canonical capture path in all three modes with
// identical logical input and asserts the semantic invariants plus a durable
// readback of the canonical count and boundary:
//
//   incomplete tail (4 U+A) -> NO canonical created
//   5 U+A                   -> exactly one canonical
//   10 U+A                  -> two canonicals
//
//   plugin_only: zero Librarian backend owner-data requests
//   mirror:      local and server authoritative bytes agree; reload is stable
//   server_only: zero local canonical writes; the server readback succeeds;
//                a fresh runtime reads the canonicals back from the server
const assert = require('node:assert/strict');
const { serverFixture, fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');

const {countCalls,classifyCall} = require('./fixtures/libra_provider_call_kinds.cjs');
const MODES = ['plugin_only', 'mirror', 'server_only'];
const BATCH_PAIRS = 5;
// The fixture's frozen transcript is exactly 5 U+A pairs (t1-u .. t5-a).
const BASE_PAIRS = 5;
// The frozen 5th assistant response, so the restored pair is byte-identical to
// the corpus the other LIBRA tests use rather than an invented sentence.
const FROZEN_ASSISTANT_5 = require('./fixtures/unified_vertical_source.json')
  .sourceRows.find(row => row.ref === 't5-a').text;

// plugin_only keeps owner data in the local plugin storage, so the manifest and
// the canonical must be read from whichever authority the mode actually uses.
const manifestValue = snapshot => {
  const serverManifest = snapshot.getManifest();
  if (serverManifest) return serverManifest;
  const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const memoryValue = (snapshot, start) => {
  const serverMemory = snapshot.getMemory(start);
  if (serverMemory) return serverMemory;
  const ref = manifestValue(snapshot)?.memories?.[String(start)];
  if (!ref?.key) return null;
  const raw = snapshot.local.get(ref.key);
  return raw ? JSON.parse(raw) : null;
};
const canonicalStarts = snapshot => Object.keys(manifestValue(snapshot)?.memories || {})
  .map(Number).sort((left, right) => left - right);
// Canonical identity is the storage key shape (`:memory:<turn>:r<rev>`), not the
// stored schema tag: mirror and server_only write the row under
// `libra.canonical_memory.v1` while carrying `artifactSchema:
// libra.canonical_artifact.v4` inside. plugin_only writes the artefact shape.
const CANONICAL_KEY = /:memory:\d+:r\d+$/;
const MANIFEST_KEY = /:manifest$/;
const canonicalRowKeys = fixture => fixture.storedRows()
  .filter(row => CANONICAL_KEY.test(row.key))
  .map(row => row.key)
  .sort();
const authoritativeRowKeys = fixture => fixture.storedRows()
  .filter(row => CANONICAL_KEY.test(row.key) || MANIFEST_KEY.test(row.key))
  .map(row => row.key)
  .sort();
const localCanonicalKeys = fixture => [...fixture.local.keys()]
  .filter(key => CANONICAL_KEY.test(key) || MANIFEST_KEY.test(key))
  .sort();
// A pair is complete only when the user row has its assistant response.
const completePairs = messages => {
  let pairs = 0;
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (!user || !assistant) break;
    if (String(user.role) !== 'user' || !['assistant', 'char'].includes(String(assistant.role))) break;
    if (!String(user.data || '').trim() || !String(assistant.data || '').trim()) break;
    pairs += 1;
  }
  return pairs;
};

async function runMode(mode) {
  const snapshot = await serverFixture({ mode });
  const fixture = snapshot.f;
  const observations = { mode, canonicalStarts: [], batches: 0, backendRequests: 0, localCanonicalKeys: [] };
  assert.equal(completePairs(fixture.chat.message), BASE_PAIRS, `${mode}: fixture starts at ${BASE_PAIRS} complete U+A pairs`);
  // A batch commits only when five complete U+A pairs are present. Keeping the
  // 5th user row without its response is the incomplete-tail case: the trailing
  // pair is incomplete, so no batch boundary is reached.
  const keepMessages = count => {
    fixture.chat.message.splice(count);
    fixture.chat.messages = fixture.chat.message;
    assert.equal(fixture.chat.message.length, count, `${mode}: transcript narrowed to ${count} messages`);
  };
  try {
    // --- incomplete tail: 4 complete pairs + a dangling 5th user turn --------
    keepMessages(BATCH_PAIRS * 2 - 1);
    assert.equal(completePairs(fixture.chat.message), BATCH_PAIRS - 1, `${mode}: the trailing pair is incomplete`);
    const incomplete = await fixture.run();
    assert.equal(incomplete.completed, 0, `${mode}: an incomplete tail must not commit a canonical (${JSON.stringify(incomplete.result)})`);
    assert.equal(incomplete.result.observedTurns, BATCH_PAIRS - 1, `${mode}: only the four complete pairs are observed`);
    assert.equal(fixture.control.calls.length, 0, `${mode}: an incomplete tail must not call the model`);
    assert.equal(canonicalStarts(snapshot).length, 0, `${mode}: no canonical exists after an incomplete tail`);
    const incompleteManifest = manifestValue(snapshot);
    assert.ok(
      incompleteManifest === undefined || Object.keys(incompleteManifest.memories || {}).length === 0,
      `${mode}: durable manifest holds no canonical after an incomplete tail`
    );
    observations.incompleteTail = { completed: incomplete.completed, observedTurns: incomplete.result.observedTurns, canonicals: 0 };

    // --- the 5th pair completes -> exactly one canonical ---------------------
    fixture.chat.message.push({ role: 'assistant', chatId: 't5-a', data: FROZEN_ASSISTANT_5 });
    fixture.chat.messages = fixture.chat.message;
    assert.equal(completePairs(fixture.chat.message), BASE_PAIRS, `${mode}: the 5th pair is restored`);
    const first = await fixture.run();
    assert.equal(first.completed, 1, `${mode}: the first complete 5-pair batch commits (${JSON.stringify(first)})`);
    assert.equal(countCalls(fixture.control).canonical,1);
    assert.deepEqual(canonicalStarts(snapshot), [1], `${mode}: exactly one canonical, keyed at turn 1`);
    const memory = memoryValue(snapshot, 1);
    assert.equal(memory?.artifactSchema, 'libra.canonical_artifact.v4', `${mode}: the canonical artifact is readable back`);
    observations.canonicalStarts.push(canonicalStarts(snapshot));
    observations.afterFive = { canonicals: canonicalStarts(snapshot).length };

    // --- 10 U+A -> two canonicals --------------------------------------------
    fiveMore(fixture);
    assert.equal(completePairs(fixture.chat.message), BASE_PAIRS * 2, `${mode}: the transcript reaches 10 pairs`);
    const second = await fixture.run();
    assert.equal(second.completed, 1, `${mode}: the second complete batch commits (${JSON.stringify(second)})`);
    // Canonical capture schedules a separate derived-vector flush. Drain it
    // before comparing mirror bytes so the local and server reads observe the
    // same completed manifest revision.
    const vectorDrain = await fixture.r.api.retryPendingUnifiedVectors();
    assert.equal(vectorDrain.ok, true, `${mode}: derived-vector work settles before storage readback`);
    assert.equal(countCalls(fixture.control).canonical,2);
    assert.deepEqual(canonicalStarts(snapshot), [1, 6], `${mode}: two canonicals, keyed at turns 1 and 6`);
    for (const start of [1, 6]) {
      assert.equal(memoryValue(snapshot, start)?.artifactSchema, 'libra.canonical_artifact.v4', `${mode}: canonical ${start} is durable`);
    }
    // The first canonical must not be rewritten by the second batch.
    assert.notEqual(manifestValue(snapshot).memories['1'].key, manifestValue(snapshot).memories['6'].key, `${mode}: canonicals use distinct storage keys`);
    observations.canonicalStarts.push(canonicalStarts(snapshot));
    observations.batches = snapshot.batches.length;
    observations.backendRequests = snapshot.requests.filter(request => request.url.includes('/v1/kv/')).length;
    observations.localCanonicalKeys = localCanonicalKeys(snapshot);

    // --- mode-specific storage contract -------------------------------------
    if (mode === 'plugin_only') {
      assert.equal(snapshot.batches.length, 0, 'plugin_only must not send any owner-data batch to the Librarian backend');
      assert.equal(observations.backendRequests, 0, 'plugin_only must not request owner data from the Librarian backend');
      assert.ok(localCanonicalKeys(snapshot).length >= 1, 'plugin_only keeps the canonical locally');
      assert.equal(snapshot.storedRows().length, 0, 'plugin_only sends no owner data to the server repository');
    }
    if (mode === 'mirror') {
      assert.ok(snapshot.batches.length >= 1, 'mirror commits the canonical through the server');
      const authoritative = authoritativeRowKeys(snapshot);
      assert.deepEqual(authoritative, [
        'libra:v1:scope:seventh-server-scope:manifest',
        'libra:v1:scope:seventh-server-scope:memory:1:r1',
        'libra:v1:scope:seventh-server-scope:memory:6:r1'
      ], 'mirror holds the manifest and both canonicals on the server');
      for (const key of authoritative) {
        // Logical agreement: the local copy must be the same value, not merely present.
        assert.ok(snapshot.local.has(key), `mirror keeps a local copy of ${key}`);
        const serverRow = snapshot.storedRows().find(row => row.key === key);
        assert.deepEqual(JSON.parse(snapshot.local.get(key)), serverRow.value, `mirror local copy of ${key} equals the server value`);
      }
      // A mirror run must never keep a locally divergent copy of owner data:
      // every locally stored manifest/canonical key must exist on the server too.
      const serverKeys = new Set(authoritativeRowKeys(snapshot));
      for (const key of localCanonicalKeys(snapshot)) {
        assert.ok(serverKeys.has(key), `mirror has no local-only authoritative key: ${key}`);
      }
      observations.mirrorAgreement = authoritative;
    }
    if (mode === 'server_only') {
      assert.ok(snapshot.batches.length >= 1, 'server_only commits the canonical through the server');
      assert.deepEqual(localCanonicalKeys(snapshot), [], 'server_only keeps no canonical or manifest locally');
      assert.deepEqual(canonicalRowKeys(snapshot), [
        'libra:v1:scope:seventh-server-scope:memory:1:r1',
        'libra:v1:scope:seventh-server-scope:memory:6:r1'
      ], 'server_only holds both canonicals on the server');
    }

    // --- reload: the canonical is durable and is not regenerated -------------
    const modelCallsBeforeReload = fixture.control.calls.length;
    const restarted = await snapshot.restart();
    const reloadedStarts = canonicalStarts(snapshot);
    assert.deepEqual(reloadedStarts, [1, 6], `${mode}: reload yields the same canonical boundaries`);
    // `restart()` returns a fresh fixture, so its own counter legitimately holds
    // only the calls made after the restart. The claim that matters is that the
    // reload itself is non-generative and changes nothing durable.
    assert.equal(restarted.control.calls.length, 0, `${mode}: reload does not re-call the model`);
    assert.deepEqual(canonicalStarts(snapshot), [1, 6], `${mode}: reload leaves the canonical boundaries untouched`);
    for (const start of [1, 6]) {
      assert.equal(memoryValue(snapshot, start)?.artifactSchema, 'libra.canonical_artifact.v4', `${mode}: canonical ${start} survives reload`);
    }
    observations.reload = {
      canonicalStarts: reloadedStarts,
      modelCallsBeforeReload,
      modelCallsAfterReload: restarted.control.calls.length
    };
    return observations;
  } finally {
    await snapshot.cleanup();
  }
}

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  assert.deepEqual(
    MODES.map(mode => results[mode].canonicalStarts.at(-1)),
    [[1, 6], [1, 6], [1, 6]],
    'all three storage modes produce identical canonical boundaries'
  );
  console.log(JSON.stringify({
    test: 'libra_canonical_capture_3mode_parity',
    passed: 1,
    boundary: 'real deployed LIBRA canonical capture + real HTTP/SQLite storage in three modes; synthetic RisuAI/LLM boundary only',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
