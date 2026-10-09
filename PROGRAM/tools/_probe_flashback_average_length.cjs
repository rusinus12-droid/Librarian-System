'use strict';
// Why did the average-length precompute measure 98% of the pass?
//
// The probe's `measure()` ran the whole averages expression REPEATS times, and the expression
// itself is O(fields x documents). That is 3 x 4096 = ~12k reads, which should be microseconds, not
// 532 ms. So the probe was measuring something else: the arrow-function closure over `docs` plus a
// fresh object allocation per field per call, on every repeat. This settles it by timing the
// shipped shape against the hoisted shape that computes all three fields in ONE pass.
const FIELDS = ['identity', 'heading', 'body'];

const makeDocuments = (count, tokensPerDoc) => Array.from({ length: count }, (_, index) => {
  const lengths = {};
  for (const field of FIELDS) lengths[field] = tokensPerDoc + (index % 7);
  return { sparse: { lengths } };
});

const measure = (fn, repeats = 20) => {
  fn(); // warm
  const started = process.hrtime.bigint();
  for (let i = 0; i < repeats; i += 1) fn();
  return Number(process.hrtime.bigint() - started) / 1e6 / repeats;
};

const rows = [];
for (const documents of [1200, 4096, 12000]) {
  const docs = makeDocuments(documents, 40);

  // (a) shipped shape: fields.map -> documents.reduce, one full pass per field.
  const shipped = () => Object.fromEntries(FIELDS.map(field => [
    field,
    docs.reduce((sum, item) => sum + Math.max(1, Number(item.sparse.lengths[field] || 1)), 0) / Math.max(1, docs.length)
  ]));

  // (b) one pass accumulating all fields at once.
  const hoisted = () => {
    const sums = {};
    for (const field of FIELDS) sums[field] = 0;
    for (const item of docs) {
      for (const field of FIELDS) sums[field] += Math.max(1, Number(item.sparse.lengths[field] || 1));
    }
    const out = {};
    const n = Math.max(1, docs.length);
    for (const field of FIELDS) out[field] = sums[field] / n;
    return out;
  };

  const a = shipped(), b = hoisted();
  const equal = FIELDS.every(f => Math.abs(a[f] - b[f]) < 1e-9);

  rows.push({
    documents,
    shippedMs: Number(measure(shipped).toFixed(3)),
    hoistedMs: Number(measure(hoisted).toFixed(3)),
    identical: equal,
    speedup: `${(measure(shipped) / Math.max(measure(hoisted), 0.0001)).toFixed(1)}x`
  });
}
console.log(JSON.stringify({ test: 'flashback_average_length', rows }, null, 1));
