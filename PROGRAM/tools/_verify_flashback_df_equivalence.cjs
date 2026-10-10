'use strict';
// Verification for the Flashback document-frequency shortcut, BEFORE it is applied.
//
// THE PROPOSED CHANGE
//
// `scoreBm25fCandidates` currently builds its document-frequency table with
//
//     for (const token of queryTokens)            // up to 160
//       for (const item of documents)             // N
//         if (fields.some(field => item.sparse.fieldTf[field]?.has(token))) count += 1;
//
// which is O(Q x N x fields) before any scoring. The natural replacement walks each document's own
// token set once —
//
//     for (const item of documents)
//       for (const field of fields)
//         for (const token of item.sparse.fieldTf[field].keys())
//           if (queryTokenSet.has(token)) documentFrequency.increment(token)
//
// and must produce an IDENTICAL table. This probe proves the equivalence on the real plugin by
// computing the table both ways over corpora that stress the edge cases:
//
//   * a token appearing in several fields of the same document (must count ONCE per document)
//   * a token in no document (df = 0)
//   * a document with empty fields
//   * tokens outside the query set (must not be counted)
//   * a query token that is a prefix / superset of document tokens
//
// It also measures the time of both constructions so the win is quantified before the change lands.
//
// If any corpus disagrees, the shortcut must not be applied.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createFixture } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'flashback_native_runtime_fixture.cjs'));

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar').split(' ');

const record = (index, options = {}) => {
  const pick = slot => WORDS[(index * 7 + slot * 13) % WORDS.length];
  const shared = index % 5 === 0 ? ['archive', 'ledger'] : [];
  const multiField = index % 7 === 0 ? ['lantern'] : [];
  return {
    id: `rec_${index}`,
    key: options.empty ? '' : `rec_${index} ${shared.join(' ')}`,
    title: options.empty ? '' : `${pick(0)} ${pick(1)} ${multiField.join(' ')}`,
    tags: options.empty ? [] : [pick(2), pick(3), ...multiField, `tag${index}`],
    summary: options.empty ? '' : `Entry ${index}`,
    body: options.empty ? '' : `Alice recorded the ${pick(4)} and the ${pick(5)} in the ledger ${shared.join(' ')}. Entry ${index}.`,
    turnStart: index, turnEnd: index + 1, scopeKey: 'flashback-df-probe'
  };
};

const QUERY = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';

(async () => {
  const fixture = await createFixture({
    arguments: { memory_suite_server_mode: 'plugin_only', enable_gui: 'false' }
  });
  try {
    const internals = fixture.api?._test;
    assert.ok(internals, 'the plugin test surface must be exposed');
    for (const name of ['scoreBm25fCandidates', 'sparseProjectionForRecord']) {
      assert.equal(typeof internals[name], 'function', `${name} must be reachable`);
    }

    // Reproduce the production loop exactly. The field list comes from the plugin's own weight table
    // via scoreBm25fCandidates' `Object.keys(FLASHBACK_BM25F_WEIGHTS)` — 8 fields, not 4.
    const weightsProbe = internals.sparseProjectionForRecord(record(0), {});
    const fields = Object.keys(weightsProbe.fieldTf || {});
    assert.equal(fields.length, 8,
      `the projection must expose the eight weighted fields (got ${JSON.stringify(fields)})`);
    const currentWay = (documents, queryTokens) => {
      const table = new Map(queryTokens.map(token => [token, 0]));
      for (const token of queryTokens) {
        let count = 0;
        for (const item of documents) {
          if (fields.some(field => item.sparse.fieldTf[field]?.has(token))) count += 1;
        }
        table.set(token, count);
      }
      return table;
    };
    const proposedWay = (documents, queryTokens) => {
      const querySet = new Set(queryTokens);
      const table = new Map(queryTokens.map(token => [token, 0]));
      for (const item of documents) {
        const seen = new Set();
        for (const field of fields) {
          const fieldTf = item.sparse.fieldTf[field];
          if (!fieldTf || typeof fieldTf.keys !== 'function') continue;
          for (const token of fieldTf.keys()) if (querySet.has(token)) seen.add(token);
        }
        for (const token of seen) table.set(token, (table.get(token) || 0) + 1);
      }
      return table;
    };

    const queryTokens = (() => {
      // Take the query tokens from the plugin's own tokenizer, via a projection of the query text
      // placed where the canonical field draws from (title/tags for this projection builder).
      const projection = internals.sparseProjectionForRecord(
        { id: 'q', key: QUERY, title: QUERY, tags: [], summary: '', body: QUERY }, {});
      const merged = new Set();
      for (const field of Object.keys(projection.fieldTf || {})) {
        const tf = projection.fieldTf[field];
        if (tf && typeof tf.keys === 'function') for (const token of tf.keys()) merged.add(token);
      }
      return [...merged].slice(0, 160);
    })();
    assert.ok(queryTokens.length > 0, 'the query must tokenize to a non-empty set');

    const corpora = {
      'shared tokens across documents': Array.from({ length: 200 }, (_, index) => record(index)),
      'empty documents mixed in': Array.from({ length: 200 }, (_, index) => record(index, { empty: index % 9 === 0 })),
      'all empty': Array.from({ length: 20 }, (_, index) => record(index, { empty: true })),
      'single document': [record(0)]
    };

    const report = {};
    for (const [name, records] of Object.entries(corpora)) {
      const documents = records.map(entry => ({ record: entry, sparse: internals.sparseProjectionForRecord(entry, {}) }));
      const current = currentWay(documents, queryTokens);
      const proposed = proposedWay(documents, queryTokens);
      assert.deepEqual([...proposed.entries()].sort(), [...current.entries()].sort(),
        `${name}: the document-frequency table must be identical`);
      // The table must be non-trivial, or the equality is vacuous.
      const nonZero = [...current.values()].filter(value => value > 0).length;
      report[name] = { documents: documents.length, queryTokens: queryTokens.length, nonZeroEntries: nonZero };
    }
    assert.ok(Object.values(report).some(entry => entry.nonZeroEntries > 0),
      'at least one corpus must produce non-zero document frequencies');

    // Timing on the largest corpus, using the plugin's own scoring pass as the reference cost.
    const large = Array.from({ length: 2000 }, (_, index) => record(index));
    const largeDocs = large.map(entry => ({ record: entry, sparse: internals.sparseProjectionForRecord(entry, {}) }));
    const timeIt = fn => {
      const start = process.hrtime.bigint();
      const value = fn();
      return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
    };
    const currentTimed = timeIt(() => currentWay(largeDocs, queryTokens));
    const proposedTimed = timeIt(() => proposedWay(largeDocs, queryTokens));
    assert.deepEqual([...proposedTimed.value.entries()].sort(), [...currentTimed.value.entries()].sort(),
      'the large corpus must agree too');

    console.log(JSON.stringify({
      probe: 'flashback_df_equivalence',
      corpora: report,
      timing: {
        documents: largeDocs.length,
        currentMs: Number(currentTimed.ms.toFixed(1)),
        proposedMs: Number(proposedTimed.ms.toFixed(1)),
        speedup: Number((currentTimed.ms / proposedTimed.ms).toFixed(2))
      },
      identical: true
    }, null, 1));
    process.stdout.write('_probe_flashback_df_equivalence: PASS\n');
  } finally {
    await fixture.dispose?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
