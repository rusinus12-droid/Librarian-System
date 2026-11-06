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
// Small passes that run inside one canonical batch (2026-11-06): evidence re-quote, story
// structure over the batch's events, and the preference/boundary check over cue windows.
// They are not extra Canonical analyses, so suites that pin Canonical calls exclude them.
const SUPPLEMENT_MARKERS = Object.freeze(['[LIBRA EVIDENCE QUOTE REPAIR]', '[LIBRA STORY STRUCTURE]', '[LIBRA PREFERENCE AND BOUNDARY CHECK]']);
const isSupplementCall = args => { const text = JSON.stringify(args || ''); return SUPPLEMENT_MARKERS.some(marker => text.includes(marker)); };

// A call is classified by the prompt it carries, so the split survives reordering and concurrency.
const classifyCall = args => {
  const text = JSON.stringify(args || '');
  if (text.includes(MICRO_MARKER)) return 'micro';
  if (SUPPLEMENT_MARKERS.some(marker => text.includes(marker))) return 'supplement';
  if (text.includes(CANONICAL_MARKER)) return 'canonical';
  return 'other';
};

const countCalls = control => {
  const calls = Array.isArray(control?.calls) ? control.calls : [];
  const counts = { total: calls.length, micro: 0, canonical: 0, other: 0 };
  // 'supplement' appears only when such a call was made, so existing count shapes stay comparable.
  for (const args of calls) { const kind = classifyCall(args); counts[kind] = (counts[kind] || 0) + 1; }
  return counts;
};

module.exports = { MICRO_MARKER, CANONICAL_MARKER, SUPPLEMENT_MARKERS, isSupplementCall, classifyCall, countCalls };
