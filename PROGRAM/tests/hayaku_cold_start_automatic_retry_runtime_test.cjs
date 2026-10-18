'use strict';
// Cold Start must finish in ONE run when a single turn of a batch answer is rejected.
//
// Measured with deepseek-v4.1-flash (temperature 0), batch of 5: in some runs one turn came back as
//   {"unitOrdinal":5,"packet":{"meta":{...},"entity":{...},"narrative":{...},"planner":{},"importance":{...}}, ...}
// i.e. with the empty "world" axis left out. The exact-key shape check refused the whole turn
// (native_repair_packet_top_level_invalid, reported only as native_record_admission_partial), the run
// finished cold_start_partial_adopted, and only a manual resume reached 5/5.
//
// Pinned here:
//  1. an ABSENT content axis is read as an empty axis (no content is added); the turn is admitted.
//  2. the batch refusal keeps its original reason next to the salvage result.
//  3. a turn the batch answer could not admit is re-analyzed once on its own in the same run; a
//     verified retry completes the run and closes the batch failure as resolved_by_retry.
//  4. a retry that also fails keeps the run partial (never adopts an invalid packet).
//  5. automaticRetry:false keeps the old single-call behaviour.
const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket } = require('./fixtures/hayaku_runtime_harness.cjs');

const sentence = n => `Alice opened box number ${n} and found a ribbon.`;
function entry(n) {
  const packet = createValidPacket({ turn: n, subject: 'Alice', summary: sentence(n) });
  for (const a of ['entity', 'world', 'narrative', 'planner']) for (const [k, v] of Object.entries(packet[a])) if (Array.isArray(v)) packet[a][k] = [];
  packet.entity.characters = [{ name: 'Alice', current_state: 'Examining the discovery' }];
  packet.world.active_events = [{ summary: 'A ribbon was discovered.' }];
  packet.meta.summary_memory = { summary: sentence(n) };
  return { unitOrdinal: n, schema: 'hayaku.native_repair_output.v1', packet,
    grounding: ['entity.characters[0]', 'world.active_events[0]', 'meta.summary_memory.summary'].map(path => ({ path, source: 'target', evidence: [sentence(n)] })) };
}
const single = n => { const e = entry(n); delete e.unitOrdinal; return e; };
const badGrounding = n => { const e = entry(n); e.grounding.forEach(row => { row.evidence = ['Absent quote']; }); return e; };
const N = 3;
const messages = Array.from({ length: N }, (_, i) => i + 1).flatMap(n => [
  { role: 'user', id: 'u' + n, chatId: 'u' + n, data: 'Open the box.' },
  { role: 'assistant', id: 'a' + n, chatId: 'a' + n, data: sentence(n) }
]);
const batch = rows => ({ type: 'success', result: JSON.stringify({ schema: 'hayaku.native_cold_start_batch_output.v1', packets: rows }), finish_reason: 'stop' });
const coldRecords = async r => (await r.hayaku.ledger.inspect({ includeRecords: true })).records.filter(row => row.captureSource === 'bridge_cold_start');

