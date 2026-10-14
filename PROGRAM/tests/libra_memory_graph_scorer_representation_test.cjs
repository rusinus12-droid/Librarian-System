'use strict';
// N02 consumption: the representation contract is an INPUT to the scorer, not decoration.
//
// Measured on the fixture (plugin_only, no usable embeddings): 33 units decided, all 33 gated — 13
// canonical without a usable representation and 20 from families that declare no producer at all — so
// no unit received a semantic score, while the answer was still delivered through the lexical, entity,
// predicate and graph channels of the same kernel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, QUOTE } = require('./fixtures/libra_memory_graph_reader_fixture.cjs');

const results = [];
const test = async (name, run) => { await run(); results.push(name); };

(async () => {
  const x = await fixture({ mode: 'plugin_only' });
  try {
    const exec = await x.f.r.api.executeMemoryGraphUnifiedQuery({ expectedScopeKey: x.scopeKey, queryInput: { queryText: QUOTE } });
    const semantic = exec.diagnostics?.semanticDiagnostics || {};

    await test('N02: every decided unit is gated by the plan before any semantic score is assigned', () => {
      assert.ok(Number.isSafeInteger(semantic.planDecisionCount) && semantic.planDecisionCount > 0, 'the plan must reach the scorer');
      assert.equal(semantic.planGatedCount, semantic.planDecisionCount, 'with no usable embeddings every decided unit must be gated');
      assert.equal(semantic.compatibleCount, 0, 'a gated unit must not be counted compatible');
      assert.equal(semantic.planDecisionCount + 0, semantic.planGatedCount + semantic.compatibleCount + semantic.missingCount,
        'every decision must be accounted: gated + compatible + missing');
    });

    await test('N02: the gating reasons are the contract vocabulary, per family', () => {
      const reasons = semantic.planGatedReasons || {};
      assert.ok(Object.keys(reasons).length > 0, 'gating must record why');
      assert.ok(Number(reasons.no_representation_producer_declared) > 0, 'vectorless families are gated as declared: ' + JSON.stringify(reasons));
      for (const reason of Object.keys(reasons)) {
        assert.match(reason, /^(no_representation_producer_declared|representation_missing|embedding_space_mismatch|representation_outside_temporal_view|representation_basis_changed)$/,
          'a gating reason must come from the contract: ' + reason);
      }
    });

    await test('N02: the answer is still delivered through the same kernel without vectors', async () => {
      assert.ok(['complete', 'partial'].includes(exec.deliveryOutcome), 'a vectorless answer must still be delivered: ' + exec.deliveryOutcome);
      assert.ok(Array.isArray(exec.bundle?.items) && exec.bundle.items.length > 0, 'units must still be selected');
      const families = [...new Set(exec.bundle.items.map(item => String(item.family || '')))].sort();
      assert.ok(families.length >= 2, 'families without vectors must still participate: ' + JSON.stringify(families));
      const trace = exec.accessTrace;
      assert.ok(trace, 'the read path is reported alongside the gating');
      assert.ok(trace.lane.roleStats.query_anchor_access.pages > 0, 'lexical anchors still drove the read');
      const recall = await x.f.r.api.previewUnifiedMemoryRecall({ queryText: QUOTE, unifiedEngineMode: 'unified' });
      const gated = recall.unifiedExecution?.diagnostics?.semanticDiagnostics;
      assert.ok(gated && gated.planGatedCount > 0, 'a recall must expose the gating counters too: ' + JSON.stringify(gated && gated.planGatedCount));
    });

    await test('N02: the plan is consulted before any injected representation (rule order)', () => {
      const kernel = fs.readFileSync(path.join(__dirname, '..', 'tools', 'libra_memory_graph_query.cjs'), 'utf8');
      const resolver = kernel.slice(kernel.indexOf('const resolveSemanticFeature = (node, queryFrame) => {'));
      const planCheck = resolver.indexOf("queryFrame.representationDecisions?.[node.id]");
      const injected = resolver.indexOf('queryFrame.documentRepresentations?.[node.id]');
      assert.ok(planCheck > 0, 'the resolver must consult the plan');
      assert.ok(injected > planCheck, 'the plan decision must be taken BEFORE the injected representation is read');
      assert.ok(resolver.includes("decision.status !== 'valid'"), 'a non-valid verdict must be rejected');
      assert.ok(resolver.includes('gatedByPlan: true'), 'a gated verdict must be identifiable');
      // The plugin maps the bridge vocabulary onto the contract statuses rather than inventing new ones.
      const plugin = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
      for (const mapping of ["reason === 'embedding_space_mismatch' ? 'foreign_space'", "reason === 'representation_outside_temporal_view' ? 'out_of_view'"]) {
        assert.ok(plugin.includes(mapping), 'the bridge reason must map to the contract status: ' + mapping);
      }
    });
  } finally { await x.cleanup(); }

  console.log(JSON.stringify({ suite: 'libra_memory_graph_scorer_representation', passed: results.length, tests: results }));
})().catch(error => { console.error('SCORER REPRESENTATION FAILED', error.code || '', error.message); process.exit(1); });
