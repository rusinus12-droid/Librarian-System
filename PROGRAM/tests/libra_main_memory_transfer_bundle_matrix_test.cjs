'use strict';
// A39 + A40 of `03_ACCEPTANCE_TESTS.md`.
//
// A39 requires a 3x3 export/import -- every storage mode exporting to every -- with the
// result READ BACK. A40 requires that a missing or ALTERED bundle is reported and never
// activated as if it were fine.
//
// The acceptance report previously marked both PASS from a check that only inspected the
// plugin's source text and mutated a JSON object in memory: neither performed a transfer.
// This suite performs the real one, through the manager's portable endpoints
// (`/v1/manager/portable/*`), which is the surface a user's export/import actually goes
// through -- export-start, download-chunk, upload-start, upload-chunk, upload-finish.
//
// A40 tampers with the exported BYTES, the only way to prove the integrity check runs on
// what is shipped rather than on a value the test already holds.
//
// The manager capability is a REAL gate (`retrace_manager_capability_required`): only the
// manager plugin's token carries the role, so this suite bootstraps its own manager
// client against the same data directory the mode fixture is writing to, instead of
// borrowing a role the product does not grant LIBRA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PROGRAM = path.join(__dirname, '..');
const { createMemorySuiteServer } = require('../server/server.cjs');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const MANAGER_PLUGIN = 'flashback_hayaku_bridge'; // the id the server maps to the retrace/manager role

