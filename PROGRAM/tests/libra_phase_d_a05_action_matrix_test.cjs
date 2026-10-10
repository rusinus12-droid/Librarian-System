'use strict';

// Aggregate the independent current-source A05 fault actions so the reporter
// only observes a PASS marker after correction, ABA, and scope-transition
// guards all succeed in the applicable storage modes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PROGRAM = path.join(__dirname, '..');
const action = require('./fixtures/acceptance_scenarios.json').cases.find(row => row.id === 'A05').action;
const sha256File = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(PROGRAM, relative))).digest('hex');
const runSuite = testFile => {
  const relative = `tests/${testFile}`;
  const stdout = execFileSync(process.execPath, [relative], { cwd: PROGRAM, encoding: 'utf8', stdio: 'pipe' });
  const rows = stdout.trim().split(/\r?\n/).map(line => {
    try { return JSON.parse(line); } catch (_) { return null; }
  }).filter(Boolean);
  const summary = rows.findLast(row => row.test === testFile.replace(/_test\.cjs$/, ''));
  assert.ok(summary, `${testFile}: natural child output includes its suite summary`);
  return { test_file: relative, test_sha256: sha256File(relative), summary, stdout };
};

(async () => {
  const correction = runSuite('libra_phase_d_v5_correction_race_recovery_test.cjs');
  const aba = runSuite('libra_phase_d_v5_aba_correction_recovery_test.cjs');
  const scope = runSuite('libra_phase_d_v5_state_scope_commit_boundary_test.cjs');
  assert.deepEqual(Object.keys(correction.summary.results).sort(), ['mirror', 'plugin_only', 'server_only']);
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    const row = correction.summary.results[mode];
    assert.equal(row.injectionObserved, true, `${mode}: concurrent public correction was injected after candidate preparation`);
    assert.equal(row.journalReadback.status, 'active', `${mode}: corrected authority was read from the durable journal`);
    assert.equal(row.stateThroughTurn, 10, `${mode}: correction-aware safe retry reaches the current State frontier`);
    assert.ok(row.headBeforeRetry?.throughTurn >= 5, `${mode}: valid Head was read before retry`);
  }
  for (const mode of ['mirror', 'server_only']) {
    const row = aba.summary.results[mode];
    assert.ok(Number(row.abaTemporaryRevision) > Number(row.abaOriginalRevision));
    assert.ok(Number(row.abaRestoredRevision) > Number(row.abaTemporaryRevision));
    assert.notEqual(row.abaRestoredRevision, row.abaOriginalRevision, `${mode}: A→B→A advances the revision despite equal final values`);
    assert.equal(row.retryPending, 1, `${mode}: stale ABA State remains explicitly pending`);
    assert.equal(row.stateThroughTurn, 5, `${mode}: the valid prior Head remains authoritative after stale commit rejection`);
  }
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    const row = scope.summary.results[mode];
    assert.equal(row.transitionRejected, true, `${mode}: post-calculation chat/scope switch is rejected`);
    assert.equal(row.changedScopeRows, 0, `${mode}: the candidate is not published into the changed namespace`);
    assert.equal(row.stateThroughTurn, 10, `${mode}: restoring the original scope recovers State safely`);
  }
  for (const mode of ['mirror', 'server_only']) console.log(JSON.stringify({
    schema: 'acceptance.action_result.v1', case_id: 'A05', mode, action, assertion_result: true,
    observed: 'Concurrent public correction, same-value A→B→A revision change, and post-calculation scope transition each rejected or safely recovered the stale candidate; the corrected or prior valid authority was read back.'
  }));
  console.log(JSON.stringify({ test: 'libra_phase_d_a05_action_matrix', passed: 2,
    modes: { mirror: 'correction+ABA+scope', server_only: 'correction+ABA+scope', plugin_only: 'correction+scope; no server ABA claim' },
    nestedTests: [correction, aba, scope].map(row => ({ test_file: row.test_file, test_sha256: row.test_sha256 })),
    boundary: 'controlled provider and actual local HTTP/SQLite server modes; plugin_only correction/scope equivalence was observed, no server receipt claimed' }));
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });
