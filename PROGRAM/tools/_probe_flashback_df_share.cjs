'use strict';
// Re-measure the Flashback DF loop's share of the scoring pass.
//
// The first survey judged this loop at under 1% (6.4 ms of 1100 ms) and left it alone. Two things
// changed since: the sparse-projection cache ceiling went 384 -> 4096, so far more records now hit
// the cache and the per-record work around this loop got cheaper, and the loop itself is unchanged
// O(queryTokens x documents x fields). If its relative share has grown, the earlier verdict needs
// revisiting rather than inheriting.
//
// The loop is the same shape LIBRA's was before its fix:
//     for (token of tokens) for (item of items) if (fields.some(has(token))) count += 1
// LIBRA replaced that with a single pass building the DF map from each document's own term list.
// The two are equivalent when every field term is visited once per document — which is exactly what
// the inverted pass does — so the same replacement is available here if it is worth it.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'Flashback_Memory.js'), 'utf8');

// Build a corpus of sparse projections with the same shape the scorer reads.
const FIELDS = ['identity', 'heading', 'body'];
const WORDS = ('archive ledger ribbon door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar wanderer northern '
  + 'southern iron glass silver copper ember harvest meadow threshold compass covenant fragment').split(' ');

const makeDocuments = (count, tokensPerDoc) => Array.from({ length: count }, (_, index) => {
  const fieldTf = {};
  for (const field of FIELDS) {
    const tf = new Map();
    for (let i = 0; i < tokensPerDoc; i += 1) {
      tf.set(WORDS[(index * 7 + i * 13) % WORDS.length], 1);
    }
    fieldTf[field] = tf;
  }
  const lengths = {};
  for (const field of FIELDS) lengths[field] = tokensPerDoc;
  return { sparse: { fieldTf, lengths } };
});

const queryTokensOf = count => WORDS.slice(0, count);

const measure = (fn, repeats = 5) => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < repeats; i += 1) fn();
  return Number(process.hrtime.bigint() - started) / 1e6 / repeats;
};

(async () => {
  const rows = [];
  for (const [documents, tokensPerDoc, queryTokens] of [[400, 40, 12], [1200, 40, 12], [4096, 40, 12], [4096, 60, 20]]) {
    const docs = makeDocuments(documents, tokensPerDoc);
    const query = queryTokensOf(queryTokens);

    // (a) the shipped loop, verbatim.
    const shipped = () => {
      const df = new Map();
      for (const token of query) {
        let count = 0;
        for (const item of docs) {
          if (FIELDS.some(field => item.sparse.fieldTf[field]?.has(token))) count += 1;
        }
        df.set(token, count);
      }
      return df;
    };

    // (b) a single inverted pass: each document contributes its distinct terms once.
    const inverted = () => {
      const df = new Map();
      for (const item of docs) {
        const seen = new Set();
        for (const field of FIELDS) {
          const tf = item.sparse.fieldTf[field];
          if (!tf) continue;
          for (const term of tf.keys()) if (!seen.has(term)) seen.add(term);
        }
        for (const term of seen) df.set(term, (df.get(term) || 0) + 1);
      }
      return df;
    };

    // Equivalence on the query tokens the scorer actually reads.
    const a = shipped(), b = inverted();
    let mismatches = 0;
    for (const token of query) if (Number(a.get(token) || 0) !== Number(b.get(token) || 0)) mismatches += 1;

    const msShipped = measure(shipped);
    const msInverted = measure(inverted);

    // The whole scoring pass, for the share this loop actually represents.
    const wholePass = () => {
      const df = shipped();
      for (const item of docs) {
        let score = 0;
        for (const token of query) {
          const idf = Math.log(1 + (docs.length - (df.get(token) || 0) + 0.5) / ((df.get(token) || 0) + 0.5));
          for (const field of FIELDS) {
            const tf = item.sparse.fieldTf[field]?.get(token);
            if (tf) score += idf * tf;
          }
        }
        item.__score = score;
      }
    };
    const msPass = measure(wholePass);

    rows.push({
      documents, tokensPerDoc, queryTokens,
      dfShippedMs: Number(msShipped.toFixed(2)),
      dfInvertedMs: Number(msInverted.toFixed(2)),
      wholePassMs: Number(msPass.toFixed(2)),
      dfShareOfPass: `${((msShipped / msPass) * 100).toFixed(1)}%`,
      equivalentOnQueryTokens: mismatches === 0,
      speedup: `${(msShipped / Math.max(msInverted, 0.001)).toFixed(1)}x`
    });
  }

  console.log(JSON.stringify({ test: 'flashback_df_share', rows }, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
