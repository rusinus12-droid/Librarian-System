'use strict';
// Lore selection scaling probe.
//
// The question: as the lorebook grows from a handful of entries to thousands, where does the
// selection path actually spend its time, and does the cost scale linearly or worse?
//
// Method: load the REAL plugin in the VM harness, then drive its REAL ranking entry point
// (responseLoreRankRecords -> responseLoreAdaptiveSelect) with synthetic corpora of increasing size,
// and time each measured phase. The synthetic records are built by the plugin's OWN record builder
// (buildResponseLoreRecord), so tokenization, field statistics and the feature set are produced by
// production code rather than approximated here.
//
// Reported per corpus size:
//   buildMs   - corpus indexing (records built from raw lore entries)
//   rankMs    - responseLoreRankRecords (BM25F x4, linear x2, exact, RRF)
//   selectMs  - responseLoreAdaptiveSelect (MMR)
//   totalMs   - rank + select (what a request pays)
//   tokens    - query token count (drives the O(tokens x records) term)
//
// A ratio column makes the scaling visible: a straight line means linear, growth means worse.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('../tests/fixtures/libra_vm_harness.cjs');

const SIZES = (process.argv[2] ? process.argv[2].split(',').map(Number) : [50, 100, 200, 400, 800, 1600, 3200])
  .filter(size => Number.isFinite(size) && size > 0);

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower silence voyage ember harvest meadow '
  + 'glass threshold compass covenant fragment echo').split(' ');

// Deterministic corpus: entry i gets a stable mixture of shared and unique vocabulary, so
// document frequency differs per term the way a real lorebook's would.
const loreEntry = (index, total) => {
  const pick = offset => WORDS[(index * 7 + offset * 13) % WORDS.length];
  const unique = `token${index}`;
  return {
    label: `Lore ${index} ${pick(0)}`,
    key: `lore_${index}_${pick(1)}`,
    keys: [pick(0), pick(1), unique],
    content: [
      `# ${pick(0)} ${pick(1)}`,
      `The ${pick(2)} near the ${pick(3)} held a ${pick(4)}.`,
      `Alice recorded the ${pick(5)} and the ${pick(6)} in the ledger.`,
      `Entry ${index} of ${total} mentions ${unique} and ${pick(7)}.`,
      `A ${pick(8)} beside the ${pick(9)} pointed toward the ${pick(10)}.`
    ].join('\n'),
    sourceType: 'character',
    source: 'current',
    priority: index % 20,
    alwaysActive: index % 97 === 0,
    mode: 'normal'
  };
};

const QUERY = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';

(async () => {
  // Inject the ranking internals in memory only; the plugin file on disk is untouched.
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  assert.equal(source.split(anchor).length, 2, 'the debug anchor must be unique');
  const instrumented = source.replace(anchor,
    `      scalingInternals: { responseLoreRankRecords, responseLoreAdaptiveSelect, responseLoreIndexRecord },\n${anchor}`)
    .replace('    debugSgaPatchOperations(draft = \'\', edits = [])',
      '    scalingInternals(){ return LibraMemoryCore.scalingInternals; },\n    debugSgaPatchOperations(draft = \'\', edits = [])');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const api = harness.api;
    assert.equal(typeof api.scalingInternals, 'function', 'the scaling internals accessor must be available');
    const internals = api.scalingInternals();
    for (const name of ['responseLoreRankRecords', 'responseLoreAdaptiveSelect', 'responseLoreIndexRecord']) {
      assert.equal(typeof internals[name], 'function', `${name} must be reachable`);
    }

    const results = [];
    for (const size of SIZES) {
      const entries = Array.from({ length: size }, (_, index) => loreEntry(index, size));

      const buildStart = process.hrtime.bigint();
      const records = entries.map((entry, index) => internals.responseLoreIndexRecord(entry))
        .filter(Boolean);
      const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
      assert.equal(records.length, size, `every lore entry must produce a record at size ${size}`);

      const rankStart = process.hrtime.bigint();
      const ranked = internals.responseLoreRankRecords({
        records,
        currentQuery: QUERY,
        terminalQuery: 'the lantern burned in the corridor',
        supportQuery: 'archive ledger ribbon',
        coverageQuery: QUERY,
        stageId: 'shared',
        activeLore: [],
        hostSelectedLore: []
      });
      const rankMs = Number(process.hrtime.bigint() - rankStart) / 1e6;
      assert.ok(ranked && Array.isArray(ranked.rows), 'ranking must return rows');
      assert.equal(ranked.rows.length, size, `every record must be ranked at size ${size}`);

      const settings = { responseLoreStartCount: 8, responseLoreMaxItems: 48, responseLoreMaxChars: 12000 };
      const selectStart = process.hrtime.bigint();
      const adaptive = internals.responseLoreAdaptiveSelect(ranked, settings, 'shared');
      const selectMs = Number(process.hrtime.bigint() - selectStart) / 1e6;
      assert.ok(adaptive && Array.isArray(adaptive.selected), 'adaptive selection must return selected rows');

      results.push({
        size,
        records: records.length,
        built: records.length,
        buildMs: Number(buildMs.toFixed(2)),
        rankMs: Number(rankMs.toFixed(2)),
        selectMs: Number(selectMs.toFixed(2)),
        totalMs: Number((rankMs + selectMs).toFixed(2)),
        selected: adaptive.selected.length,
        firstRelevance: Number(ranked.rows[0]?.relevance?.toFixed(6) || 0)
      });
    }

    // Scaling ratios: compare each size against the previous one. A ratio near the size ratio means
    // linear; a larger ratio means superlinear growth, which is the thing being looked for.
    const scaling = results.map((row, index) => {
      if (index === 0) return { size: row.size, sizeRatio: null, timeRatio: null };
      const previous = results[index - 1];
      const sizeRatio = row.size / previous.size;
      const timeRatio = previous.totalMs > 0 ? row.totalMs / previous.totalMs : null;
      return {
        size: row.size,
        sizeRatio: Number(sizeRatio.toFixed(2)),
        timeRatio: timeRatio == null ? null : Number(timeRatio.toFixed(2)),
        superlinear: timeRatio != null && timeRatio > sizeRatio * 1.35
      };
    });

    console.log(JSON.stringify({ probe: 'lore_selection_scaling', queryChars: QUERY.length, results, scaling }, null, 1));
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
