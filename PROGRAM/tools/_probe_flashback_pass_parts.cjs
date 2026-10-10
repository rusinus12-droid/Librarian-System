'use strict';
// Decompose the Flashback scoring pass to find what actually dominates, since the DF loop was
// measured (18-43% of a micro-benchmark) but its obvious replacement is 5-10x SLOWER — the
// inverted pass must touch every term of every document, while the shipped loop only visits the
// query's tokens. So the question is not "how do we speed up DF" but "what is the real cost".
//
// Measures, on the same corpus shape:
//   a) DF construction (the shipped loop)
//   b) the per-document scoring loop (idf x tf over query tokens and fields)
//   c) the sparse-projection lookup the cache now serves
const fs = require('node:fs');
const path = require('node:path');

const FIELDS = ['identity', 'heading', 'body'];
const WORDS = ('archive ledger ribbon door corridor lantern winter market harbor letter promise '
  + 'bridge garden mirror clock river stone forest tower captain keeper scholar wanderer northern '
  + 'southern iron glass silver copper ember harvest meadow threshold compass covenant fragment').split(' ');

const makeDocuments = (count, tokensPerDoc) => Array.from({ length: count }, (_, index) => {
  const fieldTf = {};
  for (const field of FIELDS) {
    const tf = new Map();
    for (let i = 0; i < tokensPerDoc; i += 1) tf.set(WORDS[(index * 7 + i * 13) % WORDS.length], 1);
    tf.set(`${WORDS[index % WORDS.length]}_${index}`, 1); // a distinctive term per document
    fieldTf[field] = tf;
  }
  const lengths = {};
  for (const field of FIELDS) lengths[field] = tokensPerDoc;
  return { sparse: { fieldTf, lengths } };
});

const measure = (fn, repeats = 5) => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < repeats; i += 1) fn();
  return Number(process.hrtime.bigint() - started) / 1e6 / repeats;
};

(async () => {
  const rows = [];
  for (const [documents, tokensPerDoc, queryTokens] of [[1200, 40, 12], [4096, 40, 12], [4096, 60, 20]]) {
    const docs = makeDocuments(documents, tokensPerDoc);
    const query = WORDS.slice(0, queryTokens);

    const msDf = measure(() => {
      const df = new Map();
      for (const token of query) {
        let count = 0;
        for (const item of docs) if (FIELDS.some(f => item.sparse.fieldTf[f]?.has(token))) count += 1;
        df.set(token, count);
      }
      return df;
    });

    // Precompute the DF once so the scoring loop can be timed alone.
    const df = new Map();
    for (const token of query) {
      let count = 0;
      for (const item of docs) if (FIELDS.some(f => item.sparse.fieldTf[f]?.has(token))) count += 1;
      df.set(token, count);
    }

    const msScore = measure(() => {
      for (const item of docs) {
        let score = 0;
        for (const token of query) {
          const d = df.get(token) || 0;
          const idf = Math.log(1 + (docs.length - d + 0.5) / (d + 0.5));
          for (const field of FIELDS) {
            const tf = item.sparse.fieldTf[field]?.get(token);
            if (tf) score += idf * tf;
          }
        }
        item.__score = score;
      }
    });

    // The average-length precompute over fields.
    const msAvg = measure(() => docs.map(item => FIELDS.map(field => [
      field,
      docs.reduce((sum, d) => sum + Math.max(1, Number(d.sparse.lengths[field] || 1)), 0) / Math.max(1, docs.length)
    ])));

    const total = msDf + msScore + msAvg;
    rows.push({
      documents, tokensPerDoc, queryTokens,
      dfMs: Number(msDf.toFixed(2)),
      scoreMs: Number(msScore.toFixed(2)),
      avgLengthMs: Number(msAvg.toFixed(2)),
      totalMs: Number(total.toFixed(2)),
      dfShare: `${((msDf / total) * 100).toFixed(1)}%`,
      scoreShare: `${((msScore / total) * 100).toFixed(1)}%`,
      avgShare: `${((msAvg / total) * 100).toFixed(1)}%`
    });
  }
  console.log(JSON.stringify({ test: 'flashback_pass_decomposition', rows }, null, 1));
})().catch(error => { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; });