(async () => {
  // 1. Absent empty axis: admitted in the single batch call.
  {
    const r = await createHayakuRuntime({ autoRepair: false, messages, llmResponder: async () => {
      const rows = [1, 2, 3].map(entry);
      rows[1].packet.world = undefined; delete rows[1].packet.world;
      rows[1].grounding = rows[1].grounding.filter(row => !row.path.startsWith('world.'));
      delete rows[2].packet.planner;
      return batch(rows);
    } });
    try {
      const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 5 });
      assert.equal(out.completed, true, JSON.stringify(out));
      assert.equal(r.llmCalls.length, 1);
      assert.equal((await coldRecords(r)).length, N);
    } finally { await r.dispose(); }
  }
  // A stray extra packet key is still refused (only ABSENT canonical axes are filled).
  {
    const r = await createHayakuRuntime({ autoRepair: false, messages });
    try {
      const t = r.hayaku._test;
      const stray = single(1); stray.packet.speaker_boundaries = [];
      assert.equal(t.validateNativeRepairEnvelopeShape(t.normalizeNativeRepairEnvelope ? t.normalizeNativeRepairEnvelope(stray) : stray).ok, false);
      const noMeta = single(1); delete noMeta.packet.meta;
      if (t.normalizeNativeRepairEnvelope) assert.equal(t.validateNativeRepairEnvelopeShape(t.normalizeNativeRepairEnvelope(noMeta)).ok, false, 'meta is never synthesized');
    } finally { await r.dispose(); }
  }
  // 2+3. Rejected turn -> automatic single-turn retry -> complete in one run.
  {
    let calls = 0;
    const prompts = [];
    const r = await createHayakuRuntime({ arguments: {hayaku_debug:'true'}, autoRepair: false, messages, llmResponder: async options => {
      calls++; prompts.push((options?.messages || []).map(m => String(m.content || '')).join('\n'));
      if (calls === 1) { const rows = [1, 2, 3].map(entry); rows[1] = badGrounding(2); return batch(rows); }
      return { type: 'success', result: JSON.stringify(single(2)), finish_reason: 'stop' };
    } });
    try {
      const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 5 });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.completed, true, JSON.stringify(out));
      assert.equal(out.reason === 'cold_start_partial_adopted', false);
      assert.equal(calls, 2);
      assert.equal(out.llmCalls, 2);
      assert.equal(JSON.stringify(out.automaticRetry), JSON.stringify({ budget: 5, attempted: 1, recovered: 1 }));
      assert.match(prompts[1], /CONCRETE FAILURE REPORT/, 'the retry tells the model what was refused');
      assert.doesNotMatch(prompts[1], /COLD START BATCH ENVELOPE/, 'the retry is a one-turn request');
      assert.equal((await coldRecords(r)).length, N);
      const failed = await r.hayaku.recovery.failedAnalysis.list();
      const states = (failed.entries || []).map(e => e.state);
      assert.equal(states.length, 1, JSON.stringify(failed.entries));
      assert.equal(states[0], 'resolved_by_retry');
      assert.equal(failed.pending, 0);
    } finally { await r.dispose(); }
  }
  // Original refusal reason survives the salvage relabel (batch path).
  {
    let calls = 0;
    const r = await createHayakuRuntime({ arguments: {hayaku_debug:'true'}, autoRepair: false, messages, llmResponder: async () => {
      calls++;
      const rows = [1, 2, 3].map(entry); rows[1].packet.extra_metadata = { note: 'x' };
      return calls === 1 ? batch(rows) : { type: 'success', result: 'not json', finish_reason: 'stop' };
    } });
    try {
      const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 5 });
      // 4. Retry also failed: partial adoption, invalid packet never adopted.
      assert.equal(out.ok, true); assert.equal(out.completed, false); assert.equal(out.reason, 'cold_start_partial_adopted');
      assert.equal(JSON.stringify(out.automaticRetry), JSON.stringify({ budget: 5, attempted: 1, recovered: 0 }));
      assert.equal((await coldRecords(r)).length, N - 1);
      const failed = await r.hayaku.recovery.failedAnalysis.list();
      const batchEntry = (failed.entries || []).find(e => e.flow === 'cold_start_batch');
      assert(batchEntry, JSON.stringify(failed.entries));
      const read = await r.hayaku.recovery.failedAnalysis.read(batchEntry.failureId);
      const err = read.payload.attempts.at(-1).error;
      const original = err.validation.normalized.find(row => row.reason === 'original_validation');
      assert(original, JSON.stringify(err.validation.normalized));
      assert.match(JSON.stringify(original), /native_repair_packet_top_level_invalid/);
      assert(failed.pending >= 1);
    } finally { await r.dispose(); }
  }
  // 5. Opt-out keeps the single-call partial behaviour.
  {
    let calls = 0;
    const r = await createHayakuRuntime({ autoRepair: false, messages, llmResponder: async () => { calls++; const rows = [1, 2, 3].map(entry); rows[1] = badGrounding(2); return batch(rows); } });
    try {
      const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 5, automaticRetry: false });
      assert.equal(out.completed, false); assert.equal(calls, 1);
      assert.equal(JSON.stringify(out.automaticRetry), JSON.stringify({ budget: 5, attempted: 0, recovered: 0 }));
    } finally { await r.dispose(); }
  }
  // Transport failure of the batch is not retried per turn.
  {
    let calls = 0;
    const r = await createHayakuRuntime({ autoRepair: false, messages, llmResponder: async () => { calls++; return { type: 'fail', result: 'network connection reset' }; } });
    try {
      const out = await r.hayaku.recovery.coldStart({ resume: true, batchTurns: 5 }).catch(e => ({ ok: false, error: String(e?.message || e) }));
      assert.equal(out.completed === true, false);
      assert.equal(calls, 1, 'no per-turn retry after a transport failure');
    } finally { await r.dispose(); }
  }
  console.log('PASS cold start automatic retry: absent empty axis admitted, original refusal reason kept, one-run retry completes and resolves the batch failure, failed retry stays partial, opt-out and transport failure make no retry calls');
})().catch(e => { console.error(e); process.exitCode = 1; });
