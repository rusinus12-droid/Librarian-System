'use strict';
// Decompose responseLoreCorpusBm25f itself, since the rank-level probe says it is ~38% of the rank
// phase and the inverted-index DF variant measured SLOWER, not faster — which means the cost is not
// where the loop shape suggests.
//
// The function has four parts, timed separately here on the real plugin:
//   (1) query tokenization
//   (2) averages: one full pass over records per field
//   (3) the document-frequency loop
//   (4) the scoring loop, which per (record x query token) builds a `pieces` object, then calls
//       Object.values(pieces).reduce(...) — two allocations per iteration — and writes fieldRaw.
//
// The scoring loop is the suspect: 3200 records x 19 query tokens = 60,800 iterations per call, and
// the production path calls the function four times per rank (current / terminal / support / domain).
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
const SUPPORT = 'archive ledger ribbon continuity story arc support text';
const DOMAIN = 'identity alias relationship knowledge world rule chronology current batch';

(async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
  const anchor = '      debugApplyDraftPatchOperations: (draftValue, edits = []) =>';
  const instrumented = source.replace(anchor,
    `      bm: { responseLoreCorpusBm25f, responseLoreIndexRecord, responseLoreTokenStats, loreJaccardUnique },\n${anchor}`)
    .replace('    debugSgaPatchOperations(draft = \'\', edits = [])',
      '    bm(){ return LibraMemoryCore.bm; },\n    debugSgaPatchOperations(draft = \'\', edits = [])');

  const harness = await createLibraVmHarness({}, {}, { transformSource: () => instrumented });
  try {
    const I = harness.api.bm();
    const records = Array.from({ length: SIZE }, (_, index) => I.responseLoreIndexRecord(entry(index, SIZE))).filter(Boolean);
    assert.equal(records.length, SIZE, 'every entry must produce a record');
    const time = (label, fn) => {
      const start = process.hrtime.bigint();
      const value = fn();
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      console.log(`  ${label.padEnd(52)} ${ms.toFixed(1).padStart(8)} ms`);
      return { value, ms };
    };
    const defs = { identity: { weight: 4.4, b: 0.10 }, heading: { weight: 2.8, b: 0.24 }, body: { weight: 1.0, b: 0.80 } };
    const fields = Object.keys(defs);

    console.log(`=== N=${SIZE} ===`);
    const total = time('responseLoreCorpusBm25f (current query), total', () => I.responseLoreCorpusBm25f(records, CURRENT));

    // (1) query tokenization
    const tokenize = time('(1) query tokenization', () =>
      I.loreJaccardUnique(Array.from(I.responseLoreTokenStats(CURRENT).counts.keys()), 180));
    const queryTokens = tokenize.value;

    // (2) averages
    time('(2) averages (3 full passes over records)', () => {
      for (const field of fields) {
        let sum = 0;
        for (const record of records) sum += Number(record.fields[field]?.length || 0);
        const avg = sum / Math.max(1, records.length);
        if (!Number.isFinite(avg)) throw new Error('bad average');
      }
      return null;
    });

    // (3) document frequency, the CURRENT shape
    const dfCurrent = time('(3a) DF loop (current shape)', () => {
      const df = new Map();
      for (const token of queryTokens) {
        let count = 0;
        for (const record of records) {
          for (const field of fields) {
            if (record.fields[field]?.counts?.has(token)) { count += 1; break; }
          }
        }
        df.set(token, count);
      }
      return df;
    });

    // (3b) document frequency, the inverted-index shape (measured slower at rank level)
    const dfInverted = time('(3b) DF loop (inverted-index shape)', () => {
      const queryTokenSet = new Set(queryTokens);
      const df = new Map(queryTokens.map(token => [token, 0]));
      for (const record of records) {
        const seen = new Set();
        for (const field of fields) {
          const counts = record.fields[field]?.counts;
          if (!counts || typeof counts.keys !== 'function') continue;
          for (const token of counts.keys()) if (queryTokenSet.has(token)) seen.add(token);
        }
        for (const token of seen) df.set(token, df.get(token) + 1);
      }
      return df;
    });
    assert.deepEqual([...dfInverted.value.entries()].sort(), [...dfCurrent.value.entries()].sort(),
      'both DF shapes must agree');

    // (4) scoring loop, current shape (allocates pieces + Object.values per token)
    const df = dfCurrent.value;
    time('(4a) scoring loop (current: pieces object + values array)', () => {
      for (const record of records) {
        let raw = 0;
        const fieldRaw = { identity: 0, heading: 0, body: 0 };
        for (const token of queryTokens) {
          const documentFrequency = Number(df.get(token) || 0);
          const idf = Math.log(1 + ((records.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
          let combinedTf = 0;
          const pieces = {};
          for (const [field, def] of Object.entries(defs)) {
            const stats = record.fields[field];
            const tf = Number(stats?.counts?.get(token) || 0);
            if (!tf) continue;
            const avg = 1;
            const norm = Math.max(0.12, (1 - def.b) + def.b * (Math.max(0, Number(stats.length || 0)) / avg));
            const weighted = def.weight * tf / norm;
            pieces[field] = weighted;
            combinedTf += weighted;
          }
          if (!combinedTf) continue;
          const contribution = idf * ((combinedTf * (1.35 + 1)) / (combinedTf + 1.35));
          raw += contribution;
          const pieceTotal = Object.values(pieces).reduce((sum, value) => sum + value, 0) || 1;
          for (const [field, value] of Object.entries(pieces)) fieldRaw[field] += contribution * (value / pieceTotal);
        }
      }
      return null;
    });

    // (4b) scoring loop, allocation-free: three named fields, no intermediate object/array.
    time('(4b) scoring loop (allocation-free)', () => {
      const [f0, f1, f2] = fields;
      const d0 = defs[f0], d1 = defs[f1], d2 = defs[f2];
      const idfByToken = new Map();
      for (const token of queryTokens) {
        const documentFrequency = Number(df.get(token) || 0);
        idfByToken.set(token, Math.log(1 + ((records.length - documentFrequency + 0.5) / (documentFrequency + 0.5))));
      }
      for (const record of records) {
        let raw = 0;
        let r0 = 0, r1 = 0, r2 = 0;
        const s0 = record.fields[f0], s1 = record.fields[f1], s2 = record.fields[f2];
        const l0 = Math.max(0, Number(s0?.length || 0));
        const l1 = Math.max(0, Number(s1?.length || 0));
        const l2 = Math.max(0, Number(s2?.length || 0));
        const n0 = Math.max(0.12, (1 - d0.b) + d0.b * l0);
        const n1 = Math.max(0.12, (1 - d1.b) + d1.b * l1);
        const n2 = Math.max(0.12, (1 - d2.b) + d2.b * l2);
        for (const token of queryTokens) {
          const idf = idfByToken.get(token);
          let tf0 = 0, tf1 = 0, tf2 = 0;
          if (s0) { const v = Number(s0.counts.get(token) || 0); if (v) tf0 = d0.weight * v / n0; }
          if (s1) { const v = Number(s1.counts.get(token) || 0); if (v) tf1 = d1.weight * v / n1; }
          if (s2) { const v = Number(s2.counts.get(token) || 0); if (v) tf2 = d2.weight * v / n2; }
          const combinedTf = tf0 + tf1 + tf2;
          if (!combinedTf) continue;
          const contribution = idf * ((combinedTf * (1.35 + 1)) / (combinedTf + 1.35));
          raw += contribution;
          const pieceTotal = (tf0 + tf1 + tf2) || 1;
          r0 += contribution * (tf0 / pieceTotal);
          r1 += contribution * (tf1 / pieceTotal);
          r2 += contribution * (tf2 / pieceTotal);
        }
      }
      return null;
    });

    console.log('');
    const parts = tokenize.ms + 0;
    console.log(`  (1)+(2) accounted: ~0 ms of ${total.ms.toFixed(1)} ms`);
    console.log(`  (3) DF: ${dfCurrent.ms.toFixed(1)} ms  |  (4) scoring: the remainder`);
  } finally {
    await harness.cleanup?.();
  }
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
