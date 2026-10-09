'use strict';
// Stage 1 promises zero additional generation, embedding and reranker calls.
// Building and reading the index must therefore be pure local computation: no model call,
// no network call, and no storage write beyond the index key itself.
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const sourceRows = require('./fixtures/unified_vertical_source.json').sourceRows;

const INDEX_KEY = /evidence-link-index/;
const results = [];
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  const fetchCalls = [];
  const argumentReads = [];
  const f = await fixture({
    args: { evidence_link_index_enabled: 'true' },
    host: {
      async nativeFetch(...args) { fetchCalls.push(args); throw new Error('offline fixture'); },
      async getArgument(name) {
        argumentReads.push(String(name));
        if (String(name).includes('memory_suite_server_mode')) return 'plugin_only';
        if (String(name).includes('enable_gui')) return 'false';
        if (String(name) === 'evidence_link_index_enabled') return 'true';
        return '';
      }
    }
  });
  try {
    const generated = await f.run();
    assert.equal(generated.completed, 1, JSON.stringify(generated));
    const modelCallsAtSetup = f.control.calls.length;
    const writesAtSetup = f.r.storageWrites.length;
    assert.ok(modelCallsAtSetup > 0, 'controlled fixture setup uses its own stub provider exactly as before');

    const index = await f.r.api.getEvidenceLinkIndex({});
    assert.equal(index.schema, 'libra.evidence_link_index.v1');

    assert.equal(f.control.calls.length, modelCallsAtSetup, 'building the index must not call the generation provider');
    assert.deepEqual(fetchCalls, [], 'building the index must not touch the network');
    assert.equal(index.status.llmCalls, 0);
    assert.equal(index.status.providerCalls, 0);

    // Reads must be as quiet as the build.
    const afterBuild = { model: f.control.calls.length, fetch: fetchCalls.length, writes: f.r.storageWrites.length };
    await f.r.api.getEvidenceLinkIndex({});
    const runtime = f.r.api.getRuntime?.();
    assert.ok(runtime);
    assert.equal(f.control.calls.length, afterBuild.model, 'reading the index must not call the generation provider');
    assert.equal(fetchCalls.length, afterBuild.fetch, 'reading the index must not touch the network');
    assert.equal(f.r.storageWrites.length, afterBuild.writes, 'a signature-stable read must not rewrite the index');

    const addedWrites = f.r.storageWrites.slice(writesAtSetup).filter(write => INDEX_KEY.test(write.key));
    assert.equal(addedWrites.length, 1, 'exactly one index write: the build itself');
    const otherWrites = f.r.storageWrites.slice(writesAtSetup).filter(write => !INDEX_KEY.test(write.key));
    assert.deepEqual(otherWrites.map(write => write.key), [], 'the index path must not write any other key');

    // The opt-in argument is resolved once per session, not per read.
    const optInReads = argumentReads.filter(name => name === 'evidence_link_index_enabled');
    assert.equal(optInReads.length, 1, `the opt-in must be memoized, saw ${optInReads.length} reads`);

    // No canonical body, lore body or vector payload is copied. Structured fact values are a
    // deliberate exception (plan §3.1 keeps declared qualifiers), so the check is on the
    // verbatim source text and the vector surfaces, not on the word "text".
    const serialized = JSON.stringify(plain(index));
    for (const forbidden of ['quote', 'vector', 'embedding', 'payload']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, `the index must not carry a "${forbidden}" field`);
    }
    for (const row of sourceRows) {
      assert.equal(serialized.includes(row.text), false, `verbatim source text ${row.ref} must not be copied`);
    }
    results.push('build and read are pure local computation');

    console.log(JSON.stringify({
      suite: 'libra_evidence_link_index_no_provider_calls', passed: results.length, tests: results,
      modelCalls: { atSetup: modelCallsAtSetup, afterBuildAndReads: f.control.calls.length },
      networkCalls: fetchCalls.length,
      indexWrites: addedWrites.length, indexBytes: serialized.length
    }, null, 2));
  } finally { await f.r.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
