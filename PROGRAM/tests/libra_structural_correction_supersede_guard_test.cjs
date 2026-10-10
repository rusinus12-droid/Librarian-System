'use strict';
// P0-A contract: a world-manager profile edit must not supersede the STRUCTURAL
// correction that created the row it edits (identity merge / split / worldline).
//
// Superseding it makes appendStateCorrection() mark the merge itself superseded
// before the new correction is recorded, so the merge disappears from replay and
// the profile edit -- written against post-merge records -- fails stale /
// NO_CHANGE. Reproduced: same edit succeeds when `supersedes` is omitted.
//
// This is a source contract (the style used by the other world-manager GUI
// contract tests): it pins the wiring so the raw correction id can never be
// re-attached to the correction request by a later edit.
//
// STILL NEEDED: behavioural coverage via a runtime fixture that performs a real
// merge and then a profile correction (handoff v2 section 12 names it
// libra_identity_merge_then_profile_correction_test.cjs). That fixture must also
// cover the exact NO_CHANGE variant the user reported.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');

// 1) the guarded helper exists and knows the structural policies
assert.match(source, /const worldManagerSupersedableProfileCorrectionId = \(row, domain = ''\) => \{/,
  'the guarded supersede helper must exist');
assert.match(source, /const WORLD_MANAGER_STRUCTURAL_CORRECTION_POLICIES = new Set\(\[/,
  'the structural policy set must exist');
for (const policy of ['identity_merge', 'identity_split', 'explicit_fact_role_allocation']) {
  assert.ok(source.includes(`'${policy}'`), `structural policy must be listed: ${policy}`);
}

// 2) the correction request uses the guarded helper, never the raw id
assert.match(source, /supersedes:worldManagerSupersedableProfileCorrectionId\(row,domain\)/,
  'the correction editor must pass the guarded supersede id');
assert.doesNotMatch(source, /supersedes:worldManagerCorrectionId\(row\)/,
  'the raw correction id must never be used as `supersedes` again');

// 3) the display helper is untouched: a merged row IS user-corrected and the UI
//    must keep saying so (label, button text, dataset flag)
assert.match(source, /const worldManagerCorrectionId = row => text\(row\?\.correctionProvenance\?\.correctionId \|\| ''\);/,
  'the display helper must stay as-is');

// 4) the helper must also reject a row whose identityCorrectionProvenance carries
//    the same correction id under merge/split, even without a policy string
assert.match(source, /for \(const key of \['merge', 'split'\]\)/,
  'merge/split provenance must be treated as structural');

// 5) GUI boundary: the settings GUI may not reach for LibraMemoryCore-private
//    helpers (a separate contract test enforces this for asObject specifically)
const helperStart = source.indexOf('const worldManagerSupersedableProfileCorrectionId');
const helperEnd = source.indexOf('};', helperStart);
const helperBody = source.slice(helperStart, helperEnd);
assert.doesNotMatch(helperBody, /\basObject\(/,
  'the helper must not use the core-private asObject in the GUI region');

console.log(JSON.stringify({ test: 'libra_structural_correction_supersede_guard', result: 'pass' }));
