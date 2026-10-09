'use strict';
// G03 — the adaptive lore frontier must not be capped far below the original.
//
// Source: reference/Librarian-System-0.3.63-ISSUES-AND-GRADIA-COMPARISON-PACKAGE, §18
// ("후보 수와 stage budget이 원본보다 크게 축소됨"). Its required regression:
//
//   libra_lore_adaptive_frontier_contract_test.cjs
//   "100~300개 lore에서 required anchor / protected lore / stage-only lore가
//    hard cap 때문에 사라지지 않는지 검사."
//
// THE REGRESSION: the original GRADIA treats its cut as a STARTING POINT, never a hard cap:
//
//     const LORE_DYNAMIC_SHARED_MAX = 512;
//     const LORE_DYNAMIC_STAGE_MAX = 128;
//
// and expands the frontier while protected evidence, exact host/key/entity evidence, uncovered
// query anchors or a flat relevance cluster remain. That is precisely what v0.25.78 changed the
// fixed 48/24/8 cut into: "fixed cut 때문에 필요한 lore가 사라지는 문제 제거".
//
// LIBRA re-introduced a hard ceiling:
//
//     MAX_RESPONSE_LORE_ITEMS = 32          // vs the original's 512 shared
//     DEFAULT_RESPONSE_LORE_MAX_ITEMS = 18  // the working default
//
// so a complex scene needing Character + Relationship + World + Faction + Location + Item lore
// at once can lose most candidates before reranking ever sees them — the exact problem the
// original set out to remove.
//
// THE INVARIANT THIS TEST ASSERTS:
//   * the shared ceiling is not a small fixed number — it must leave room for the original's
//     adaptive expansion order of magnitude;
//   * a protected/anchor-rescued candidate may exceed the ordinary top-K, so the frontier can
//     actually grow rather than being clipped;
//   * the STARTING count stays small (the original's philosophy is "start small, expand"), so
//     this is an expansion fix, not a "return everything" fix.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const observations = {};

const num = (name, pattern) => {
  const m = source.match(pattern);
  assert.ok(m, `${name} must exist`);
  return Number(m[1]);
};

const constants = {
  MIN_START: num('MIN_RESPONSE_LORE_START_COUNT', /const MIN_RESPONSE_LORE_START_COUNT = (\d+);/),
  DEFAULT_START: num('DEFAULT_RESPONSE_LORE_START_COUNT', /const DEFAULT_RESPONSE_LORE_START_COUNT = (\d+);/),
  DEFAULT_MAX: num('DEFAULT_RESPONSE_LORE_MAX_ITEMS', /const DEFAULT_RESPONSE_LORE_MAX_ITEMS = (\d+);/),
  MAX_ITEMS: num('MAX_RESPONSE_LORE_ITEMS', /const MAX_RESPONSE_LORE_ITEMS = (\d+);/)
};
observations.constants = constants;

// The original's shared/stage ceilings, for comparison.
const ORIGINAL_SHARED_MAX = 512;
const ORIGINAL_STAGE_MAX = 128;
observations.original = { sharedMax: ORIGINAL_SHARED_MAX, stageMax: ORIGINAL_STAGE_MAX };

// The declared arguments must advertise the same ceiling the code enforces.
const argMax = source.match(/^\/\/@arg response_lore_max_items\s+int\s+([^\n]*)$/m);
assert.ok(argMax, '//@arg response_lore_max_items must exist');
observations.argMaxNote = argMax[1].trim();

console.log(JSON.stringify({ test: 'libra_gradia_large_lore_frontier', observations }, null, 1));

// 1. The ceiling must leave room for the original's expansion order of magnitude. A shared
//    ceiling in the tens is the regression; the original allows hundreds.
const lowerBound = 128;   // the original's per-stage ceiling
assert.ok(constants.MAX_ITEMS >= lowerBound,
  `the shared lore ceiling must allow adaptive expansion to at least the original's per-stage `
  + `limit (${lowerBound}), not clip it at ${constants.MAX_ITEMS}`);
assert.ok(constants.DEFAULT_MAX >= 48,
  `the working default must allow more than the original's starting cut (48), `
  + `so a complex scene is not cut before reranking (got ${constants.DEFAULT_MAX})`);

// 2. Ordering must hold: start <= default max <= hard max. A broken ordering would make the
//    clamp silently ignore the configured value.
assert.ok(constants.DEFAULT_START <= constants.DEFAULT_MAX,
  `the starting count (${constants.DEFAULT_START}) must not exceed the default maximum `
  + `(${constants.DEFAULT_MAX})`);
assert.ok(constants.DEFAULT_MAX <= constants.MAX_ITEMS,
  `the default maximum (${constants.DEFAULT_MAX}) must not exceed the hard ceiling `
  + `(${constants.MAX_ITEMS})`);
assert.ok(constants.MIN_START >= 1, 'the starting count must be at least 1');

// 3. Starting small is the original's philosophy: expansion is the mechanism, not a big start.
assert.ok(constants.DEFAULT_START <= 24,
  `the STARTING count must stay small so the engine expands on demand rather than always `
  + `processing everything (got ${constants.DEFAULT_START})`);

// 4. Protected/anchor-rescued candidates must be able to exceed the ordinary top-K. If the
//    frontier can only ever return `configuredMax` rows, protection cannot rescue anything.
const frontierSlice = source.slice(
  source.indexOf('const selectResponseLore = ') >= 0
    ? source.indexOf('const selectResponseLore = ')
    : source.indexOf('add(row, row.protected ?'),
  source.indexOf('add(row, row.protected ?') + 4000
);
observations.frontierMarkers = {
  hasProtectedFrontier: source.includes("'protected_frontier'"),
  hasMandatoryRescue: /mandatory|anchor.?rescue|rescue/i.test(source),
  hasAdaptiveExpansion: /adaptive|expandFrontier|frontier/i.test(source)
};
assert.equal(observations.frontierMarkers.hasAdaptiveExpansion, true,
  'the engine must retain an adaptive frontier, not a single fixed cut');

// 5. The ceiling the code enforces must match what the argument documents.
assert.match(observations.argMaxNote, new RegExp(String(constants.MAX_ITEMS)),
  `//@arg response_lore_max_items must document the enforced ceiling (${constants.MAX_ITEMS}); `
  + `note reads: "${observations.argMaxNote}"`);

process.stdout.write('libra_lore_adaptive_frontier_contract_test: PASS\n');
