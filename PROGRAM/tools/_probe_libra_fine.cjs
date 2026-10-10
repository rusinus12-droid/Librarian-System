'use strict';
// Fine decomposition of the two remaining hot spots: responseLoreExactScore and
// responseLoreCorpusBm25f, at the sizes the previous probe identified (47% and 38% of the rank
// phase). The goal is to name the exact loop that dominates, not to guess.
//
// responseLoreExactScore has two parts:
//   (a) the key loop: loreJaccardUnique over label/key/keys/secondaryKeys/additionalKeys (cap 80),
//       then for each key a loreJaccardNormalizeKey + `normalized.includes(key)`;
//   (b) loreExactEntityAnchorScore, which was already optimized.
//
// responseLoreCorpusBm25f has three parts:
//   (a) query tokenization + the constants,
//   (b) averages: one full pass over records PER FIELD,
//   (c) the document-frequency loop, and the scoring loop that re-derives idf per token per record
//       and iterates Object.entries(defs) inside it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require(path.resolve(__dirname, '..', 'tests', 'fixtures', 'libra_vm_harness.cjs'));

const WORDS = ('archive ledger ribbon alice door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar wanderer northern '
  + 'southern iron glass silver copper ember harvest meadow threshold compass covenant fragment').split(' ');

const SIZE = Number(process.argv[2] || 3200);

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
const COMBINED = `${CURRENT}\n${TERMINAL}`;

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const instrumented = source.replace(anchor,
    `      fine: { responseLoreExactScore, loreExactEntityAnchorScore, loreJaccardUnique, loreJaccardNormalizeKey, responseLoreIndexRecord, responseLoreCorpusBm25f, responseLoreTokenStats, loreJaccardTokens, loreJaccardCleanText },\n${anchor}`)
    .replace('    debugSgaPatchOperations(draft = \'\', edits = [])',
      '    fine(){ return LibraMemoryCore.fine; },\n    debugSgaPatchOperations(draft = \'\', edits = [])');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const I = harness.api.fine();
    const records = Array.from({ length: SIZE }, (_, index) => I.responseLoreIndexRecord(entry(index, SIZE))).filter(Boolean);
    assert.equal(records.length, SIZE, 'every entry must produce a record');
    const time = (fn) => {
      const start = process.hrtime.bigint();
      const value = fn();
      return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
    };

    console.log(`=== N=${SIZE} ===`);

    // --- responseLoreExactScore decomposition -------------------------------------------------
    const exactTotal = time(() => {
      for (const record of records) I.responseLoreExactScore(record, COMBINED);
      return null;
    });
    const entityTotal = time(() => {
      for (const record of records) I.loreExactEntityAnchorScore(COMBINED, record.identityText);
      return null;
    });
    const keyLoop = time(() => {
      const normalized = I.loreJaccardNormalizeKey(COMBINED);
      for (const record of records) {
        const keys = I.loreJaccardUnique([
          record.lore?.label, record.lore?.key,
          ...(Array.isArray(record.lore?.keys) ? record.lore.keys : []),
          ...(Array.isArray(record.lore?.secondaryKeys) ? record.lore.secondaryKeys : []),
          ...(Array.isArray(record.lore?.additionalKeys) ? record.lore.additionalKeys : [])
        ], 80);
        let score = 0;
        for (const raw of keys) {
          const key = I.loreJaccardNormalizeKey(raw);
          if (!key || key.length < 2) continue;
          if (normalized.includes(key)) score = Math.max(score, key.length >= 4 ? 1 : 0.88);
        }
      }
      return null;
    });
    console.log('--- responseLoreExactScore ---');
    console.log(`  total            ${exactTotal.ms.toFixed(1).padStart(9)} ms`);
    console.log(`  entity part      ${entityTotal.ms.toFixed(1).padStart(9)} ms  (${(entityTotal.ms / exactTotal.ms * 100).toFixed(1)}%)`);
    console.log(`  key loop part    ${keyLoop.ms.toFixed(1).padStart(9)} ms  (${(keyLoop.ms / exactTotal.ms * 100).toFixed(1)}%)`);

    // --- responseLoreCorpusBm25f decomposition ------------------------------------------------
    const bm25Total = time(() => I.responseLoreCorpusBm25f(records, CURRENT));
    const tokenize = time(() => {
      for (let repeat = 0; repeat < 4; repeat += 1) I.loreJaccardUnique(Array.from(I.responseLoreTokenStats(CURRENT).counts.keys()), 180);
      return null;
    });
    console.log('');
    console.log('--- responseLoreCorpusBm25f (current query) ---');
    console.log(`  total            ${bm25Total.ms.toFixed(1).padStart(9)} ms`);
    console.log(`  tokenize x4      ${tokenize.ms.toFixed(1).padStart(9)} ms  (${(tokenize.ms / bm25Total.ms * 100).toFixed(1)}%)`);
    console.log(`  remainder        ${(bm25Total.ms - tokenize.ms).toFixed(1).padStart(9)} ms`);

    // How many query tokens actually reach the DF loop, and what the records look like.
    const queryTokens = I.loreJaccardUnique(Array.from(I.responseLoreTokenStats(CURRENT).counts.keys()), 180);
    const avgIdentityKeys = records.reduce((sum, r) => sum + (r.fields?.identity?.counts?.size || 0), 0) / records.length;
    console.log('');
    console.log(`  query tokens: ${queryTokens.length} | avg identity keys/record: ${avgIdentityKeys.toFixed(1)} | records: ${records.length}`);
    console.log(`  DF loop cost estimate: ${queryTokens.length} x ${records.length} x 3 fields = ${(queryTokens.length * records.length * 3).toLocaleString()} checks`);
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
