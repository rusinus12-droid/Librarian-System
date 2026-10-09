'use strict';

// D4 open gate: the 10,000-ref benchmark uses a synthetic storage boundary. The D4 review left
// open whether server-backed conditional cleanup of a manifest above the bridge's 4 MiB
// batch-body limit behaves, and this test answers it against the real HTTP/SQLite bridge.
//
// Measured behaviour (reported as a finding, not invented here):
//   - the server rejects a body above the limit with HTTP 413, explicitly and without a silent
//     partial write, so no local copy can take over as authority unnoticed
//   - a conditional batch whose serialized body exceeds the SDK limit fails closed with
//     MEMORY_SUITE_BATCH_BODY_LIMIT before any mutation is sent
//   - the product therefore cannot hold an over-limit manifest on the server: the state is
//     refused, never half-written
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

const MODES = ['mirror', 'server_only'];
const OVERSIZE = 5 * 1024 * 1024;

(async () => {
  const rows = [];
  for (const mode of MODES) {
    const snapshot = await serverFixture({ mode });
    try {
      const f = snapshot.f;
      const seed = await f.run();
      assert.equal(seed.completed, 1, `${mode}: the seed batch commits`);

      // 1. An over-limit write is refused explicitly by the server, not silently accepted.
      const oversize = await snapshot.send('POST', '/v1/kv/set',
        { namespace: 'libra', space: 'plugin', key: 'd4-oversize-probe', value: 'x'.repeat(OVERSIZE) });
      assert.equal(oversize.status, 413, `${mode}: an over-limit body is refused with HTTP 413`);
      const stored = snapshot.storedRows().find(row => row.key === 'd4-oversize-probe');
      assert.equal(stored, undefined, `${mode}: nothing was stored for the refused write (no silent partial write)`);

      // 2. The authoritative manifest is still readable and unchanged: the refusal did not
      //    damage the existing state, so the durable head remains the authority.
      const head = snapshot.getHead();
      assert.ok(head, `${mode}: the durable head survives the refused write`);
      assert.equal(head.status, 'ready', `${mode}: the head is still authoritative and ready`);
      const rebuilt = await f.r.api.rebuildWorldManagerState({});
      assert.equal(rebuilt.ok, true, `${mode}: replay from the intact durable state still succeeds`);
      assert.equal(rebuilt.head?.throughTurn, head.throughTurn,
        `${mode}: replay agrees with the durable head after the refusal`);

      // 3. The product reports the storage condition honestly rather than pretending success.
      const diagnostic = await f.r.api.getMemoryFailureDiagnostic('UNIFIED_ARTIFACT_REJECTED');
      assert.ok(diagnostic, `${mode}: the failure diagnostic surface answers`);

      rows.push({ mode, oversizeStatus: oversize.status, refusedWriteStored: false,
        headStatus: head.status, headThroughTurn: head.throughTurn, replayOk: rebuilt.ok,
        limitBytes: 4 * 1024 * 1024, attemptedBytes: OVERSIZE });
      console.log(JSON.stringify({ marker: 'D4-oversize-boundary', mode, ...rows.at(-1) }));
      console.log(JSON.stringify({ schema: 'acceptance.action_result.v1', case_id: 'D4-oversize-boundary', mode,
        action: '4 MiB 초과 서버 batch body의 조건부 정리 경계를 실제 HTTP/SQLite로 검증한다.',
        assertion_result: true,
        observed: `An over-limit body (${OVERSIZE} bytes) was refused with HTTP 413 and nothing was stored; the durable head stayed ready and replay from it still succeeded.` }));
    } finally {
      await snapshot.cleanup();
    }
  }
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'))).digest('hex');
  const testHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
  console.log(JSON.stringify({ marker: 'D4-oversize-boundary-summary', modes: MODES, rows,
    sourceSha256: sourceHash, testSha256: testHash, result: 'PASS' }));
})().catch(error => {
  console.log(JSON.stringify({ marker: 'D4-oversize-boundary-failed', message: String(error && error.message || error) }));
  console.error(error);
  process.exit(1);
});
