'use strict';
// Code-review findings — reachability defects the branch's own tests could not see.
//
// These were found by an independent review of the fix branch, AFTER every test was green. Why the
// branch's tests missed them is the point of this file, and it is a lesson about assertion shape:
//
//   libra_gradia_unified_lore_activation_test    asserted the evidence PRODUCERS exist (string)
//   libra_gradia_unified_semantic_retrieval_test asserted the route literals appear (string)
//
// Both are string-presence checks. Neither asked whether the code that CONSUMES that evidence is
// reachable. A grep for `'jaccard_current_input'` passes while the only function that assigns that
// literal sits behind a guard that can never be true — which is exactly what had happened.
//
// So the assertions below are behavioural wherever a runtime is available, and about structure only
// where no runtime can answer (then with an explicit note saying so):
//
//   A. applyLoreActivationMode must RUN the Jaccard promotion engine.
//      Guard was `normalizedMode !== 'libra_extended'` -> early return. Normalization maps every
//      alias to the single literal 'unified', so the guard was permanently true and the entire
//      promotion engine was unreachable: semantic evidence collected, then discarded.
//
//   B. canonicalLoreReferenceItems must label host-selected lore and take the Jaccard excerpt.
//      Both were gated on `loreMode === 'risu_selected'` / `'libra_extended'` — literals the
//      normalizer can no longer produce — so hostSelected was permanently false and the excerpt
//      route dead.
//
//   C. The embedding reconcile must NOT treat a missing / status-less row as settled. Writing
//      `embeddingStatus: ''` to the manifest made a never-embedded ref count as completed ('' is not
//      in ['pending','retry_pending']) and reported success for work that never happened.
//
//   D. harness_console_capture must swallow a throwing toString() instead of letting it escape
//      console.error as an uncaughtException.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const PLUGIN = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// Extract a balanced brace body starting at a known header. Used only where no runtime can answer.
const bodyAfter = (source, header) => {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `anchor not found: ${header}`);
  const open = source.indexOf('{', start + header.length);
  assert.ok(open > start, `no body brace after: ${header}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`unbalanced braces after: ${header}`);
};

(async () => {
  // ----------------------------------------------------------------------------------------------
  // A + B, executed: load the real plugin and drive the real activation path.
  // The internals accessor is injected IN MEMORY ONLY (transformSource) — the plugin file on disk is
  // never modified, following the same pattern as libra_gradia_unified_semantic_retrieval_test.
  // ----------------------------------------------------------------------------------------------
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  // Inject into LibraMemoryCore (where the lore activation helpers live), not the public API surface.
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  assert.equal(source.split(anchor).length, 2, 'the debug surface anchor must be unique');
  const instrumented = source.replace(anchor,
    `      reviewInternals: { applyLoreActivationMode, promoteLoreCandidatesWithJaccard, canonicalLoreReferenceItems, normalizeLoreActivationMode },\n${anchor}`)
    .replace('  const publicApi = Object.freeze({\n    getHostLineageStatus:',
      '  const publicApi = Object.freeze({\n    reviewInternals: () => LibraMemoryCore.reviewInternals,\n    getHostLineageStatus:');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const api = harness.api;
    assert.ok(api, 'the LIBRA plugin must expose its API after load');
    assert.equal(typeof api.reviewInternals, 'function', 'the review internals accessor must be available');
    const internals = api.reviewInternals();

    // A. The normalizer must still fold every legacy alias onto the unified literal.
    for (const legacy of ['risu_selected', 'risu_key', 'libra_extended', 'host_selected', 'extended', 'jaccard', '']) {
      assert.equal(internals.normalizeLoreActivationMode(legacy), 'unified',
        `'${legacy}' must normalize to the unified engine`);
    }

    // A. THE REGRESSION: the promotion engine must actually run. Before the fix this returned an
    //    empty `promotions` array for every input because the guard returned early. The candidate is
    //    shaped to satisfy the engine's documented entry conditions: it carries `key`/`keys` that
    //    match the query (lorePromotionEvidence requires a key or section hit) and its content is the
    //    same sentence, so the Jaccard score clears candidatePromotionFloor (0.085).
    assert.equal(typeof internals.applyLoreActivationMode, 'function',
      'applyLoreActivationMode must be reachable for verification');
    const SENTENCE = 'Alice opened the archive door and found a blue ribbon beside the ledger.';
    const candidate = {
      sourceType: 'character', source: 'current', label: 'Alice archive ledger',
      key: 'alice_archive_ledger', keys: ['alice', 'archive', 'ledger', 'ribbon'],
      content: SENTENCE, activationRoute: 'direct', mode: 'normal'
    };
    const activationOptions = {
      maxPromotions: 6, terminalQuery: '', chatLength: 3, loreChatVars: {}, loreGreetingIndex: -1
    };
    const promoted = internals.applyLoreActivationMode(
      'unified', [candidate], [], SENTENCE, activationOptions
    );
    assert.equal(promoted?.mode, 'unified', 'the unified mode must be reported');
    assert.ok(Array.isArray(promoted?.activeLore), 'applyLoreActivationMode must return activeLore');
    assert.equal(
      'promotions' in promoted,
      true,
      'applyLoreActivationMode must run the promotion engine, which is what supplies `promotions`'
    );
    // The engine must be genuinely wired: a matching candidate must actually be promoted. This is the
    // fact the old guard suppressed — the evidence was collected and then discarded.
    const engine = internals.promoteLoreCandidatesWithJaccard;
    assert.equal(typeof engine, 'function', 'the Jaccard promotion engine must be reachable');
    const engineResult = engine([candidate], [], SENTENCE, activationOptions);
    assert.ok(Array.isArray(engineResult?.activeLore), 'the engine must return activeLore');
    const promotions = engineResult.promotions || [];
    assert.ok(
      promotions.length > 0,
      `the engine must promote a candidate whose key and content match the query (got ${promotions.length})`
    );
    const routes = promotions.map(item => item?.activationRoute);
    assert.ok(
      routes.some(route => route === 'jaccard_current_input' || route === 'terminal_entity'),
      `a promotion must carry a Jaccard activation route (got ${JSON.stringify(routes)})`
    );
    // And the wiring must be unconditional: applyLoreActivationMode must return the engine's own
    // result, which cannot hold if an early return short-circuits it.
    assert.equal(
      (promoted.promotions || []).length,
      promotions.length,
      'applyLoreActivationMode must delegate to the promotion engine unconditionally'
    );
    assert.equal(
      promoted.activeLore.length,
      engineResult.activeLore.length,
      'applyLoreActivationMode must return the engine-produced activeLore'
    );

    // B. canonicalLoreReferenceItems must key host-selection and the Jaccard excerpt off the ROUTE.
    assert.equal(typeof internals.canonicalLoreReferenceItems, 'function',
      'canonicalLoreReferenceItems must be reachable for verification');
    const hostItem = internals.canonicalLoreReferenceItems(
      [{ sourceType: 'character', source: 'current', label: 'Host lore', content: 'host content',
        activationRoute: 'risu_request_selected', position: 'before', depth: 0, role: 'system' }],
      'unified'
    )[0];
    assert.ok(hostItem, 'a host-selected item must be produced');
    assert.equal(hostItem.hostSelected, true, 'host-selected lore must be labelled hostSelected');
    assert.equal(hostItem.selectionReason, 'host_selected', 'host-selected lore must report its reason');

    const jaccardItem = internals.canonicalLoreReferenceItems(
      [{ sourceType: 'character', source: 'current', label: 'Jaccard lore', content: 'full content',
        retrievedContent: 'excerpt content', activationRoute: 'jaccard_current_input',
        position: 'before', depth: 0, role: 'system' }],
      'unified'
    )[0];
    assert.ok(jaccardItem, 'a Jaccard item must be produced');
    assert.equal(jaccardItem.content, 'excerpt content',
      'the Jaccard route must take the retrieved excerpt, not the full content');

    process.stdout.write(`A/B executed: promotions=${(promoted.promotions || []).length}, `
      + `hostSelected=${hostItem.hostSelected}, excerpt=${jaccardItem.content}\n`);
  } finally {
    await harness.cleanup?.();
  }

  // ----------------------------------------------------------------------------------------------
  // C. The reconcile must require positive evidence. No runtime needed: this is a guard shape whose
  //    absence is precisely the defect, and the invariant is stated over the durable field.
  // ----------------------------------------------------------------------------------------------
  {
    // The reconcile sits inside flushUnifiedDerivedVectors' enqueue callback (a nested arrow body), so
    // assert over the source region from the flush declaration to the next top-level declaration —
    // scanning only the outer braces would miss the very lines the defect lives on.
    const start = PLUGIN.indexOf('const flushUnifiedDerivedVectors = ');
    assert.ok(start >= 0, 'flushUnifiedDerivedVectors must exist');
    const end = PLUGIN.indexOf('\n    const scheduleUnifiedDerivedVectors =', start);
    assert.ok(end > start, 'the flush function region must be bounded');
    const body = PLUGIN.slice(start, end);
    assert.ok(body.includes('rowStatus'), 'the region must contain the reconcile logic');
    assert.equal(
      /!\[['"]pending['"],\s*['"]retry_pending['"]\]\.includes\(rowStatus\)/.test(body),
      false,
      'the reconcile must not fire when the row status is ABSENT — a missing row is not evidence'
    );
    assert.ok(
      /rowStatus\s*===\s*'ready'/.test(body),
      "the reconcile must require the row to positively report status 'ready'"
    );
    assert.ok(
      /const settled\s*=\s*diagnostic\?\.ok!==false\s*&&\s*!\[['"]pending['"],\s*['"]retry_pending['"]\]\.includes\(string\(ref\.embeddingStatus/.test(body),
      'settledness must still be judged from the durable ref, not from the returned object'
    );
    const guardAt = body.indexOf("rowStatus==='ready'");
    const writeAt = body.indexOf('await saveManifest(live.scope,manifest)');
    assert.ok(guardAt >= 0 && writeAt > guardAt,
      'the positive-evidence guard must precede the manifest write-back');
  }

  // ----------------------------------------------------------------------------------------------
  // D. The console capture must not let a throwing toString() escape, and must keep filtering.
  // ----------------------------------------------------------------------------------------------
  {
    const { installConsoleErrorCapture, isNodeRuntimeNotice } = require('../tools/harness_console_capture.cjs');
    const record = { consoleErrors: [] };
    const original = installConsoleErrorCapture(record);
    try {
      const hostile = { toString() { throw new Error('HOSTILE_TOSTRING'); } };
      let escaped = null;
      try { console.error('plugin log', hostile); } catch (error) { escaped = error; }
      assert.equal(escaped, null, 'a throwing toString() must not escape console.error');
      assert.deepEqual(record.consoleErrors, [], 'nothing is recorded when an argument cannot be stringified');

      // Both directions of the filter must still hold.
      console.error('a real plugin error');
      assert.equal(record.consoleErrors.length, 1, 'a real plugin error must still be recorded');
      console.error('(node:123) ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.');
      assert.equal(record.consoleErrors.length, 1, 'a Node runtime notice must still be filtered out');
      assert.equal(isNodeRuntimeNotice('a real plugin error'), false, 'a real error is not a runtime notice');
    } finally {
      console.error = original;
    }
  }

  process.stdout.write('code_review_findings_reachability_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
