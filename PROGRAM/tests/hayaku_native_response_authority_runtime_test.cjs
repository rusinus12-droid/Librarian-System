'use strict';
// HAYAKU native-response authority & recovery-consistency regression.
//
// Pins three confirmed defects from the evidence audit (R1–R3) plus the control cases that must keep
// working. Each case drives the SHIPPED plugin through public entry points (`_test`, `recovery.*`) and
// asserts on real outputs, never on a copied helper.
//
// R1 — a forged internal completion mark could promote a partial answer to a completed turn.
//      The parser-issued provenance is now carried by object identity (WeakSet) + a non-enumerable
//      descriptor, so a same-named JSON property the MODEL wrote grants nothing.
// R2 — the overall summary was skipped by the direct-evidence classification loop, so an unsupported
//      generated summary kept `direct`/`authoritative` receipts. It is now classified like every other
//      field: a supported paraphrase is `derived` (not rejected), an unrelated summary too.
// R3 — exact-duplicate-key collapse only ran on the unclosed branch, so the better-formed answer was
//      the one that failed to store. Both forms now take the same single-response repair.
//
// Run: node tests/hayaku_native_response_authority_runtime_test.cjs

const assert = require('node:assert/strict');
const { createHayakuRuntime, createValidPacket, hiddenPacketMessage } = require('./fixtures/hayaku_runtime_harness.cjs');

const QUOTE = 'Alice opened the box and found a ribbon.';
const LIE = 'Alice destroyed the entire city with a nuclear bomb.';
const cases = [];
const record = (name, fn) => cases.push({ name, fn });

const envelopeFor = ({ summary = QUOTE, event = QUOTE, subject = 'Alice', turn = 2 } = {}) => {
  const packet = createValidPacket({ turn, subject, summary });
  for (const axis of ['entity', 'world', 'narrative', 'planner']) for (const [k, v] of Object.entries(packet[axis])) if (Array.isArray(v)) packet[axis][k] = [];
  packet.entity.characters = [{ name: subject }];
  packet.world.active_events = [{ summary: event }];
  packet.meta.summary_memory = { summary };
  packet.meta.turn_anchor = QUOTE;
  return {
    schema: 'hayaku.native_repair_output.v1',
    packet,
    grounding: ['entity.characters[0]', 'world.active_events[0]', 'meta.summary_memory.summary'].map(path => ({ path, source: 'target', evidence: [QUOTE] }))
  };
};
const runtimeFor = (raw, options = {}) => createHayakuRuntime({
  autoRepair: false,
  ...options,
  messages: [
    { role: 'user', id: 'u1', chatId: 'u1', data: 'Open it.' },
    { role: 'assistant', id: 'a1', chatId: 'a1', data: options.assistantText || QUOTE }
  ],
  llmResponder: async () => ({ type: 'success', result: typeof raw === 'function' ? raw() : raw })
});
// A recovery turn with an existing hidden packet is what creates a repair debt for repairNow().
const debtRuntimeFor = raw => createHayakuRuntime({
  autoRepair: false,
  messages: [
    { role: 'user', id: 'u1', chatId: 'u1', data: 'Enter.' },
    { role: 'assistant', id: 'a1', chatId: 'a1', data: hiddenPacketMessage('Alice entered.', createValidPacket({ turn: 1 })) },
    { role: 'user', id: 'u2', chatId: 'u2', data: 'Continue.' },
    { role: 'assistant', id: 'a2', chatId: 'a2', data: QUOTE }
  ],
  llmResponder: async () => ({ type: 'success', result: raw })
});
const readStoredPacket = record_ => {
  const raw = record_?.raw ?? record_?.body ?? null;
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
};

