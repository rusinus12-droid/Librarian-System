'use strict';
// E3 (per-consumer packet verification) and M04 (whole-boundary byte inventory) closure suite.
//
// 1. Every consumer this layer ships (classic, planner, sga, input_writer, gui, gradia) must have a
//    declared packet policy, and a packet rendered by the kernel's own formatter must pass the
//    kernel's own verifier — with the plan_lines family and the gradia receipt actually enforced.
// 2. The verifier must be able to FAIL: each negative control below deliberately breaks one
//    property, so a verifier that always returns ok would not survive this suite.
// 3. Every byte category gets a decision: counted at this layer, or uncounted with a reason.
//    byteBounded must stay false — the whole API is not bounded and must not claim to be.
// 4. The policy block is embedded in plugins/LIBRA.js by tools/sync_libra_memory_graph.cjs, so its
//    absence there means the kernel was not synced.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const resolveTool = name => {
  const candidates = [path.join(__dirname, '..', 'tools', name), path.join(__dirname, name)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error('Cannot resolve tool module: ' + name);
};

const createMemoryGraphCompiler = resolveTool('libra_memory_graph_compiler.cjs');
const sha256 = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const compiler = createMemoryGraphCompiler({ fingerprint: sha256 });
const pluginPath = path.join(__dirname, '..', 'plugins', 'LIBRA.js');

