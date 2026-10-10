// Shared call counting for suites written before the one-turn Micro producer existed.
//
// Task 3 introduced a separate `micro_memory` provider job that runs once per completed U+A. Suites
// that assert "regeneration costs exactly one more provider call" therefore started failing as soon
// as Micro was wired in, even though no Canonical work was added. Counting the two kinds separately
// keeps the original guarantee (the Canonical/Librarian pass still runs once) while acknowledging the
// Micro job, and it still catches an extra Canonical call, which is what those assertions protected.
'use strict';

const MICRO_MARKER = 'LIBRA MICRO SOURCE CONTRACT';
const CANONICAL_MARKER = 'LIBRA LONG-TERM MEMORY EXTRACTION';

// A call is classified by the prompt it carries, so the split survives reordering and concurrency.
const classifyCall = args => {
  const text = JSON.stringify(args || '');
  if (text.includes(MICRO_MARKER)) return 'micro';
  if (text.includes(CANONICAL_MARKER)) return 'canonical';
  return 'other';
};

const countCalls = control => {
  const calls = Array.isArray(control?.calls) ? control.calls : [];
  const counts = { total: calls.length, micro: 0, canonical: 0, other: 0 };
  for (const args of calls) counts[classifyCall(args)] += 1;
  return counts;
};

module.exports = { MICRO_MARKER, CANONICAL_MARKER, classifyCall, countCalls };
