'use strict';
// E2E finding — in server-backed modes the session handoff must fail closed.
//
// Discovered by E2E review of the 0.3.63 fix branch (see the P01-P05 / G01-G04 work):
// `libra_unified_server_writer_v1_test` already asserted this contract and was failing from
// 0.3.61 onward. Instrumenting the real fixture showed WHY:
//
//   rollbackWorldManagerState -> threw UNIFIED_BACKEND_NOT_SUPPORTED   (correct)
//   prepareSessionHandoff     -> returned { prepared: true, records: [...] } (WRONG)
//                                 and wrote 3 new rows while doing it
//
// The guard exists in `mutateStateWorldline` (for rollback) but NOT on the handoff path:
// `prepareSessionHandoff` only calls `validateUnifiedTransferRefs`, which checks ref identity
// and digests, never the storage mode. The one mode-shaped guard it does have is nested inside
//
//     if (fullContinuityRefs(manifest).some(unifiedRefIsV4)) { ... }
//
// so when the manifest carries no v4 ref it is skipped entirely — leaving a server-backed
// install able to "prepare" a handoff package it cannot faithfully serve.
//
// THE CONTRACT: the moment the install is running a server-backed mode (mirror / server_only),
// the handoff must fail closed with UNIFIED_BACKEND_NOT_SUPPORTED and must not write, rather
// than silently producing a package whose durable side the server does not support.
//
// The mirror half of the same contract is asserted by libra_unified_server_writer_v1_test's
// final case ("mirror unified path commits server batches and verified local copies"), which
// must keep passing.
const assert = require('node:assert/strict');
const path = require('node:path');

const { serverFixture } = require(path.join(__dirname, 'fixtures', 'libra_server_runtime_fixture.cjs'));

// --- 1. The handoff entry point must consult the storage mode -----------------------------
const fs = require('node:fs');
const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const handoffAt = source.indexOf('const prepareSessionHandoff = async (options = {}) => {');
assert.ok(handoffAt > 0, 'prepareSessionHandoff must exist');
// The body runs until the next top-level const of the same indentation.
const handoffEnd = source.indexOf('\n    const ', handoffAt + 10);
const handoffBody = source.slice(handoffAt, handoffEnd > 0 ? handoffEnd : handoffAt + 12000);
assert.match(handoffBody, /MemorySuiteStorageBridge\.getMode\(\)/,
  'prepareSessionHandoff must consult the storage mode: without it a server-backed install can '
  + 'prepare a handoff whose durable side the server does not support');
assert.match(handoffBody, /UNIFIED_BACKEND_NOT_SUPPORTED/,
  'the unsupported backend must fail closed with UNIFIED_BACKEND_NOT_SUPPORTED');

// --- 2. Runtime: server_only must reject and must not write --------------------------------
const snapshotCounts = async s => {
  const rows = s.storedRows();
  return { rows: rows.length, keys: rows.map(r => r.key).sort().join('|') };
};

(async () => {
  const s = await serverFixture({});           // fixture default mode is server_only
  try {
  await s.f.run();
  await s.f.r.api.retryPendingUnifiedVectors();
  const before = await snapshotCounts(s);
  const callsBefore = s.f.control.calls.length;

  const observations = { mode: 'server_only', before, callsBefore };

  let rejected = null;
  try {
    const result = await s.f.r.api.prepareSessionHandoff({ transferId: 'unsupported-server-handoff' });
    rejected = { threw: false, prepared: result?.prepared, recordCount: Array.isArray(result?.records) ? result.records.length : null };
  } catch (error) {
    rejected = { threw: true, code: error?.code, message: String(error?.message || error).slice(0, 160) };
  }
  observations.rejected = rejected;

  const after = await snapshotCounts(s);
  observations.after = after;
  observations.writesHappened = after.rows !== before.rows;
  observations.callsAfter = s.f.control.calls.length;

  console.log(JSON.stringify({ test: 'libra_unified_server_handoff_fail_closed', observations }, null, 1));

  assert.equal(rejected.threw, true,
    'the handoff must fail closed when the storage backend does not support it, instead of '
    + `returning a package (got ${JSON.stringify(rejected)})`);
  assert.equal(rejected.code, 'UNIFIED_BACKEND_NOT_SUPPORTED',
    `the rejection must carry UNIFIED_BACKEND_NOT_SUPPORTED (got '${rejected.code}')`);
  assert.equal(observations.writesHappened, false,
    `a rejected handoff must not write anything (rows ${before.rows} -> ${after.rows})`);

  process.stdout.write('libra_unified_server_handoff_fail_closed_test: PASS\n');
  } finally {
    await s.cleanup();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