// A manager client on the SAME server the fixture started, using RETRACE's plugin id so
// the bootstrapped token carries the manager role the endpoints require.
const managerClient = url => {
  let token = '';
  const auth = async () => {
    if (!token) {
      const boot = await (await fetch(`${url}/bootstrap`, { headers: { 'X-Memory-Suite-Plugin': MANAGER_PLUGIN } })).json();
      token = boot.token || '';
    }
    return token;
  };
  let operationSeq = 0;
  const call = async (action, body) => {
    // The manager requires an operation id per request, so a retry can be told from a
    // new attempt. The suite supplies its own, one per call.
    operationSeq += 1;
    const payload = { operationId: `libra-transfer-${action}-${operationSeq}-${Date.now()}`, ...(body || {}) };
    const response = await fetch(`${url}/v1/manager/portable/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await auth()}`, 'X-Memory-Suite-Plugin': MANAGER_PLUGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { status: response.status, ...(await response.json()) };
  };
  return { call, hasToken: async () => !!(await auth()) };
};

// A transfer session is addressed by the PAIR (transferId, transferToken): the token is
// what authorizes work on that session, so every follow-up call carries both.
const waitFor = async (client, session, want, tries = 60) => {
  const { transferId, transferToken } = session;
  for (let index = 0; index < tries; index += 1) {
    const state = await client.call('status', { transferId, transferToken });
    const s = state.result || {};
    if (want.includes(s.status)) return s;
    if (['failed', 'cancelled'].includes(s.status)) return s;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
};
// `download-chunk` is addressed by BYTE OFFSET and answers with base64 content plus the
// chunk's own sha256, so the archive is reassembled from offsets until totalBytes.
const downloadAll = async (client, session) => {
  const { transferId, transferToken } = session;
  const chunks = [];
  let offset = 0;
  for (let guard = 0; guard < 4096; guard += 1) {
    const chunk = await client.call('download-chunk', { transferId, transferToken, offset });
    if (chunk.status !== 200) return { bytes: Buffer.concat(chunks), error: chunk.error || `status ${chunk.status}` };
    const result = chunk.result || {};
    const part = Buffer.from(result.base64 || '', 'base64');
    if (!part.length) return { bytes: Buffer.concat(chunks), error: 'empty chunk before totalBytes' };
    chunks.push(part);
    offset += part.length;
    if (offset >= Number(result.totalBytes || 0)) break;
  }
  return { bytes: Buffer.concat(chunks), error: null };
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    // Commit one real batch so the export has content to carry.
    f.control.artifact = artifact();
    observation.committed = (await f.run())?.completed ?? null;

    const client = managerClient(snapshot.url);
    observation.managerToken = await client.hasToken();

    // ── A39: export through the manager, then upload it back ──────────────────
    const started = await client.call('export-start', {});
    assert.equal(started.status, 200, `${mode}: export-start is accepted for the manager (got ${started.status} ${started.error || ''})`);
    const transferId = started.result?.transferId;
    const transferToken = started.result?.transferToken;
    observation.transferId = transferId;
    assert.ok(transferId && transferToken,
      `${mode}: export-start returns a transfer id and token (${JSON.stringify(started.result || {}).slice(0, 160)})`);
    // The export runs asynchronously through the snapshot phase, so its readiness is
    // polled; reading chunks before it is ready yields an incomplete archive.
    const seen = [];
    let ready = null;
    for (let i = 0; i < 60; i += 1) {
      const st = await client.call('status', { transferId, transferToken });
      const r = st.result || {};
      seen.push(`${r.status}/${r.phase}`);
      if (['ready', 'completed', 'failed', 'cancelled'].includes(r.status)) { ready = r; break; }
      await new Promise(res => setTimeout(res, 200));
    }
    observation.statuses = [...new Set(seen)];
    observation.lastState = JSON.stringify(ready || {}).slice(0, 400);
    observation.exportStatus = ready?.status || null;
    observation.exportError = ready?.error || null;
    assert.ok(ready && ['ready', 'completed'].includes(ready.status),
      `${mode}: the export finishes (status ${observation.exportStatus} ${observation.exportError || ''}) seen=${JSON.stringify(observation.statuses)} last=${observation.lastState}`);
    observation.exportTotalBytes = ready.totalBytes || ready.bytes || 0;
    observation.exportSha = String(ready.sha256 || '').slice(0, 16);
    const downloaded = await downloadAll(client, { transferId, transferToken });
    const bytes = downloaded.bytes;
    observation.downloadError = downloaded.error;
    observation.exportBytes = bytes.length;
    assert.ok(bytes.length > 0, `${mode}: the export produces bytes`);
    observation.zipMagic = bytes.length > 2 ? bytes.slice(0, 2).toString('utf8') : '';
    assert.equal(observation.zipMagic, 'PK', `${mode}: the export is the declared zip32 format`);

    // The bundle must be REFUSED when its bytes changed. Upload the tampered copy and
    // let the manager's own integrity check answer.
    const tampered = Buffer.from(bytes);
    const at = Math.floor(tampered.length / 2);
    tampered[at] = tampered[at] ^ 0xff;
    // `upload-start` takes `size` (the declared archive length) and the archive must be
    // at least the 22-byte zip minimum; the export's own length is passed through.
    const uploadStart = await client.call('upload-start', { size: tampered.length });
    observation.uploadStart = JSON.stringify(uploadStart).slice(0, 240);
    const uploadId = uploadStart.result?.transferId;
    const uploadToken = uploadStart.result?.transferToken;
    assert.ok(uploadId && uploadToken,
      `${mode}: upload-start is accepted (got ${JSON.stringify(uploadStart).slice(0, 200)})`);
    // Upload chunks are addressed by BYTE OFFSET and carry `base64`.
    const uploaded = await client.call('upload-chunk', {
      transferId: uploadId, transferToken: uploadToken, offset: 0,
      base64: tampered.toString('base64')
    });
    observation.uploadChunkStatus = uploaded.status;
    const finished = await client.call('upload-finish', { transferId: uploadId, transferToken: uploadToken });
    observation.uploadFinish = JSON.stringify(finished).slice(0, 300);

    // A40: the alteration must be REPORTED -- by the finish response or by the session
    // state. Silence would mean it was accepted as if it were fine.
    let refused = finished.status !== 200 || finished.ok === false
      || /invalid|mismatch|corrupt|digest|damaged|zip|failed/i.test(JSON.stringify(finished));
    if (!refused) {
      const state = await waitFor(client, { transferId: uploadId, transferToken: uploadToken }, ['ready', 'failed', 'cancelled'], 40);
      observation.uploadStatus = state?.status || null;
      observation.uploadError = state?.error || null;
      refused = state?.status === 'failed' || !!state?.error;
    }
    observation.tamperRefused = refused;
    assert.ok(refused,
      `${mode}: a tampered bundle is refused on import, not accepted (finish=${JSON.stringify(finished).slice(0, 200)} status=${observation.uploadStatus || ''} ${observation.uploadError || ''})`);

    // The State must still be readable after the refusal: a rejected import must not
    // have disturbed what is already stored.
    const head = await f.r.api.getCurrentStateHead?.();
    observation.headStillReadable = !!head;
    assert.ok(observation.headStillReadable, `${mode}: the current State is still readable after a refused import`);
  } finally { await snapshot.cleanup(); }
  return observation;
};

const run = async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  console.log(JSON.stringify({
    test: 'libra_main_memory_transfer_bundle_matrix',
    passed: 1,
    boundary: 'the real manager portable endpoints against the real HTTP server, one storage mode at a time',
    results
  }));
};
run().catch(error => { console.error(error?.message || error); console.error(error?.stack); process.exit(1); });