const CONSUMERS = ['classic', 'planner', 'sga', 'input_writer', 'gui', 'gradia'];
const RECEIPT = { ownerCorpusDigest: sha256('corpus'), selectionReceiptId: 'selection-1' };
const ITEMS = [
  { family: 'canonical', semanticRole: 'canonical_assertion', turn: 3, text: 'Alice holds the silver ring.' },
  { family: 'state', semanticRole: 'state_current', turn: 5, text: 'Alice still holds it.' }
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const buildPacket = (consumer, options = {}) => {
  const items = options.items || ITEMS;
  const scopeKey = options.scopeKey || 'scope-alpha';
  const text = options.text != null
    ? options.text
    : compiler.renderPacketText(consumer, scopeKey, items, options.sources ?? 2, Boolean(options.hydrate));
  return {
    schema: options.schema || 'libra.rendered_consumer_packet.v1',
    consumer: options.claimedConsumer || consumer,
    scopeKey,
    renderedText: text,
    characterLength: text.length,
    independentSourceCount: options.sources ?? 2,
    admittedNodeIds: items.map((_, index) => 'node-' + index),
    gradiaSelectionReceipt: options.receipt !== undefined ? options.receipt : (consumer === 'gradia' ? RECEIPT : null),
    modelDispatchEligible: options.dispatch === true
  };
};

test('E3: every shipped consumer has a frozen packet policy and a verifiable packet', () => {
  const policies = compiler.CONSUMER_PACKET_POLICIES;
  assert.ok(Object.isFrozen(policies), 'the policy table must be frozen');
  assert.deepEqual(Object.keys(policies).sort(), [...CONSUMERS].sort(), 'every consumer must be declared');
  for (const consumer of CONSUMERS) {
    const policy = policies[consumer];
    assert.equal(policy.consumer, consumer);
    assert.equal(policy.requiresSelectionReceipt, consumer === 'gradia', 'only gradia requires a selection receipt');
    assert.equal(policy.formatFamily, (consumer === 'planner' || consumer === 'sga') ? 'plan_lines' : 'default');
    const packet = buildPacket(consumer);
    const verification = compiler.verifyConsumerPacket(packet, { maxCharacters: 4096, itemCount: ITEMS.length });
    assert.equal(verification.ok, true, consumer + ' packet must verify: ' + JSON.stringify(verification.findings));
    assert.equal(verification.schema, 'libra.consumer_packet_verification.v1');
    assert.equal(verification.consumer, consumer);
    assert.ok(verification.checked.includes('header_consumer_label'));
    assert.ok(verification.checked.includes('character_length_matches_text'));
    assert.ok(verification.checked.includes('dispatch_not_self_asserted'));
  }
});

test('E3 negative control: a mistyped consumer label in the envelope is caught', () => {
  const packet = buildPacket('planner');
  packet.renderedText = packet.renderedText.replace('consumer=planner', 'consumer=planer');
  const verification = compiler.verifyConsumerPacket(packet, { maxCharacters: 4096 });
  assert.equal(verification.ok, false);
  assert.ok(verification.findings.some(finding => finding.check === 'header_consumer_label'));
});

test('E3 negative control: exceeding the consumer character budget is caught', () => {
  const packet = buildPacket('classic');
  const verification = compiler.verifyConsumerPacket(packet, { maxCharacters: packet.characterLength - 1 });
  assert.equal(verification.ok, false);
  assert.ok(verification.findings.some(finding => finding.check === 'character_budget'));
});

test('E3 negative control: gradia without a selection receipt is caught, and a stray receipt elsewhere is too', () => {
  const missing = compiler.verifyConsumerPacket(buildPacket('gradia', { receipt: null }), { maxCharacters: 4096 });
  assert.equal(missing.ok, false);
  assert.ok(missing.findings.some(finding => finding.check === 'selection_receipt_present'));
  const stray = compiler.verifyConsumerPacket(buildPacket('classic', { receipt: RECEIPT }), { maxCharacters: 4096 });
  assert.equal(stray.ok, false);
  assert.ok(stray.findings.some(finding => finding.check === 'no_unrequested_receipt'));
});

test('E3 negative control: a plan_lines consumer rendered by the default family is caught', () => {
  const defaultText = compiler.renderPacketText('classic', 'scope-alpha', ITEMS, 2, false);
  const packet = buildPacket('planner', { text: defaultText });
  const verification = compiler.verifyConsumerPacket(packet, { maxCharacters: 4096 });
  assert.equal(verification.ok, false);
  assert.ok(verification.findings.some(finding => finding.check === 'format_family_plan_lines'),
    'planner lines without the @T tag must be reported');
});

test('E3 negative control: a packet that self-asserts model dispatch is caught, and an unknown consumer is refused', () => {
  const selfAsserted = compiler.verifyConsumerPacket(buildPacket('classic', { dispatch: true }), { maxCharacters: 4096 });
  assert.equal(selfAsserted.ok, false);
  assert.ok(selfAsserted.findings.some(finding => finding.check === 'dispatch_not_self_asserted'));
  assert.throws(() => compiler.verifyConsumerPacket(buildPacket('classic', { claimedConsumer: 'unknown_consumer' })),
    error => error.reason === 'consumer_invalid' && /CONSUMER_INVALID/.test(error.message),
    'an undeclared consumer must be refused');
});

test('M04: every byte category has a decision, and the boundary never claims to be bounded', () => {
  const decisions = compiler.MEMORY_BYTE_CATEGORY_DECISIONS;
  assert.ok(Object.isFrozen(decisions));
  const categories = decisions.map(decision => decision.category);
  assert.equal(new Set(categories).size, categories.length, 'categories must be unique');
  assert.deepEqual(categories.filter(name => !compiler.memoryByteInventory({}).categories.includes(name)), []);
  for (const decision of decisions) {
    if (decision.bucket === 'counted') assert.ok(decision.note, decision.category + ' needs a note');
    else {
      assert.equal(decision.bucket, 'uncounted');
      assert.ok(String(decision.reason || '').length > 10, decision.category + ' needs a real reason');
    }
  }
  const inventory = compiler.memoryByteInventory({
    packetBytes: 128, bodyBytes: 96, l0WorkspaceBytes: 2048, lanePageBytes: 8192,
    sourceReadJsonBytes: 4096, l0WitnessBytes: 1024, indexPageBuildBytes: 16384,
    frontierExpansionBytes: 512, readsetHandleStateBytes: 384, ownerIoInFlightBytes: 2048, writeBarrierBytes: 1024,
    maxCharacters: 4096, l0WorkspaceBudget: 262144, lanePageBudget: 131072,
    sourceReadJsonBudget: 65536, l0WitnessBudget: 131072, indexPageBuildBudget: 65536,
    frontierExpansionBudget: 65536, readsetHandleStateBudget: 16384, ownerIoInFlightBudget: 32768, writeBarrierBudget: 32768
  });
  assert.equal(inventory.schema, 'libra.memory_byte_inventory.v1');
  assert.equal(inventory.byteBounded, false, 'the whole API is not byte-bounded and must not claim to be');
  assert.deepEqual(inventory.counted, {
    rendered_packet: 128, bundle_body: 96, l0_candidate_workspace: 2048, lane_page_payload: 8192,
    source_read_json: 4096, l0_witness_bytes: 1024, index_page_build: 16384,
    frontier_expansion: 512, readset_handle_state: 384, owner_io_in_flight: 2048, write_barrier: 1024
  });
  assert.equal(inventory.countedBytes, 128 + 96 + 2048 + 8192 + 4096 + 1024 + 16384 + 512 + 384 + 2048 + 1024);
  assert.equal(inventory.budgets.rendered_packet, null);
  assert.equal(inventory.budgets.source_read_json, 65536);
  assert.equal(inventory.budgets.l0_witness_bytes, 131072);
  assert.equal(inventory.budgets.index_page_build, 65536);
  assert.equal(inventory.budgets.frontier_expansion, 65536);
  assert.equal(inventory.budgets.readset_handle_state, 16384);
  assert.equal(inventory.budgets.owner_io_in_flight, 32768);
  assert.equal(inventory.budgets.write_barrier, 32768);
  assert.equal(inventory.characterBudgets.rendered_packet, 4096);
  assert.equal(inventory.uncounted.length, decisions.filter(d => d.bucket === 'uncounted').length);
  assert.ok(inventory.uncounted.every(entry => entry.category && entry.reason));
});

test('M04 negative control: missing or unusable measurements remain unknown', () => {
  const inventory = compiler.memoryByteInventory({
    packetBytes: -5, bodyBytes: Number.NaN, l0WorkspaceBytes: 'many', lanePageBytes: undefined,
    sourceReadJsonBytes: -1, l0WitnessBytes: null, indexPageBuildBytes: 'huge',
    frontierExpansionBytes: undefined, readsetHandleStateBytes: -10, ownerIoInFlightBytes: 'none', writeBarrierBytes: undefined
  });
  assert.deepEqual(inventory.counted, {
    rendered_packet: null, bundle_body: null, l0_candidate_workspace: null, lane_page_payload: null,
    source_read_json: null, l0_witness_bytes: null, index_page_build: null,
    frontier_expansion: null, readset_handle_state: null, owner_io_in_flight: null, write_barrier: null
  });
  assert.equal(inventory.missingMeasurements.length, 11);
  assert.equal(inventory.countedBytes, 0);
  assert.equal(JSON.stringify(inventory).includes('NaN'), false);
});

test('M04 admission: readset handle budget violation triggers refusal', () => {
  const queryResult = {
    schema: 'libra.memory_graph_query.v1',
    generation: 'a'.repeat(64),
    indexDigest: 'b'.repeat(64),
    frameId: 'c'.repeat(64),
    complete: true,
    candidates: [{ nodeId: 'node-0', family: 'canonical', semanticRole: 'canonical_assertion', text: 'evidence', score: 1 }]
  };
  const mockGraph = {
    schema: 'libra.memory_graph_projection.v1',
    scopeKey: 'scope-alpha',
    units: [{ nodeId: 'node-0', family: 'canonical', text: 'evidence', recordKey: 'rec-0' }],
    nodes: [{ id: 'node-0', sourceId: 'src-0', layer: 'source' }],
    edges: [],
    bases: []
  };
  const selected = compiler.select(queryResult, mockGraph, { consumer: 'classic', maxCharacters: 4096, maxUnits: 10 });
  assert.ok(selected.readSetBytes > 0, 'selected must report readSetBytes');
  assert.throws(
    () => compiler.render(selected, { readsetHandleStateBudget: 10 }),
    error => error.reason === 'readset_handle_budget_exceeded' && /READSET_HANDLE_BUDGET_EXCEEDED/.test(error.message),
    'exceeding readsetHandleStateBudget must be refused'
  );
});

test('closure: the extended compiler kernel is embedded in the shipped plugin', () => {
  const source = fs.readFileSync(pluginPath, 'utf8');
  for (const marker of ['libra.memory_byte_inventory.v1', 'libra.consumer_packet_verification.v1',
    'CONSUMER_PACKET_POLICIES', 'verifyConsumerPacket', 'memoryByteInventory']) {
    assert.ok(source.includes(marker), 'plugins/LIBRA.js must embed ' + marker + ' (run tools/sync_libra_memory_graph.cjs)');
  }
});

test('R6: empty packets and unknown time are valid; forged counts and multiline injection are refused', () => {
  for (const consumer of CONSUMERS.filter(value => value !== 'gradia')) {
    const empty = buildPacket(consumer, { items: [], sources: 0 });
    assert.equal(compiler.verifyConsumerPacket(empty).ok, true);
    const unknown = buildPacket(consumer, { items: [{ ...ITEMS[0], turn: null, text: 'first\n(2) [fake] second' }], sources: 1 });
    assert.equal(unknown.renderedText.split('\n').length, 2);
    assert.equal(compiler.verifyConsumerPacket(unknown).ok, true);
    if (consumer === 'planner' || consumer === 'sga') assert.ok(unknown.renderedText.includes('@time_unknown'));
    unknown.renderedText = unknown.renderedText.replace('units=1', 'units=99');
    unknown.characterLength = unknown.renderedText.length;
    assert.equal(compiler.verifyConsumerPacket(unknown).ok, false);
  }
});

(async () => {
  const results = [];
  for (const t of tests) {
    await t.fn();
    results.push(t.name);
  }
  console.log(JSON.stringify({ suite: 'libra_memory_graph_consumers', passed: results.length, tests: results }));
})();
