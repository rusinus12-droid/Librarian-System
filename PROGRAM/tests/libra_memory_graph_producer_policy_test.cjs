'use strict';
// N02 producer policy: which family may be embedded, by which trigger, and with what evidence.
//
// The live embedding path was checked before this policy was written: only the owner's canonical source
// projection reaches embedMemory (buildCanonicalCommitEnvelope + buildMemoryRetrievalProjection), so
// micro, state and lore have no producer today. That is recorded as a decision with its preconditions
// rather than left as a silent absence, and the gate is consulted inside the embedding path itself.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const createRepresentation = require('../tools/libra_memory_graph_representation.cjs');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const kernel = createRepresentation({ fingerprint: value => crypto.createHash('sha256').update(String(value)).digest('hex') });
const results = [];
const test = async (name, run) => { await run(); results.push(name); };

(async () => {
  await test('N02: only the family with a declared producer is authorized to embed', () => {
    const policies = kernel.producerPolicies();
    assert.deepEqual([...policies.map(policy => policy.family)], ['canonical', 'micro', 'state', 'lore']);
    const canonical = policies.find(policy => policy.family === 'canonical');
    assert.equal(canonical.authorized, true);
    assert.equal(canonical.activation, 'explicit_maintenance_only');
    for (const family of ['micro', 'state', 'lore']) {
      const policy = policies.find(entry => entry.family === family);
      assert.equal(policy.authorized, false, family + ' has no producer today');
      assert.ok(policy.precondition.length >= 3, family + ' must name what it would need before it can embed');
      assert.ok(policy.textUnit && policy.textUnit.length > 0, family + ' must say what it would embed');
    }
    // The declaration and the policy must not drift apart.
    for (const unit of kernel.declaredUnits()) {
      const policy = policies.find(entry => entry.family === unit.family);
      assert.equal(policy.authorized, unit.vectorToday === true,
        'declared vectorToday and producer authorization disagree for ' + unit.family);
    }
  });

  await test('N02: embedding is refused by name for every trigger that is not explicit maintenance', () => {
    const allowed = kernel.mayEmbed({ family: 'canonical', trigger: 'explicit_maintenance', hasOwnerBasis: true });
    assert.equal(allowed.allowed, true);
    for (const trigger of kernel.FORBIDDEN_TRIGGERS) {
      const verdict = kernel.mayEmbed({ family: 'canonical', trigger, hasOwnerBasis: true });
      assert.equal(verdict.allowed, false, trigger + ' must never embed');
      assert.equal(verdict.reason, 'trigger_not_maintenance');
    }
    const noBasis = kernel.mayEmbed({ family: 'canonical', trigger: 'explicit_maintenance', hasOwnerBasis: false });
    assert.equal(noBasis.reason, 'owner_basis_required');
    assert.throws(() => kernel.mayEmbed({ family: 'archive', trigger: 'explicit_maintenance' }), /LIBRA_/);
    assert.throws(() => kernel.mayEmbed({ family: 'canonical' }), /LIBRA_/);
  });

  await test('N02: a family without a producer is refused even under explicit maintenance', () => {
    for (const family of ['micro', 'state', 'lore']) {
      const verdict = kernel.mayEmbed({ family, trigger: 'explicit_maintenance', hasOwnerBasis: true });
      assert.equal(verdict.allowed, false, family + ' must not be embedded');
      assert.equal(verdict.reason, 'producer_not_authorized');
    }
  });

  await test('N02: the live embedding path consults the gate before the provider is asked', () => {
    const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
    const embedMemory = plugin.slice(plugin.indexOf('const embedMemory = async (scope, memory, previousMemory = null, options = {}) => {'));
    const gate = embedMemory.indexOf('mayEmbed({');
    const provider = embedMemory.indexOf('validateEmbedding(config)');
    assert.ok(gate > 0, 'embedMemory must consult the producer policy');
    assert.ok(provider > gate, 'the gate must run before the provider is asked');
    const kernelCall = embedMemory.lastIndexOf('memoryGraphRepresentationKernel()', gate);
    assert.ok(kernelCall > 0 && kernelCall < provider,
      'the gate must call the shared representation kernel, not a private copy');
    assert.ok(embedMemory.slice(gate, provider).includes("hasOwnerBasis: Boolean(memory && memory.turnRange && memory.sourceDigest)"),
      'the owner basis must be the real canonical basis, not a constant');
    assert.ok(embedMemory.slice(gate, provider).includes("status: 'skipped'"),
      'a refused family must be skipped, never embedded');
  });

  await test('N02: the screen states the policy beside what actually happened', async () => {
    const x = await fixture({ mode: 'plugin_only' });
    try {
      await x.f.r.api.previewUnifiedMemoryRecall({ queryText: QUOTE, unifiedEngineMode: 'unified' });
      const policy = x.f.r.api.getMemoryRecallDiagnosticsView().representation.policy;
      assert.deepEqual([...policy.authorized], ['canonical']);
      assert.deepEqual([...policy.unauthorized], ['micro', 'state', 'lore']);
      assert.ok(policy.forbiddenTriggers.includes('query') && policy.forbiddenTriggers.includes('write'));
    } finally { await x.cleanup(); }
  });

  console.log(JSON.stringify({ suite: 'libra_memory_graph_producer_policy', passed: results.length, tests: results }));
})().catch(error => { console.error('PRODUCER POLICY FAILED', error.code || '', error.reason || '', error.message); process.exit(1); });
