'use strict';
// Where does the ranking phase spend its time AFTER the entity-pass optimization?
//
// The previous probe established that the exact-entity pass was 83% of the rank phase and fixed it.
// This one decomposes what remains, so the next change is chosen by measurement rather than by
// reading the code. Candidates the source suggests:
//
//   * responseLoreCorpusBm25f runs FOUR times per rank call (current / terminal / domain / support),
//     and each call rebuilds its own document-frequency table with an O(tokens x records x fields)
//     loop, plus averages with another full pass over records.
//   * Object.keys(defs) / Object.entries(defs) are re-created inside those inner loops, and defs is
//     rebuilt on every call even though it is a constant table.
//   * responseLoreRankRecords runs ONCE for 'shared' and then once PER CONSUMER stage, re-ranking
//     the same record set with the same corpus.
//
// Method: load the real plugin, build a realistic corpus, and time each phase with the same input.
// The four BM25F calls are timed with the actual four queries the production path uses, so the
// measurement reflects real token counts rather than a single synthetic query.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_vm_harness.cjs'));

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar wanderer northern '
  + 'southern iron glass silver copper ember harvest meadow threshold compass covenant fragment').split(' ');

const SIZES = (process.argv[2] ? process.argv[2].split(',').map(Number) : [1600, 3200]).filter(Number.isFinite);

const entry = (index, total) => {
  const pick = slot => WORDS[(index * 7 + slot * 13) % WORDS.length];
  const shared = index % 5 === 0 ? 'archive ledger ribbon' : '';
  return {
    label: `Lore ${index} ${pick(0)} ${pick(1)}`,
    key: `lore_${index}_${pick(2)}`,
    keys: [pick(0), pick(1), pick(2), `entrykey${index}`],
    content: `# ${pick(0)} ${pick(1)}\n`
      + `Alice recorded the ${pick(3)} and the ${pick(4)} in the ledger near the ${pick(5)}. `
      + `The ${pick(6)} beside the ${pick(7)} pointed toward the ${pick(8)} ${shared}. `
      + `Entry ${index} of ${total} mentions ${pick(9)} and ${pick(10)}.`,
    sourceType: 'character', source: 'current', priority: index % 20,
    alwaysActive: index % 97 === 0, mode: 'normal'
  };
};

const CURRENT = 'Alice opened the archive door and found a blue ribbon beside the ledger '
  + 'while the lantern burned in the corridor near the winter market';
const TERMINAL = 'the lantern burned in the corridor near the winter market and the ledger was open';
const SUPPORT = 'archive ledger ribbon continuity story arc support text';
const DOMAIN = 'identity alias relationship knowledge world rule chronology current batch';

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  assert.equal(source.split(anchor).length, 2, 'the debug anchor must be unique');
  const instrumented = source.replace(anchor,
    `      deep: { responseLoreCorpusBm25f, responseLoreLinearScore, responseLoreExactScore, responseLoreRankRecords, responseLoreAdaptiveSelect, responseLoreIndexRecord, responseLoreExactScore: responseLoreExactScore, responseLoreRrfFuse, responseLoreSetSimilarity },\n${anchor}`)
    .replace('    debugSgaPatchOperations(draft = \'\', edits = [])',
      '    deep(){ return LibraMemoryCore.deep; },\n    debugSgaPatchOperations(draft = \'\', edits = [])');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const I = harness.api.deep();
    const SETTINGS = { responseLoreStartCount: 8, responseLoreMaxItems: 48, responseLoreMaxChars: 12000 };
    const time = (fn) => {
      const start = process.hrtime.bigint();
      const value = fn();
      return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
    };

    const report = {};
    for (const size of SIZES) {
      const records = Array.from({ length: size }, (_, index) => I.responseLoreIndexRecord(entry(index, size))).filter(Boolean);
      assert.equal(records.length, size, `every entry must produce a record at size ${size}`);

      const rankArgs = {
        records, currentQuery: CURRENT, terminalQuery: TERMINAL,
        supportQuery: SUPPORT, coverageQuery: CURRENT, stageId: 'shared',
        activeLore: [], hostSelectedLore: []
      };

      // Full rank phase, then each phase separately with the same input.
      const rank = time(() => I.responseLoreRankRecords(rankArgs));
      const bm25Current = time(() => I.responseLoreCorpusBm25f(records, CURRENT));
      const bm25Terminal = time(() => I.responseLoreCorpusBm25f(records, TERMINAL));
      const bm25Support = time(() => I.responseLoreCorpusBm25f(records, SUPPORT));
      const bm25Domain = time(() => I.responseLoreCorpusBm25f(records, DOMAIN));
      const linear = time(() => {
        for (const record of records) {
          I.responseLoreLinearScore(record, CURRENT);
          I.responseLoreLinearScore(record, TERMINAL);
        }
        return null;
      });
      const exact = time(() => {
        for (const record of records) I.responseLoreExactScore(record, `${CURRENT}\n${TERMINAL}`);
        return null;
      });
      const rrf = time(() => I.responseLoreRrfFuse(rank.value.rows, [
        { name: 'current_bm25f', weight: 1.00, score: row => row.currentBm25 },
        { name: 'current_lexical', weight: 0.82, score: row => row.currentLexical },
        { name: 'exact', weight: 1.22, score: row => row.exactScore },
        { name: 'activation', weight: 0.92, score: row => row.activation },
        { name: 'terminal_bm25f', weight: 0.46, score: row => row.terminalBm25 },
        { name: 'terminal_lexical', weight: 0.28, score: row => row.terminalLexical },
        { name: 'support_bm25f', weight: 0.28, score: row => row.supportBm25 },
        { name: 'domain_bm25f', weight: 0, score: row => row.domainBm25 },
        { name: 'source_affinity', weight: 0, score: row => row.sourceAffinity },
        { name: 'priority', weight: 0.08, score: row => row.priority }
      ]));
      const adaptive = time(() => I.responseLoreAdaptiveSelect(rank.value, SETTINGS, 'shared'));

      const bm25Total = bm25Current.ms + bm25Terminal.ms + bm25Support.ms + bm25Domain.ms;
      report[size] = {
        rankMs: Number(rank.ms.toFixed(1)),
        bm25: {
          current: Number(bm25Current.ms.toFixed(1)),
          terminal: Number(bm25Terminal.ms.toFixed(1)),
          support: Number(bm25Support.ms.toFixed(1)),
          domain: Number(bm25Domain.ms.toFixed(1)),
          total: Number(bm25Total.toFixed(1)),
          shareOfRank: Number((bm25Total / rank.ms * 100).toFixed(1))
        },
        linearMs: Number(linear.ms.toFixed(1)),
        linearShare: Number((linear.ms / rank.ms * 100).toFixed(1)),
        exactMs: Number(exact.ms.toFixed(1)),
        exactShare: Number((exact.ms / rank.ms * 100).toFixed(1)),
        rrfMs: Number(rrf.ms.toFixed(1)),
        rrfShare: Number((rrf.ms / rank.ms * 100).toFixed(1)),
        adaptiveMs: Number(adaptive.ms.toFixed(1)),
        selected: adaptive.value?.selected?.length ?? null
      };
    }

    console.log(JSON.stringify({ probe: 'libra_rank_decomposition', report }, null, 1));
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