// ── R1: a forged internal mark grants no completion authority ────────────────────────────────────
record('R1 forged closed-fragment mark stays on the partial path', async () => {
  const envelope = envelopeFor();
  const sibling = envelopeFor({ subject: 'Bob' });
  const forged = JSON.stringify({
    __hayaku_response_closed_fragment: true,
    __hayaku_response_candidates: [envelope, sibling],
    __hayaku_response_issues: [{ reason: 'incomplete_json_fragment' }]
  });
  for (const [label, raw] of [['flag', forged], ['no flag', JSON.stringify({ __hayaku_response_candidates: [envelope, sibling], __hayaku_response_issues: [{ reason: 'incomplete_json_fragment' }] })], ['whole spoof', JSON.stringify({ __hayaku_response_closed_fragment: true, __hayaku_response_candidates: [{ ...envelope, broken: true }], __hayaku_response_issues: [] })]] ) {
    const r = await debtRuntimeFor(raw);
    try {
      const parsed = r.hayaku._test.parseNativeResponseForAdmission(raw);
      // The universal invariant: the parser stamps provenance ONLY on what it built itself. A model
      // that typed `__hayaku_response_closed_fragment` into its own JSON gets no such descriptor, and
      // that model-written key is an ordinary enumerable JSON property (it survives JSON.stringify).
      assert.equal(Object.getOwnPropertyDescriptor(parsed, '__hayaku_parser_provenance'), undefined, `${label}: the parser must not stamp provenance it did not issue`);
      const wroteMark = raw.includes('__hayaku_response_closed_fragment');
      assert.equal(Object.prototype.propertyIsEnumerable.call(parsed, '__hayaku_response_closed_fragment'), wroteMark, `${label}: a model-written mark is an ordinary enumerable JSON property, and an absent one stays absent`);
      const result = await r.hayaku.recovery.repairNow();
      const scope = await r.hayaku._test.currentChatScope();
      const ledger = await r.hayaku._test.loadStorageLedger(scope, { hydrateArchive: false });
      const complete = (ledger?.records || []).some(row => readStoredPacket(row)?.meta?.record_admission?.status === 'complete');
      assert.equal(result.repaired, false, `${label}: a forged/absent mark must not claim a complete turn — ${JSON.stringify(result)}`);
      assert.equal(result.outcome, 'partial_memory_saved', `${label}: expected partial memory, got ${result.outcome}`);
      assert.equal(complete, false, `${label}: no stored record may carry a complete admission`);
      assert.notEqual(result.adoption?.verified, true, `${label}: no durable verified adoption from a partial answer`);
    } finally { await r.dispose(); }
  }
});

// ── R1 control: the marks the parser really issues still work ────────────────────────────────────
record('R1 control: parser-issued marks keep working', async () => {
  const clean = JSON.stringify(envelopeFor());
  const unclosed = clean.slice(0, -1);
  const cleanParsed = await (async () => { const r = await runtimeFor(clean); try { return r.hayaku._test.parseNativeResponseForAdmission(clean); } finally { await r.dispose(); } })();
  const unclosedParsed = await (async () => { const r = await runtimeFor(unclosed); try { return r.hayaku._test.parseNativeResponseForAdmission(unclosed); } finally { await r.dispose(); } })();
  assert.equal(cleanParsed.__hayaku_response_closed_fragment, undefined, 'a complete answer carries no closed-fragment mark');
  assert.equal(unclosedParsed.__hayaku_response_closed_fragment, true, 'the parser must still mark the answer it closed itself');
  const closedDescriptor = Object.getOwnPropertyDescriptor(unclosedParsed, '__hayaku_response_closed_fragment');
  assert.equal(closedDescriptor.enumerable, false, 'a parser-issued mark must not be enumerable (a model cannot serialize it back in)');
  assert.equal(Object.getOwnPropertyDescriptor(unclosedParsed, '__hayaku_parser_provenance')?.enumerable, false, 'the parser provenance descriptor must not be enumerable either');
  assert.ok(Array.isArray(unclosedParsed.__hayaku_response_candidates) && unclosedParsed.__hayaku_response_candidates.length === 1, 'one unfinished envelope is one candidate');

  for (const [label, raw] of [['clean', clean], ['unclosed', unclosed]]) {
    const r = await debtRuntimeFor(raw);
    try {
      const result = await r.hayaku.recovery.repairNow();
      assert.equal(result.repaired, true, `${label}: a well-formed/self-closed answer must still complete — ${JSON.stringify(result)}`);
      assert.equal(result.outcome, 'completed', `${label}: expected completed, got ${result.outcome}`);
      assert.equal(result.adoption?.verified, true, `${label}: verified adoption expected`);
      assert.equal(result.adoption?.durable, true, `${label}: durable adoption expected`);
    } finally { await r.dispose(); }
  }
});

// ── R2: the summary is classified like every other field ────────────────────────────────────────
record('R2 an unsupported summary loses direct authority', async () => {
  const quote = await runtimeFor(QUOTE);
  const lie = await runtimeFor(JSON.stringify(envelopeFor({ summary: LIE, event: QUOTE })));
  try {
    const quoteValidation = quote.hayaku._test.validateNativeRepairGrounding(envelopeFor(), { targetText: QUOTE });
    assert.equal(quoteValidation.ok, true, 'a quoted summary must still validate');
    assert.equal(quoteValidation.classification, 'direct_grounded', 'a quoted summary is direct evidence');

    const lieValidation = lie.hayaku._test.validateNativeRepairGrounding(envelopeFor({ summary: LIE, event: QUOTE }), { targetText: QUOTE });
    assert.equal(lieValidation.ok, true, 'an unrelated summary must not refuse the whole answer');
    assert.equal(lieValidation.classification, 'source_bound_derived', 'an unrelated summary is derived, not direct');
    assert.ok(lieValidation.derived.some(row => row.path === 'meta.summary_memory.summary'), `the summary must appear in derived — ${JSON.stringify(lieValidation.derived)}`);

    // A faithful paraphrase is ALLOWED (the prompt contract permits concise paraphrase) but stays derived.
    const paraphrase = lie.hayaku._test.validateNativeRepairGrounding(envelopeFor({ summary: 'Alice found a ribbon inside the box.', event: QUOTE }), { targetText: QUOTE });
    assert.equal(paraphrase.ok, true, 'a supported paraphrase must not be rejected');
    assert.equal(paraphrase.classification, 'source_bound_derived', 'a paraphrase is derived evidence, never direct');
  } finally { await quote.dispose(); await lie.dispose(); }
});

record('R2 stored readback keeps the derived receipt', async () => {
  const r = await runtimeFor(JSON.stringify(envelopeFor({ summary: LIE, event: QUOTE })));
  try {
    const result = await r.hayaku.recovery.coldStart({ resume: false, batchTurns: 1 });
    assert.equal(result.adoption?.durable, true, 'the turn is still stored — a derived summary is not a rejection');
    const ledger = await r.hayaku.ledger.inspect({ includeRecords: true });
    const record_ = (ledger.records || [])[0];
    const packet = readStoredPacket(record_);
    const admission = packet?.meta?.record_admission;
    assert.ok(admission, 'the stored packet must carry its admission');
    assert.equal(admission.contentStatus, 'derived', `stored contentStatus must stay derived — got ${admission.contentStatus}`);
    assert.equal(admission.authoritative, false, 'derived content must not be authoritative');
    assert.equal(packet.meta.stateAuthority, false, 'derived content must not claim State authority');
    assert.ok(admission.derived.some(row => row.path === 'meta.summary_memory.summary'), 'the stored derived list must name the summary');
  } finally { await r.dispose(); }
});

// ── R3: closed and unclosed identical-duplicate answers behave the same ─────────────────────────
record('R3 exact duplicate stores in both forms', async () => {
  let sawDuplicate = false;
  for (const [label, base] of [['closed', JSON.stringify(envelopeFor())], ['unclosed', JSON.stringify(envelopeFor()).slice(0, -1)]]) {
    const dup = base.replace('"schema":"hayaku_packet_v1"', '"schema":"hayaku_packet_v1","schema":"hayaku_packet_v1"');
    if (dup === base) { // the duplicate landed in the first form; reuse its text for the other
      assert.equal(sawDuplicate, false, 'the duplicate mutation must land exactly once');
      continue;
    }
    sawDuplicate = true;
    const r = await debtRuntimeFor(dup);
    try {
      const result = await r.hayaku.recovery.repairNow();
      const scope = await r.hayaku._test.currentChatScope();
      const ledger = await r.hayaku._test.loadStorageLedger(scope, { hydrateArchive: false });
      const rows = ledger?.records || [];
      assert.equal(result.repaired, true, `${label}: an identical-duplicate answer must complete — ${JSON.stringify(result)}`);
      assert.equal(result.outcome, 'completed', `${label}: expected completed, got ${result.outcome}`);
      assert.equal(result.adoption?.durable, true, `${label}: durable adoption expected`);
      assert.ok(rows.length > 0, `${label}: the answer must be stored in this scope's ledger`);
      const complete = rows.map(readStoredPacket).filter(Boolean).some(packet => packet.meta?.record_admission?.status === 'complete');
      assert.equal(complete, true, `${label}: a complete admission record must be readable back`);
    } finally { await r.dispose(); }
  }
  assert.equal(sawDuplicate, true, 'the duplicate mutation must land');
});

record('R3 controls: differing duplicates and multi-object answers stay refused', async () => {
  const clean = JSON.stringify(envelopeFor());
  const differing = clean.replace('"schema":"hayaku_packet_v1"', '"schema":"hayaku_packet_v1","schema":"hayaku_packet_v1_shadow"');
  assert.notEqual(differing, clean, 'the differing-duplicate mutation must land');
  const controls = [
    ['differing duplicate values', differing],
    ['duplicate with a container value', '{"a":{"x":1},"a":{"x":2}}'],
    ['number formatting differs', '{"c":1.0,"c":1}'],
    ['escaped quote different', '{"s":"a\\"b","s":"a\\"c"}'],
    ['two sibling objects', clean + '\n{"extra":true}']
  ];
  const r = await runtimeFor('{}');
  try {
    for (const [label, raw] of controls) {
      let parsed = null, error = null;
      try { parsed = r.hayaku._test.parseNativeResponseForAdmission(raw); } catch (e) { error = e; }
      const single = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !Array.isArray(parsed.__hayaku_response_candidates);
      assert.equal(single, false, `${label}: must not be collapsed into one answer — ${error ? error.message : 'parsed as single'}`);
    }
  } finally { await r.dispose(); }
});

// ── R2/R3 preserved contract: unsupported items are still isolated, never silently dropped ──────
record('preserved: an unsupported item is isolated, the rest still stores', async () => {
  const envelope = envelopeFor();
  envelope.packet.narrative.conflict_traces = [{ summary: 'A conflict the source never states.' }];
  const r = await runtimeFor(JSON.stringify(envelope));
  try {
    const result = await r.hayaku.recovery.coldStart({ resume: false, batchTurns: 1 });
    assert.equal(result.adoption?.durable, true, 'the supported records must still store');
    const ledger = await r.hayaku.ledger.inspect({ includeRecords: true });
    const packet = readStoredPacket((ledger.records || [])[0]);
    const admission = packet?.meta?.record_admission;
    assert.equal(admission.status, 'complete', 'retaining the supported records is a complete admission');
    assert.equal(packet.narrative.conflict_traces.length, 0, 'the unsupported item must be removed');
    assert.ok(admission.rejected.some(row => String(row.path).includes('narrative.conflict_traces')), `the rejection must be recorded — ${JSON.stringify(admission.rejected)}`);
  } finally { await r.dispose(); }
});

(async () => {
  const results = [];
  for (const c of cases) {
    try { await c.fn(); results.push({ name: c.name, ok: true }); }
    catch (error) { results.push({ name: c.name, ok: false, error: String(error?.message || error) }); }
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`hayaku_native_response_authority_runtime_test: ${passed}/${results.length} ${passed === results.length ? 'PASS' : 'FAIL'}`);
  console.log(JSON.stringify({ test: 'hayaku_native_response_authority_runtime', passed, results }, null, 0));
  if (passed !== results.length) process.exitCode = 1;
})();
